import 'server-only';
import type { LeadProfile } from '@/lib/ai-sales/lead';

/**
 * Lead-context block, ported from the original Python implementation.
 * Renders the resolved LeadProfile as the `## Lead info` markdown section that sits at the same
 * heading level as `## Chat History` in the assembled system prompt.
 *
 * Strings are byte-for-byte with the original Python so a ported session is
 * indistinguishable from it.
 */
export function buildLeadContextBlock(lead: LeadProfile | null): string {
  if (lead === null) {
    return '## Lead info\n\nKnown lead context: none — this is a cold visitor. Treat as pure discovery.';
  }

  const lines: string[] = ['## Lead info', '', 'Known lead context (from the signup survey):'];

  const push = (label: string, value: unknown): void => {
    if (value === null || value === undefined || value === '') return;
    lines.push(`- ${label}: ${value}`);
  };

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || null;
  push('Name', name);
  push('Email', lead.email);
  push('Company', lead.company);
  push('Country', lead.country);
  push('Job title', lead.job_title);
  push('Use case', lead.use_case_description || lead.use_case_type);
  if (lead.budget_qualified !== null) push('Budget fit', lead.budget_qualified ? 'Yes' : 'No');
  if (lead.has_dev_team !== null) push('Has dev team', lead.has_dev_team ? 'Yes' : 'No');
  push('In-house or client', lead.in_house_or_client);

  if (lead.is_liveavatar_user) {
    const planType = lead.liveavatar_plan_type || 'unknown';
    const planLabel = lead.liveavatar_plan_name
      ? `${lead.liveavatar_plan_name} (${planType})`
      : planType;
    push('Already a LiveAvatar user', `Yes — plan: ${planLabel}`);
    if (lead.liveavatar_member_since) {
      push('LiveAvatar member since', lead.liveavatar_member_since.slice(0, 10));
    }
    if (lead.liveavatar_session_count !== null) {
      push('LiveAvatar sessions started', lead.liveavatar_session_count);
    }
  } else {
    push('Already a LiveAvatar user', 'No');
  }

  if (lead.survey_submitted_at) {
    push('Submitted survey', lead.survey_submitted_at.slice(0, 10));
  }

  lines.push('');
  lines.push(
    'Use this context naturally — do NOT recite it back. Fields left blank mean the lead ' +
      'did not answer; do not ask them again unless they bring it up.',
  );
  return lines.join('\n');
}
