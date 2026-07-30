import 'server-only';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { applyIdentityTokens } from './agent-identity';

/**
 * Persona loader — assembles the system prompt from a directory of Markdown
 * "parts" instead of one monolithic file.
 *
 * ## Layout
 *
 * Parts live in `src/lib/ai-sales/brain/prompt-parts/` — one file per section
 * (`01_agent_info.md`, `02_communication_style.md`, …).
 *
 * ## Assembly rules (all of them)
 *
 * 1. Every `*.md` file in the parts directory is a part. Adding or removing a
 *    part requires NO code change.
 * 2. Order is ascending filename order (plain codepoint sort). That's why the
 *    files carry zero-padded numeric prefixes — the order is visible in `ls`.
 *    Leave gaps (`05_`, `06_`) so a new part can be slotted in.
 * 3. Files whose name starts with `_` are ignored — a cheap way to park a part
 *    without deleting it.
 * 4. Each part's leading YAML frontmatter is stripped; only the body is sent to
 *    the model.
 * 5. HTML comments (`<!-- … -->`) are stripped too — they are notes FOR THE
 *    OPERATOR reading the repo (what belongs in a section, what was removed for
 *    the public release), not instructions for the model, and they'd otherwise
 *    burn tokens and risk being narrated on a call.
 * 6. `{{AGENT_NAME}}`-style tokens are substituted from agent-identity.ts.
 * 7. Parts are joined with a blank line between them.
 *
 * ## Overriding the prompt (no code changes)
 *
 * Set `PROMPT_PARTS_DIR` to another directory — absolute, or relative to the
 * process cwd — and that directory replaces the bundled one wholesale. This is
 * the supported way to run your own (private) sales prompt against this
 * codebase: mount/copy your parts at deploy time and point the env var at them.
 *
 * ## Failure behaviour
 *
 * A single unreadable part is skipped with a warning: one bad file must not
 * take the whole agent down, and the remaining sections still make a coherent
 * prompt. But an EMPTY assembled prompt is fatal (no persona, no response) —
 * that includes a missing/empty parts directory. The chat route surfaces the
 * throw as a 400 before any streaming begins.
 *
 * The assembled body is cached in module scope, i.e. once per lambda cold
 * start. Editing a part file in dev requires a server restart.
 *
 * The parts directory is bundled on Vercel via `outputFileTracingIncludes` in
 * next.config.js (fs reads aren't auto-traced).
 */

const DEFAULT_PARTS_DIR = 'src/lib/ai-sales/brain/prompt-parts';

let cachedBody: string | null = null;

/** Resolved parts directory: `PROMPT_PARTS_DIR` if set, else the bundled one. */
export function promptPartsDir(): string {
  const override = process.env.PROMPT_PARTS_DIR?.trim();
  if (override) {
    return isAbsolute(override) ? override : join(process.cwd(), override);
  }
  return join(process.cwd(), DEFAULT_PARTS_DIR);
}

// Strip a leading `---\n ... \n---\n` YAML frontmatter block. Tolerates a BOM.
// Only the body feeds the model; frontmatter (part name/version/etc.) is
// metadata for humans.
function stripFrontmatter(raw: string): string {
  const match = /^\uFEFF?---\s*\n[\s\S]*?\n---\s*\n?/.exec(raw);
  return match ? raw.slice(match[0].length) : raw;
}

// Drop `<!-- ... -->` blocks (operator notes) and collapse the blank-line runs
// they leave behind. Anything the MODEL should read must be plain markdown.
function stripHtmlComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
}

/** Part filenames in assembly order. Empty if the directory is unreadable. */
export function listPromptParts(dir: string = promptPartsDir()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`[ai-sales] prompt parts directory unreadable: ${dir}`, err);
    return [];
  }
  return entries.filter((name) => name.endsWith('.md') && !name.startsWith('_')).sort();
}

/** Reads + sanitizes every part and joins them. Exported for tests. */
export function assemblePrompt(dir: string = promptPartsDir()): string {
  const bodies: string[] = [];
  for (const name of listPromptParts(dir)) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch (err) {
      // Skip, don't die — a single missing/unreadable part still leaves a
      // usable prompt (e.g. a part deleted mid-deploy, or a bad symlink).
      console.warn(`[ai-sales] skipping unreadable prompt part ${name}`, err);
      continue;
    }
    const body = applyIdentityTokens(stripHtmlComments(stripFrontmatter(raw))).trim();
    if (body) bodies.push(body);
  }
  return bodies.join('\n\n');
}

export function loadPersona(): string {
  if (cachedBody !== null) return cachedBody;
  const dir = promptPartsDir();
  const body = assemblePrompt(dir);
  if (!body) {
    throw new Error(
      `no prompt parts found in ${dir} — add Markdown parts there, or point ` +
        'PROMPT_PARTS_DIR at your own parts directory',
    );
  }
  cachedBody = body;
  return cachedBody;
}

/** Test-only: drops the module-scope cache so env changes take effect. */
export function resetPersonaCache(): void {
  cachedBody = null;
}
