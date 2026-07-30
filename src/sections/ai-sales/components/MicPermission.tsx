'use client';

import { useEffect, useRef } from 'react';
import CTAButton from '@/components/ui/CTAButton';
import Image from 'next/image';

interface MicPermissionProps {
  onEnable: () => void;
  permissionState: 'idle' | 'granted' | 'denied';
}

export default function MicPermission({ onEnable, permissionState }: MicPermissionProps) {
  const deniedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (permissionState === 'denied') {
      deniedRef.current?.focus();
    }
  }, [permissionState]);

  if (permissionState === 'granted') {
    return null;
  }
  return (
    <div
      className={`inline-flex min-h-[183px] md:min-h-[140px] lg:min-h-[183px] flex-col items-center gap-5${permissionState === 'denied' ? ' mb-4' : ''}`}
    >
      {permissionState === 'idle' && (
        <>
          <h2 className="text-center font-semibold text-[20px] md:text-[24px] leading-none bg-gradient-to-r from-white to-[#F1ECFA] bg-clip-text text-transparent">
            Allow mic permission to start the chat
          </h2>
          <CTAButton
            href="#enable-mic"
            unstyled
            onClick={(e) => {
              e.preventDefault();
              onEnable();
            }}
            className="inline-flex items-center justify-center gap-2 h-[38px] max-h-[38px] px-4 py-0 rounded-[999px] text-[15px] leading-[23px] bg-[#00C3FF] text-[#0E404F] shadow-[inset_0_0_0_1px_rgba(186,214,247,0.06)]"
          >
            <Image src="/icons/mic-fill.svg" alt="Mic" width={20} height={20} />
            <span className="font-semibold text-[#0E404F]">Enable Microphone</span>
          </CTAButton>
        </>
      )}
      {permissionState === 'denied' && (
        <div
          ref={deniedRef}
          tabIndex={-1}
          className="flex flex-col items-center gap-4 rounded-2xl bg-black/40 backdrop-blur-md px-6 py-5 max-w-[380px] outline-none"
        >
          <h2 className="text-center text-[#E54945] font-semibold text-[20px] leading-tight">
            Microphone permission rejected
          </h2>
          <ol className="list-decimal list-outside pl-5 space-y-1.5 text-white/80 text-[14px] leading-relaxed">
            <li>
              Click the <strong className="text-white">site settings icon</strong> near your
              browser&apos;s address bar
            </li>
            <li>
              Find <strong className="text-white">Microphone</strong> and change it to{' '}
              <strong className="text-white">Allow</strong>
            </li>
            <li>Click the button below to reload</li>
          </ol>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center justify-center gap-2 h-[38px] px-5 rounded-[999px] bg-[#E54945] text-white font-semibold text-[15px] cursor-pointer hover:bg-[#D43C38] active:bg-[#C03430] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/40"
          >
            <Image src="/icons/mute.svg" alt="" aria-hidden="true" width={18} height={18} />
            Reload page
          </button>
        </div>
      )}
      <div aria-live="polite" className="sr-only">
        {permissionState === 'denied' &&
          'Microphone permission rejected. Follow the on-screen instructions to allow mic access, then reload the page.'}
      </div>
    </div>
  );
}
