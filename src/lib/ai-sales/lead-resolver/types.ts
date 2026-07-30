/**
 * The one seam for lead resolution.
 *
 * Everything that wants to know "who is this email?" goes through a
 * `LeadResolver`. The only shipped implementation is a no-op stub (see
 * `./stub`), selected by env config in `./index`.
 *
 * Implement this interface against your own CRM / enrichment service and
 * register it in `./index` — nothing else in the app needs to change.
 */
import type { LeadProfile } from '@/lib/ai-sales/lead';

export interface LeadResolver {
  /** Stable id, used in logs and by the selection tests. */
  readonly id: string;

  /**
   * Hot path (session mint, chat turn). MUST NOT throw and MUST NOT block for
   * long — return `null` on any failure so the prompt is assembled cold.
   */
  resolve(email: string): Promise<LeadProfile | null>;
}

/** Shared input validation so every implementation rejects the same things. */
export function normalizeEmail(email: string): string | null {
  const clean = email.trim().toLowerCase();
  if (!clean || !clean.includes('@')) return null;
  return clean;
}
