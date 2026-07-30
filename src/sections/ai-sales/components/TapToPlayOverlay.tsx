'use client';

/**
 * Recovery affordance for iOS Safari, where the browser blocks the
 * unmuted avatar `<video>` from auto-playing (and LiveKit's fallback leaves it
 * silent/black). Rendered inside the avatar window ONLY when
 * `avatarPlaybackBlocked` is true; tapping it runs the gesture-bound
 * `resume()` (`el.muted = false; el.play()`), which iOS permits. It never
 * mounts on desktop/Android, where autoplay already succeeds.
 */
export default function TapToPlayOverlay({
  onTap,
  agentName,
}: {
  onTap: () => void;
  agentName: string;
}) {
  return (
    <button
      type="button"
      data-testid="ai-sales-tap-to-play"
      onClick={onTap}
      aria-label={`Tap to start ${agentName}`}
      className="group absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-[rgba(24,21,24,0.72)] backdrop-blur-[6px] text-white cursor-pointer"
    >
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 transition-colors group-hover:bg-white/25">
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="translate-x-[2px]"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
      <span className="text-sm font-semibold">Tap to start {agentName}</span>
    </button>
  );
}
