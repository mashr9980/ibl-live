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
