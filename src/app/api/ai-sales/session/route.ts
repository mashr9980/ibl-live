/**
 * Session token mint for the `/ai-sales` page.
 *
 * Mints via the public LiveAvatar API: `POST /v1/sessions/token` with an
 * `X-API-KEY` header, in FULL mode — we hand it the avatar, the session cap,
 * and, optionally, the `llm_configuration_id` that points the session's brain
 * at this app's own `/api/chat/completions`.
 *
 * The browser posts { name, email }. We then:
 *   1. Resolve a LeadProfile via the configured lead resolver (by email).
 *   2. Build a context-aware opening line (greets by name/company/use case
 *      when we have them, falls back to a referer-tailored default otherwise).
 *   3. Forward name + opening as `dynamic_variables` — the LiveKit agent
 *      substitutes `${opening_intro}` / `${username}` into the context's
 *      opening text and prompt at dispatch time.
 */
import type { NextRequest } from 'next/server';
import { buildOpeningIntro, pickOpening } from '@/lib/ai-sales/opening';
import { resolveLead, type LeadProfile } from '@/lib/ai-sales/lead';
import { signSessionId } from '@/lib/ai-sales/session-auth';
import {
  BUSY_MESSAGE,
  buildDynamicVariables,
  DEFAULT_API_BASE,
  DEFAULT_LANGUAGE,
  DEFAULT_MAX_SESSION_DURATION,
  isBusyUpstream,
} from '@/lib/ai-sales/session-mint';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PublicTokenResponse = {
  code: number;
  message: string;
  data: {
    session_id: string;
    session_token: string;
  };
};

type RequestBody = {
  name?: string;
  email?: string;
};

function env(name: string): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  throw new Error(`Missing required env var: ${name}`);
}

function optionalEnv(name: string): string | null {
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function POST(req: NextRequest): Promise<Response> {
  let apiBase: string;
  let avatarId: string;
  let apiKey: string;
  let llmConfigurationId: string | null = null;
  let voiceId: string | null = null;
  let contextId: string;
  let language = DEFAULT_LANGUAGE;
  let maxSessionDuration = DEFAULT_MAX_SESSION_DURATION;
  try {
    // The public API has a well-known host, so LIVEAVATAR_API_URL is only
    // needed to point at a non-default (e.g. staging) backend.
    apiBase = trimTrailingSlash(optionalEnv('LIVEAVATAR_API_URL') ?? DEFAULT_API_BASE);
    avatarId = env('AI_SALES_AVATAR_ID');
    apiKey = env('LIVEAVATAR_API_KEY');
    llmConfigurationId = optionalEnv('LLM_CONFIGURATION_ID');
    voiceId = optionalEnv('AI_SALES_VOICE_ID');
    // Required in practice even though the API marks it optional: the context
    // supplies the avatar's `opening_text`, which is where `${opening_intro}`
    // is substituted. Without one the avatar connects and then says nothing.
    contextId = env('AI_SALES_CONTEXT_ID');
    language = optionalEnv('AI_SALES_LANGUAGE') ?? DEFAULT_LANGUAGE;
    const rawDuration = optionalEnv('AI_SALES_MAX_SESSION_DURATION');
    if (rawDuration !== null) {
      const parsed = Number.parseInt(rawDuration, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('AI_SALES_MAX_SESSION_DURATION must be a positive integer (seconds)');
      }
      maxSessionDuration = parsed;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server misconfigured';
    return Response.json({ error: { message } }, { status: 500 });
  }

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    // Empty body is fine — fall back to defaults below.
  }

  const name = (body.name ?? '').trim();
  const email = (body.email ?? '').trim().toLowerCase();

  // Enrich via the configured lead resolver. Non-fatal if it misses — we
  // just fall back to a referer-tailored default opening.
  let lead: LeadProfile | null = null;
  if (email) {
    try {
      lead = await resolveLead(email);
    } catch (err) {
      console.error('[ai-sales] lead resolution failed', err);
    }
  }

  const referer = req.headers.get('referer');
  // Prefer name-aware intro whenever we have any name signal (URL param or
  // resolved lead). Fall back to referer-tailored default only when we truly
  // know nothing about the visitor.
  const openingIntro =
    lead || name ? buildOpeningIntro(lead, name || undefined) : pickOpening({ referer });

  // `username` used for both the top-level token field (shown as the
  // participant identity in LiveKit) and the `${username}` substitution.
  const displayName = name || lead?.first_name || 'friend';

  const dynamicVariables = buildDynamicVariables({
    username: displayName,
    email,
    opening_intro: openingIntro,
  });

  const url = `${apiBase}/v1/sessions/token`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-API-KEY': apiKey,
  };

  const payload = {
    mode: 'FULL' as const,
    avatar_id: avatarId,
    // Required, and capped by the account tier.
    max_session_duration: maxSessionDuration,
    // FULL mode requires exactly one of `avatar_persona` or `voice_agent`;
    // omitting both is a 422. We send the persona inline so a deployment needs
    // no pre-built voice-agent resource. `context_id` is mandatory here — it
    // carries the `opening_text` the avatar speaks first, and the conversation
    // thereafter is driven by this app's prompt via `llm_configuration_id`.
    //
    // Note this also keeps `dynamic_variables` at the top level: the
    // `voice_agent` form carries its own nested `dynamic_variables` and
    // rejects the top-level field, which would break the opening line.
    avatar_persona: {
      language,
      context_id: contextId,
      ...(voiceId ? { voice_id: voiceId } : {}),
      // Speech recognition provider (deepgram | assembly_ai | gladia | elevenlabs);
      // unset = the account default.
      ...(optionalEnv('AI_SALES_STT_PROVIDER') ? { stt_config: { provider: optionalEnv('AI_SALES_STT_PROVIDER') } } : {}),
    },
    // Points the session's brain at this app's /api/chat/completions.
    // Omitted when unset — the session then uses the account default.
    ...(llmConfigurationId ? { llm_configuration_id: llmConfigurationId } : {}),
    // Sandbox sessions cost no credits: only the public Wayne avatar, about a
    // minute long. For wiring checks, never for visitors.
    ...(optionalEnv('AI_SALES_SANDBOX') === '1' ? { is_sandbox: true } : {}),
    dynamic_variables: dynamicVariables,
  };

  let tokenBody: PublicTokenResponse;
  try {
    const tokenRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      if (isBusyUpstream(tokenRes.status, text)) {
        console.warn('[ai-sales] mint busy', tokenRes.status, text);
        return Response.json({ error: { code: 'busy', message: BUSY_MESSAGE } }, { status: 503 });
      }
      return Response.json(
        { error: { message: `Token mint failed: ${tokenRes.status} ${text}` } },
        { status: 502 },
      );
    }
    tokenBody = JSON.parse(text) as PublicTokenResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token mint error';
    return Response.json({ error: { message } }, { status: 502 });
  }

  const sessionToken = tokenBody.data?.session_token;
  const sessionId = tokenBody.data?.session_id;
  if (!sessionToken || !sessionId) {
    return Response.json(
      { error: { message: 'Token response missing session_token/session_id' } },
      { status: 502 },
    );
  }

  // Sign the session_id so /api/ai-sales/session-end can prove the caller
  // received this token from us. Without it, anyone with the public URL could
  // spam the session-end fan-out (Notion CRM + Slack + Anthropic summary).
  // If AI_SALES_SESSION_SIGNING_SECRET is unset, signature is null and the
  // session-end gate will reject — fail closed. Both mint modes return a
  const sessionSignature = signSessionId(sessionId);

  return Response.json({
    session_id: sessionId,
    session_token: sessionToken,
    session_signature: sessionSignature,
    api_base: apiBase,
    // Echo minimal lead metadata so the client can render personalized chrome
    // (e.g. "Starting chat as Wayne from Acme…") without a second round-trip.
    // `survey_lead` is the boolean derived from `survey_submitted_at` so
    // the client can tell a warm lead from a cold one without having to fetch
    // the full LeadProfile separately.
    lead: lead
      ? {
          first_name: lead.first_name,
          company: lead.company,
          is_liveavatar_user: lead.is_liveavatar_user,
          survey_lead: !!lead.survey_submitted_at,
        }
      : null,
  });
}
