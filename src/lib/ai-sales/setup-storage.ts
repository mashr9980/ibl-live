/**
 * localStorage cache of the resolved-lead chrome (first_name, company,
 * is_liveavatar_user) keyed by email.
 *
 * When the visitor's email is known — either from URL deep-link or from a
 * just-submitted SetupForm — we use the cached profile to render the
 * "Welcoming Wayne from Acme" copy on ConnectingStage instantly, instead of
 * waiting for /api/ai-sales/session to round-trip.
 *
 * We deliberately do NOT cache the SetupForm inputs themselves: a fresh
 * visit (no URL params) must always show the form, since cached identity is
 * not confirmed identity. Cache only applies once the email is reaffirmed.
 *
 * 7-day TTL: long enough that a within-week revisit feels frictionless,
 * short enough that a stale profile doesn't haunt a returning user months
 * later. Writes degrade silently on quota / private-mode / disabled-storage.
 */

const LEAD_HINT_PREFIX = 'ai-sales:lead-hint:v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type StoredLeadHint = {
  first_name: string | null;
  company: string | null;
  is_liveavatar_user: boolean;
};

type Envelope<T> = { fetchedAt: number; payload: T };

function leadHintKey(email: string): string {
  return `${LEAD_HINT_PREFIX}:${email.trim().toLowerCase()}`;
}

function readEnvelope<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Envelope<T>;
    if (!parsed?.fetchedAt || typeof parsed.fetchedAt !== 'number') return null;
    if (Date.now() - parsed.fetchedAt > TTL_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed.payload;
  } catch {
    return null;
  }
}

function writeEnvelope<T>(key: string, payload: T): void {
  if (typeof window === 'undefined') return;
  try {
    const env: Envelope<T> = { fetchedAt: Date.now(), payload };
    window.localStorage.setItem(key, JSON.stringify(env));
  } catch {
    // Quota exceeded / disabled — silent.
  }
}

export function readLeadHint(email: string): StoredLeadHint | null {
  if (!email.trim()) return null;
  return readEnvelope<StoredLeadHint>(leadHintKey(email));
}

export function writeLeadHint(email: string, hint: StoredLeadHint): void {
  if (!email.trim()) return;
  writeEnvelope(leadHintKey(email), hint);
}
