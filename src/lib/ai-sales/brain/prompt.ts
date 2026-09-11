import 'server-only';

/**
 * System-prompt assembly — ported from the original Python implementation.
 *
 * Section order (each `---`-separated, except the realworld intro which lives
 * INSIDE the persona section, right after its `# Persona` heading):
 *
 *     # Persona
 *     <realworld intro>      (if non-empty)
 *     <persona body>
 *     ---
 *     <lead block>           (if non-empty)
 *     ---
 *     <chat history block>   (if non-empty)
 *
 * Lead before history so the model has THIS visitor's context before prior
 * conversations; history last so it's freshest in the attention window.
 *
 * LEAD / CRM INJECTION POINT: `leadBlock` is where per-session prospect context
 * enters the prompt (rendered by `lead-block.ts`, appended under the
 * `# 11. PROSPECT KNOWLEDGE` part). Operators inject lead/CRM context here —
 * see LeadResolver; resolving a lead is typically a network call to your own
 * CRM or enrichment service and is deliberately not implemented in this repo.
 * Treat whatever lands in these blocks as untrusted data, never instructions.
 */

// Matches a "Persona" heading at any level, tolerating "1. " numbering, e.g.
// `# Persona`, `## 2. PERSONA`. Case-insensitive, multiline.
const PERSONA_HEADING_RE = /^(#+)\s*(?:\d+\.\s*)?persona\b/im;
// First H1 fallback.
const ANY_H1_RE = /^#\s+\S/m;

function stripLeadingNewlines(s: string): string {
  return s.replace(/^\n+/, '');
}

export function spliceIntroAfterPersonaHeading(persona: string, intro: string): string {
  if (!intro) return persona;

  // Strategy 1: explicit Persona heading. Strategy 2: first H1.
  let match = PERSONA_HEADING_RE.exec(persona);
  if (match === null) match = ANY_H1_RE.exec(persona);

  // Strategy 3: no heading at all — prepend, preserving leading newlines.
  if (match === null) {
    const stripped = stripLeadingNewlines(persona);
    const leadingNl = persona.length - stripped.length;
    return `${persona.slice(0, leadingNl)}${intro}\n\n${stripped}`;
  }

  const lineStart = match.index;
  const lineEnd = persona.indexOf('\n', lineStart);
  if (lineEnd === -1) {
    // Heading is the last line — append intro on a new line.
    return `${persona}\n\n${intro}`;
  }
  const headingLine = persona.slice(lineStart, lineEnd);
  const before = persona.slice(0, lineStart);
  const after = stripLeadingNewlines(persona.slice(lineEnd + 1));
  return `${before}${headingLine}\n\n${intro}\n\n${after}`;
}

export function buildSystemPrompt(
  persona: string,
  leadBlock: string,
  chatHistoryBlock = '',
  realworldIntro = '',
): string {
  // The persona first and unchanged, so OpenAI's prompt cache keeps the long
  // stable prefix; the parts that vary per session or per day come last.
  let out = persona;
  if (leadBlock) out = `${out}\n\n---\n\n${leadBlock}`;
  if (chatHistoryBlock) out = `${out}\n\n---\n\n${chatHistoryBlock}`;
  if (realworldIntro) out = `${out}\n\n---\n\n${realworldIntro}`;
  return out;
}
