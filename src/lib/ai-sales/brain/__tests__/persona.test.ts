import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assemblePrompt,
  listPromptParts,
  loadPersona,
  promptPartsDir,
  resetPersonaCache,
} from '../persona';
import { applyIdentityTokens, agentIdentity } from '../agent-identity';

/**
 * Loader tests: assembly order, frontmatter stripping, identity tokens, the
 * PROMPT_PARTS_DIR override, graceful skipping of a bad part, and the
 * fail-loudly-on-empty contract.
 */

let dir: string;
const ENV_KEYS = [
  'PROMPT_PARTS_DIR',
  'AI_SALES_AGENT_NAME',
  'AI_SALES_AGENT_ROLE',
  'AI_SALES_PRODUCT_NAME',
  'AI_SALES_COMPANY_NAME',
] as const;
let saved: Record<string, string | undefined>;

function part(name: string, body: string): void {
  writeFileSync(join(dir, name), body, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prompt-parts-'));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetPersonaCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPersonaCache();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('prompt-parts directory resolution', () => {
  it('defaults to the in-repo parts directory', () => {
    expect(promptPartsDir()).toBe(join(process.cwd(), 'src/lib/ai-sales/brain/prompt-parts'));
  });

  it('honours an absolute PROMPT_PARTS_DIR override', () => {
    process.env.PROMPT_PARTS_DIR = dir;
    expect(promptPartsDir()).toBe(dir);
  });

  it('resolves a relative PROMPT_PARTS_DIR against cwd', () => {
    process.env.PROMPT_PARTS_DIR = 'my-parts';
    expect(promptPartsDir()).toBe(join(process.cwd(), 'my-parts'));
  });
});

describe('part discovery', () => {
  it('lists .md files in ascending filename order', () => {
    part('02_b.md', 'b');
    part('01_a.md', 'a');
    part('10_c.md', 'c');
    expect(listPromptParts(dir)).toEqual(['01_a.md', '02_b.md', '10_c.md']);
  });

  it('ignores non-markdown and underscore-prefixed files', () => {
    part('01_a.md', 'a');
    part('_parked.md', 'nope');
    part('notes.txt', 'nope');
    expect(listPromptParts(dir)).toEqual(['01_a.md']);
  });

  it('returns [] for a missing directory instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(listPromptParts(join(dir, 'nope'))).toEqual([]);
  });
});

describe('assembly', () => {
  it('concatenates parts in filename order, blank line separated', () => {
    part('01_a.md', '# One\nalpha\n');
    part('02_b.md', '# Two\nbeta\n');
    expect(assemblePrompt(dir)).toBe('# One\nalpha\n\n# Two\nbeta');
  });

  it('strips YAML frontmatter from each part', () => {
    part('01_a.md', '---\npart: a\n---\n\n# One\nalpha\n');
    expect(assemblePrompt(dir)).toBe('# One\nalpha');
  });

  it('strips HTML comments (operator notes never reach the model)', () => {
    part('01_a.md', '# One\n\n<!-- note to operators\n  multi-line\n-->\n\nalpha\n');
    expect(assemblePrompt(dir)).toBe('# One\n\nalpha');
  });

  it('skips a part whose only content is comments', () => {
    part('01_a.md', 'alpha');
    part('02_notes.md', '<!-- TODO: fill this in -->\n');
    expect(assemblePrompt(dir)).toBe('alpha');
  });

  it('substitutes identity tokens and leaves unknown tokens alone', () => {
    process.env.AI_SALES_AGENT_NAME = 'Ada';
    process.env.AI_SALES_PRODUCT_NAME = 'Widget';
    part('01_a.md', 'I am {{AGENT_NAME}} from {{PRODUCT_NAME}}. {{NOPE}}');
    expect(assemblePrompt(dir)).toBe('I am Ada from Widget. {{NOPE}}');
  });

  it('adding a part file changes the output with no code change', () => {
    part('01_a.md', 'alpha');
    const before = assemblePrompt(dir);
    part('02_new.md', 'brand new section');
    expect(assemblePrompt(dir)).toBe(`${before}\n\nbrand new section`);
  });

  it('skips an empty part rather than emitting blank space', () => {
    part('01_a.md', 'alpha');
    part('02_empty.md', '---\npart: empty\n---\n');
    expect(assemblePrompt(dir)).toBe('alpha');
  });

  it('skips an unreadable individual part and keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    part('01_a.md', 'alpha');
    // A directory named *.md is listed but cannot be read as a file (EISDIR),
    // which is the portable way to simulate a broken part.
    mkdirSync(join(dir, '02_broken.md'));
    expect(assemblePrompt(dir)).toBe('alpha');
    expect(warn).toHaveBeenCalled();
  });
});

describe('loadPersona', () => {
  it('assembles from PROMPT_PARTS_DIR and caches the result', () => {
    process.env.PROMPT_PARTS_DIR = dir;
    part('01_a.md', 'alpha');
    expect(loadPersona()).toBe('alpha');
    // Cached in module scope: a later file change is NOT picked up until reset.
    part('02_b.md', 'beta');
    expect(loadPersona()).toBe('alpha');
    resetPersonaCache();
    expect(loadPersona()).toBe('alpha\n\nbeta');
  });

  it('throws when the whole prompt is empty', () => {
    process.env.PROMPT_PARTS_DIR = dir;
    expect(() => loadPersona()).toThrow(/no prompt parts found/);
  });

  it('throws when the parts directory is missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PROMPT_PARTS_DIR = join(dir, 'does-not-exist');
    expect(() => loadPersona()).toThrow(/no prompt parts found/);
  });
});

describe('bundled parts', () => {
  it('assemble into a prompt with a PERSONA heading and no leaked internals', () => {
    resetPersonaCache();
    const prompt = loadPersona();
    // The prompt assembler splices the realworld intro after this heading.
    expect(prompt).toMatch(/^#+\s*(?:\d+\.\s*)?PERSONA\b/im);
    // Published pricing stays…
    expect(prompt).toContain('$475/month');
    // …internal commercial material must not.
    for (const leak of [
      'One Call Deals',
      '$24K',
      '40.8K',
      '$40,800',
      'Discount Policy',
      'prompt_revision',
      'Tavus',
      'Anam',
      'LemonSlice',
      'BeyondPresence',
      'Synthesia',
      'NOT FOR PROSPECT',
    ]) {
      expect(prompt).not.toContain(leak);
    }
    // Identity tokens are all resolved.
    expect(prompt).not.toMatch(/\{\{(AGENT_NAME|AGENT_ROLE|PRODUCT_NAME|COMPANY_NAME)\}\}/);
    // Operator scaffolding lives in HTML comments and must not reach the model.
    expect(prompt).not.toContain('<!--');
    expect(prompt).not.toContain('OPERATOR SCAFFOLD');
  });
});

describe('agent identity', () => {
  it('defaults, then reads env overrides', () => {
    expect(agentIdentity().name).toBe('Wayne');
    process.env.AI_SALES_AGENT_NAME = 'Ada';
    process.env.AI_SALES_AGENT_ROLE = 'Head of Widgets';
    expect(agentIdentity()).toMatchObject({ name: 'Ada', role: 'Head of Widgets' });
  });

  it('applyIdentityTokens replaces all four tokens', () => {
    const out = applyIdentityTokens(
      '{{AGENT_NAME}}/{{AGENT_ROLE}}/{{PRODUCT_NAME}}/{{COMPANY_NAME}}',
      {
        name: 'n',
        role: 'r',
        product: 'p',
        company: 'c',
      },
    );
    expect(out).toBe('n/r/p/c');
  });
});
