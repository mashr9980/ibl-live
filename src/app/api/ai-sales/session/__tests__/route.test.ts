/**
 * Vitest coverage for the session-mint route.
 *
 * Pins the upstream contract: POST /v1/sessions/token with `X-API-KEY`, a
 * FULL-mode body, and clamped `dynamic_variables`.
 *
 * `fetch` is mocked at the global boundary — no network calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '../route';

// `opening_intro` is generated prose whose length depends on the resolved
// lead. Stub the generators so the clamping test can drive an explicitly
// oversized value instead of hoping real copy crosses 1000 chars.
const LONG_INTRO = `${'word '.repeat(400)}tail`; // 2004 chars, space-separated

vi.mock('@/lib/ai-sales/opening', () => ({
  buildOpeningIntro: vi.fn(() => LONG_INTRO),
  pickOpening: vi.fn(() => LONG_INTRO),
}));

type CapturedCall = { url: string; init: RequestInit };

function makeRequest(body: unknown = { name: 'Ada', email: 'Ada@Example.com' }): NextRequest {
  return new Request('http://localhost:3003/api/ai-sales/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', referer: 'https://liveavatar.com/pricing' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function mockUpstream(status: number, body: unknown): CapturedCall[] {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function parsePayload(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const OK_PUBLIC = {
  code: 100,
  message: 'success',
  data: { session_id: 'sess-123', session_token: 'tok-abc' },
};

beforeEach(() => {
  delete process.env.LIVEAVATAR_API_URL;
  process.env.LIVEAVATAR_API_KEY = 'test-api-key';
  process.env.AI_SALES_AVATAR_ID = 'avatar-uuid';
  process.env.AI_SALES_CONTEXT_ID = 'context-uuid';
  delete process.env.LLM_CONFIGURATION_ID;
  delete process.env.AI_SALES_MAX_SESSION_DURATION;
  delete process.env.AI_SALES_VOICE_ID;
  delete process.env.AI_SALES_LANGUAGE;
  process.env.AI_SALES_SESSION_SIGNING_SECRET = 'signing-secret';
});

afterEach(() => {
  delete process.env.LIVEAVATAR_API_URL;
  delete process.env.LIVEAVATAR_API_KEY;
  delete process.env.AI_SALES_AVATAR_ID;
  delete process.env.AI_SALES_CONTEXT_ID;
  delete process.env.LLM_CONFIGURATION_ID;
  delete process.env.AI_SALES_MAX_SESSION_DURATION;
  delete process.env.AI_SALES_VOICE_ID;
  delete process.env.AI_SALES_LANGUAGE;
  delete process.env.AI_SALES_SESSION_SIGNING_SECRET;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('session mint', () => {
  it('POSTs the FULL-mode body to /v1/sessions/token with X-API-KEY', async () => {
    const calls = mockUpstream(200, OK_PUBLIC);

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.liveavatar.com/v1/sessions/token');
    expect((call.init.headers as Record<string, string>)['X-API-KEY']).toBe('test-api-key');

    const payload = parsePayload(call);
    expect(payload.mode).toBe('FULL');
    expect(payload.avatar_id).toBe('avatar-uuid');
    expect(payload.max_session_duration).toBe(600);
    // FULL mode requires exactly one of avatar_persona / voice_agent — the API
    // 422s without it. voice_id / context_id are omitted unless configured.
    expect(payload.avatar_persona).toEqual({ language: 'en', context_id: 'context-uuid' });
    expect(payload).not.toHaveProperty('voice_agent');
    // dynamic_variables stays top-level; the voice_agent form would reject it.
    expect(payload).toHaveProperty('dynamic_variables');
    // Optional; absent unless LLM_CONFIGURATION_ID is configured.
    expect(payload).not.toHaveProperty('llm_configuration_id');
  });

  it('folds voice, context and language into avatar_persona when configured', async () => {
    process.env.AI_SALES_VOICE_ID = 'voice-uuid';
    process.env.AI_SALES_CONTEXT_ID = 'context-uuid';
    process.env.AI_SALES_LANGUAGE = 'es';
    const calls = mockUpstream(200, OK_PUBLIC);

    await POST(makeRequest());

    expect(parsePayload(calls[0]!).avatar_persona).toEqual({
      language: 'es',
      context_id: 'context-uuid',
      voice_id: 'voice-uuid',
    });
  });

  it('honors LIVEAVATAR_API_URL, LLM_CONFIGURATION_ID and AI_SALES_MAX_SESSION_DURATION', async () => {
    process.env.LIVEAVATAR_API_URL = 'https://staging.liveavatar.com/';
    process.env.LLM_CONFIGURATION_ID = 'llm-config-uuid';
    process.env.AI_SALES_MAX_SESSION_DURATION = '900';
    const calls = mockUpstream(200, OK_PUBLIC);

    const res = await POST(makeRequest());
    const json = (await res.json()) as { api_base: string };

    expect(calls[0]!.url).toBe('https://staging.liveavatar.com/v1/sessions/token');
    expect(json.api_base).toBe('https://staging.liveavatar.com');
    const payload = parsePayload(calls[0]!);
    expect(payload.llm_configuration_id).toBe('llm-config-uuid');
    expect(payload.max_session_duration).toBe(900);
  });

  it('clamps every dynamic_variables value to 1000 chars, on a word boundary', async () => {
    const calls = mockUpstream(200, OK_PUBLIC);

    await POST(makeRequest({ name: 'A'.repeat(1500), email: 'ada@example.com' }));

    const vars = parsePayload(calls[0]!).dynamic_variables as Record<string, string>;
    const intro = vars.opening_intro ?? '';
    expect(intro.length).toBeLessThanOrEqual(1000);
    expect(intro.length).toBeGreaterThan(900);
    // Space-separated prose clamps at a word boundary — no partial word.
    expect(intro.endsWith('word')).toBe(true);
    // Non-prose values still clamp, just hard (no boundary near the cut).
    expect(vars.username).toHaveLength(1000);
    expect(vars.email).toBe('ada@example.com');
  });

  it('omits empty dynamic_variables entries', async () => {
    const calls = mockUpstream(200, OK_PUBLIC);

    await POST(makeRequest({ name: 'Ada' }));

    const vars = parsePayload(calls[0]!).dynamic_variables as Record<string, string>;
    expect(vars).not.toHaveProperty('email');
    expect(vars.username).toBe('Ada');
  });

  it('returns session id/token + signature and no demo-queue fields', async () => {
    mockUpstream(200, OK_PUBLIC);

    const res = await POST(makeRequest());
    const json = (await res.json()) as Record<string, unknown>;

    expect(json.session_id).toBe('sess-123');
    expect(json.session_token).toBe('tok-abc');
    expect(typeof json.session_signature).toBe('string');
    expect(json).not.toHaveProperty('state');
    expect(json).not.toHaveProperty('position');
    expect(json).not.toHaveProperty('estimated_wait_time');
  });

  it('fails with a 500 config error when LIVEAVATAR_API_KEY is missing', async () => {
    delete process.env.LIVEAVATAR_API_KEY;
    const calls = mockUpstream(200, OK_PUBLIC);

    const res = await POST(makeRequest());
    const json = (await res.json()) as { error: { message: string } };

    expect(res.status).toBe(500);
    expect(json.error.message).toContain('LIVEAVATAR_API_KEY');
    // Guard runs before any upstream call.
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-numeric AI_SALES_MAX_SESSION_DURATION with a 500', async () => {
    process.env.AI_SALES_MAX_SESSION_DURATION = 'ten minutes';
    mockUpstream(200, OK_PUBLIC);

    const res = await POST(makeRequest());
    const json = (await res.json()) as { error: { message: string } };

    expect(res.status).toBe(500);
    expect(json.error.message).toContain('AI_SALES_MAX_SESSION_DURATION');
  });

  it('maps upstream concurrency/credit errors to a 503 busy shape', async () => {
    mockUpstream(429, { code: 429, message: 'concurrent session limit reached' });

    const res = await POST(makeRequest());
    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(json.error.code).toBe('busy');
    expect(json.error.message).toMatch(/busy/i);
  });

  it('keeps the 502 path for ordinary upstream failures', async () => {
    mockUpstream(422, { code: 422, message: 'avatar_id is not a valid uuid' });

    const res = await POST(makeRequest());
    const json = (await res.json()) as { error: { code?: string; message: string } };

    expect(res.status).toBe(502);
    expect(json.error.code).toBeUndefined();
    expect(json.error.message).toContain('Token mint failed: 422');
  });
});
