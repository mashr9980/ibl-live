import 'server-only';
import type { ChatMessage } from './iblai';

/**
 * OpenAI chat-completions request shapes + message helpers, ported from the
 * original Python implementation.
 */

export type OpenAIContentPart = { type?: string; text?: string | null };
export type OpenAIMessage = { role: string; content: string | OpenAIContentPart[] };
export type OpenAIChatRequest = {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

// The LiveKit voice agent plants `SESSION_EMAIL: <addr>` in the system message
// (via the session context prompt + dynamic_variables).
//
// Requires an `@` and rejects `$ { }`, so an unsubstituted `${email}` — what a
// visitor who gave no email leaves behind, since buildDynamicVariables drops
// empty values — reads as "no email" instead of being passed to the lead
// resolver as the literal string `${email}`.
const SESSION_EMAIL_MARKER = /SESSION_EMAIL:\s*([^\s<{}$]+@[^\s<{}$]+)/;

/** Flatten OpenAI content (string | parts[]) to text, keeping only `text` parts. */
export function extractText(content: string | OpenAIContentPart[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/** Pull the visitor email out of the first system message carrying the marker. */
export function extractSessionEmail(messages: OpenAIMessage[]): string | null {
  for (const msg of messages) {
    if (msg.role !== 'system') continue;
    const match = SESSION_EMAIL_MARKER.exec(extractText(msg.content));
    if (match && match[1]) return match[1].trim().toLowerCase();
  }
  return null;
}

/**
 * Keep only user/assistant turns with non-empty text → chat messages.
 * System messages (incl. the SESSION_EMAIL marker) are dropped — the real
 * system prompt is assembled separately and passed in the `system` field.
 */
export function toChatMessages(messages: OpenAIMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = extractText(msg.content).trim();
    if (!text) continue;
    out.push({ role: msg.role, content: text });
  }
  return out;
}
