import 'server-only';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic -> OpenAI Chat Completions SSE adapter.
 *
 * Ported from the original Python implementation. The LiveKit
 * voice agent speaks OpenAI's chat-completions dialect; Anthropic emits its
 * own event shapes, so we re-emit each text delta as an OpenAI
 * `chat.completion.chunk` SSE frame. The stream ALWAYS closes with
 * `data: [DONE]`; an error after the first frame is surfaced as a content
 * delta (never an HTTP error) so a mid-turn failure degrades gracefully in
 * the avatar instead of dropping the socket.
 */

export const LLM_MODEL = 'claude-haiku-4-5';
export const DEFAULT_MAX_TOKENS = 512;

export type ChatDelta = { role?: string; content?: string };

// The whole system prompt (persona + lead + history, ~2.5K tokens) is rebuilt
// every turn. Marking it ephemeral lets Anthropic serve later turns from
// prompt cache at ~10% of base input price; turn 1 pays a 1.25x write
// surcharge, net positive after turn 2.
function systemBlocks(text: string): Anthropic.TextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function chatId(): string {
  // Python: `chatcmpl-{secrets.token_urlsafe(6)[:8]}` — 6 random bytes,
  // url-safe base64, first 8 chars.
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

type StreamArgs = {
  client: Anthropic;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  modelLabel: string;
  maxTokens: number;
  temperature: number | null;
};

/**
 * Stream Anthropic text deltas as OpenAI `chat.completion.chunk` SSE frames.
 * Yields ready-to-write SSE strings; the route encodes them into the
 * ReadableStream. Always terminates with `data: [DONE]\n\n`.
 */
export async function* streamChatCompletion(args: StreamArgs): AsyncGenerator<string> {
  const { client, systemPrompt, messages, modelLabel, maxTokens, temperature } = args;
  const cid = chatId();
  try {
    // Open the assistant role frame (no content) so the OpenAI client knows
    // an assistant message is streaming.
    yield sseLine(openaiChunk(cid, modelLabel, { role: 'assistant', content: '' }));

    const params: Anthropic.MessageStreamParams = {
      model: LLM_MODEL,
      max_tokens: maxTokens,
      system: systemBlocks(systemPrompt),
      messages,
    };
    if (temperature !== null) params.temperature = temperature;

    const anthropicStream = client.messages.stream(params);
    for await (const event of anthropicStream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const text = event.delta.text || '';
        if (text) yield sseLine(openaiChunk(cid, modelLabel, { content: text }));
      }
    }

    yield sseLine(openaiChunk(cid, modelLabel, {}, 'stop'));
    yield 'data: [DONE]\n\n';
  } catch (err) {
    // Error AFTER the stream opened: surface as a content delta, not an HTTP
    // error — the socket is already committed.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ai-sales] stream failed', err);
    yield sseLine(openaiChunk(cid, modelLabel, { content: `\n[error: ${message}]` }, 'stop'));
    yield 'data: [DONE]\n\n';
  }
}

type CompletionArgs = Omit<StreamArgs, never>;

/** OpenAI-shaped non-streaming completion (tests + `stream:false` callers). */
export async function nonStreamingCompletion(args: CompletionArgs) {
  const { client, systemPrompt, messages, modelLabel, maxTokens, temperature } = args;
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: LLM_MODEL,
    max_tokens: maxTokens,
    system: systemBlocks(systemPrompt),
    messages,
  };
  if (temperature !== null) params.temperature = temperature;

  const response = await client.messages.create(params);
  const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;

  return {
    id: chatId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelLabel,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
