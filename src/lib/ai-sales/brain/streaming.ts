import 'server-only';
import { iblaiChat, type ChatMessage, type IblaiConfig } from './iblai';

/**
 * ibl.ai -> OpenAI Chat Completions SSE adapter.
 *
 * LiveAvatar speaks OpenAI's chat-completions dialect and so does ibl.ai, but
 * the frames are re-emitted rather than piped through: the stream then ALWAYS
 * closes with `data: [DONE]`, an error after the first frame is surfaced as a
 * content delta (never an HTTP error) so a mid-turn failure degrades
 * gracefully in the avatar instead of dropping the socket, and the real model
 * name never reaches the wire.
 */

// Kept for callers; NOT sent upstream — ibl.ai answers "internal_error" to any
// request carrying max_tokens (seen 2026-09-11), and the persona already caps
// replies at 30 words.
export const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_TEMPERATURE = 0.2;

export type ChatDelta = { role?: string; content?: string };

/** Spoken aloud when ibl.ai cannot answer; the real reason goes to the server log. */
export const SPOKEN_FALLBACK =
  "Sorry, I can't reach my knowledge right now. Please try again in a moment, or book a call with the team from the link on this page.";

export function chatId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `chatcmpl-${Buffer.from(bytes).toString('base64url').slice(0, 8)}`;
}

export function openaiChunk(
  id: string,
  modelLabel: string,
  delta: ChatDelta,
  finishReason: string | null = null,
) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelLabel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

type CompletionArgs = {
  config: IblaiConfig;
  systemPrompt: string;
  messages: ChatMessage[];
  modelLabel: string;
  maxTokens: number;
  temperature: number | null;
};

function requestBody(args: CompletionArgs, stream: boolean) {
  return {
    messages: [{ role: 'system' as const, content: args.systemPrompt }, ...args.messages],
    stream,
    // Low by default: this is a factual guide, not a storyteller.
    temperature: args.temperature !== null ? args.temperature : DEFAULT_TEMPERATURE,
  };
}

async function failureText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return `ibl.ai ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
}

/** Text deltas out of an OpenAI-style SSE body. */
export async function* upstreamDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let chunk: { choices?: { delta?: { content?: unknown } }[]; error?: { message?: string } };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // a partial or keep-alive line
      }
      // ibl.ai reports a failed turn as an error frame on a 200 stream.
      if (chunk.error) throw new Error(`ibl.ai: ${chunk.error.message ?? 'upstream error'}`);
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text) yield text;
    }
  }
}

/**
 * Stream ibl.ai text deltas as OpenAI `chat.completion.chunk` SSE frames.
 * Yields ready-to-write SSE strings. Always terminates with `data: [DONE]`.
 */
export async function* streamChatCompletion(args: CompletionArgs): AsyncGenerator<string> {
  const { modelLabel } = args;
  const cid = chatId();
  try {
    yield sseLine(openaiChunk(cid, modelLabel, { role: 'assistant', content: '' }));
    const res = await iblaiChat(args.config, requestBody(args, true));
    if (!res.ok || !res.body) throw new Error(await failureText(res));
    for await (const text of upstreamDeltas(res.body)) {
      yield sseLine(openaiChunk(cid, modelLabel, { content: text }));
    }
    yield sseLine(openaiChunk(cid, modelLabel, {}, 'stop'));
    yield 'data: [DONE]\n\n';
  } catch (err) {
    console.error('[ai-sales] stream failed', err);
    yield sseLine(openaiChunk(cid, modelLabel, { content: SPOKEN_FALLBACK }, 'stop'));
    yield 'data: [DONE]\n\n';
  }
}

/** The answer text of a one-shot completion. */
export async function completionText(args: CompletionArgs): Promise<string> {
  const res = await iblaiChat(args.config, requestBody(args, false));
  if (!res.ok) throw new Error(await failureText(res));
  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
    error?: { message?: string };
  };
  if (data.error) throw new Error(`ibl.ai: ${data.error.message ?? 'upstream error'}`);
  const text = data.choices?.[0]?.message?.content;
  return typeof text === 'string' ? text : '';
}

/** OpenAI-shaped non-streaming completion (`stream:false` callers). */
export async function nonStreamingCompletion(args: CompletionArgs) {
  const text = await completionText(args);
  return {
    id: chatId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: args.modelLabel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
