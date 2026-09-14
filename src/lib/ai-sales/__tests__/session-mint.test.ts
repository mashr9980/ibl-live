/**
 * Unit coverage for the session-mint helpers — mode selection,
 * `dynamic_variables` clamping, and busy-error classification.
 */
import { describe, expect, it } from 'vitest';

import { buildDynamicVariables, clampValue, isBusyUpstream } from '../session-mint';

describe('clampValue', () => {
  it('leaves values at or below the limit untouched', () => {
    expect(clampValue('hi')).toBe('hi');
    expect(clampValue('x'.repeat(1000))).toHaveLength(1000);
  });

  it('clamps prose on a word boundary without exceeding the limit', () => {
    const prose = `${'word '.repeat(400)}tail`;
    const clamped = clampValue(prose);
    expect(clamped.length).toBeLessThanOrEqual(1000);
    expect(clamped.endsWith('word')).toBe(true);
  });

  it('hard-cuts when no word boundary is near the limit', () => {
    const clamped = clampValue(`start ${'x'.repeat(2000)}`);
    expect(clamped).toHaveLength(1000);
  });

  it('accepts a custom max', () => {
    expect(clampValue('abcdefghij', 4)).toBe('abcd');
  });
});

describe('buildDynamicVariables', () => {
  it('clamps values, drops empties, and rejects over-long keys', () => {
    const out = buildDynamicVariables({
      username: 'Ada',
      email: '',
      opening_intro: 'y'.repeat(1500),
      ['k'.repeat(65)]: 'ignored',
    });
    expect(Object.keys(out)).toEqual(['username', 'opening_intro']);
    expect(out.opening_intro).toHaveLength(1000);
  });

  it('caps the entry count at 50', () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) input[`k${i}`] = 'v';
    expect(Object.keys(buildDynamicVariables(input))).toHaveLength(50);
  });
});

describe('isBusyUpstream', () => {
  it('treats rate-limit and payment-required as busy regardless of body', () => {
    expect(isBusyUpstream(429, '')).toBe(true);
    expect(isBusyUpstream(402, '')).toBe(true);
  });

  it('treats concurrency/credit wording on 400/403/409 as busy', () => {
    expect(isBusyUpstream(400, '{"message":"Concurrent session limit reached"}')).toBe(true);
    expect(isBusyUpstream(403, '{"message":"insufficient credits"}')).toBe(true);
    expect(isBusyUpstream(409, '{"message":"too many active sessions"}')).toBe(true);
  });

  it('leaves genuine errors alone', () => {
    expect(isBusyUpstream(422, '{"message":"avatar_id must be a uuid"}')).toBe(false);
    expect(isBusyUpstream(401, '{"message":"invalid api key"}')).toBe(false);
    expect(isBusyUpstream(500, 'boom')).toBe(false);
  });
});

import {
  buildTokenPayload,
  busyMessageFor,
  friendlyStartFailure,
  BUSY_MESSAGE,
  NO_CREDITS_MESSAGE,
} from '../session-mint';

describe('buildTokenPayload', () => {
  it('FULL mode carries the persona, the brain and the top-level variables', () => {
    const p = buildTokenPayload({
      mode: 'full',
      avatarId: 'av',
      maxSessionDuration: 120,
      language: 'en',
      contextId: 'ctx',
      voiceId: null,
      sttProvider: 'deepgram',
      llmConfigurationId: 'llm',
      dynamicVariables: { username: 'A', opening_intro: 'Hi A' },
      sandbox: false,
    });
    expect(p).toEqual({
      mode: 'FULL',
      avatar_id: 'av',
      max_session_duration: 120,
      avatar_persona: { language: 'en', context_id: 'ctx', stt_config: { provider: 'deepgram' } },
      llm_configuration_id: 'llm',
      dynamic_variables: { username: 'A', opening_intro: 'Hi A' },
    });
  });

  it('ElevenLabs mode is LITE with the agent config and no top-level variables', () => {
    const p = buildTokenPayload({
      mode: 'elevenlabs',
      avatarId: 'av',
      maxSessionDuration: 120,
      secretId: 'sec',
      agentId: 'agent_1',
      voiceId: null,
      agentVariables: { user_name: 'A' },
      sandbox: true,
    });
    expect(p).toEqual({
      mode: 'LITE',
      avatar_id: 'av',
      max_session_duration: 120,
      is_sandbox: true,
      elevenlabs_agent_config: {
        secret_id: 'sec',
        agent_id: 'agent_1',
        dynamic_variables: { user_name: 'A' },
      },
    });
    expect(p).not.toHaveProperty('dynamic_variables');
    expect(p).not.toHaveProperty('avatar_persona');
  });
});

describe('refusal wording', () => {
  it('names out-of-credits at mint and at start, busy for capacity, null for real bugs', () => {
    expect(busyMessageFor('{"code":4033,"message":"Insufficient credits for session"}')).toBe(
      NO_CREDITS_MESSAGE,
    );
    expect(busyMessageFor('{"message":"concurrent session limit reached"}')).toBe(BUSY_MESSAGE);
    expect(
      friendlyStartFailure(
        'Error: {"code":4033,"data":null,"message":"Insufficient credits for session"}',
      ),
    ).toBe(NO_CREDITS_MESSAGE);
    expect(friendlyStartFailure('429 too many sessions')).toBe(BUSY_MESSAGE);
    expect(friendlyStartFailure('TypeError: x is not a function')).toBeNull();
  });
});
