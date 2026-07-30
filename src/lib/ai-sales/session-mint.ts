/**
 * Pure helpers for the session-token mint (`/api/ai-sales/session`).
 *
 * These live outside the route module because a Next.js `route.ts` may only
 * export HTTP handlers and route config — anything else fails the build's
 * route-type check. Keeping them here also makes them unit-testable without
 * standing up a request.
 */

/** Public API default host — an OSS deploy only has to supply an API key. */
export const DEFAULT_API_BASE = 'https://api.liveavatar.com';

/**
 * Default session cap, in seconds. 10 minutes is a sensible ceiling for a
 * demo conversation; override with AI_SALES_MAX_SESSION_DURATION.
 * The value must be ≤ whatever your account's tier allows, or the API rejects
 * the mint.
 */
export const DEFAULT_MAX_SESSION_DURATION = 600;

/** Spoken language for the session persona; override with AI_SALES_LANGUAGE. */
export const DEFAULT_LANGUAGE = 'en';

/**
 * Public-API `dynamic_variables` limits: at most 50 entries, keys ≤ 64 chars,
 * values ≤ 1000 chars. `opening_intro` is generated prose and otherwise
 * unbounded, so every value goes through `clampValue` — over the limit the API
 * 422s and the visitor gets a hard failure instead of a session.
 */
export const DYNAMIC_VAR_MAX_ENTRIES = 50;
export const DYNAMIC_VAR_MAX_KEY_LENGTH = 64;
export const DYNAMIC_VAR_MAX_VALUE_LENGTH = 1000;

/** Rendered by the client when the account is out of capacity or credits. */
export const BUSY_MESSAGE =
  'All avatar sessions are busy right now. Please try again in a few moments.';

/**
 * Clamp a `dynamic_variables` value to the API's 1000-char ceiling, preferring
 * a word boundary when one is close enough to the cut that we're not throwing
 * away a meaningful chunk of the sentence.
 */
export function clampValue(value: string, max = DYNAMIC_VAR_MAX_VALUE_LENGTH): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace >= max * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Enforce the whole `dynamic_variables` contract: drop empty values, clamp
 * every value, skip over-long keys, and cap the entry count. Cheap insurance —
 * a single oversized value 422s the entire mint.
 */
export function buildDynamicVariables(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (Object.keys(out).length >= DYNAMIC_VAR_MAX_ENTRIES) break;
    if (!key || key.length > DYNAMIC_VAR_MAX_KEY_LENGTH) continue;
    if (!rawValue) continue;
    out[key] = clampValue(rawValue);
  }
  return out;
}

/**
 * Upstream "come back later" conditions: the account is at its concurrent-
 * session ceiling, or it is out of credits. Neither is a bug on our side and
 * neither is fixed by an immediate retry, so the UI renders a friendly busy
 * state rather than a 502 error blob.
 */
export function isBusyUpstream(status: number, body: string): boolean {
  if (status === 429 || status === 402) return true;
  if (status !== 400 && status !== 403 && status !== 409) return false;
  return /concurren|credit|quota|insufficient|limit reached|too many/i.test(body);
}
