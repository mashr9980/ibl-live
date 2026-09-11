import 'server-only';

/**
 * The brain: an OpenAI-compatible chat/completions endpoint.
 *
 * Default is ibl.ai. The platform exposes the endpoint per organization; the
 * streaming host (ASGI) serves both streamed and one-shot completions, so
 * everything goes there. Setting OPENAI_API_KEY switches the brain to OpenAI
 * itself, same wire format, for demos while an ibl.ai org has no credits.
 */

export type IblaiConfig = {
  provider: 'iblai' | 'openai';
  apiKey: string;
  org: string;
  model: string;
  chatUrl: string;
};
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export const DEFAULT_IBLAI_MODEL = 'google/gemini-3.1-flash-lite';
export const DEFAULT_IBLAI_ASGI_URL = 'https://asgi.data.iblai.app';
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1';
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/** Null until a brain is configured: OPENAI_API_KEY, or IBLAI_API_KEY + IBLAI_ORG. */
export function iblaiConfig(): IblaiConfig | null {
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    return {
      provider: 'openai',
      apiKey: openaiKey,
      org: '',
      model: process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
      chatUrl: OPENAI_CHAT_URL,
    };
  }
  const apiKey = process.env.IBLAI_API_KEY?.trim();
  const org = process.env.IBLAI_ORG?.trim();
  if (!apiKey || !org) return null;
  const model = process.env.IBLAI_MODEL?.trim() || DEFAULT_IBLAI_MODEL;
  const base = (process.env.IBLAI_ASGI_URL?.trim() || DEFAULT_IBLAI_ASGI_URL).replace(/\/+$/, '');
  return {
    provider: 'iblai',
    apiKey,
    org,
    model,
    chatUrl: `${base}/api/ai-mentor/orgs/${encodeURIComponent(org)}/v1/chat/completions`,
  };
}

export type ChatBody = {
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
};

/** One chat/completions call against the brain; the caller reads the body. */
export function iblaiChat(config: IblaiConfig, body: ChatBody): Promise<Response> {
  return fetch(config.chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: body.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify({ model: config.model, ...body }),
    cache: 'no-store',
  });
}
