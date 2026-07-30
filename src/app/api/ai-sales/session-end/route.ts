/**
 * Session-end pipeline for the `/ai-sales` page.
 *
 * Client posts the final transcript when the LiveKit session reaches
 * DISCONNECTED. We:
 *   1. Look up the lead again (by email) so Notion/Slack render with fresh
 *      survey data.
 *   2. Generate a markdown meeting summary via Claude.
 *   3. Write a Notion page into the "LA AI Sales CRM" DB (headings:
 *      Meeting summary, Survey response, Transcript).
 *   4. Post a Slack webhook notification with the summary + Notion link.
 *
 * Notion and Slack run in parallel after the summary is ready. Either one
 * failing doesn't block the other — partial success is logged and returned.
 * Always 200 OK; the client uses this as fire-and-forget.
 */
import type { NextRequest } from 'next/server';
import { fetchLead } from '@/lib/ai-sales/brain/lead-client';
import { loadPersona } from '@/lib/ai-sales/brain/persona';
import {
  formatTranscript,
  generateSummary,
  postSlackNotification,
  upsertNotionPage,
  type TranscriptTurn,
} from '@/lib/ai-sales/session-end';
import {
  clientIp,
  getSessionSigningSecret,
  makeRateLimiter,
  verifySessionSignature,
} from '@/lib/ai-sales/session-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // summary + Notion + Slack can take a few seconds

// Legitimate usage is one POST per session lifecycle. 5/min/IP leaves room for
// retries and tab refreshes while blocking trivial scripted abuse.
const allowSessionEndRequest = makeRateLimiter(5, 60_000);

type RequestBody = {
  session_id?: string;
  session_signature?: string;
  name?: string;
  email?: string;
  transcript?: TranscriptTurn[];
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  debug?: boolean;
};

export async function POST(req: NextRequest): Promise<Response> {
  if (!allowSessionEndRequest(clientIp(req))) {
    return Response.json({ error: 'rate limit' }, { status: 429 });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  // Verify the HMAC issued at /api/ai-sales/session mint time. Without a
  // valid signature, anyone could spam the Notion/Slack/Anthropic fan-out by
  // hitting the public marketing host. Fails closed if the signing secret
  // isn't configured.
  if (!getSessionSigningSecret()) {
    console.error('[ai-sales] AI_SALES_SESSION_SIGNING_SECRET is not configured');
    return Response.json({ error: 'session-end unavailable' }, { status: 500 });
  }
  const sessionId = (body.session_id ?? '').trim();
  const signature = (body.session_signature ?? '').trim();
  if (!sessionId || !signature || !verifySessionSignature(sessionId, signature)) {
    return Response.json({ error: 'invalid session signature' }, { status: 401 });
  }

  const email = (body.email ?? '').trim().toLowerCase();
  const firstName = (body.name ?? '').trim();
  const turns = Array.isArray(body.transcript) ? body.transcript : [];
  const startedAt = body.started_at ?? new Date().toISOString();
  const endedAt = body.ended_at ?? new Date().toISOString();
  const durationMs = body.duration_ms ?? 0;
  const debug = body.debug === true;

  // No email = we can't look up or attribute — still record a Slack ping so
  // the team sees cold sessions, but skip Notion (no title source).
  //
  // Lead comes from the resolver. The persona for the digest's
  // Qualified/Disqualified verdict comes from the SAME local prompt parts the
  // conversational brain uses (loadPersona()), so both apply one source of
  // qualification guidance.
  const lead = email ? await fetchLead(email).catch(() => null) : null;
  let personaPrompt: string | null = null;
  try {
    personaPrompt = loadPersona();
  } catch (err) {
    console.warn('[ai-sales] persona load failed for digest — using baseline judgment', err);
  }
  const transcript = formatTranscript(turns);

  let digest;
  try {
    digest = await generateSummary(transcript, lead, email || null, personaPrompt);
  } catch (err) {
    console.error('[ai-sales] summary generation failed', err);
    digest = {
      tldr: 'Session ended — summary generation failed.',
      summary: `(summary generation failed — transcript attached)\n\n${transcript}`,
      todos: [],
      leadQuality: 'Unknown' as const,
    };
  }

  // Notion first so the URL + chatCount are present in the Slack message.
  // upsertNotionPage does find-by-email -> update OR create, and returns
  // chatCount so the Slack title
  // can include the `Nth chat` suffix.
  const notionResult: { url: string | null; error: string | null; chatCount: number } = email
    ? await upsertNotionPage({
        lead,
        email,
        firstName,
        digest,
        transcript,
        durationMs,
        startedAt,
        endedAt,
        debug,
      }).catch((err: unknown) => ({
        url: null,
        error: `Notion threw: ${err instanceof Error ? err.message : String(err)}`,
        chatCount: 0,
      }))
    : { url: null, error: 'no email — Notion skipped', chatCount: 0 };

  const notionUrl = notionResult.url;
  const notionError = notionResult.error;
  const chatCount = notionResult.chatCount;

  const slack = await postSlackNotification({
    lead,
    email: email || 'anonymous@unknown',
    firstName,
    tldr: digest.tldr,
    todos: digest.todos,
    leadQuality: digest.leadQuality,
    notionUrl,
    durationMs,
    debug,
    chatCount,
  });

  if (notionError) console.warn('[ai-sales] Notion write failed:', notionError);
  if (!slack.ok) console.warn('[ai-sales] Slack post failed:', slack.error);

  return Response.json({
    ok: true,
    notion_url: notionUrl,
    notion_error: notionError,
    chat_count: chatCount,
    slack_ok: slack.ok,
    slack_error: slack.error,
    tldr: digest.tldr,
    todos: digest.todos,
    lead_quality: digest.leadQuality,
  });
}
