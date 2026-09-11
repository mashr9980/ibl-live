/**
 * Agent identity — the ONE place the agent's name/role/product/company live.
 *
 * Both the prompt parts (`prompt-parts/*.md`, via `{{TOKEN}}` substitution in
 * persona.ts) and the pre-LLM opening lines (`src/lib/ai-sales/opening.ts`)
 * read from here, so renaming the agent is an env change — no code edits, no
 * markdown edits.
 *
 * Every value is env-overridable; the defaults describe this repo's public demo
 * agent. Read at call time (not module init) so tests can flip env vars.
 */
export type AgentIdentity = {
  /** First name the agent introduces itself with. */
  name: string;
  /** Role/title, e.g. "Head of Business". */
  role: string;
  /** Product being sold. */
  product: string;
  /** Company behind the product. */
  company: string;
};

export const DEFAULT_AGENT_IDENTITY: AgentIdentity = {
  name: 'Ivy',
  role: 'AI Guide',
  product: 'ibl.ai',
  company: 'ibl.ai',
};

function env(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : fallback;
}

export function agentIdentity(): AgentIdentity {
  return {
    name: env('AI_SALES_AGENT_NAME', DEFAULT_AGENT_IDENTITY.name),
    role: env('AI_SALES_AGENT_ROLE', DEFAULT_AGENT_IDENTITY.role),
    product: env('AI_SALES_PRODUCT_NAME', DEFAULT_AGENT_IDENTITY.product),
    company: env('AI_SALES_COMPANY_NAME', DEFAULT_AGENT_IDENTITY.company),
  };
}

/**
 * Substitutes `{{AGENT_NAME}}` / `{{AGENT_ROLE}}` / `{{PRODUCT_NAME}}` /
 * `{{COMPANY_NAME}}` in prompt-part markdown. Unknown `{{...}}` tokens are left
 * verbatim — a typo shows up in the prompt instead of silently vanishing.
 */
export function applyIdentityTokens(text: string, identity = agentIdentity()): string {
  const table: Record<string, string> = {
    AGENT_NAME: identity.name,
    AGENT_ROLE: identity.role,
    PRODUCT_NAME: identity.product,
    COMPANY_NAME: identity.company,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => table[key] ?? match);
}
