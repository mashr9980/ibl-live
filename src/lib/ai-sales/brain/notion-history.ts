import 'server-only';

/**
 * Notion chat-history block, ported from the original Python implementation.
 *
 * Queries the Notion CRM by email, pulls each matched page's block tree, and
 * renders the `## Chat History` markdown that goes into the system prompt
 * after the lead block. Non-fatal end to end: any failure (unconfigured,
 * transport, parse) degrades to `''` — the prompt ships without history.
 *
 * Faithful to the original:
 *  - filter is Email-only (the `[test]` company filter was removed 2026-05-19
 *    so debug sessions see their own history).
 *  - the `## Transcript` section is recognized but NEVER rendered back into
 *    the prompt (prompt-injection mitigation) — only Summary + TODOs flow.
 *  - handles OLD (no chat-H1s) and NEW (per-`# Nth chat` H1) page formats.
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const QUERY_PAGE_SIZE = 25;
const CHILDREN_PAGE_SIZE = 100;
const CHILDREN_PAGE_CAP = 5; // hard cap of 500 blocks per page
const NOTION_TIMEOUT_MS = 10_000;

type NotionBlock = Record<string, unknown>;
type NotionPage = { id?: string; created_time?: string; properties?: Record<string, unknown> };

export type ChatRecord = {
  label: string;
  dateIso: string | null;
  summary: string;
  nextSteps: string[];
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function notionRequest(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  token: string,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
  try {
    const res = await fetch(`${NOTION_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        'User-Agent': 'live-avatar-api',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON — leave null
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function queryPagesByEmail(
  email: string,
  dbId: string,
  token: string,
): Promise<NotionPage[]> {
  const clean = email.trim().toLowerCase();
  const res = await notionRequest(
    'POST',
    `/databases/${dbId}/query`,
    {
      // Email is filtered as rich_text (mirrors the original + the proven
      // session-end query path), sorted newest-edited first.
      filter: { property: 'Email', rich_text: { equals: clean } },
      page_size: QUERY_PAGE_SIZE,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    },
    token,
  );
  if (!res.ok) throw new Error(`Notion query ${res.status}: ${res.text.slice(0, 200)}`);
  const body = res.json as { results?: NotionPage[] } | null;
  return body?.results ?? [];
}

async function fetchPageChildren(pageId: string, token: string): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CHILDREN_PAGE_CAP; page++) {
    const query = cursor
      ? `?page_size=${CHILDREN_PAGE_SIZE}&start_cursor=${encodeURIComponent(cursor)}`
      : `?page_size=${CHILDREN_PAGE_SIZE}`;
    const res = await notionRequest('GET', `/blocks/${pageId}/children${query}`, undefined, token);
    if (!res.ok) throw new Error(`Notion children ${res.status}: ${res.text.slice(0, 200)}`);
    const body = res.json as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    } | null;
    for (const b of body?.results ?? []) out.push(b);
    if (!body?.has_more) break;
    cursor = body?.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const SUMMARY_HEADINGS = new Set(['summary']);
const TODO_HEADINGS = new Set(['todo', 'todos', 'todo list']);
const TRANSCRIPT_HEADINGS = new Set(['transcript']);
const LEAD_INFO_HEADINGS = new Set(['lead info', 'lead information']);

function blockText(block: NotionBlock): string {
  const btype = block.type;
  if (typeof btype !== 'string') return '';
  const payload = block[btype];
  if (!payload || typeof payload !== 'object') return '';
  const rich = (payload as Record<string, unknown>).rich_text;
  if (!Array.isArray(rich)) return '';
  const parts: string[] = [];
  for (const item of rich) {
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>;
      if (typeof it.plain_text === 'string') {
        parts.push(it.plain_text);
      } else if (it.text && typeof it.text === 'object') {
        const content = (it.text as Record<string, unknown>).content;
        if (typeof content === 'string') parts.push(content);
      }
    }
  }
  return parts.join('').trim();
}

function normalizeHeading(text: string): string {
  return text.trim().toLowerCase().replace(/:+$/, '').trim();
}

function isLeadInfoH1(text: string): boolean {
  return LEAD_INFO_HEADINGS.has(normalizeHeading(text));
}

function isChatH1(text: string): boolean {
  return text.toLowerCase().includes('chat') && !isLeadInfoH1(text);
}

function parseLabelFromChatH1(text: string): [string, string | null] {
  const stripped = text.trim();
  const idx = stripped.indexOf(' - ');
  if (idx !== -1) {
    const left = stripped.slice(0, idx).trim();
    const right = stripped.slice(idx + 3).trim();
    return [left || 'Chat', right || null];
  }
  return [stripped || 'Chat', null];
}

function extractSingleChatFromH2Run(
  blocks: NotionBlock[],
  label: string,
  dateIso: string | null,
): ChatRecord {
  const summaryParts: string[] = [];
  const nextSteps: string[] = [];
  let currentSection: 'summary' | 'next_steps' | null = null;

  for (const block of blocks) {
    const btype = block.type;
    if (btype === 'heading_2') {
      const heading = normalizeHeading(blockText(block));
      if (SUMMARY_HEADINGS.has(heading)) currentSection = 'summary';
      else if (TODO_HEADINGS.has(heading)) currentSection = 'next_steps';
      // Transcript recognized only to section OFF — never rendered back into
      // the prompt (prompt-injection mitigation).
      else if (TRANSCRIPT_HEADINGS.has(heading)) currentSection = null;
      else currentSection = null;
    } else if (currentSection === 'summary' && btype === 'paragraph') {
      const text = blockText(block);
      if (text) summaryParts.push(text);
    } else if (currentSection === 'next_steps') {
      if (btype === 'bulleted_list_item') {
        const text = blockText(block);
        if (text) nextSteps.push(text);
      } else if (btype === 'paragraph') {
        // Some old pages store TODOs as newline-separated paragraphs.
        const text = blockText(block);
        if (text) {
          for (const line of text.split('\n')) {
            const cleaned = line
              .trim()
              .replace(/^[-•*\s]+/, '')
              .trim();
            if (cleaned) nextSteps.push(cleaned);
          }
        }
      }
    }
  }

  const summary = summaryParts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n\n');
  return { label, dateIso, summary, nextSteps };
}

export function extractChatFromNotionBlocks(
  blocks: NotionBlock[],
  pageCreatedTime: string | null,
): ChatRecord[] {
  if (blocks.length === 0) return [];

  const h1Positions: Array<[number, string]> = [];
  blocks.forEach((block, idx) => {
    if (block.type === 'heading_1') {
      const text = blockText(block);
      if (text) h1Positions.push([idx, text]);
    }
  });

  const chatH1s = h1Positions.filter(([, text]) => isChatH1(text));

  if (chatH1s.length === 0) {
    // OLD format — whole page is one chat.
    const record = extractSingleChatFromH2Run(blocks, 'Chat', pageCreatedTime);
    return record.summary || record.nextSteps.length > 0 ? [record] : [];
  }

  // NEW format — one record per chat-H1; window runs to the next H1 (any kind).
  const allH1Indices = [...new Set(h1Positions.map(([idx]) => idx))].sort((a, b) => a - b);
  const records: ChatRecord[] = [];
  for (const [chatH1Idx, chatH1Text] of chatH1s) {
    const nextH1 = allH1Indices.find((i) => i > chatH1Idx) ?? blocks.length;
    const window = blocks.slice(chatH1Idx + 1, nextH1);
    const [label, parsedDate] = parseLabelFromChatH1(chatH1Text);
    const record = extractSingleChatFromH2Run(window, label, parsedDate ?? pageCreatedTime);
    if (record.summary || record.nextSteps.length > 0) records.push(record);
  }
  return records;
}

function formatDateForDisplay(stored: string | null): string {
  if (!stored) return '';
  const trimmed = stored.trim();
  // ISO-looking (`YYYY-MM-DDT...` / `YYYY-MM-DD ...`) → trim to date.
  if (
    trimmed.length >= 11 &&
    trimmed[4] === '-' &&
    trimmed[7] === '-' &&
    (trimmed[10] === 'T' || trimmed[10] === ' ')
  ) {
    return trimmed.slice(0, 10);
  }
  return trimmed;
}

function ordinalOf(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 10 && mod100 <= 20) return `${n}th`;
  const suffix = ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

export function renderChatHistoryBlock(chatsByPage: ChatRecord[][]): string {
  // Pages arrive newest-query-first; reverse so oldest chat renders first.
  const allChats: ChatRecord[] = [];
  for (const pageChats of [...chatsByPage].reverse()) allChats.push(...pageChats);

  const kept = allChats.filter((c) => c.summary || c.nextSteps.length > 0);
  if (kept.length === 0) return '';

  const lines: string[] = ['## Chat History'];
  kept.forEach((chat, i) => {
    const ordinal = ordinalOf(i + 1);
    const dateStr = formatDateForDisplay(chat.dateIso);
    lines.push('');
    lines.push(dateStr ? `### ${ordinal} chat - ${dateStr}` : `### ${ordinal} chat`);
    if (chat.summary) {
      lines.push('Summary');
      lines.push(chat.summary);
    }
    if (chat.nextSteps.length > 0) {
      lines.push('Next steps');
      for (const step of chat.nextSteps) lines.push(`- ${step}`);
    }
  });
  return lines.join('\n');
}

function extractCreatedTime(page: NotionPage): string | null {
  return typeof page.created_time === 'string' ? page.created_time : null;
}

// ---------------------------------------------------------------------------
// Orchestration (port of service._fetch_chat_history)
// ---------------------------------------------------------------------------

/**
 * Fetch the visitor's prior Notion CRM records by email and render the
 * `## Chat History` block. Non-fatal — returns `''` on any failure or when
 * Notion isn't configured.
 */
export async function fetchChatHistoryBlock(email: string): Promise<string> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!token || !dbId) return '';

  let pages: NotionPage[];
  try {
    pages = await queryPagesByEmail(email, dbId, token);
  } catch (err) {
    console.warn('[ai-sales] chat_history query failed', err);
    return '';
  }
  if (pages.length === 0) return '';

  // Fetch children per page concurrently; a per-page failure degrades to [].
  const perPage = await Promise.all(
    pages.map(async (page): Promise<ChatRecord[]> => {
      const pageId = page.id;
      if (typeof pageId !== 'string' || !pageId) return [];
      try {
        const blocks = await fetchPageChildren(pageId, token);
        return extractChatFromNotionBlocks(blocks, extractCreatedTime(page));
      } catch (err) {
        console.warn('[ai-sales] chat_history fetch_page_children failed', pageId, err);
        return [];
      }
    }),
  );

  return renderChatHistoryBlock(perPage);
}
