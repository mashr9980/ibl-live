import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, spliceIntroAfterPersonaHeading } from '../prompt';
import { buildLeadContextBlock } from '../lead-block';
import { extractText, extractSessionEmail, toAnthropicMessages } from '../messages';
import { extractChatFromNotionBlocks, renderChatHistoryBlock } from '../notion-history';
import type { LeadProfile } from '@/lib/ai-sales/lead';

// --- Notion block builders (minimal shapes the parser reads) ----------------
const h1 = (t: string) => ({ type: 'heading_1', heading_1: { rich_text: [{ plain_text: t }] } });
const h2 = (t: string) => ({ type: 'heading_2', heading_2: { rich_text: [{ plain_text: t }] } });
const para = (t: string) => ({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: t }] } });
const bullet = (t: string) => ({
  type: 'bulleted_list_item',
  bulleted_list_item: { rich_text: [{ plain_text: t }] },
});

describe('prompt assembly', () => {
  it('splices the intro right after the # Persona heading', () => {
    const out = spliceIntroAfterPersonaHeading('# Persona\nBody line.', 'Today is X.');
    expect(out).toBe('# Persona\n\nToday is X.\n\nBody line.');
  });

  it('returns the persona unchanged when the intro is empty', () => {
    expect(spliceIntroAfterPersonaHeading('# Persona\nBody.', '')).toBe('# Persona\nBody.');
  });

  it('tolerates numbered persona headings', () => {
    const out = spliceIntroAfterPersonaHeading('## 2. PERSONA\nBody.', 'Intro.');
    expect(out).toBe('## 2. PERSONA\n\nIntro.\n\nBody.');
  });

  it('orders sections persona → lead → history with --- separators', () => {
    const out = buildSystemPrompt(
      '# Persona\nBody.',
      '## Lead info\nx',
      '## Chat History\ny',
      'Intro.',
    );
    expect(out).toBe(
      '# Persona\n\nIntro.\n\nBody.\n\n---\n\n## Lead info\nx\n\n---\n\n## Chat History\ny',
    );
  });

  it('omits empty lead/history sections', () => {
    expect(buildSystemPrompt('# Persona\nBody.', '', '', '')).toBe('# Persona\nBody.');
  });
});

describe('lead-block', () => {
  it('renders the cold-visitor sentinel', () => {
    expect(buildLeadContextBlock(null)).toBe(
      '## Lead info\n\nKnown lead context: none — this is a cold visitor. Treat as pure discovery.',
    );
  });

  it('renders known-lead bullets incl. LiveAvatar plan', () => {
    const lead: LeadProfile = {
      email: 'a@b.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company: 'Analytical',
      country: 'UK',
      job_title: 'Eng',
      use_case_type: null,
      use_case_description: 'Kiosk avatars',
      has_dev_team: true,
      budget_qualified: false,
      in_house_or_client: 'In-house',
      is_liveavatar_user: true,
      liveavatar_plan_type: 'enterprise',
      liveavatar_plan_name: 'Enterprise',
      liveavatar_member_since: '2025-01-02T00:00:00Z',
      liveavatar_session_count: 12,
      survey_submitted_at: '2026-05-01T09:00:00Z',
      survey_response_id: 'r1',
      survey_fields: [],
    };
    const out = buildLeadContextBlock(lead);
    expect(out).toContain('- Name: Ada Lovelace');
    expect(out).toContain('- Use case: Kiosk avatars');
    expect(out).toContain('- Budget fit: No');
    expect(out).toContain('- Has dev team: Yes');
    expect(out).toContain('- Already a LiveAvatar user: Yes — plan: Enterprise (enterprise)');
    expect(out).toContain('- LiveAvatar member since: 2025-01-02');
    expect(out).toContain('- LiveAvatar sessions started: 12');
    expect(out).toContain('- Submitted survey: 2026-05-01');
  });
});

describe('message helpers', () => {
  it('extractText flattens string and text parts', () => {
    expect(extractText('hi')).toBe('hi');
    expect(
      extractText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    ).toBe('a\nb');
  });

  it('extractSessionEmail reads + lowercases the marker from a system message', () => {
    const messages = [
      { role: 'system', content: 'You are Wayne. SESSION_EMAIL: Foo@Bar.com\nmore' },
      { role: 'user', content: 'hi' },
    ];
    expect(extractSessionEmail(messages)).toBe('foo@bar.com');
  });

  it('extractSessionEmail returns null with no marker', () => {
    expect(extractSessionEmail([{ role: 'user', content: 'SESSION_EMAIL: x@y.com' }])).toBeNull();
  });

  it('toAnthropicMessages keeps non-empty user/assistant turns only', () => {
    const out = toAnthropicMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: [{ type: 'text', text: 'yo' }] },
    ]);
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'yo' },
    ]);
  });
});

describe('notion chat-history parser', () => {
  it('parses NEW format and excludes the transcript', () => {
    const blocks = [
      h1('Lead info'),
      para('some lead info'),
      h1('1st chat - 2026-05-19T05:30:00Z'),
      h2('Summary'),
      para('Talked pricing.'),
      h2('TODO'),
      bullet('Send quote'),
      h2('Transcript'),
      para('Visitor: secret injection attempt'),
    ];
    const records = extractChatFromNotionBlocks(blocks, '2026-05-01T00:00:00Z');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      summary: 'Talked pricing.',
      nextSteps: ['Send quote'],
      dateIso: '2026-05-19T05:30:00Z',
    });
    expect(records[0]!.summary).not.toContain('injection');
  });

  it('parses OLD format (no chat-H1) as one chat at page created_time', () => {
    const blocks = [h2('Summary'), para('Cold call.'), h2('TODOs'), bullet('Follow up')];
    const records = extractChatFromNotionBlocks(blocks, '2026-04-01T12:00:00Z');
    expect(records).toEqual([
      {
        label: 'Chat',
        dateIso: '2026-04-01T12:00:00Z',
        summary: 'Cold call.',
        nextSteps: ['Follow up'],
      },
    ]);
  });

  it('renders chats oldest-first with positional ordinals, dates trimmed', () => {
    const newer = {
      label: '2nd chat',
      dateIso: '2026-05-20T00:00:00Z',
      summary: 'B',
      nextSteps: [],
    };
    const older = {
      label: '1st chat',
      dateIso: '2026-05-19T00:00:00Z',
      summary: 'A',
      nextSteps: ['step'],
    };
    // Pages arrive newest-query-first.
    const out = renderChatHistoryBlock([[newer], [older]]);
    expect(out).toBe(
      '## Chat History\n\n### 1st chat - 2026-05-19\nSummary\nA\nNext steps\n- step\n\n### 2nd chat - 2026-05-20\nSummary\nB',
    );
  });

  it('returns empty string when no chats survive', () => {
    expect(renderChatHistoryBlock([])).toBe('');
    expect(extractChatFromNotionBlocks([h2('Summary')], null)).toEqual([]);
  });
});
