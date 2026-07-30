import type { LeadResolver } from './types';

/**
 * Default `LeadResolver` — resolves nothing, calls nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTEGRATION SEAM: replace with a network call to your own CRM / enrichment
 * service. Return a `LeadProfile` for a known contact and `null` for an
 * unknown one; never throw. Every consumer already degrades gracefully when
 * the lead is `null` (the prompt is assembled "cold" and the agent treats the
 * visitor as pure discovery), so a partial implementation is safe — populate
 * only the fields your CRM actually has and leave the rest `null`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Deliberately silent: this runs on every session mint and every chat turn, so
 * a per-call `console.warn` would be pure log spam. The single startup note in
 * `./index` is the only signal that lead enrichment is disabled.
 */
export const stubLeadResolver: LeadResolver = {
  id: 'stub',

  async resolve() {
    return null;
  },
};
