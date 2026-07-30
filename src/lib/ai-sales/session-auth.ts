import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Constant-time string compare. Length is checked first because
 * `timingSafeEqual` throws on mismatched buffer lengths — that leaks length
 * but not content, which is the standard trade-off.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Bearer-token gate for the OpenAI-compatible Chat Completions endpoint.
// The voice agent sends the configured LLM key as `Authorization: Bearer
// <key>`; we compare it against AI_SALES_LLM_CONFIG_API_KEY.
//
// Threat model: prevents anyone who finds the public host from hitting our
// Anthropic key, exfiltrating the prompt, or enumerating leads via the
// SESSION_EMAIL marker.
export function getLlmConfigApiKey(): string | null {
  const v = process.env.AI_SALES_LLM_CONFIG_API_KEY;
  return v && v.length > 0 ? v : null;
}

export function extractBearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? (m[1] ?? '').trim() : null;
}

export function isValidLlmCaller(req: NextRequest): { ok: true } | { ok: false; reason: string } {
  const expected = getLlmConfigApiKey();
  if (!expected) return { ok: false, reason: 'AI_SALES_LLM_CONFIG_API_KEY unset' };
  const provided = extractBearerToken(req);
  if (!provided) return { ok: false, reason: 'Authorization header missing or malformed' };
  if (!safeEqual(provided, expected)) return { ok: false, reason: 'Bearer token mismatch' };
  return { ok: true };
}

// HMAC over session_id, issued at session mint and required at session end.
// Without it, anyone could spam our session-end pipeline (Notion CRM + Slack
// channel + Anthropic summary) by hitting the public marketing host.
export function getSessionSigningSecret(): string | null {
  const v = process.env.AI_SALES_SESSION_SIGNING_SECRET;
  return v && v.length > 0 ? v : null;
}

export function signSessionId(sessionId: string): string | null {
  const secret = getSessionSigningSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(sessionId).digest('hex');
}

export function verifySessionSignature(sessionId: string, signature: string): boolean {
  const expected = signSessionId(sessionId);
  if (!expected) return false;
  if (!signature || signature.length !== expected.length) return false;
  return safeEqual(signature, expected);
}

// Tiny per-IP rate limit, matching the in-memory pattern already used in
// /api/ai-sales/lead. Process-local; multiple Next instances each track
// independently, which is fine as a soft ceiling against trivial abuse.
type RateBucket = Map<string, { count: number; resetAt: number }>;

export function makeRateLimiter(maxRequests: number, windowMs: number) {
  const bucket: RateBucket = new Map();
  return function allowRequest(ip: string): boolean {
    const now = Date.now();
    const b = bucket.get(ip);
    if (!b || b.resetAt < now) {
      bucket.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (b.count >= maxRequests) return false;
    b.count += 1;
    return true;
  };
}

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0];
    return (first ?? '').trim() || 'unknown';
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}
