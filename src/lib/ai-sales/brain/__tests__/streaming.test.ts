import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  completionText,
  SPOKEN_FALLBACK,
  streamChatCompletion,
  upstreamDeltas,
} from '../streaming';
import type { IblaiConfig } from '../iblai';

const config: IblaiConfig = {
  apiKey: 'token',
  org: 'org1',
  model: 'google/gemini-3.1-flash-lite',
  chatUrl: 'https://asgi.example/api/ai-mentor/orgs/org1/v1/chat/completions',
};

const args = {
  config,
  systemPrompt: 'You are a guide.',
  messages: [{ role: 'user' as const, content: 'What is ibl.ai?' }],
  modelLabel: 'ibl-guide',
  maxTokens: 256,
  temperature: null,
};

function sse(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Split across chunks mid-line to prove the parser buffers.
      const text = lines.join('\n') + '\n';
      const half = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, half)));
      controller.enqueue(encoder.encode(text.slice(half)));
      controller.close();
    },
  });
}

const chunk = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}`;

afterEach(() => vi.unstubAllGlobals());

describe('upstreamDeltas', () => {
  it('yields only text deltas and stops at [DONE]', async () => {
    const body = sse([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}`,
      chunk('Hello'),
      '',
      ': keep-alive',
      chunk(' world'),
      'data: [DONE]',
      chunk('never'),
    ]);
    const out: string[] = [];
    for await (const t of upstreamDeltas(body)) out.push(t);
    expect(out).toEqual(['Hello', ' world']);
  });
});

describe('streamChatCompletion', () => {
  it('sends the persona as the system message with Bearer auth and re-emits OpenAI frames', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(sse([chunk('ibl.ai builds'), chunk(' agents.'), 'data: [DONE]']), {
        status: 200,
      });
    });
    const frames: string[] = [];
    for await (const f of streamChatCompletion(args)) frames.push(f);

    expect(calls[0]!.url).toBe(config.chatUrl);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer token');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.model).toBe('google/gemini-3.1-flash-lite');
    expect(sent.stream).toBe(true);
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are a guide.' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'What is ibl.ai?' });

    const payloads = frames.map((f) => f.replace(/^data: /, '').trim());
    expect(payloads.at(-1)).toBe('[DONE]');
    const chunks = payloads.slice(0, -1).map((p) => JSON.parse(p));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe(
      'ibl.ai builds agents.',
    );
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
    expect(chunks.every((c) => c.model === 'ibl-guide')).toBe(true);
  });

  it('speaks a friendly fallback on an upstream failure and still closes the stream', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 502 }));
    const frames: string[] = [];
    for await (const f of streamChatCompletion(args)) frames.push(f);
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
    expect(frames.some((f) => f.includes(SPOKEN_FALLBACK))).toBe(true);
    expect(frames.some((f) => f.includes('boom'))).toBe(false);
  });
});

describe('streamChatCompletion error frames', () => {
  it('turns an error frame on a 200 stream into a spoken-safe delta', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          sse([
            chunk('Hello'),
            `data: ${JSON.stringify({ error: { message: 'model unavailable', code: 'internal_error' } })}`,
            'data: [DONE]',
          ]),
          { status: 200 },
        ),
    );
    const frames: string[] = [];
    for await (const f of streamChatCompletion(args)) frames.push(f);
    expect(frames.some((f) => f.includes('Hello'))).toBe(true);
    expect(frames.some((f) => f.includes(SPOKEN_FALLBACK))).toBe(true);
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
  });
});

describe('completionText', () => {
  it('returns the message content of a one-shot completion', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).stream).toBe(false);
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Hi there.' } }] });
    });
    expect(await completionText(args)).toBe('Hi there.');
  });

  it('throws with the status on failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 401 }));
    await expect(completionText(args)).rejects.toThrow('ibl.ai 401: nope');
  });
});
