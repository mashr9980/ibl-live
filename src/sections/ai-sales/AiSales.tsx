'use client';

/**
 * Main section for `/ai-sales-agent`.
 *
 * Renders an inline avatar card on the page (no full-screen modal — page
 * chrome stays visible). Two entry points:
 *
 *   1. Deep link from an email follow-up: `/ai-sales-agent?name=X&email=Y`.
 *      We skip the setup step, request mic permission, and auto-start.
 *   2. Fresh visitor: `/ai-sales-agent`. We collect name + email via the
 *      inline form, then request mic permission, then auto-start.
 *
 * Layout: heading + avatar window (16:9) on the left, optional toggleable
 * transcript pane on the right showing the live conversation (per-utterance
 * stream from useChatHistory). When ?debug=1, the prompt/lead inspector
 * panel renders below the avatar instead of overlaying it.
 *
 * On the backend, `/api/ai-sales/session` resolves the email against our
 * configured lead resolver and builds a context-aware opening line carried
 * on the session JWT as
 * `${opening_intro}`. The LiveKit agent substitutes it into
 * Context.opening_text at dispatch, so the guide's first spoken line is lead-
 * aware. On DISCONNECTED we POST the transcript to
 * `/api/ai-sales/session-end` for summary → Notion → Slack fan-out.
 */
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCountDown } from 'ahooks';
import { twMerge } from 'tailwind-merge';

import {
  AgentEventsEnum,
  LiveAvatarContextProvider,
  type LiveAvatarSessionMessage,
  SessionState,
  useAvatarActions,
  useChatHistory,
  useLiveAvatarContext,
  useSession,
  useVoiceChat,
} from '@/lib/vendor/liveavatar-react';

type AvatarTurnState = {
  id: string;
  buffered: string;
  revealed: number;
  timestamp: number;
  // The final `avatar.transcription` event closes a turn. Once true, the
  // next incoming chunk opens a fresh turn instead of appending here, so
  // each user/avatar exchange renders as its own bubble in the transcript.
  isFinalized: boolean;
};

// ~44 chars/sec — midway between the earlier 67 chars/sec (raced ahead of
// audio in long bursts) and the slower 22 chars/sec (lagged noticeably
// behind the avatar's TTS). At this rate captions sit just ahead of audio.
const REVEAL_CHARS_PER_TICK = 2;
const REVEAL_TICK_MS = 45;

// Wrap-up signal threshold. When ≤ this many seconds remain, the FE pushes a
// `session.time_warning` so the agent injects a one-shot system note into the
// next LLM turn (avatar mentions the hard stop / offers an email follow-up).
// Sized for the 600s demo cap — 2 minutes gives the avatar enough room to wrap
// without feeling rushed. Visual chip escalates amber at the same threshold.
const TIME_WARNING_THRESHOLD_SEC = 120;
// Cosmetic-only red threshold for the timer chip — last 30s of the call.
const TIME_RED_THRESHOLD_SEC = 30;
import MicPermission from './components/MicPermission';
import MicDropdown from './components/MicDropdown';
import TapToPlayOverlay from './components/TapToPlayOverlay';
import type { AgentIdentity } from '@/lib/ai-sales/brain/agent-identity';
import { readLeadHint, writeLeadHint } from '@/lib/ai-sales/setup-storage';
import { usePrewarmMint } from '@/lib/ai-sales/use-prewarm-mint';
import { useAvatarPlayback } from '@/lib/ai-sales/avatar-playback';
import { friendlyStartFailure, NO_CREDITS_MESSAGE } from '@/lib/ai-sales/session-mint';

type TokenResponse = {
  session_id: string;
  session_token: string;
  session_signature: string | null;
  api_base: string;
  mode?: 'full' | 'elevenlabs';
  lead: {
    first_name: string | null;
    company: string | null;
    is_liveavatar_user: boolean;
    // Optional: only present on the fresh mint response. Restored hints
    // (StoredLeadHint, PreMintTokenResponse) omit it since they're cached /
    // pre-mint and don't carry the survey signal.
    survey_lead?: boolean;
  } | null;
};

type PermissionState = 'idle' | 'granted' | 'denied';

/**
 * Recognize the mint route's busy shape — `{ error: { code: 'busy', message } }`
 * — in a raw error body. Returns the message to show, or null when this is an
 * ordinary failure that should surface as an error.
 */
function readBusyMessage(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { code?: string; message?: string } };
    if (parsed?.error?.code !== 'busy') return null;
    return parsed.error.message || 'All avatar sessions are busy right now. Please try again.';
  } catch {
    return null;
  }
}

export default function AiSales({ identity }: { identity: AgentIdentity }) {
  return (
    <LiveAvatarContextProvider>
      <AiSalesInline identity={identity} />
    </LiveAvatarContextProvider>
  );
}

function AiSalesInline({ identity }: { identity: AgentIdentity }) {
  const searchParams = useSearchParams();
  const urlName = (searchParams.get('name') ?? '').trim();
  const urlEmail = (searchParams.get('email') ?? '').trim();
  const hasUrlLead = urlName.length > 0 && urlEmail.length > 0;
  const debugMode = searchParams.get('debug') === '1';

  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionStartRef = useRef<number | null>(null);
  const sessionEndedRef = useRef(false);
  // Session credentials surfaced to /api/ai-sales/session-end so it can verify
  // the caller minted via /api/ai-sales/session (HMAC) — without these, anyone
  // with the public URL could spam the Notion/Slack fan-out.
  const sessionIdRef = useRef<string | null>(null);
  const sessionSignatureRef = useRef<string | null>(null);
  // Fires once when the countdown crosses the wrap-up threshold so we don't
  // spam the agent. Reset alongside other refs at session start.
  const timeWarningSentRef = useRef(false);
  // In ElevenLabs mode the agent owns the voice; a speak_text command would be ignored or collide.
  const sessionModeRef = useRef<'full' | 'elevenlabs'>('full');
  const {
    attachStream,
    startSession,
    stopSession,
    isStreamReady,
    sessionState,
    maxSessionDuration,
  } = useSession();
  const { isMuted, mute, unmute, setDevice: setVoiceChatDevice } = useVoiceChat();
  const { chatHistory } = useChatHistory();
  const { sessionRef } = useLiveAvatarContext();
  const { interrupt, repeat } = useAvatarActions();

  // Attach the avatar stream when ready AND recover from iOS Safari's
  // unmuted-autoplay block. `attachStream` is the same SDK call as before; the
  // hook adds a gesture-bound retry (surfaced via TapToPlayOverlay below) for
  // when the browser leaves the avatar paused/muted. No-op on desktop/Android.
  const { avatarPlaybackBlocked, requestPlay } = useAvatarPlayback({
    videoRef,
    isStreamReady,
    attachStream,
  });

  // Avatar turns owned by this component (we don't read them from
  // useChatHistory because that fires once at speech-end, too late for live
  // captioning). The backend emits `avatar.transcription.chunk` as each LLM
  // token arrives — well before the avatar finishes speaking — and the final
  // `avatar.transcription` closes the turn with the canonical text.
  //
  // Turn boundaries are derived from arrival order, not from an id: each
  // chunk appends to the last turn unless it's already finalized, in which
  // case it opens a new one. `source_event_id` looks like the natural key but
  // isn't usable here — it's only registered for client-driven speak
  // commands, so every chunk of an STT-triggered response carries the same
  // stale id and they'd all bucket into one ever-growing line.
  const [avatarTurns, setAvatarTurns] = useState<AvatarTurnState[]>([]);

  useEffect(() => {
    if (sessionState !== SessionState.CONNECTED) return;
    const session = sessionRef.current;
    if (!session) return;

    const onChunk = ({ text }: { text: string }) => {
      if (!text) return;
      setAvatarTurns((prev) => {
        const last = prev[prev.length - 1];
        // Open a new turn when there's no prior turn or the previous one has
        // been finalized (post-final, post-interrupt). Otherwise append onto
        // the in-flight turn.
        if (!last || last.isFinalized) {
          return [
            ...prev,
            {
              id: `${Date.now()}-${prev.length}`,
              buffered: text,
              revealed: 0,
              timestamp: Date.now(),
              isFinalized: false,
            },
          ];
        }
        const next = prev.slice();
        next[prev.length - 1] = { ...last, buffered: last.buffered + text };
        return next;
      });
    };

    // Authoritative final. Two cases:
    //   - chunks dropped → final is longer than buffered; replace to recover
    //     the missing words.
    //   - interrupted → final is the audible-only portion, shorter than the
    //     full response we've already buffered and shown. Keep buffered so
    //     revealed text doesn't visibly shrink after the user has seen it.
    // Either way, mark finalized so the next chunk opens a new turn.
    const onFinal = ({ text }: { text: string }) => {
      if (!text) return;
      setAvatarTurns((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.isFinalized) {
          // Final arrived before any chunks (or after the turn already
          // closed). Treat as a complete turn on its own.
          return [
            ...prev,
            {
              id: `${Date.now()}-${prev.length}`,
              buffered: text,
              revealed: 0,
              timestamp: Date.now(),
              isFinalized: true,
            },
          ];
        }
        const next = prev.slice();
        next[prev.length - 1] = {
          ...last,
          buffered: text.length >= last.buffered.length ? text : last.buffered,
          isFinalized: true,
        };
        return next;
      });
    };

    session.on(AgentEventsEnum.AVATAR_TRANSCRIPTION_CHUNK, onChunk);
    session.on(AgentEventsEnum.AVATAR_TRANSCRIPTION, onFinal);
    return () => {
      session.off(AgentEventsEnum.AVATAR_TRANSCRIPTION_CHUNK, onChunk);
      session.off(AgentEventsEnum.AVATAR_TRANSCRIPTION, onFinal);
    };
  }, [sessionState, sessionRef]);

  // Typewriter-paced reveal. Chunks arrive in LLM-token bursts that would
  // otherwise outrun the avatar's TTS; we drip text out at REVEAL_CHARS_PER_TICK
  // / REVEAL_TICK_MS so captions stay just ahead of audio. Advances every
  // turn whose revealed cursor trails buffered text — which in practice is
  // only the most recent in-flight turn, but we don't special-case it.
  useEffect(() => {
    if (sessionState !== SessionState.CONNECTED) return;
    const interval = setInterval(() => {
      setAvatarTurns((prev) => {
        let changed = false;
        const next = prev.map((t) => {
          if (t.revealed < t.buffered.length) {
            changed = true;
            return {
              ...t,
              revealed: Math.min(t.buffered.length, t.revealed + REVEAL_CHARS_PER_TICK),
            };
          }
          return t;
        });
        return changed ? next : prev;
      });
    }, REVEAL_TICK_MS);
    return () => clearInterval(interval);
  }, [sessionState]);

  // Form state
  const [formName, setFormName] = useState(urlName);
  const [formEmail, setFormEmail] = useState(urlEmail);
  const [hasSetupComplete, setHasSetupComplete] = useState(hasUrlLead);

  // Mic + devices
  const [permissionState, setPermissionState] = useState<PermissionState>('idle');
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  // Connection
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasAttemptedStart, setHasAttemptedStart] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Upstream capacity/credit exhaustion (`{ error: { code: 'busy' } }` from
  // /api/ai-sales/session). Not an app error — the visitor just needs to come
  // back in a moment — so it gets its own stage with a retry affordance
  // instead of the red error text.
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [resolvedLead, setResolvedLead] = useState<TokenResponse['lead']>(null);

  // Right-rail transcript pane. Default open on desktop only — on mobile the
  // pane appears as an overlay drawer when toggled, so we keep it shut by
  // default to give the avatar window the full viewport width.
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  // Browsers block unmuted autoplay until the page has a user activation gesture.
  // URL-params flow auto-resolves both setup + (cached) mic permission with zero
  // clicks, so LiveKit silently mutes the <video> when it tries play(). Gate
  // start-session on at least one fresh click in this page lifetime.
  const [hasUserGesture, setHasUserGesture] = useState(false);

  // Pre-warmed session-mint promise. The hook fires the same /api/ai-sales/
  // session POST handleStart uses as soon as the user has shown intent (form
  // complete + mic granted but no fresh user gesture yet — i.e. we're sitting
  // on ReadyStage). handleStart awaits this ref so the avatar joins ~one
  // round-trip sooner.
  const preMintRef = usePrewarmMint({
    hasSetupComplete,
    permissionGranted: permissionState === 'granted',
    hasUserGesture,
    hasAttemptedStart,
    name: formName,
    email: formEmail,
  });

  // Timer
  const [targetDate, setTargetDate] = useState<Date | null>(null);
  const [, { minutes, seconds }] = useCountDown({
    targetDate,
    onEnd: () => {
      stopSession();
    },
  });
  const remainingSeconds = minutes * 60 + seconds;

  // Once the countdown crosses the wrap-up threshold, interrupt whatever
  // Wayne is currently saying and have him deliver a canned goodbye so the
  // call ends gracefully instead of getting cut mid-word when the max-duration
  // timer fires. FE-only — uses the SDK's interrupt + repeat primitives so the
  // shared livekit_avatar agent stays generic (no Wayne-specific handlers).
  //
  // Known limitation: an in-flight LLM completion can still pre-empt the
  // canned wrap-up with its own TTS, so the line is occasionally cut. Wayne
  // is aware; the proper fix (system-note injection into the next LLM turn)
  // needs agent-side support and will land in a follow-up PR.
  useEffect(() => {
    if (sessionState !== SessionState.CONNECTED) return;
    if (!targetDate) return;
    if (timeWarningSentRef.current) return;
    if (sessionModeRef.current === 'elevenlabs') return;
    // Short caps (sandbox is 60 s, small free tiers) warn at a quarter of the
    // session instead of two minutes, or the wrap-up would fire at the start.
    const warnAt = Math.min(
      TIME_WARNING_THRESHOLD_SEC,
      Math.max(10, Math.floor((maxSessionDuration ?? 600) / 4)),
    );
    if (remainingSeconds <= 0 || remainingSeconds > warnAt) return;
    timeWarningSentRef.current = true;

    interrupt();
    repeat(
      "We're almost out of time, so let me wrap up with the key points. " +
        'You can always continue on the website or book a call with the team.',
    );
  }, [sessionState, targetDate, remainingSeconds, maxSessionDuration, interrupt, repeat]);

  // Hydrate the cached resolved-lead chrome (first_name / company) once we
  // know the email, so ConnectingStage can show "Welcoming Wayne from Acme"
  // instantly on revisit instead of waiting for /api/ai-sales/session.
  // Cache key is the (lowercased) email — only applies when the visitor has
  // either deep-linked with ?email= or just submitted the SetupForm. We do
  // NOT auto-restore name/email itself: a fresh visit (no URL params) must
  // always show the form, since cached identity ≠ confirmed identity.
  useEffect(() => {
    const email = formEmail.trim();
    if (!email) return;
    const hint = readLeadHint(email);
    if (hint) setResolvedLead(hint);
  }, [formEmail]);

  // Probe mic permission on mount
  useEffect(() => {
    let mounted = true;
    let permissionStatusRef: PermissionStatus | null = null;
    (async () => {
      try {
        const permissions: Permissions | undefined = (
          navigator as Navigator & { permissions?: Permissions }
        ).permissions;
        if (!permissions) return;
        const status = await permissions.query({ name: 'microphone' as unknown as PermissionName });
        if (!mounted || !status) return;
        permissionStatusRef = status;
        if (status.state === 'granted') setPermissionState('granted');
        else if (status.state === 'denied') setPermissionState('denied');
        status.onchange = () => {
          const s = status.state;
          if (s === 'granted') setPermissionState('granted');
          else if (s === 'denied') setPermissionState('denied');
          else setPermissionState('idle');
        };
      } catch {
        // Safari doesn't expose navigator.permissions for mic — stays 'idle'.
      }
    })();
    return () => {
      mounted = false;
      if (permissionStatusRef) permissionStatusRef.onchange = null;
    };
  }, []);

  const refreshAudioDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audios = devices.filter((d) => d.kind === 'audioinput');
      setAudioDevices(audios);
      setSelectedDeviceId((current) => {
        if (current && audios.some((d) => d.deviceId === current)) return current;
        return audios[0]?.deviceId ?? '';
      });
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (permissionState !== 'granted') return;
    refreshAudioDevices();
    const handleChange = () => refreshAudioDevices();
    navigator.mediaDevices.addEventListener('devicechange', handleChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleChange);
  }, [permissionState, refreshAudioDevices]);

  const requestMicPermission = useCallback(async () => {
    setHasUserGesture(true);
    try {
      const audio: MediaTrackConstraints | true = selectedDeviceId
        ? { deviceId: { exact: selectedDeviceId } }
        : true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      stream.getTracks().forEach((t) => t.stop());
      setPermissionState('granted');
      await refreshAudioDevices();
    } catch {
      setPermissionState('denied');
    }
  }, [refreshAudioDevices, selectedDeviceId]);

  const handleSetupSubmit = useCallback(() => {
    const name = formName.trim();
    const email = formEmail.trim();
    if (!name || (email && !/@/.test(email))) return;
    setHasUserGesture(true);
    setHasSetupComplete(true);
  }, [formName, formEmail]);

  const handleStart = useCallback(async () => {
    if (hasAttemptedStart) return;
    setHasAttemptedStart(true);
    setErrorMessage(null);
    setBusyMessage(null);
    setIsConnecting(true);
    const name = formName.trim();
    const email = formEmail.trim();
    try {
      // Reuse the pre-warmed promise from the pre-warm effect when one was
      // started.
      let data: TokenResponse | null = null;
      const cached = preMintRef.current;
      if (cached) {
        try {
          data = await cached;
        } catch {
          data = null;
        }
      }
      if (!data) {
        const res = await fetch('/api/ai-sales/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email }),
        });
        if (!res.ok) {
          const text = await res.text();
          // 503 + `code: 'busy'` = the account is at its concurrency ceiling
          // or out of credits. Show the busy stage (with retry) rather than
          // the generic failure text.
          const busy = readBusyMessage(text);
          if (busy) {
            setBusyMessage(busy);
            preMintRef.current = null;
            return;
          }
          throw new Error(`Failed to start session (${res.status}): ${text}`);
        }
        data = (await res.json()) as TokenResponse;
      }
      setResolvedLead(data.lead);
      // localStorage write (not HTTP) — pre-fills welcome chrome on revisit.
      if (data.lead) writeLeadHint(email, data.lead);
      sessionIdRef.current = data.session_id;
      sessionSignatureRef.current = data.session_signature;
      sessionModeRef.current = data.mode ?? 'full';
      sessionStartRef.current = Date.now();
      timeWarningSentRef.current = false;
      // Clear the pre-mint ref now that we've consumed the token. Today the
      // UX is single-shot (no restart from EndedStage), so this is purely
      // forward-looking: it prevents a future "Talk again" affordance from
      // silently reusing stale credentials before usePrewarmMint can re-fire.
      preMintRef.current = null;
      await startSession(data.session_token, {
        voiceChat: selectedDeviceId ? { deviceId: selectedDeviceId } : true,
        apiUrl: data.api_base,
      });
    } catch (err) {
      console.error('[ai-sales] start failed', err);
      const raw = err instanceof Error ? err.message : 'Something went wrong.';
      // Out of credits or capacity at the start step: the friendly screen, not the raw JSON.
      const friendly = friendlyStartFailure(raw);
      if (friendly) setBusyMessage(friendly);
      else setErrorMessage(raw);
      sessionStartRef.current = null; // never connected: nothing to summarize
      setHasAttemptedStart(false); // allow retry
      preMintRef.current = null;
    } finally {
      setIsConnecting(false);
    }
  }, [formName, formEmail, hasAttemptedStart, preMintRef, selectedDeviceId, startSession]);

  // Auto-start once setup is done, mic is granted, AND there's been at least
  // one user click in this page lifetime (autoplay policy).
  useEffect(() => {
    if (
      hasSetupComplete &&
      permissionState === 'granted' &&
      hasUserGesture &&
      !hasAttemptedStart &&
      sessionState === SessionState.INACTIVE
    ) {
      handleStart();
    }
  }, [
    hasSetupComplete,
    permissionState,
    hasUserGesture,
    hasAttemptedStart,
    sessionState,
    handleStart,
  ]);

  // Stream attach + iOS-Safari playback recovery moved into
  // useAvatarPlayback (declared above). Do not re-add a raw attach effect here.

  // Start countdown when we have a duration
  useEffect(() => {
    if (maxSessionDuration) {
      setTargetDate(new Date(Date.now() + maxSessionDuration * 1000));
    }
  }, [maxSessionDuration]);

  // On DISCONNECTED, fire the session-end pipeline exactly once.
  useEffect(() => {
    if (sessionState !== SessionState.DISCONNECTED) return;
    if (sessionEndedRef.current) return;
    if (!sessionStartRef.current) return; // never connected — nothing to report
    sessionEndedRef.current = true;
    const startedAt = new Date(sessionStartRef.current).toISOString();
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - sessionStartRef.current;
    const transcript = coalesceTurns(chatHistory).map((t) => ({
      sender: t.sender,
      message: t.message,
      timestamp: t.timestamp,
    }));
    // The session-end fan-out is keyed on the minted session id.
    if (!sessionIdRef.current) {
      console.warn('[ai-sales] session-end skipped — missing session id');
      return;
    }
    // The signed Notion+Slack fan-out requires the session signature. In
    // envs without AI_SALES_SESSION_SIGNING_SECRET the signature is null
    // and the route would 401 — skip cleanly with a self-describing log.
    if (!sessionSignatureRef.current) {
      console.warn('[ai-sales] session-end POST skipped — missing session signature');
      return;
    }

    const payload = JSON.stringify({
      session_id: sessionIdRef.current,
      session_signature: sessionSignatureRef.current,
      name: formName.trim(),
      email: formEmail.trim(),
      transcript,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: durationMs,
      // ?debug=1 → prefix the Notion CRM row title with [test] so QA traffic
      // is filterable from real visitor sessions in the same database.
      debug: debugMode,
    });
    // Fire-and-forget — user UX shouldn't wait for Notion/Slack round-trips.
    fetch('/api/ai-sales/session-end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: payload,
    }).catch((err) => console.error('[ai-sales] session-end failed', err));
  }, [sessionState, chatHistory, formName, formEmail, debugMode]);

  const handleEnd = useCallback(() => {
    try {
      stopSession();
    } catch {
      // noop
    }
    setTargetDate(null);
  }, [stopSession]);

  const handleDeviceChangeLive = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      setVoiceChatDevice({ exact: deviceId }).catch((err) => {
        console.error('[ai-sales] set mic failed', err);
      });
    },
    [setVoiceChatDevice],
  );

  // Retry after a busy mint. Clearing `hasAttemptedStart` lets the auto-start
  // effect re-fire (setup + mic + gesture are all still satisfied), so this is
  // the same code path as the first attempt.
  const handleBusyRetry = useCallback(() => {
    setBusyMessage(null);
    setErrorMessage(null);
    setHasAttemptedStart(false);
  }, []);

  // Derived stage
  const stage: 'setup' | 'mic' | 'ready' | 'busy' | 'connecting' | 'connected' | 'ended' = (() => {
    // A refused start leaves the SDK DISCONNECTED; the refusal screen wins over "ended".
    if (busyMessage) return 'busy';
    if (sessionState === SessionState.DISCONNECTED) return 'ended';
    if (sessionState === SessionState.CONNECTED && isStreamReady) return 'connected';
    if (
      isConnecting ||
      sessionState === SessionState.CONNECTING ||
      (sessionState === SessionState.CONNECTED && !isStreamReady)
    )
      return 'connecting';
    if (!hasSetupComplete) return 'setup';
    if (permissionState !== 'granted') return 'mic';
    if (!hasUserGesture) return 'ready';
    return 'connecting'; // auto-start effect will advance us
  })();

  const showHeaderTimer = stage === 'connected' || stage === 'connecting';
  // Gate "Show transcript" to states where a transcript
  // actually exists / is being built. Pre-session stages have nothing
  // to show; `ended` preserves review-after capability.
  const showTranscriptToggle = stage === 'connected' || stage === 'ended';
  const userFirstName = (formName.trim().split(/\s+/)[0] || '').trim();

  return (
    <section className="w-full px-4 md:px-6 py-6 md:py-12">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 md:mb-8 text-center">
          <h1 className="font-semibold text-3xl md:text-5xl tracking-[-0.02em] bg-gradient-to-r from-white to-[#F1ECFA] bg-clip-text text-transparent">
            Meet {identity.name}, the live guide to {identity.product}
          </h1>
          <p className="mt-2 text-white/70 text-sm md:text-base max-w-2xl mx-auto">
            A real-time avatar that answers your questions about {identity.product}.
            <br />
            Ask about the products, who uses them, and how to get started.
          </p>
        </header>

        <div
          className={twMerge(
            'grid grid-cols-1 gap-4 items-stretch',
            transcriptOpen && 'lg:grid-cols-[1fr_320px]',
          )}
        >
          {/* Avatar window — single 16:9 surface used across all stages.

              `w-full` is load-bearing on iOS Safari. This box is a
              grid item (parent is `grid grid-cols-1` / `lg:grid-cols-[1fr_320px]`)
              carrying `aspect-ratio: 16/9`. WebKit does NOT apply the grid's
              implicit `justify-self: stretch` to an aspect-ratio item, so it
              collapses the width toward 0 (→ ~4×2px = an invisible sliver: the
              whole avatar section "disappears" between the header and footer).
              Chromium stretches it correctly, which masked the bug on every
              desktop/Chromium check. An explicit `width: 100%` pins the box to
              the column width and lets `aspect-ratio` derive the height, on
              every engine. (`flex-1` was inert here — a grid item ignores flex
              sizing — and is dropped.) */}
          <div
            data-testid="ai-sales-avatar-window"
            className="relative w-full min-w-0 aspect-video rounded-[22px] overflow-hidden bg-black border border-white/10"
          >
            <video
              ref={videoRef}
              className="absolute inset-0 w-full h-full object-cover"
              autoPlay
              playsInline
              muted={false}
            />

            <div
              className={twMerge(
                'absolute inset-0 flex flex-col',
                stage !== 'connected' && 'bg-[rgba(24,21,24,0.85)] backdrop-blur-[12px]',
              )}
            >
              {/* Top right: timer (live) or transcript toggle (always) */}
              <div className="relative z-20 flex items-start justify-end px-4 pt-4 md:px-6 md:pt-6">
                <div className="flex items-center gap-2">
                  {showHeaderTimer && (
                    // Escalate chip color as time runs out: neutral → amber
                    // (last minute, when the wrap-up signal has fired) → red
                    // (last 30s, hard cutoff imminent). Pure cosmetic — the
                    // graceful wrap-up itself is driven by the LLM nudge.
                    // The big "End session" CTA below is the only stop affordance.
                    <div
                      className={twMerge(
                        'inline-flex h-[36px] items-center justify-center rounded-full px-3 text-white transition-colors',
                        remainingSeconds > 0 && remainingSeconds <= TIME_RED_THRESHOLD_SEC
                          ? 'bg-red-500/90'
                          : remainingSeconds > 0 && remainingSeconds <= TIME_WARNING_THRESHOLD_SEC
                            ? 'bg-amber-500/80'
                            : 'bg-[#363036]',
                      )}
                    >
                      <span className="font-semibold text-[13px]">
                        {minutes}:{seconds.toString().padStart(2, '0')}
                      </span>
                    </div>
                  )}
                  {showTranscriptToggle && (
                    // Only render the toggle when a transcript
                    // is being / has been recorded. Pre-session stages (setup,
                    // mic, ready, connecting) have nothing to show; gating
                    // hides the affordance until it's actionable.
                    <button
                      type="button"
                      data-testid="show-transcript-btn"
                      onClick={() => setTranscriptOpen((v) => !v)}
                      aria-pressed={transcriptOpen}
                      className="inline-flex h-[36px] items-center gap-2 rounded-full bg-white/10 hover:bg-white/15 px-3 text-white text-[12px] font-semibold cursor-pointer"
                    >
                      {transcriptOpen ? 'Hide transcript' : 'Show transcript'}
                    </button>
                  )}
                </div>
              </div>

              {/* Stage content */}
              <div className="relative z-20 w-full flex flex-col flex-1 items-center justify-end pb-4 md:pb-6 overflow-y-auto">
                {stage === 'setup' && (
                  <SetupForm
                    name={formName}
                    setName={setFormName}
                    email={formEmail}
                    setEmail={setFormEmail}
                    onSubmit={handleSetupSubmit}
                    errorMessage={errorMessage}
                    identity={identity}
                  />
                )}

                {stage === 'mic' && (
                  <MicPermission
                    onEnable={requestMicPermission}
                    permissionState={permissionState}
                  />
                )}

                {stage === 'ready' && (
                  <ReadyStage
                    name={formName}
                    company={resolvedLead?.company ?? null}
                    onStart={() => setHasUserGesture(true)}
                  />
                )}

                {stage === 'busy' && (
                  <BusyStage message={busyMessage ?? ''} onRetry={handleBusyRetry} />
                )}

                {stage === 'connecting' && <ConnectingStage identity={identity} />}

                {stage === 'connected' && (
                  <LiveControls
                    isMuted={isMuted}
                    toggleMuted={() => (isMuted ? unmute() : mute())}
                    onEnd={handleEnd}
                    audioDevices={audioDevices}
                    selectedDeviceId={selectedDeviceId}
                    onDeviceChange={handleDeviceChangeLive}
                  />
                )}

                {stage === 'ended' && <EndedStage />}
              </div>
            </div>

            {/* iOS Safari blocks the unmuted avatar autoplay; this
                gesture-bound recovery mounts ONLY when playback is actually
                blocked (paused/muted after attach). No-op on desktop/Android.

                `stage === 'connected'` is a hard guard, not cosmetic: the
                controller reads the live element's own state, and on teardown
                the SDK fires `SESSION_STATE_CHANGED → DISCONNECTED` (→ stage
                'ended') and the element's `pause` on independent ticks. Since
                the hook clears `avatarPlaybackBlocked` in a post-paint effect
                cleanup, a `pause` in that window could otherwise paint the
                overlay over `EndedStage` — and a tap would call play() on a
                dead stream. Gating to `connected` also suppresses the overlay
                during a transient `connecting` re-attach (isStreamReady flips
                false → stage 'connecting'). The live stream only exists while
                connected, so this is the only stage the overlay is valid. */}
            {stage === 'connected' && avatarPlaybackBlocked && (
              <TapToPlayOverlay onTap={requestPlay} agentName={identity.name} />
            )}
          </div>

          {/* Right-rail transcript pane — toggleable. Hidden on mobile until
              opened (then becomes a sheet below the avatar). */}
          {transcriptOpen && (
            // On lg, position TranscriptPane absolutely inside the aside so
            // its content is out of normal flow — the grid row track sizes
            // to the avatar's aspect-video height instead of growing with
            // transcript content.
            <aside className="lg:relative lg:min-h-0">
              <div className="lg:absolute lg:inset-0">
                <TranscriptPane
                  chatHistory={chatHistory}
                  avatarTurns={avatarTurns}
                  userName={userFirstName || 'You'}
                  avatarName={identity.name}
                  onClose={() => setTranscriptOpen(false)}
                />
              </div>
            </aside>
          )}
        </div>
      </div>
    </section>
  );
}

// --- Stages ------------------------------------------------------------------

function SetupForm({
  name,
  setName,
  email,
  setEmail,
  onSubmit,
  errorMessage,
  identity,
}: {
  name: string;
  setName: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  onSubmit: () => void;
  errorMessage: string | null;
  identity: AgentIdentity;
}) {
  const canSubmit = name.trim().length > 0 && (email.trim() === '' || /@/.test(email.trim()));
  return (
    <div className="flex flex-1 items-center justify-center px-4 md:px-6 w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit();
        }}
        className="w-full max-w-md flex flex-col items-center gap-6 text-center"
      >
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-white text-2xl md:text-4xl font-semibold">Talk to {identity.name}</h2>
          <p className="text-white/70 text-sm md:text-base max-w-sm">
            Tell me your name and we&apos;ll start. Email is optional.
          </p>
        </div>
        <div className="w-full flex flex-col gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="given-name"
            autoFocus
            className="w-full rounded-lg bg-black/40 border border-white/10 focus:border-[#00C3FF] focus:outline-none text-white placeholder:text-white/30 px-4 py-3 text-base"
          />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Your email (optional)"
            autoComplete="email"
            className="w-full rounded-lg bg-black/40 border border-white/10 focus:border-[#00C3FF] focus:outline-none text-white placeholder:text-white/30 px-4 py-3 text-base"
          />
        </div>
        <button
          type="submit"
          disabled={!canSubmit}
          className={`inline-flex h-[44px] items-center justify-center rounded-full px-6 text-[15px] font-semibold transition-opacity ${
            canSubmit
              ? 'bg-[#00C3FF] text-[#0E404F] cursor-pointer'
              : 'bg-[rgba(0,195,255,0.4)] text-[#0E404F]/60 cursor-not-allowed'
          }`}
        >
          Talk to {identity.name}
        </button>
        {errorMessage && <p className="text-red-400 text-sm">{errorMessage}</p>}
      </form>
    </div>
  );
}

function ReadyStage({
  name,
  company,
  onStart,
}: {
  name: string;
  company: string | null;
  onStart: () => void;
}) {
  const displayName = name.trim() || 'there';
  const trimmedCompany = company?.trim();
  return (
    <div className="flex flex-1 items-center justify-center px-4 md:px-6 w-full">
      <div className="w-full max-w-md flex flex-col items-center gap-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-white text-2xl md:text-4xl font-semibold">
            Ready when you are, {displayName}
          </h2>
          <p className="text-white/70 text-sm md:text-base max-w-sm">
            Tap below to chat about your use case
            {trimmedCompany ? ` for ${trimmedCompany}` : ''}.
          </p>
        </div>
        <button
          type="button"
          onClick={onStart}
          autoFocus
          className="inline-flex h-[44px] items-center justify-center rounded-full bg-[#00C3FF] text-[#0E404F] px-6 text-[15px] font-semibold cursor-pointer"
        >
          Start chatting
        </button>
      </div>
    </div>
  );
}

/**
 * Shown when the mint route reports upstream capacity/credit exhaustion.
 * There is no queue to poll, so the only affordance is a manual retry.
 */
function BusyStage({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 md:px-6 w-full">
      <div
        data-testid="ai-sales-busy"
        className="w-full max-w-md flex flex-col items-center gap-6 text-center"
      >
        <div className="flex flex-col items-center gap-3">
          <h2 className="text-white text-2xl md:text-4xl font-semibold">
            {message === NO_CREDITS_MESSAGE ? 'Out of free minutes' : 'All lines are busy'}
          </h2>
          <p className="text-white/70 text-sm md:text-base max-w-sm">{message}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-[44px] items-center justify-center rounded-full bg-[#00C3FF] text-[#0E404F] px-6 text-[15px] font-semibold cursor-pointer"
          >
            Try again
          </button>
          <a
            href="https://cal.com/iblai/30min"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-[44px] items-center justify-center rounded-full border border-white/20 text-white px-6 text-[15px] font-semibold"
          >
            Book a call
          </a>
        </div>
      </div>
    </div>
  );
}

function ConnectingStage({ identity }: { identity: AgentIdentity }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 md:px-6 text-center">
      <div className="flex flex-col items-center gap-[28px]">
        <p className="font-semibold text-[36px] leading-[44px] md:text-[55px] md:leading-[66px] tracking-[-1.65px] bg-gradient-to-r from-white to-[#F1ECFA] bg-clip-text text-transparent">
          Connecting you to {identity.name}…
        </p>
        <p className="text-white/80 text-base md:text-lg">
          {identity.name} is joining the call, hope you have a good chat!
        </p>
        <div className="h-10 w-10 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      </div>
    </div>
  );
}

function LiveControls({
  isMuted,
  toggleMuted,
  onEnd,
  audioDevices,
  selectedDeviceId,
  onDeviceChange,
}: {
  isMuted: boolean;
  toggleMuted: () => void;
  onEnd: () => void;
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string;
  onDeviceChange: (id: string) => void;
}) {
  return (
    <div className="inline-flex flex-col items-center gap-3 py-4 md:py-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggleMuted}
          className="flex w-12 h-12 justify-center items-center rounded-full bg-white hover:bg-white/90"
          aria-label={isMuted ? 'Turn on mic' : 'Turn off mic'}
        >
          <Image
            src={isMuted ? '/icons/mute.svg' : '/icons/mic.svg'}
            alt={isMuted ? 'muted' : 'mic'}
            width={24}
            height={24}
          />
        </button>
        <button
          type="button"
          onClick={onEnd}
          className="inline-flex items-center justify-center rounded-full bg-red-500 hover:bg-red-600 text-white font-semibold px-5 h-12 text-sm"
        >
          End session
        </button>
      </div>
      {audioDevices.length > 0 && (
        <div className="w-[220px]">
          <MicDropdown
            audioDevices={audioDevices}
            selectedDeviceId={selectedDeviceId}
            setSelectedDeviceId={onDeviceChange}
          />
        </div>
      )}
    </div>
  );
}

function EndedStage() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 md:px-6 w-full">
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="font-semibold text-3xl md:text-5xl bg-gradient-to-r from-white to-[#F1ECFA] bg-clip-text text-transparent">
          Thanks for chatting
        </p>
        <p className="text-white/80 text-base md:text-lg max-w-md">
          Hope that helped. Start for free at ibl.ai/join, or book a 30-minute call with the team at
          cal.com/iblai/30min.
        </p>
      </div>
    </div>
  );
}

type TranscriptTurn = {
  id: string;
  sender: 'user' | 'avatar';
  message: string;
  timestamp: number;
};

// Coalesce consecutive same-sender chunks into one turn. The SDK emits a
// fresh message per ASR/LLM segment, so a single sentence often arrives as
// 3-5 separate entries — rendering one bubble per chunk is jarring. We keep
// the first chunk's id+timestamp as the turn anchor and append later chunks
// to its message so the bubble grows in place as audio streams in. A single
// space joins fragments because the upstream ASR doesn't include trailing
// whitespace.
function coalesceTurns(messages: LiveAvatarSessionMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const m of messages) {
    const sender = m.sender === 'avatar' ? 'avatar' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.sender === sender) {
      const next = m.message.trim();
      if (next) last.message = last.message ? `${last.message} ${next}` : next;
    } else {
      turns.push({ id: m.id, sender, message: m.message.trim(), timestamp: m.timestamp });
    }
  }
  return turns;
}

function TranscriptPane({
  chatHistory,
  avatarTurns,
  userName,
  avatarName,
  onClose,
}: {
  chatHistory: LiveAvatarSessionMessage[];
  // Avatar turns owned by AiSalesInline (chunk-driven, paced reveal). User
  // turns still come from chatHistory — the SDK already streams those live.
  avatarTurns: AvatarTurnState[];
  userName: string;
  avatarName: string;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // User turns: coalesce the full history first so consecutive same-sender
  // ASR fragments merge but the avatar entries between user turns still
  // act as boundaries — then filter to user. (Filtering first would merge
  // every user utterance across the whole session into a single bubble.)
  const userTurns = useMemo(
    () => coalesceTurns(chatHistory).filter((t) => t.sender === 'user'),
    [chatHistory],
  );

  // Merge user turns and avatar turns by timestamp. Avatar turns may still
  // have buffered text > revealed (typewriter trailing); we render only
  // what's been revealed so the cadence stays paced.
  const merged = useMemo(() => {
    type Row = { id: string; sender: 'user' | 'avatar'; text: string; timestamp: number };
    const rows: Row[] = [];
    for (const t of userTurns) {
      rows.push({ id: t.id, sender: 'user', text: t.message, timestamp: t.timestamp });
    }
    for (const t of avatarTurns) {
      const text = t.buffered.slice(0, t.revealed);
      if (!text) continue;
      rows.push({ id: t.id, sender: 'avatar', text, timestamp: t.timestamp });
    }
    rows.sort((a, b) => a.timestamp - b.timestamp);
    return rows;
  }, [userTurns, avatarTurns]);

  // Auto-scroll only when the user is "stuck to the bottom" — i.e. hasn't
  // scrolled up to read history. Once they scroll up, new messages stop
  // jerking the view back down; scrolling back near the bottom re-enables
  // live-follow. Ref instead of state because the auto-scroll effect should
  // read the latest value without triggering re-renders.
  //
  // 40px threshold so a programmatic `scrollTop = scrollHeight` (which fires
  // a scroll event with distance≈0) keeps the flag true, and a UA bounce
  // near the bottom doesn't accidentally drop us out of follow mode.
  const stuckToBottomRef = useRef(true);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckToBottomRef.current = distanceFromBottom < 40;
  }, []);

  const lastRowLength = merged[merged.length - 1]?.text.length ?? 0;
  useEffect(() => {
    if (!stuckToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [merged.length, lastRowLength]);

  return (
    <div className="h-full flex flex-col bg-black/70 border border-white/10 rounded-[14px] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 flex-shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-white/60 font-semibold">
          Transcript · live
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide transcript"
          className="text-white/40 hover:text-white text-base leading-none cursor-pointer"
        >
          ×
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 space-y-3 min-h-[280px] lg:min-h-0"
      >
        {merged.length === 0 && (
          <p className="text-white/40 text-[12px] italic">
            The conversation will appear here once you start chatting.
          </p>
        )}
        {merged.map((row) => {
          const isUser = row.sender === 'user';
          const speaker = isUser ? userName : avatarName;
          return (
            <div key={`${row.sender}:${row.id}`} className="space-y-1">
              <p
                className={twMerge(
                  'text-[10px] uppercase tracking-wider font-semibold',
                  isUser ? 'text-[#00C3FF]' : 'text-[#9EE493]',
                )}
              >
                {speaker}
              </p>
              <p className="text-white/90 text-[13px] leading-snug whitespace-pre-wrap break-words">
                {row.text}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
