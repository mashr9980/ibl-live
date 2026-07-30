import 'server-only';
import type { LeadProfile } from '@/lib/ai-sales/lead';
import { getLeadResolver } from '@/lib/ai-sales/lead-resolver';

/**
 * Brain-side lead lookup — a thin alias over the pluggable lead resolver.
 *
 * This used to be a second, separate HTTP client (its own endpoint, its own
 * secret) alongside `src/lib/ai-sales/lead.ts`. That split was an internal
 * artifact, not a design: both now go through the single `LeadResolver`
 * interface in `src/lib/ai-sales/lead-resolver/`, whose default implementation
 * is a no-op stub that makes no network calls.
 *
 * Non-fatal by contract: any failure resolves to `null` and the prompt is
 * assembled cold (cold visitor → pure discovery). Kept as its own export so the
 * chat-turn and session-end call sites don't need to change.
 */
export async function fetchLead(email: string): Promise<LeadProfile | null> {
  return getLeadResolver().resolve(email);
}
