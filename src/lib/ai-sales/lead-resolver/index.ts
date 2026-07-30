/**
 * Lead resolver selection.
 *
 * One env var picks the implementation:
 *
 *   AI_SALES_LEAD_RESOLVER=stub   (default) no-op — no network calls
 *
 * Only the no-op stub ships. To enrich leads from your own CRM, implement
 * `LeadResolver` (see `./types`, start from `./stub`), add it to `RESOLVERS`
 * below under whatever name you like, and select it with the env var. Nothing
 * else in the app needs to change.
 */
import { stubLeadResolver } from './stub';
import type { LeadResolver } from './types';

export type { LeadResolver } from './types';
export { stubLeadResolver } from './stub';

const RESOLVERS: Record<string, LeadResolver> = {
  stub: stubLeadResolver,
  // Accepted aliases for "lead enrichment is off".
  none: stubLeadResolver,
  noop: stubLeadResolver,
  off: stubLeadResolver,
};

/**
 * Pure selector — exported for tests. Unset/blank means the OSS default.
 * An unrecognised value falls back to the stub rather than failing the boot:
 * lead enrichment is optional everywhere, so a typo must not take the app down.
 */
export function selectLeadResolver(name: string | undefined): {
  resolver: LeadResolver;
  note: string;
  /** True only for a typo'd selector — the one case worth logging. */
  misconfigured: boolean;
} {
  const key = (name ?? '').trim().toLowerCase();
  if (!key) {
    return {
      resolver: stubLeadResolver,
      note: 'lead enrichment disabled (no AI_SALES_LEAD_RESOLVER set) — using the no-op stub',
      misconfigured: false,
    };
  }
  const resolver = RESOLVERS[key];
  if (!resolver) {
    return {
      resolver: stubLeadResolver,
      note: `unknown AI_SALES_LEAD_RESOLVER=${key} — falling back to the no-op stub`,
      misconfigured: true,
    };
  }
  return { resolver, note: `lead resolver: ${resolver.id}`, misconfigured: false };
}

let cached: LeadResolver | null = null;

/**
 * Memoised accessor.
 *
 * Silent on the happy paths, including the default (stubbed) one: the previous
 * code warned on *every* unconfigured lookup, which is pure log spam when lead
 * enrichment is simply switched off. Only a typo'd selector gets a note, once
 * per process.
 */
export function getLeadResolver(): LeadResolver {
  if (cached) return cached;
  const { resolver, note, misconfigured } = selectLeadResolver(process.env.AI_SALES_LEAD_RESOLVER);
  if (misconfigured) console.warn(`[ai-sales] ${note}`);
  cached = resolver;
  return cached;
}

/** Test-only: drop the memoised selection so env changes take effect. */
export function resetLeadResolverCache(): void {
  cached = null;
}
