import 'server-only';
import { getLeadResolver } from './lead-resolver';

/**
 * Lead types + the stable façade over the pluggable lead resolver.
 *
 * The app only ever needs a resolved `LeadProfile` (to build the opening intro
 * and to decorate the post-session Notion/Slack pipeline). Where that profile
 * comes from is a swappable implementation detail: see
 * `src/lib/ai-sales/lead-resolver/` — the default resolver is a no-op stub that
 * makes no network calls, and every consumer here degrades to `null`.
 *
 * `resolveLead` is the stable entry point; it delegates to whichever resolver
 * is selected by `AI_SALES_LEAD_RESOLVER`.
 */

export type LeadProfile = {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  country: string | null;
  job_title: string | null;
  use_case_type: string | null;
  use_case_description: string | null;
  has_dev_team: boolean | null;
  budget_qualified: boolean | null;
  in_house_or_client: string | null;
  is_liveavatar_user: boolean;
  liveavatar_plan_type: string | null;
  liveavatar_plan_name: string | null;
  liveavatar_member_since: string | null;
  liveavatar_session_count: number | null;
  survey_submitted_at: string | null;
  survey_response_id: string | null;
  survey_fields: Array<{ question: string; answer: string }>;
  /**
   * Optional extension point — nothing populates it by default (the bundled
   * stub resolver returns `null`).
   *
   * A `LeadResolver` implementation that also supplies the system prompt may
   * return an opaque revision identifier for the prompt it handed back, so a
   * client holding a cached prompt can tell when its copy has gone stale.
   * Purely informational: no code path reads it.
   */
  prompt_revision?: string | null;
};

export async function resolveLead(email: string): Promise<LeadProfile | null> {
  return getLeadResolver().resolve(email);
}
