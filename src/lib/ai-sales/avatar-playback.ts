import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * iOS Safari avatar playback recovery.
 *
 * The live avatar `<video>` receives LiveKit's video AND audio tracks on the
 * SAME element via the SDK's `session.attach(el)`. On iOS Safari the unmuted
 * element's autoplay is rejected (`NotAllowedError`), and LiveKit's own
 * fallback then force-mutes the element to salvage video
 * (livekit-client@2.15.7 `RemoteTrack.attach`: `element.muted = true; play()`).
 * So on iOS the avatar ends up SILENT (video may play muted) or BLACK (if even
 * muted play fails) — the user can't hold a conversation. Desktop/Android
 * autoplay is lenient, so `play()` resolves unmuted and it works (masking it).
 *
 * This controller does NOT issue its own `play()` while the SDK is attaching —
 * that would race the SDK's in-flight `play()` calls and reject with a benign
 * `AbortError`, which would mis-signal "blocked" on desktop. Instead it detects
 * the blocked/silent state from the ELEMENT'S OWN state, and exposes a
 * gesture-bound `resume()` that unmutes + plays (the only thing iOS accepts).
 *
 * Flash-free: `blocked` starts false and only ever flips true via (a) a
 * `'playing'` event fired while the element is muted (LiveKit's muted-video
 * fallback), (b) a settle timer that, after `settleMs`, finds the attached
 * element still paused or muted, or (c) a later `pause`/`volumechange` that
 * finds the element blocked again. `settleMs` (default 1500ms) comfortably
 * outlasts both desktop's async unmuted `play()` resolve (so `'playing'` clears
 * blocked first — no desktop flash) and Safari's DEFERRED `setTimeout(0)`
 * attach (so `srcObject` is set by the time we check).
 *
 * Clearing is asymmetric on purpose. `blocked` is
 * cleared to false ONLY on *confirmed audible playback*: a `'playing'` event
 * while unmuted, or `resume()`'s own `play()` resolving unmuted. The event
 * listeners (`pause`/`volumechange`) can only ever SET blocked true — they
 * never clear it. This closes two real-element failure modes the DOM exposes
 * (but the node-env `FakeMediaEl` did not):
 *   1. `resume()` runs `el.muted = false`, which on a REAL element fires
 *      `volumechange` synchronously-ish, BEFORE `play()` resolves. If that
 *      event were allowed to clear `blocked`, the overlay would unmount before
 *      playback is confirmed — and if `play()` then rejects the user is left
 *      with a black box and no retry affordance.
 *   2. On iOS the block state is *already playing but muted*, so unmuting an
 *      already-playing element resolves `play()` WITHOUT re-firing `'playing'`.
 *      "Only clear on `'playing'`" would therefore wedge the overlay open
 *      forever — so `resume()` clears explicitly on its own `play()` success
 *      instead of leaning on an event that may never come.
 */

export type AvatarPlaybackController = {
  /** Gesture handler: unmute + play. Call synchronously from a click/tap. */
  resume: () => Promise<void>;
  /** Remove listeners + clear the settle timer. Idempotent. */
  dispose: () => void;
};

type OnBlockedChange = (blocked: boolean) => void;

// Non-`playing` events that can change the audible-playback state later
// (e.g. the SDK re-muting the element).
const RECOMPUTE_EVENTS = ['pause', 'volumechange'] as const;

export function createAvatarPlaybackController(
  el: HTMLMediaElement,
  { onBlockedChange, settleMs = 1500 }: { onBlockedChange: OnBlockedChange; settleMs?: number },
): AvatarPlaybackController {
  let disposed = false;
  let sawPlaying = false;

  // Blocked := stream attached but the element is not playing audibly.
  // The iOS avatar block always ends up MUTED — LiveKit force-mutes the
  // audio+video element when its unmuted autoplay is rejected. `paused` on its
  // own is ambiguous (on desktop the element is briefly paused-and-unmuted
  // while the SDK's async play() is still resolving), so we only treat `paused`
  // as blocked once the element has actually played and then stalled
  // (`sawPlaying`). This keeps iOS coverage while staying flash-free on desktop.
  const isBlocked = () => !!el.srcObject && (el.muted || (el.paused && sawPlaying));

  // `playing` is the positive, confirmed-playback signal — the ONLY event
  // allowed to CLEAR blocked. If it fires while muted, the SDK's muted-video
  // fallback is active and the user still needs to restore audio (set blocked);
  // if unmuted, playback is audible (clear blocked).
  const onPlaying = () => {
    if (disposed) return;
    sawPlaying = true;
    onBlockedChange(el.muted);
  };
  // `pause`/`volumechange` re-evaluate the element but may ONLY set blocked
  // true — never clear it. Clearing is reserved for confirmed audible playback
  // (`onPlaying` unmuted, or `resume()` success). This is load-bearing: on a
  // real element `resume()`'s `el.muted = false` fires `volumechange` before
  // `play()` resolves, and letting that clear the overlay would hide it before
  // playback is confirmed.
  const markBlockedIfNeeded = () => {
    if (!disposed && isBlocked()) onBlockedChange(true);
  };

  el.addEventListener('playing', onPlaying);
  for (const ev of RECOMPUTE_EVENTS) el.addEventListener(ev, markBlockedIfNeeded);

  const timer = setTimeout(markBlockedIfNeeded, settleMs);

  return {
    resume: async () => {
      // Un-mute + play, synchronously from the caller's user gesture, so iOS
      // permits unmuted playback. The element already has srcObject from
      // attach(), so this just resumes it.
      el.muted = false;
      try {
        await el.play();
      } catch (err) {
        // play() rejected (dead/again-gestureless element, or the browser
        // still blocking). Keep the overlay up so the user retains a retry
        // affordance instead of being stranded on a black box. Re-throw so the
        // caller can log; state is already correct.
        if (!disposed) onBlockedChange(true);
        throw err;
      }
      // play() resolved: audible iff the element ended up unmuted. We clear
      // explicitly here rather than waiting for a `'playing'` event, which does
      // NOT re-fire when we merely unmute an already-playing (muted-fallback)
      // element.
      if (!disposed) onBlockedChange(el.muted);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      el.removeEventListener('playing', onPlaying);
      for (const ev of RECOMPUTE_EVENTS) el.removeEventListener(ev, markBlockedIfNeeded);
    },
  };
}

/**
 * React wrapper: attaches the stream when ready, then watches for the
 * blocked/silent state and exposes a gesture-bound `requestPlay`.
 *
 * Ordering invariant: `attachStream(el)` (both synchronous `RemoteTrack.attach`
 * calls) runs BEFORE the controller installs its listeners, so the transient
 * muted state between the video-track and audio-track attaches is never
 * observed (no desktop flash).
 */
export function useAvatarPlayback({
  videoRef,
  isStreamReady,
  attachStream,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isStreamReady: boolean;
  attachStream: (element: HTMLMediaElement) => void;
}): { avatarPlaybackBlocked: boolean; requestPlay: () => void } {
  const [avatarPlaybackBlocked, setAvatarPlaybackBlocked] = useState(false);
  const controllerRef = useRef<AvatarPlaybackController | null>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!isStreamReady || !el) return;

    attachStream(el);
    const controller = createAvatarPlaybackController(el, {
      onBlockedChange: setAvatarPlaybackBlocked,
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
      setAvatarPlaybackBlocked(false);
    };
  }, [isStreamReady, attachStream, videoRef]);

  const requestPlay = useCallback(() => {
    // resume() manages `blocked` itself — it clears on confirmed unmuted
    // playback and re-asserts blocked (keeping the overlay for a retry) if
    // play() rejects. We only swallow the re-thrown AbortError/NotAllowedError
    // here so it doesn't surface as an unhandled rejection.
    controllerRef.current?.resume().catch(() => {});
  }, []);

  return { avatarPlaybackBlocked, requestPlay };
}
