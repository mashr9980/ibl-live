import 'server-only';

/**
 * ibl.ai as the brain. The platform exposes an OpenAI-compatible
 * chat/completions endpoint per organization; the streaming host (ASGI)
 * serves both streamed and one-shot completions, so everything goes there.
 */

export type IblaiConfig = { apiKey: string; org: string; model: string; chatUrl: string };
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export const DEFAULT_IBLAI_MODEL = 'google/gemini-3.1-flash-lite';
export const DEFAULT_IBLAI_ASGI_URL = 'https://asgi.data.iblai.app';

/** Null until IBLAI_API_KEY and IBLAI_ORG are both set. */
export function iblaiConfig(): IblaiConfig | null {
  const apiKey = process.env.IBLAI_API_KEY?.trim();
  const org = process.env.IBLAI_ORG?.trim();
  if (!apiKey || !org) return null;
  const model = process.env.IBLAI_MODEL?.trim() || DEFAULT_IBLAI_MODEL;
  const base = (process.env.IBLAI_ASGI_URL?.trim() || DEFAULT_IBLAI_ASGI_URL).replace(/\/+$/, '');
  return {
    apiKey,
    org,
    model,
    chatUrl: `${base}/api/ai-mentor/orgs/${encodeURIComponent(org)}/v1/chat/completions`,
  };
}

export type ChatBody = {
  messages: ChatMessage[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
};

/** One chat/completions call against ibl.ai; the caller reads the body. */
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
