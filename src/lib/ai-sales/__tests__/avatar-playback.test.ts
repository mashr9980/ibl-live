/**
 * Unit tests for the iOS-Safari avatar playback recovery controller.
 *
 * Vitest runs `environment: 'node'` (no DOM), so these tests inject a
 * fake `HTMLMediaElement` (an EventTarget-ish stub with mutable
 * `paused`/`muted`/`srcObject` + a `play` mock) and drive the settle timer with
 * fake timers. They discriminate the ACTUAL playback states — playing-unmuted
 * (healthy, no overlay), playing-but-muted (LiveKit's force-mute fallback →
 * overlay), and paused (blocked → overlay) — and the gesture recovery.
 *
 * NOTE: these tests model the *inline* attach/play path. They do NOT model
 * livekit-client's Safari-only DEFERRED `setTimeout(0)` attach; a real-WebKit
 * e2e run is load-bearing there.
 *
 * The fake models the real-element divergences
 * the earlier stub masked — mutating `muted` fires a `volumechange` event (as a
 * real HTMLMediaElement does), and `play()` can be driven to reject (which on a
 * real element also pauses + fires `pause`). These are what let the suite
 * observe the "unmute fires volumechange → clears overlay before play resolves"
 * and "play() rejects → user stranded" failure modes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAvatarPlaybackController } from '../avatar-playback';

class FakeMediaEl {
  paused = true;
  srcObject: unknown = null;
  play = vi.fn(() => Promise.resolve());
  private _muted = false;
  private listeners: Record<string, Set<() => void>> = {};

  // A real HTMLMediaElement dispatches `volumechange` whenever `muted` flips.
  // The previous plain field masked this — so the suite could not see that
  // `resume()`'s `el.muted = false` fires `volumechange` BEFORE `play()`
  // resolves. Model it faithfully.
  get muted() {
    return this._muted;
  }
  set muted(v: boolean) {
    if (this._muted === v) return;
    this._muted = v;
    this.emit('volumechange');
  }

  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= new Set()).add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners[type]?.delete(cb);
  }
  emit(type: string) {
    this.listeners[type]?.forEach((cb) => cb());
  }
  listenerCount(type: string) {
    return this.listeners[type]?.size ?? 0;
  }

  /** Drive `play()` to reject like iOS autoplay denial: pause + fire `pause`. */
  failPlayWith(err: Error) {
    this.play = vi.fn(() => {
      this.paused = true;
      this.emit('pause');
      return Promise.reject(err);
    });
  }
}

const makeController = (el: FakeMediaEl, onBlockedChange: (b: boolean) => void, settleMs = 1500) =>
  createAvatarPlaybackController(el as unknown as HTMLMediaElement, { onBlockedChange, settleMs });

const calls = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.map((c) => c[0] as boolean);

describe('createAvatarPlaybackController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('never_blocked_when_playing_unmuted (desktop autoplay → no overlay)', () => {
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = false;
    el.muted = false;
    const onBlockedChange = vi.fn();

    makeController(el, onBlockedChange);
    el.emit('playing'); // desktop: unmuted playing
    vi.advanceTimersByTime(1500); // settle timer confirms

    expect(calls(onBlockedChange)).not.toContain(true); // overlay never shown
  });

  it('muted_fallback_is_flagged_and_resume_unmutes (regression)', async () => {
    // LiveKit's fallback plays the video MUTED after iOS blocks unmuted autoplay.
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = false;
    el.muted = true; // ← the silent-avatar state
    const onBlockedChange = vi.fn();

    const controller = makeController(el, onBlockedChange);
    el.emit('playing'); // playing but muted
    expect(onBlockedChange).toHaveBeenLastCalledWith(true); // overlay shown to restore audio

    // Gesture recovery: unmute + play.
    await controller.resume();
    expect(el.muted).toBe(false);
    expect(el.play).toHaveBeenCalled();

    el.emit('playing'); // now unmuted playing
    expect(onBlockedChange).toHaveBeenLastCalledWith(false); // overlay hides
  });

  it('blocked_when_muted_fallback_paused_then_recovers_on_gesture (fully-blocked → overlay → tap)', async () => {
    // Real iOS fully-blocked state: LiveKit force-muted the element after the
    // unmuted autoplay was rejected, and even the muted play did not start.
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = true;
    el.muted = true;
    const onBlockedChange = vi.fn();

    const controller = makeController(el, onBlockedChange);
    vi.advanceTimersByTime(1500); // settle timer finds it muted
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);

    await controller.resume();
    expect(el.muted).toBe(false);
    expect(el.play).toHaveBeenCalled();

    el.paused = false;
    el.emit('playing');
    expect(onBlockedChange).toHaveBeenLastCalledWith(false);
  });

  it('no_flash_when_paused_unmuted_before_first_play (no desktop settle-timer flash)', () => {
    // Desktop: attached + unmuted, still paused because the SDK's async play()
    // hasn't resolved yet and the element has NEVER played (sawPlaying=false).
    // The settle timer must NOT flag blocked — otherwise the overlay flashes on
    // a desktop user who has no autoplay problem.
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = true;
    el.muted = false;
    const onBlockedChange = vi.fn();

    makeController(el, onBlockedChange);
    vi.advanceTimersByTime(1500);
    expect(calls(onBlockedChange)).not.toContain(true); // no flash

    el.paused = false;
    el.emit('playing'); // late play resolve
    expect(onBlockedChange).toHaveBeenLastCalledWith(false);
  });

  it('muted_then_unmuted_before_listeners_yields_unblocked (ordering invariant)', () => {
    // The SDK's two synchronous attach() calls mute (video-only) then unmute
    // (audio) BEFORE the controller installs listeners; that transient must not
    // be treated as blocked.
    const el = new FakeMediaEl();
    el.muted = true; // transient during video-track attach
    el.muted = false; // audio-track attach un-mutes
    el.srcObject = {};
    el.paused = false; // playing unmuted by the time the controller starts
    const onBlockedChange = vi.fn();

    makeController(el, onBlockedChange);
    vi.advanceTimersByTime(1500);

    expect(calls(onBlockedChange)).not.toContain(true);
  });

  it('volumechange_from_unmute_does_not_clear_overlay_before_play_resolves (real-element divergence)', async () => {
    // Real iOS block: element is PLAYING but MUTED (LiveKit's fallback). The
    // overlay is shown. A tap runs `el.muted = false`, which on a real element
    // fires `volumechange` BEFORE `play()` resolves. The overlay must NOT
    // unmount on that transient event — only on confirmed unmuted playback.
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = false;
    el.muted = true;
    const onBlockedChange = vi.fn();

    const controller = makeController(el, onBlockedChange);
    el.emit('playing'); // playing but muted → overlay shown
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);

    // Deferred play so we can inspect state between unmute and play-resolve.
    let resolvePlay!: () => void;
    el.play = vi.fn(() => new Promise<void>((r) => (resolvePlay = r)));

    const pending = controller.resume(); // sets muted=false → fires volumechange
    // The volumechange fired synchronously inside the setter. It must NOT have
    // cleared the overlay — blocked is still true, no `false` emitted yet.
    expect(calls(onBlockedChange)).not.toContain(false);

    resolvePlay();
    await pending;
    // Now that play() resolved unmuted, the overlay clears — exactly once, on
    // confirmed audible playback.
    expect(onBlockedChange).toHaveBeenLastCalledWith(false);
  });

  it('play_rejection_keeps_overlay_for_retry (retry affordance, sawPlaying=false)', async () => {
    // Fully-blocked muted state reached via the settle timer (element never
    // fired `playing`, so sawPlaying=false). This is the path where the naive
    // "clear on volumechange" would strand the user: unmuting clears the
    // overlay, play() rejects, and no `pause`/`playing` re-shows it.
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = true;
    el.muted = true;
    const onBlockedChange = vi.fn();

    const controller = makeController(el, onBlockedChange);
    vi.advanceTimersByTime(1500); // settle timer flags blocked (muted)
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);

    el.failPlayWith(new Error('NotAllowedError'));
    await expect(controller.resume()).rejects.toThrow('NotAllowedError');

    // The overlay must remain (retry affordance). Despite the unmute's
    // volumechange and the rejected play's pause, blocked was never cleared.
    expect(calls(onBlockedChange)).not.toContain(false);
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);
  });

  it('resume_clears_overlay_without_a_new_playing_event (no wedged overlay)', async () => {
    // On iOS the block state is *already playing, muted*. Unmuting an
    // already-playing element resolves play() WITHOUT re-firing `playing`, so a
    // "clear only on playing" design would wedge the overlay open forever.
    // resume() must clear on its own play()-resolve instead.
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = false;
    el.muted = true;
    const onBlockedChange = vi.fn();

    const controller = makeController(el, onBlockedChange);
    el.emit('playing'); // playing but muted → overlay shown
    expect(onBlockedChange).toHaveBeenLastCalledWith(true);

    // play() resolves immediately (already playing); NO new 'playing' event.
    await controller.resume();

    expect(el.muted).toBe(false);
    expect(onBlockedChange).toHaveBeenLastCalledWith(false); // cleared, not wedged
  });

  it('dispose_removes_listeners_no_duplicate (leak/idempotency)', () => {
    const el = new FakeMediaEl();
    el.srcObject = {};
    el.paused = true;
    const onBlockedChange = vi.fn();

    const controller = makeController(el, onBlockedChange);
    expect(el.listenerCount('playing')).toBe(1);
    controller.dispose();
    expect(el.listenerCount('playing')).toBe(0);
    controller.dispose(); // idempotent

    el.muted = true;
    el.emit('playing');
    el.emit('volumechange');
    el.emit('pause');
    vi.advanceTimersByTime(1500); // timer was cleared on dispose

    expect(onBlockedChange).not.toHaveBeenCalled();
  });
});
