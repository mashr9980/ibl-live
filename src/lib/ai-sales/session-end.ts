import 'server-only';
import { iblaiConfig } from './brain/iblai';
import { completionText } from './brain/streaming';
import type { LeadProfile } from './lead';
import { agentIdentity } from './brain/agent-identity';

// Max chars we'll hand to the summarizer. Typical Wayne sessions run <5 min,
// so ~200 turns at ~80 chars is plenty — we cap defensively.
const TRANSCRIPT_CHAR_BUDGET = 18_000;

export type TranscriptTurn = {
  sender: 'user' | 'avatar';
  message: string;
  timestamp: number;
};

export function formatTranscript(turns: TranscriptTurn[]): string {
  if (turns.length === 0) return '(no dialogue captured)';
  const lines: string[] = [];
  let used = 0;
  for (const turn of turns) {
    const who = turn.sender === 'user' ? 'Visitor' : agentIdentity().name;
    const text = turn.message.trim();
    if (!text) continue;
    const line = `${who}: ${text}`;
    if (used + line.length > TRANSCRIPT_CHAR_BUDGET) {
      lines.push('…(truncated)');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export type LeadQuality = 'Qualified' | 'Disqualified' | 'Unknown';

const LEAD_QUALITY_VALUES: readonly LeadQuality[] = ['Qualified', 'Disqualified', 'Unknown'];

function coerceLeadQuality(value: unknown): LeadQuality {
  if (typeof value !== 'string') return 'Unknown';
  const trimmed = value.trim();
  // Accept lowercase / verbose forms ("qualified ✓", "Disqualified — self-serve fit")
  // by matching enough of the leading word to disambiguate without silently
  // dropping near-misses. Use the 4-character prefix `disq` / `qual` rather
  // than just `dis` / `q` so unrelated words ("discovery", "discussion",
  // "questionable") can't false-positive into a Notion verdict. Order matters:
  // "Disqualified" starts with 'd', not 'q', so a leading-'q' branch wouldn't
  // catch it.
  if (/^disq/i.test(trimmed)) return 'Disqualified';
  if (/^qual/i.test(trimmed)) return 'Qualified';
  if (LEAD_QUALITY_VALUES.includes(trimmed as LeadQuality)) return trimmed as LeadQuality;
  return 'Unknown';
}

export type SessionDigest = {
  tldr: string;
  summary: string;
  todos: string[];
  leadQuality: LeadQuality;
};

const FALLBACK_DIGEST: SessionDigest = {
  tldr: 'Session ended — summary unavailable.',
  summary: '(summary unavailable)',
  todos: [],
  leadQuality: 'Unknown',
};

function buildLeadBlock(lead: LeadProfile | null, fallbackEmail: string | null): string {
  if (!lead) {
    return fallbackEmail
      ? `Known lead: none (cold visitor — only email collected: ${fallbackEmail}).`
      : 'Known lead: none (cold visitor).';
  }
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || '(no name)';
  const useCase = lead.use_case_description || lead.use_case_type;
  const lines = [
    `Name: ${name}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company ?? '(unknown)'}`,
    `Country: ${lead.country ?? '(unknown)'}`,
    `Job title: ${lead.job_title ?? '(unknown)'}`,
    `Use case: ${useCase ?? '(unknown)'}`,
    `Has dev team: ${formatTriBool(lead.has_dev_team)}`,
    `Budget qualified: ${formatTriBool(lead.budget_qualified)}`,
    `In-house or client work: ${lead.in_house_or_client ?? '(unknown)'}`,
    `Existing LiveAvatar user: ${lead.is_liveavatar_user ? 'yes' : 'no'}${
      lead.liveavatar_plan_type ? ` (${lead.liveavatar_plan_type})` : ''
    }`,
  ];
  return `Known lead:\n${lines.map((l) => `  - ${l}`).join('\n')}`;
}

function formatTriBool(v: boolean | null): string {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return '(unknown)';
}

function extractFirstJsonObject(text: string): string | null {
  // Robust against the model wrapping output in ```json fences or prose.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence && fence[1]) return fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export async function generateSummary(
  transcript: string,
  lead: LeadProfile | null,
  fallbackEmail: string | null,
  // The same assembled system prompt the conversational LLM loaded for this
  // session (loadPersona() over prompt-parts/*.md). Injected so the digest LLM
  // applies the prompt's lead-qualification guidance verbatim — single source of
  // truth, no duplicated criteria here. `null` when the prompt failed to
  // assemble; the digest falls back to a brief baseline so we never block the
  // summary on it.
  personaPrompt: string | null,
): Promise<SessionDigest> {
  const config = iblaiConfig();
  if (!config) {
    return { ...FALLBACK_DIGEST, tldr: 'IBLAI_API_KEY / IBLAI_ORG not configured.' };
  }
  if (!transcript || transcript === '(no dialogue captured)') {
    return {
      tldr: 'Session ended without dialogue captured.',
      summary: 'No dialogue was captured for this session.',
      todos: [],
      leadQuality: 'Unknown',
    };
  }

  const leadBlock = buildLeadBlock(lead, fallbackEmail);

  // Pair the qualification guidance with a matching lead_quality schema
  // instruction so they always agree about which source-of-truth the LLM
  // should apply. Earlier version inconsistently told the LLM to "apply the
  // criteria from the sales agent prompt above" even on the null-prompt
  // fallback path where no such prompt was inlined.
  const qualificationGuidance = personaPrompt
    ? `The agent's full sales prompt is below — the same one its conversational LLM loaded for this session. Use its lead-qualification guidance (enterprise vs self-serve fit — business email, real company, a dev team, serious budget, and a clear timeline all point to a qualified enterprise lead) as the authoritative basis for your verdict.

<sales_agent_prompt>
${personaPrompt}
</sales_agent_prompt>`
    : `(Sales-agent prompt was unavailable for this request — applying baseline judgment.) Qualified = real enterprise lead (business email, real company, dev team, serious budget, clear timeline). Disqualified = better fit for self-serve. Unknown only when transcript is too thin to judge.`;

  const leadQualityInstruction = personaPrompt
    ? 'Qualified | Disqualified | Unknown — apply the lead-qualification guidance from the sales agent prompt above (a qualified lead meets the enterprise-fit signals it describes). Use Unknown only when the transcript is too thin to judge.'
    : 'Qualified | Disqualified | Unknown — apply the baseline judgment criteria above. Use Unknown only when the transcript is too thin to judge.';

  const identity = agentIdentity();
  const system = `You are a concise assistant. A visitor just finished a conversation with ${identity.name}, ${identity.product}'s live AI guide. Produce a structured handoff for the human sales team.

${qualificationGuidance}

Respond with ONLY a single JSON object — no prose before or after, no markdown fences. Schema:

{
  "tldr": "one short sentence (under 200 chars) suitable for a Slack notification — name + company if known + the most signal-rich detail",
  "summary": "markdown body for the Notion page. Use these sections (skip any you have no evidence for): **Who**, **What they wanted**, **Key questions asked**, **Signals** (budget/timeline/buying-stage), **Recommended next step**",
  "todos": ["concrete next actions for the human team — each a single short imperative sentence (1–5 items max). Examples: 'Send pricing for 50-seat enterprise tier', 'Schedule technical deep-dive with their CTO'. Empty array if no follow-ups warranted."],
  "lead_quality": "${leadQualityInstruction}"
}

Be specific — cite what the visitor actually said. Don't hallucinate budgets or commitments not in the transcript. When the qualification signals are ambiguous, default to Disqualified and mention the missing signal in the summary so the sales team can probe on follow-up.`;

  const raw = (
    await completionText({
      config,
      systemPrompt: system,
      messages: [{ role: 'user', content: `${leadBlock}\n\nTranscript:\n${transcript}` }],
      modelLabel: 'ibl-guide-summary',
      maxTokens: 1000,
      temperature: null,
    })
  ).trim();

  const json = extractFirstJsonObject(raw);
  if (!json) {
    console.warn('[ai-sales] summary JSON parse: no object in model output');
    return { tldr: 'Session ended.', summary: raw || '(empty)', todos: [], leadQuality: 'Unknown' };
  }
  try {
    const parsed = JSON.parse(json) as Partial<SessionDigest> & { lead_quality?: unknown };
    return {
      tldr:
        typeof parsed.tldr === 'string' && parsed.tldr.trim()
          ? parsed.tldr.trim()
          : 'Session ended.',
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim()
          ? parsed.summary.trim()
          : raw || '(empty)',
      todos: Array.isArray(parsed.todos)
        ? parsed.todos.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : [],
      leadQuality: coerceLeadQuality(parsed.lead_quality),
    };
  } catch (err) {
    console.warn('[ai-sales] summary JSON parse failed', err);
    return { tldr: 'Session ended.', summary: raw, todos: [], leadQuality: 'Unknown' };
  }
}

type NotionBlock = Record<string, unknown>;

function heading1(
  text: string,
  { toggleable = false }: { toggleable?: boolean } = {},
): NotionBlock {
  // Default: plain (non-toggleable) H1. We append Summary/TODO/Transcript
  // blocks as page-level SIBLINGS of the H1 (not as children of it), so the
  // H1 itself has no children — Notion accepts non-toggleable H1 blocks
  // without any children field. Earlier code set `is_toggleable: true` on
  // every H1, leaving an empty chevron widget in the Notion UI because the
  // content was never actually nested inside the toggle (verified live with
  // Wayne's 2026-05-19 vhduran test pages: H1 reported `has_children: false`
  // despite `is_toggleable: true`). Plain H1 renders the header with content
  // visible below.
  //
  // `toggleable: true` is reserved for the OLD-format → NEW-format
  // restructure path in updateExistingPage, where we wrap a legacy page's
  // existing top-level blocks under a synthetic `1st chat - <date>` H1 by
  // appending them as TRUE CHILDREN of the H1 (Notion's API requires
  // `is_toggleable: true` for that to work — HTTP 400 "Block does not
  // support children" otherwise).
  return {
    object: 'block',
    type: 'heading_1',
    heading_1: {
      rich_text: [{ type: 'text', text: { content: text } }],
      is_toggleable: toggleable,
    },
  };
}

function heading2(text: string): NotionBlock {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: {
      rich_text: [{ type: 'text', text: { content: text } }],
    },
  };
}

function paragraph(text: string): NotionBlock {
  // Notion rich_text items cap at 2000 chars — split defensively.
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 1900));
    remaining = remaining.slice(1900);
  }
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: chunks.map((c) => ({ type: 'text', text: { content: c } })),
    },
  };
}

function splitIntoParagraphs(text: string): NotionBlock[] {
  const parts = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  if (parts.length === 0) return [paragraph('(empty)')];
  return parts.map(paragraph);
}

function bulletedListItem(text: string): NotionBlock {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, 1900));
    remaining = remaining.slice(1900);
  }
  return {
    object: 'block',
    type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: chunks.map((c) => ({ type: 'text', text: { content: c } })),
    },
  };
}

function formatTodosBlock(todos: string[]): NotionBlock[] {
  if (todos.length === 0) return [paragraph('(no follow-ups identified)')];
  return todos.map(bulletedListItem);
}

function paragraphWithBoldLabel(label: string, body: string): NotionBlock {
  // Notion rich_text items cap at 2000 chars — split the body defensively.
  const truncated = body.length > 1900 ? body.slice(0, 1897) + '…' : body;
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: `${label}: ` },
          annotations: { bold: true },
        },
        { type: 'text', text: { content: truncated } },
      ],
    },
  };
}

function formatLeadInfoBlock(lead: LeadProfile | null): NotionBlock[] {
  if (!lead || lead.survey_fields.length === 0) {
    return [paragraph('(no survey response on file — cold visitor)')];
  }
  return lead.survey_fields.map((f) =>
    paragraphWithBoldLabel(f.question.trim() || '(question)', f.answer.trim() || '(blank)'),
  );
}

// =============================================================================
// Notion upsert
// =============================================================================
//
// Find-by-email -> update existing record OR create new page in NEW format.
// New format:
//
//   # Lead info        (survey answers as paragraphs)
//   # 1st chat - DATE  (Summary / TODO / Transcript H2 children)
//   # 2nd chat - DATE  (...)
//
// On a returning lead's first 2nd-chat, OLD-format pages (no `# Lead info` H1;
// just top-level `## Summary` / `## TODOs` / `## Transcript` H2s) are
// restructured losslessly under an append-then-delete ordering: append-only
// steps (1-5) first, then deletes (step 6) last. Partial failure in steps 1-5
// leaves orphan duplicates that the next session's detect-then-defer guard
// tolerates without re-attempting the restructure.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
// Notion's append-children API caps each request at 100 blocks.
const NOTION_CHILDREN_CAP = 100;

type NotionPage = {
  id: string;
  url?: string;
  created_time?: string;
  properties?: Record<string, unknown>;
};

async function notionRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  token: string,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // leave parsed null on non-JSON responses
  }
  return { ok: res.ok, status: res.status, body: parsed, text };
}

async function queryPagesByEmail(
  email: string,
  databaseId: string,
  token: string,
  debug = false,
): Promise<{ pages: NotionPage[]; error: string | null }> {
  // Isolate prod from debug:
  // - Prod sessions (debug=false) ONLY find non-[test] pages → update real
  //   customer rows, never mutate a debug-test page.
  // - Debug sessions (debug=true) ONLY find [test]-prefixed pages → update
  //   prior debug runs for the same lead, never mutate a real customer row.
  // The two filters are mirror images on the same Company column. Prior code
  // only had the non-[test] branch, so debug sessions found nothing and
  // always fell through to createNewPage — producing one fresh [test] page
  // per debug session instead of accumulating Nth chat sub-sections on a
  // single page (Wayne's 2026-05-19 vhduran + adhinan repro).
  const companyClause = debug
    ? { property: 'Company', rich_text: { contains: '[test]' } }
    : { property: 'Company', rich_text: { does_not_contain: '[test]' } };
  const baseFilter = {
    and: [{ property: 'Email', rich_text: { equals: email.trim().toLowerCase() } }, companyClause],
  };
  const tryQuery = async (sorts: Array<Record<string, string>>) =>
    notionRequest(
      'POST',
      `/databases/${databaseId}/query`,
      { filter: baseFilter, sorts, page_size: 25 },
      token,
    );
  // Sort by Notion's built-in last_edited_time system timestamp — Wayne's
  // "Last edited time" column auto-populates on every page edit (including our
  // PATCH calls), so "latest call" = "most recently edited page" matches the
  // spec's "pick the latest by Meeting time" intent. The previous
  // "Meeting time" property column was replaced with the last_edited_time
  // system column on 2026-05-19.
  const res = await tryQuery([{ timestamp: 'last_edited_time', direction: 'descending' }]);
  if (!res.ok) {
    return { pages: [], error: `Notion query ${res.status}: ${res.text.slice(0, 300)}` };
  }
  const body = res.body as { results?: NotionPage[] } | null;
  return { pages: body?.results ?? [], error: null };
}

function buildLeadInfoChildren(lead: LeadProfile | null): NotionBlock[] {
  return [heading1('Lead info'), ...formatLeadInfoBlock(lead)];
}

function buildChatChildren(digest: SessionDigest, transcript: string): NotionBlock[] {
  return [
    heading2('Summary'),
    ...splitIntoParagraphs(digest.summary),
    heading2('TODO'),
    ...formatTodosBlock(digest.todos),
    heading2('Transcript'),
    ...splitIntoParagraphs(transcript),
  ];
}

function buildPropertiesPatch(params: {
  email: string;
  lead: LeadProfile | null;
  firstName: string;
  digest: SessionDigest;
  endedAt: string;
  chatCount: number;
  debug?: boolean;
}): Record<string, unknown> {
  const { email, lead, firstName, digest, endedAt, chatCount, debug } = params;
  const personName =
    [lead?.first_name ?? firstName, lead?.last_name].filter(Boolean).join(' ') ||
    firstName ||
    email ||
    'Unknown visitor';
  const titlePrefix = debug ? '[test] ' : '';
  const companyTitle = `${titlePrefix}${lead?.company || personName}`;
  const contactName = `${titlePrefix}${personName}`;
  const properties: Record<string, unknown> = {
    Company: { title: [{ type: 'text', text: { content: companyTitle } }] },
    Contact: { rich_text: [{ type: 'text', text: { content: contactName } }] },
    'Lead quality': { select: { name: digest.leadQuality } },
    'Chat count': { number: chatCount },
  };
  if (email) {
    properties.Email = { email };
  }
  if (lead?.job_title) {
    properties['Job title'] = { rich_text: [{ type: 'text', text: { content: lead.job_title } }] };
  }
  if (lead?.country) {
    properties.Country = { select: { name: lead.country } };
  }
  const useCase = lead?.use_case_description ?? lead?.use_case_type;
  if (useCase) {
    properties['Use case'] = {
      rich_text: [{ type: 'text', text: { content: useCase.slice(0, 1900) } }],
    };
  }
  // No write to Meeting time — Wayne replaced the writable column with a
  // Notion-managed Last edited time system column on 2026-05-19 that auto-
  // populates on every PATCH below; the spec's "latest call timestamp"
  // semantic is preserved without an explicit write from us.
  void endedAt;
  return properties;
}

function getBlockText(block: NotionBlock): string {
  const type = block.type as string | undefined;
  if (!type) return '';
  const payload = block[type] as
    { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> } | undefined;
  if (!payload?.rich_text) return '';
  return payload.rich_text
    .map((rt) => rt.plain_text ?? rt.text?.content ?? '')
    .join('')
    .trim();
}

function isLeadInfoH1(block: NotionBlock): boolean {
  return block.type === 'heading_1' && /^lead info$/i.test(getBlockText(block));
}

function isChatH1(block: NotionBlock): boolean {
  return block.type === 'heading_1' && /chat/i.test(getBlockText(block));
}

function recreateBlock(orig: NotionBlock): NotionBlock | null {
  const type = orig.type as string | undefined;
  if (!type) return null;
  const SUPPORTED = new Set([
    'paragraph',
    'heading_1',
    'heading_2',
    'heading_3',
    'bulleted_list_item',
    'numbered_list_item',
    'to_do',
    'quote',
    'callout',
    'code',
    'divider',
  ]);
  if (!SUPPORTED.has(type)) return null;
  const payload = orig[type];
  if (payload === undefined) return null;
  const cleaned: Record<string, unknown> = {};
  if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'children' || k === 'id') continue;
      cleaned[k] = v;
    }
  }
  return { object: 'block', type, [type]: cleaned };
}

async function appendChildren(
  parentBlockId: string,
  blocks: NotionBlock[],
  token: string,
): Promise<{ ids: string[]; error: string | null }> {
  const allIds: string[] = [];
  for (let i = 0; i < blocks.length; i += NOTION_CHILDREN_CAP) {
    const batch = blocks.slice(i, i + NOTION_CHILDREN_CAP);
    const res = await notionRequest(
      'PATCH',
      `/blocks/${parentBlockId}/children`,
      { children: batch },
      token,
    );
    if (!res.ok) {
      return { ids: allIds, error: `Notion append ${res.status}: ${res.text.slice(0, 300)}` };
    }
    const body = res.body as { results?: Array<{ id?: string }> } | null;
    for (const b of body?.results ?? []) {
      if (b?.id) allIds.push(b.id);
    }
  }
  return { ids: allIds, error: null };
}

async function createNewPage(params: {
  databaseId: string;
  token: string;
  lead: LeadProfile | null;
  email: string;
  firstName: string;
  digest: SessionDigest;
  transcript: string;
  endedAt: string;
  debug?: boolean;
}): Promise<{ url: string | null; error: string | null; chatCount: number }> {
  const { databaseId, token, lead, email, firstName, digest, transcript, endedAt, debug } = params;
  const chatCount = 1;
  const properties = buildPropertiesPatch({
    email,
    lead,
    firstName,
    digest,
    endedAt,
    chatCount,
    debug,
  });
  const chatHeadingDate = formatChatHeadingTimestamp(endedAt);
  const children: NotionBlock[] = [
    ...buildLeadInfoChildren(lead),
    heading1(`1st chat - ${chatHeadingDate}`),
    ...buildChatChildren(digest, transcript),
  ];
  const safeChildren = children.slice(0, NOTION_CHILDREN_CAP);
  const res = await notionRequest(
    'POST',
    '/pages',
    { parent: { database_id: databaseId }, properties, children: safeChildren },
    token,
  );
  if (!res.ok) {
    return { url: null, error: `Notion ${res.status}: ${res.text.slice(0, 400)}`, chatCount };
  }
  const body = res.body as { url?: string; id?: string } | null;
  return { url: body?.url ?? null, error: null, chatCount };
}

async function updateExistingPage(params: {
  page: NotionPage;
  token: string;
  lead: LeadProfile | null;
  email: string;
  firstName: string;
  digest: SessionDigest;
  transcript: string;
  endedAt: string;
  debug?: boolean;
}): Promise<{ url: string | null; error: string | null; chatCount: number }> {
  const { page, token, lead, email, firstName, digest, transcript, endedAt, debug } = params;
  const pageId = page.id;
  // CR-2 fix: paginate when the page has > 100 children. Notion's API caps
  // each response at 100; long-lived pages (50+ chats with multi-block
  // transcripts) can have hundreds of top-level children. Without
  // pagination, both `existingChatH1Count` and `originals` are derived
  // from a partial result — chat counts drift, and OLD-format restructure
  // misses originals that aren't deleted. Cap at 10 pages (1000 blocks)
  // for safety against runaway loops on pathological pages.
  const originals: NotionBlock[] = [];
  let cursor: string | undefined;
  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const path = cursor
      ? `/blocks/${pageId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : `/blocks/${pageId}/children?page_size=100`;
    const childrenRes = await notionRequest('GET', path, undefined, token);
    if (!childrenRes.ok) {
      return {
        url: page.url ?? null,
        error: `Notion fetch_children ${childrenRes.status}: ${childrenRes.text.slice(0, 300)}`,
        chatCount: 0,
      };
    }
    const childrenBody = childrenRes.body as {
      results?: NotionBlock[];
      has_more?: boolean;
      next_cursor?: string | null;
    } | null;
    for (const child of childrenBody?.results ?? []) {
      originals.push(child);
    }
    if (!childrenBody?.has_more) break;
    cursor = childrenBody?.next_cursor ?? undefined;
    if (!cursor) break;
  }

  const leadInfoH1Count = originals.filter(isLeadInfoH1).length;
  const existingChatH1Count = originals.filter(isChatH1).length;

  if (leadInfoH1Count >= 2) {
    console.warn(
      '[ai-sales] notion_upsert.broken_state page_id=%s lead_info_h1_count=%d - skipping restructure, appending Nth chat only',
      pageId,
      leadInfoH1Count,
    );
  }

  const isOldFormat = leadInfoH1Count === 0;
  const chatHeadingDate = formatChatHeadingTimestamp(endedAt);
  const newChatCount = isOldFormat ? 2 : existingChatH1Count + 1;
  const chatLabel = `${ordinalOf(newChatCount)} chat - ${chatHeadingDate}`;

  if (isOldFormat) {
    const leadInfoBlocks = buildLeadInfoChildren(lead);
    const leadInfoAppend = await appendChildren(pageId, leadInfoBlocks, token);
    if (leadInfoAppend.error) {
      return { url: page.url ?? null, error: leadInfoAppend.error, chatCount: newChatCount };
    }
    const origCreated = page.created_time
      ? formatChatHeadingTimestamp(page.created_time)
      : chatHeadingDate;
    const firstChatAppend = await appendChildren(
      pageId,
      // This H1 is special: legacy top-level blocks get re-parented UNDER
      // it as TRUE CHILDREN (see the `appendChildren(firstChatH1Id, ...)`
      // call below). Notion requires `is_toggleable: true` to support
      // children on H1. Everywhere else, H1s use the default plain (non-
      // toggleable) form.
      [heading1(`1st chat - ${origCreated}`, { toggleable: true })],
      token,
    );
    if (firstChatAppend.error || firstChatAppend.ids.length === 0) {
      return {
        url: page.url ?? null,
        error: firstChatAppend.error ?? 'Notion append returned no first-chat H1 id',
        chatCount: newChatCount,
      };
    }
    const firstChatH1Id = firstChatAppend.ids[0];
    const recreated: NotionBlock[] = [];
    for (const orig of originals) {
      const r = recreateBlock(orig);
      if (r) recreated.push(r);
    }
    if (recreated.length > 0 && firstChatH1Id) {
      const recreateAppend = await appendChildren(firstChatH1Id, recreated, token);
      if (recreateAppend.error) {
        return {
          url: page.url ?? null,
          error: recreateAppend.error,
          chatCount: newChatCount,
        };
      }
    }
  }

  const newChatBlocks: NotionBlock[] = [
    heading1(chatLabel),
    ...buildChatChildren(digest, transcript),
  ];
  const newChatAppend = await appendChildren(pageId, newChatBlocks, token);
  if (newChatAppend.error) {
    return { url: page.url ?? null, error: newChatAppend.error, chatCount: newChatCount };
  }

  if (isOldFormat) {
    for (const orig of originals) {
      const origId = orig.id as string | undefined;
      if (!origId) continue;
      const del = await notionRequest('DELETE', `/blocks/${origId}`, undefined, token);
      if (!del.ok) {
        console.warn(
          '[ai-sales] Notion delete original block failed page=%s block=%s status=%d',
          pageId,
          origId,
          del.status,
        );
      }
    }
  }

  const properties = buildPropertiesPatch({
    email,
    lead,
    firstName,
    digest,
    endedAt,
    chatCount: newChatCount,
    debug,
  });
  const propsRes = await notionRequest('PATCH', `/pages/${pageId}`, { properties }, token);
  if (!propsRes.ok) {
    return {
      url: page.url ?? null,
      error: `Notion properties patch ${propsRes.status}: ${propsRes.text.slice(0, 300)}`,
      chatCount: newChatCount,
    };
  }

  return { url: page.url ?? null, error: null, chatCount: newChatCount };
}

/**
 * Format an ISO timestamp as `MM-DD-YYYY HH:MM in PST` — the per-call
 * heading shape Wayne specified on 2026-05-19. Uses Intl with
 * `America/Los_Angeles` to handle PST/PDT automatically; renders both as
 * "PST" for human-readable consistency (LLM prompt format, not a
 * machine-parsed timestamp).
 *
 * Falls back to the bare YYYY-MM-DD prefix when the input isn't a parseable
 * ISO string (defensive — `endedAt` should always be ISO, but legacy code
 * paths might pass a date-only string).
 */
function formatChatHeadingTimestamp(isoOrDate: string): string {
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) {
    // Best-effort fallback — strip to date prefix to keep the heading parseable.
    return isoOrDate.slice(0, 10);
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month');
  const day = get('day');
  const year = get('year');
  const hour = get('hour');
  const minute = get('minute');
  return `${month}-${day}-${year} ${hour}:${minute} in PST`;
}

function ordinalOf(n: number): string {
  if (n >= 11 && n <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

export async function upsertNotionPage(params: {
  lead: LeadProfile | null;
  email: string;
  firstName: string;
  digest: SessionDigest;
  transcript: string;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  debug?: boolean;
}): Promise<{ url: string | null; error: string | null; chatCount: number }> {
  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!token || !databaseId) {
    return {
      url: null,
      error: 'NOTION_TOKEN or NOTION_DATABASE_ID not configured',
      chatCount: 0,
    };
  }

  const { lead, email, firstName, digest, transcript, endedAt, debug } = params;
  const isDebug = debug === true;

  // Both prod AND debug sessions now go through find-or-create. The
  // queryPagesByEmail filter is mirrored on the Company column ([test]-only
  // for debug, non-[test] for prod) so the two flows are isolated and can't
  // mutate each other's pages. Wayne's 2026-05-19 feedback: debug sessions
  // were always creating new pages because the prior debug branch
  // short-circuited to createNewPage without ever querying — fixed here.
  try {
    const query = await queryPagesByEmail(email, databaseId, token, isDebug);
    if (query.error) {
      return { url: null, error: query.error, chatCount: 0 };
    }
    const latest = query.pages.length > 0 ? query.pages[0] : null;
    if (!latest) {
      return await createNewPage({
        databaseId,
        token,
        lead,
        email,
        firstName,
        digest,
        transcript,
        endedAt,
        debug: isDebug,
      });
    }
    return await updateExistingPage({
      page: latest,
      token,
      lead,
      email,
      firstName,
      digest,
      transcript,
      endedAt,
      debug: isDebug,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    return { url: null, error: `Notion fetch failed: ${message}`, chatCount: 0 };
  }
}

// BC alias - older callers may still import the legacy name. New code should
// use upsertNotionPage which returns the additional chatCount field.
export const writeNotionPage = upsertNotionPage;

export async function postSlackNotification(params: {
  lead: LeadProfile | null;
  email: string;
  firstName: string;
  tldr: string;
  todos: string[];
  leadQuality: LeadQuality;
  notionUrl: string | null;
  durationMs: number;
  debug?: boolean;
  // chatCount: total chats for this lead AFTER the upsert (1 for a new lead,
  // 2+ for a returning lead). When > 0, the header includes a `· *Nth chat*`
  // suffix. When 0 (e.g., Notion upsert failed
  // upstream and we still want a Slack ping), the suffix is omitted.
  chatCount?: number;
}): Promise<{ ok: boolean; error: string | null }> {
  // Each Slack incoming-webhook URL is bound to one channel at creation time,
  // so the destination channel is determined by which URL is configured here,
  // not by anything the payload says — the operator picks the destination when
  // creating the webhook.
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    return { ok: false, error: 'SLACK_WEBHOOK_URL not configured' };
  }

  const {
    lead,
    email,
    firstName,
    tldr,
    todos,
    leadQuality,
    notionUrl,
    durationMs,
    debug,
    chatCount,
  } = params;
  const durationMin = Math.max(1, Math.round(durationMs / 60_000));
  const displayName =
    [lead?.first_name ?? firstName, lead?.last_name].filter(Boolean).join(' ') || email;
  const company = lead?.company ? ` from *${lead.company}*` : '';
  const liveavatarUser = lead?.is_liveavatar_user
    ? ` — existing LiveAvatar user${lead.liveavatar_plan_type ? ` (${lead.liveavatar_plan_type})` : ''}`
    : '';
  const testPrefix = debug ? '[test] ' : '';
  // Chat count suffix. `· *1st chat*` for a new lead's
  // first session, `· *2nd chat*` for the second, etc. Omitted when
  // chatCount is missing or zero (Notion upsert never ran).
  const chatSuffix = chatCount && chatCount > 0 ? ` · *${ordinalOf(chatCount)} chat*` : '';

  const header = `:wave: *${testPrefix}New sales agent session* — ${displayName}${company} (${email})${liveavatarUser} · _${durationMin} min_${chatSuffix}`;
  const qualityLine = `\n*Lead Quality:* ${leadQuality}`;
  const todosLine = todos.length > 0 ? `\n*TODOs:*\n${todos.map((t) => `• ${t}`).join('\n')}` : '';
  const link = notionUrl ? `\n<${notionUrl}|:notion: Open full notes in Notion>` : '';
  const body = `${tldr}${qualityLine}${todosLine}${link}`;

  const payload = {
    text: `${testPrefix}New sales agent session — ${displayName} (${email})`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: header } },
      { type: 'section', text: { type: 'mrkdwn', text: body } },
    ],
  };

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Slack ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    return { ok: false, error: `Slack fetch failed: ${message}` };
  }
}
