/**
 * Vitest tests for `upsertNotionPage` and `postSlackNotification`.
 *
 * Mocks `fetch` at the global boundary; no real Notion or Slack calls. Pins
 * the exact request payloads and the OLD→NEW restructure step ordering
 * (append-only steps first, deletes last, so a partial failure is recoverable).
 *
 * 2026-05-19 follow-up (Wayne):
 *   - Top-level H1s (`# Lead info`, `# Nth chat`) are now plain (non-
 *     toggleable). The earlier always-toggleable approach left empty
 *     chevron widgets in Notion's UI because we write content as page-
 *     level siblings, not as children. Only the OLD→NEW restructure's
 *     synthetic `# 1st chat` H1 stays toggleable because that's the one
 *     site where we genuinely DO nest legacy blocks under the H1 (via
 *     `appendChildren(firstChatH1Id, ...)`).
 *   - Debug sessions no longer short-circuit to createNewPage — they go
 *     through find-or-create against [test]-prefixed pages so repeat
 *     debug runs accumulate `Nth chat` entries on a single page.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertNotionPage, postSlackNotification, type SessionDigest } from '../session-end';

type FetchMock = ReturnType<typeof vi.fn>;

const DIGEST: SessionDigest = {
  tldr: 'Demo summary.',
  summary: 'Visitor wants pricing.',
  todos: ['Send pricing sheet'],
  leadQuality: 'Qualified',
};

function setEnv() {
  process.env.NOTION_TOKEN = 'test-token';
  process.env.NOTION_DATABASE_ID = 'test-db-id';
  process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
}

function clearEnv() {
  delete process.env.NOTION_TOKEN;
  delete process.env.NOTION_DATABASE_ID;
  delete process.env.SLACK_WEBHOOK_URL;
}

/** Build a fake Response object for fetch mocks. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }) as Response;
}

beforeEach(() => {
  setEnv();
});

afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

describe('upsertNotionPage — new lead (zero matches → createNewPage)', () => {
  it('creates a NEW-format page with plain (non-toggleable) heading_1s on every top-level H1', async () => {
    const fetchMock = vi.fn() as FetchMock;
    let capturedCreateBody: { children?: Array<Record<string, unknown>> } | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/databases/test-db-id/query')) {
        // No matches → triggers createNewPage path
        return jsonResponse({ results: [], has_more: false });
      }
      if (u.endsWith('/pages')) {
        capturedCreateBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: 'page-new', url: 'https://notion.so/page-new' });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await upsertNotionPage({
      lead: null,
      email: 'alice@example.com',
      firstName: 'Alice',
      digest: DIGEST,
      transcript: 'Hello world.',
      durationMs: 60_000,
      startedAt: '2026-05-19T00:00:00.000Z',
      endedAt: '2026-05-19T00:01:00.000Z',
    });

    expect(result.url).toBe('https://notion.so/page-new');
    expect(result.error).toBeNull();
    expect(result.chatCount).toBe(1);
    // Top-level H1s emit `is_toggleable: false` (page-level siblings — no
    // nesting, no chevron in the Notion UI).
    expect(capturedCreateBody).not.toBeNull();
    const h1s = (capturedCreateBody!.children ?? []).filter(
      (b) => (b as { type?: string }).type === 'heading_1',
    );
    expect(h1s.length).toBeGreaterThanOrEqual(2); // Lead info H1 + 1st chat H1
    for (const h1 of h1s) {
      const payload = (h1 as { heading_1?: { is_toggleable?: boolean } }).heading_1;
      expect(payload?.is_toggleable).toBe(false);
    }
  });
});

describe('upsertNotionPage — OLD-format restructure (append-then-delete atomicity)', () => {
  it('appends Lead info H1 + 1st chat H1 + Nth chat H1; recreates originals; deletes originals last', async () => {
    const fetchMock = vi.fn() as FetchMock;
    // Track all PATCH /blocks/.../children calls + DELETE /blocks/... calls in order
    const calls: Array<{ kind: string; url: string; body?: unknown }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/databases/test-db-id/query')) {
        return jsonResponse({
          results: [
            {
              id: 'page-old',
              url: 'https://notion.so/page-old',
              created_time: '2026-05-15T00:00:00.000Z',
              properties: {},
            },
          ],
          has_more: false,
        });
      }
      if (u.includes('/blocks/page-old/children') && method === 'GET') {
        // OLD-format page: top-level H2s, no Lead-info H1
        return jsonResponse({
          results: [
            { id: 'b1', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Summary' }] } },
            {
              id: 'b2',
              type: 'paragraph',
              paragraph: { rich_text: [{ plain_text: 'old summary text' }] },
            },
            { id: 'b3', type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'TODOs' }] } },
            {
              id: 'b4',
              type: 'bulleted_list_item',
              bulleted_list_item: { rich_text: [{ plain_text: 'old todo' }] },
            },
          ],
          has_more: false,
        });
      }
      if (method === 'PATCH' && u.includes('/blocks/') && u.endsWith('/children')) {
        const body = JSON.parse(String(init?.body));
        calls.push({ kind: 'append_children', url: u, body });
        // Return a fake created block id so the caller can use it as the
        // 1st-chat H1 id for the next nested append.
        return jsonResponse({
          results: (body.children ?? []).map((c: Record<string, unknown>, idx: number) => ({
            ...c,
            id: `new-block-${calls.length}-${idx}`,
          })),
        });
      }
      if (method === 'DELETE' && u.includes('/blocks/')) {
        calls.push({ kind: 'delete_block', url: u });
        return jsonResponse({}, 200);
      }
      if (method === 'PATCH' && u.includes('/pages/page-old')) {
        const body = JSON.parse(String(init?.body));
        calls.push({ kind: 'patch_page', url: u, body });
        return jsonResponse({ id: 'page-old' });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await upsertNotionPage({
      lead: null,
      email: 'bob@example.com',
      firstName: 'Bob',
      digest: DIGEST,
      transcript: 'follow-up call',
      durationMs: 90_000,
      startedAt: '2026-05-19T00:00:00.000Z',
      endedAt: '2026-05-19T00:01:30.000Z',
    });

    expect(result.error).toBeNull();
    expect(result.chatCount).toBe(2);

    // Atomicity sequence: append-only (Lead info, 1st chat, recreate, Nth chat) BEFORE deletes
    const appendCalls = calls.filter((c) => c.kind === 'append_children');
    const deleteCalls = calls.filter((c) => c.kind === 'delete_block');
    const patchPageCalls = calls.filter((c) => c.kind === 'patch_page');

    expect(appendCalls.length).toBeGreaterThanOrEqual(4); // Lead info H1, 1st chat H1, recreate, Nth chat H1
    expect(deleteCalls.length).toBe(4); // one per original block
    expect(patchPageCalls.length).toBe(1);

    // First append is `# Lead info` H1
    const firstAppendH1 = (appendCalls[0]!.body as { children: Array<Record<string, unknown>> })
      .children[0]!;
    expect((firstAppendH1 as { type?: string }).type).toBe('heading_1');
    const firstAppendH1Payload = firstAppendH1 as {
      heading_1?: { rich_text?: Array<{ text?: { content?: string } }>; is_toggleable?: boolean };
    };
    // Top-level Lead info H1 is plain (page-level sibling — no nesting).
    expect(firstAppendH1Payload.heading_1?.is_toggleable).toBe(false);
    const firstAppendText = firstAppendH1Payload.heading_1?.rich_text?.[0]?.text?.content;
    expect(firstAppendText).toBe('Lead info');

    // The 2nd append is the synthetic `1st chat - <date>` H1 that wraps legacy
    // top-level blocks as TRUE children — that one MUST be toggleable, or
    // Notion 400s on the children-append below.
    const secondAppendH1 = (appendCalls[1]!.body as { children: Array<Record<string, unknown>> })
      .children[0]!;
    const secondAppendH1Payload = secondAppendH1 as {
      heading_1?: { is_toggleable?: boolean };
    };
    expect(secondAppendH1Payload.heading_1?.is_toggleable).toBe(true);

    // All append calls come BEFORE all delete calls (the ordering invariant)
    let lastAppendIdx = -1;
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i]!.kind === 'append_children') {
        lastAppendIdx = i;
        break;
      }
    }
    const firstDeleteIdx = calls.findIndex((c) => c.kind === 'delete_block');
    expect(lastAppendIdx).toBeLessThan(firstDeleteIdx);

    // Properties PATCH runs LAST (after deletes)
    const patchPageIdx = calls.findIndex((c) => c.kind === 'patch_page');
    expect(patchPageIdx).toBeGreaterThan(firstDeleteIdx);

    // Chat count = 2 (1 wrapped historical + 1 new)
    const patchBody = patchPageCalls[0]!.body as {
      properties: Record<string, { number?: number }>;
    };
    expect(patchBody.properties['Chat count']?.number).toBe(2);
  });
});

describe('upsertNotionPage — NEW-format page (just append)', () => {
  it('skips restructure when `# Lead info` H1 is present; just appends new chat', async () => {
    const fetchMock = vi.fn() as FetchMock;
    const calls: Array<{ kind: string; body?: unknown }> = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/databases/test-db-id/query')) {
        return jsonResponse({
          results: [
            {
              id: 'page-new-fmt',
              url: 'https://notion.so/page-new-fmt',
              created_time: '2026-05-15T00:00:00.000Z',
              properties: {},
            },
          ],
          has_more: false,
        });
      }
      if (u.includes('/blocks/page-new-fmt/children') && method === 'GET') {
        // NEW-format page: Lead info H1 + 1st chat H1 already exist
        return jsonResponse({
          results: [
            {
              id: 'li',
              type: 'heading_1',
              heading_1: { rich_text: [{ plain_text: 'Lead info' }], is_toggleable: true },
            },
            {
              id: 'p1',
              type: 'paragraph',
              paragraph: { rich_text: [{ plain_text: 'lead detail' }] },
            },
            {
              id: 'c1',
              type: 'heading_1',
              heading_1: {
                rich_text: [{ plain_text: '1st chat - 2026-05-15' }],
                is_toggleable: true,
              },
            },
          ],
          has_more: false,
        });
      }
      if (method === 'PATCH' && u.endsWith('/children')) {
        calls.push({ kind: 'append', body: JSON.parse(String(init?.body)) });
        return jsonResponse({ results: [{ id: 'new-h1' }] });
      }
      if (method === 'DELETE') {
        calls.push({ kind: 'delete' });
        return jsonResponse({});
      }
      if (method === 'PATCH' && u.includes('/pages/page-new-fmt')) {
        calls.push({ kind: 'patch_page', body: JSON.parse(String(init?.body)) });
        return jsonResponse({ id: 'page-new-fmt' });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await upsertNotionPage({
      lead: null,
      email: 'returning@example.com',
      firstName: '',
      digest: DIGEST,
      transcript: 'second visit',
      durationMs: 60_000,
      startedAt: '2026-05-19T00:00:00.000Z',
      endedAt: '2026-05-19T00:01:00.000Z',
    });

    expect(result.error).toBeNull();
    expect(result.chatCount).toBe(2); // 1 existing chat H1 + 1 new = 2

    // NO delete calls (NEW format — nothing to clean up)
    expect(calls.filter((c) => c.kind === 'delete').length).toBe(0);
    // Exactly one append (the new # Nth chat H1)
    expect(calls.filter((c) => c.kind === 'append').length).toBe(1);
  });
});

describe('upsertNotionPage — debug sessions reuse [test] pages (2026-05-19)', () => {
  it('debug=true filters Company for `[test]` and updates the latest matching page', async () => {
    const fetchMock = vi.fn() as FetchMock;
    let capturedQueryBody: Record<string, unknown> | null = null;
    let updateCalled = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/databases/test-db-id/query')) {
        capturedQueryBody = JSON.parse(String(init?.body));
        return jsonResponse({
          results: [
            {
              id: 'test-page-prior',
              url: 'https://notion.so/test-page-prior',
              created_time: '2026-05-19T00:00:00.000Z',
              properties: {},
            },
          ],
          has_more: false,
        });
      }
      if (u.includes('/blocks/test-page-prior/children') && method === 'GET') {
        return jsonResponse({
          results: [
            {
              id: 'li',
              type: 'heading_1',
              heading_1: { rich_text: [{ plain_text: 'Lead info' }] },
            },
            {
              id: 'c1',
              type: 'heading_1',
              heading_1: { rich_text: [{ plain_text: '1st chat - 05-19-2026 10:00 in PST' }] },
            },
          ],
          has_more: false,
        });
      }
      if (method === 'PATCH' && u.includes('/blocks/test-page-prior/children')) {
        return jsonResponse({ results: [{ id: 'new-h1' }] });
      }
      if (method === 'PATCH' && u.includes('/pages/test-page-prior')) {
        updateCalled = true;
        return jsonResponse({ id: 'test-page-prior' });
      }
      throw new Error(`unexpected fetch: ${method} ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await upsertNotionPage({
      lead: null,
      email: 'wayne@heygen.com',
      firstName: 'Wayne',
      digest: DIGEST,
      transcript: 'second debug session',
      durationMs: 30_000,
      startedAt: '2026-05-19T00:00:00.000Z',
      endedAt: '2026-05-19T00:00:30.000Z',
      debug: true,
    });

    expect(result.error).toBeNull();
    expect(result.url).toBe('https://notion.so/test-page-prior');
    expect(result.chatCount).toBe(2);

    // Debug query MUST filter Company contains "[test]" (mirror of the prod
    // filter) so debug runs reuse prior debug pages and never touch real rows.
    expect(capturedQueryBody).not.toBeNull();
    const filter = (
      capturedQueryBody as unknown as {
        filter?: { and?: Array<Record<string, unknown>> };
      }
    ).filter;
    const companyClause = (filter?.and ?? []).find(
      (c) => (c as { property?: string }).property === 'Company',
    ) as { rich_text?: { contains?: string; does_not_contain?: string } } | undefined;
    expect(companyClause?.rich_text?.contains).toBe('[test]');
    expect(companyClause?.rich_text?.does_not_contain).toBeUndefined();

    expect(updateCalled).toBe(true);
  });

  it('debug=true falls back to createNewPage with [test] prefix when no prior [test] page exists', async () => {
    const fetchMock = vi.fn() as FetchMock;
    let capturedCreateBody: { properties?: Record<string, unknown>; children?: unknown[] } | null =
      null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/databases/test-db-id/query')) {
        return jsonResponse({ results: [], has_more: false });
      }
      if (u.endsWith('/pages') && (init?.method ?? 'GET') === 'POST') {
        capturedCreateBody = JSON.parse(String(init?.body));
        return jsonResponse({
          id: 'test-page-new',
          url: 'https://notion.so/test-page-new',
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await upsertNotionPage({
      lead: null,
      email: 'wayne@heygen.com',
      firstName: 'Wayne',
      digest: DIGEST,
      transcript: 'first debug session',
      durationMs: 30_000,
      startedAt: '2026-05-19T00:00:00.000Z',
      endedAt: '2026-05-19T00:00:30.000Z',
      debug: true,
    });

    expect(result.error).toBeNull();
    expect(result.url).toBe('https://notion.so/test-page-new');
    expect(result.chatCount).toBe(1);

    expect(capturedCreateBody).not.toBeNull();
    const companyProp = (
      capturedCreateBody!.properties as
        { Company?: { title?: Array<{ text?: { content?: string } }> } } | undefined
    )?.Company;
    const companyText = companyProp?.title?.[0]?.text?.content ?? '';
    expect(companyText.startsWith('[test] ')).toBe(true);
  });
});

describe('upsertNotionPage — graceful degradation', () => {
  it('returns "not configured" error without throwing when NOTION_TOKEN is unset', async () => {
    delete process.env.NOTION_TOKEN;
    const result = await upsertNotionPage({
      lead: null,
      email: 'whatever@example.com',
      firstName: '',
      digest: DIGEST,
      transcript: '',
      durationMs: 0,
      startedAt: '2026-05-19T00:00:00.000Z',
      endedAt: '2026-05-19T00:01:00.000Z',
    });
    expect(result.url).toBeNull();
    expect(result.error).toContain('not configured');
    expect(result.chatCount).toBe(0);
  });
});

describe('upsertNotionPage — pagination (CR-2 fix)', () => {
  it('paginates getChildren when has_more is true; sees blocks past the first page', async () => {
    const fetchMock = vi.fn() as FetchMock;
    let getChildrenCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/databases/test-db-id/query')) {
        return jsonResponse({
          results: [
            { id: 'pg', url: 'u', created_time: '2026-05-15T00:00:00.000Z', properties: {} },
          ],
          has_more: false,
        });
      }
      if (u.includes('/blocks/pg/children') && method === 'GET') {
        getChildrenCalls++;
        if (getChildrenCalls === 1) {
          return jsonResponse({
            results: [
              // Lead info H1 → triggers NEW-format branch (skips restructure)
              {
                id: 'li',
                type: 'heading_1',
                heading_1: { rich_text: [{ plain_text: 'Lead info' }] },
              },
              {
                id: 'c1',
                type: 'heading_1',
                heading_1: { rich_text: [{ plain_text: '1st chat - 2026-05-15' }] },
              },
            ],
            has_more: true,
            next_cursor: 'cursor-2',
          });
        }
        return jsonResponse({
          results: [
            {
              id: 'c2',
              type: 'heading_1',
              heading_1: { rich_text: [{ plain_text: '2nd chat - 2026-05-17' }] },
            },
          ],
          has_more: false,
        });
      }
      if (method === 'PATCH' && u.endsWith('/children')) {
        return jsonResponse({ results: [{ id: 'new' }] });
      }
      if (method === 'PATCH' && u.includes('/pages/pg')) {
        const body = JSON.parse(String(init?.body));
        // Chat count must reflect ALL chat H1s including the one on page 2
        // (1 + 2 already exist = 2; +1 new = 3)
        expect(
          (body.properties as { 'Chat count'?: { number?: number } })['Chat count']?.number,
        ).toBe(3);
        return jsonResponse({ id: 'pg' });
      }
      throw new Error(`unexpected: ${method} ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await upsertNotionPage({
      lead: null,
      email: 'long@example.com',
      firstName: '',
      digest: DIGEST,
      transcript: '',
      durationMs: 60_000,
      startedAt: '2026-05-19T00:00:00.000Z',
      endedAt: '2026-05-19T00:01:00.000Z',
    });

    expect(result.error).toBeNull();
    expect(getChildrenCalls).toBe(2); // pagination loop ran twice
    expect(result.chatCount).toBe(3);
  });
});

describe('postSlackNotification — `Nth chat` suffix', () => {
  it('includes "1st chat" suffix when chatCount=1', async () => {
    const fetchMock = vi.fn() as FetchMock;
    let capturedPayload: { blocks: Array<{ text?: { text?: string } }> } | null = null;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      capturedPayload = JSON.parse(String(init?.body));
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await postSlackNotification({
      lead: null,
      email: 'alice@example.com',
      firstName: 'Alice',
      tldr: 'Demo session.',
      todos: [],
      leadQuality: 'Qualified',
      notionUrl: null,
      durationMs: 60_000,
      chatCount: 1,
    });

    expect(result.ok).toBe(true);
    const headerText = capturedPayload!.blocks[0]!.text!.text!;
    expect(headerText).toContain('1st chat');
  });

  it('includes "2nd chat" suffix when chatCount=2', async () => {
    const fetchMock = vi.fn() as FetchMock;
    let headerText = '';
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      headerText = body.blocks[0].text.text;
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await postSlackNotification({
      lead: null,
      email: 'bob@example.com',
      firstName: 'Bob',
      tldr: 'Returning visitor.',
      todos: [],
      leadQuality: 'Qualified',
      notionUrl: null,
      durationMs: 60_000,
      chatCount: 2,
    });

    expect(headerText).toContain('2nd chat');
  });

  it('omits suffix when chatCount is 0 or undefined', async () => {
    const fetchMock = vi.fn() as FetchMock;
    let headerText = '';
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      headerText = body.blocks[0].text.text;
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await postSlackNotification({
      lead: null,
      email: 'c@example.com',
      firstName: '',
      tldr: 'No chat count.',
      todos: [],
      leadQuality: 'Unknown',
      notionUrl: null,
      durationMs: 60_000,
      chatCount: 0,
    });

    expect(headerText).not.toMatch(/\b\dth chat|\b\dst chat|\b\dnd chat|\b\drd chat\b/);
  });
});
