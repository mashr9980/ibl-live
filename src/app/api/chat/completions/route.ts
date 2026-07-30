import type { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { clientIp, isValidLlmCaller, makeRateLimiter } from '@/lib/ai-sales/session-auth';
import {
  extractSessionEmail,
  toAnthropicMessages,
  type OpenAIChatRequest,
} from '@/lib/ai-sales/brain/messages';
import { loadPersona } from '@/lib/ai-sales/brain/persona';
import { buildRealworldContextIntro } from '@/lib/ai-sales/brain/realworld';
import { fetchLead } from '@/lib/ai-sales/brain/lead-client';
import { fetchChatHistoryBlock } from '@/lib/ai-sales/brain/notion-history';
import { buildLeadContextBlock } from '@/lib/ai-sales/brain/lead-block';
import { buildSystemPrompt } from '@/lib/ai-sales/brain/prompt';
import {
  DEFAULT_MAX_TOKENS,
  nonStreamingCompletion,
  streamChatCompletion,
} from '@/lib/ai-sales/brain/streaming';

/**
 * OpenAI-compatible chat/completions endpoint — the AI Sales Agent brain,
 * ported from the original Python implementation. The LiveKit voice agent's
 * Custom-LLM `base_url` points here; it calls this per conversational turn
 * with a Bearer secret.
 *
 * Flow: auth → parse → extract SESSION_EMAIL → assemble the system prompt
 * (persona + realworld + lead + Notion history, concurrent, best-effort) →
 * stream Anthropic as OpenAI SSE (default) or return a JSON completion.
 */

export const runtime = 'nodejs'; // persona.ts reads prompt-parts/*.md via fs
export const dynamic = 'force-dynamic';
// Ceiling for a SINGLE turn's function invocation (not the whole conversation
// — LiveKit calls this once per turn). Generous headroom for long completions.
export const maxDuration = 60;

// 120 req/min/IP. In-memory per
// lambda; a soft ceiling, not admission control (abuse not a launch concern).
const allowRequest = makeRateLimiter(120, 60_000);

// Every non-2xx response goes through here so the reason is always logged
// server-side — 5xx as an error, 4xx as a warning. Without this a 500 reaches
// the caller as an opaque body with nothing in the server logs.
function jsonError(message: string, status: number): Response {
  const line = `[ai-sales] chat/completions ${status}: ${message}`;
  if (status >= 500) console.error(line);
  else console.warn(line);
  return Response.json({ error: { message } }, { status });
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    // 1. Auth — constant-time Bearer vs AI_SALES_LLM_CONFIG_API_KEY.
    const auth = isValidLlmCaller(req);
    if (!auth.ok) {
      const status = auth.reason.includes('unset') ? 500 : 401;
      return jsonError(auth.reason, status);
    }

    if (!allowRequest(clientIp(req))) {
      return jsonError('rate limit', 429);
    }

    // 2. Parse the OpenAI request. `stream` defaults to true.
    let body: OpenAIChatRequest;
    try {
      body = (await req.json()) as OpenAIChatRequest;
    } catch {
      return jsonError('invalid JSON body', 400);
    }
    if (!Array.isArray(body?.messages)) {
      return jsonError('messages[] required', 400);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return jsonError('ANTHROPIC_API_KEY is not configured', 500);
    }

    // 3. Assemble the system prompt. The persona (prompt-parts/*.md) is fatal
    //    if it assembles to nothing — 400 before streaming;
    //    realworld / lead / history are best-effort and self-degrade to
    //    empty, so the concurrent gather never rejects (mirrors _build_prompt).
    let persona: string;
    try {
      persona = loadPersona();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'persona unavailable';
      return jsonError(message, 400);
    }

    const email = extractSessionEmail(body.messages);
    const [realworldIntro, lead, historyBlock] = await Promise.all([
      buildRealworldContextIntro(),
      email ? fetchLead(email) : Promise.resolve(null),
      email ? fetchChatHistoryBlock(email) : Promise.resolve(''),
    ]);
    const leadBlock = email ? buildLeadContextBlock(lead) : '';
    const systemPrompt = buildSystemPrompt(persona, leadBlock, historyBlock, realworldIntro);

    // 4. Anthropic messages — user/assistant only, "Hello." fallback if empty.
    const messages = toAnthropicMessages(body.messages);
    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Hello.' });
    }

    const client = new Anthropic({ apiKey });
    const modelLabel = body.model || 'wayne-la-sales'; // real model never on wire
    // Guard caller input — a negative max_tokens or out-of-range temperature
    // would be rejected by Anthropic. Only the trusted internal caller reaches
    // here, but the guards are cheap.
    const maxTokens =
      typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : DEFAULT_MAX_TOKENS;
    const temperature =
      typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 1
        ? body.temperature
        : null;

    // 5a. Non-streaming path — only an explicit `stream:false` opts out.
    if (body.stream === false) {
      const completion = await nonStreamingCompletion({
        client,
        systemPrompt,
        messages,
        modelLabel,
        maxTokens,
        temperature,
      });
      return Response.json(completion);
    }

    // 5b. Streaming path — pump the SSE generator into a ReadableStream.
    // Errors AFTER the first frame are handled inside the generator (surfaced
    // as a content delta), so they don't reach the catch below.
    const encoder = new TextEncoder();
    const generator = streamChatCompletion({
      client,
      systemPrompt,
      messages,
      modelLabel,
      maxTokens,
      temperature,
    });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await generator.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      },
      async cancel() {
        await generator.return?.(undefined);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    // Anything unexpected (e.g. an Anthropic API error on the non-streaming
    // path, or a throw during prompt assembly) lands here — log the full
    // error + stack so a 500 is never opaque, then return a structured 500.
    console.error('[ai-sales] chat/completions unhandled error', err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: { message: `internal error: ${message}` } }, { status: 500 });
  }
}
