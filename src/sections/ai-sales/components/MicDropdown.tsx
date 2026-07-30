'use client';

import React, { useRef, useEffect } from 'react';

export default function MicDropdown({
  audioDevices,
  selectedDeviceId,
  setSelectedDeviceId,
}: {
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string;
  setSelectedDeviceId: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const currentDevice = audioDevices.find((d) => d.deviceId === selectedDeviceId);
  const currentDeviceIndex = audioDevices.findIndex((d) => d.deviceId === selectedDeviceId);
  const deviceLabel =
    !currentDevice || currentDeviceIndex === 0
      ? 'Default mic'
      : (currentDevice.label || 'Unknown mic').length > 20
        ? (currentDevice.label || 'Unknown mic').substring(0, 17) + '...'
        : currentDevice.label || 'Unknown mic';

  return (
    <div className="relative flex justify-center w-full" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Select microphone"
        className="flex items-center gap-1 text-white text-sm font-normal bg-transparent hover:opacity-80 transition-opacity cursor-pointer border-0 border-b border-solid border-white pb-0.5"
      >
        <span className="truncate max-w-[150px]">{deviceLabel}</span>
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && audioDevices.length > 0 && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-[#1A1A1A] rounded-lg py-1 z-50 max-h-32 overflow-y-auto"
          role="listbox"
          style={{
            boxShadow:
              '0 6.745px 6.745px -3.372px rgba(0, 195, 255, 0.05), 0 13.489px 13.489px -6.745px rgba(0, 195, 255, 0.05), 0 26.979px 26.979px 0 rgba(0, 195, 255, 0.05)',
          }}
        >
          {audioDevices.map((device, index) => (
            <button
              key={device.deviceId}
              type="button"
              role="option"
              aria-selected={selectedDeviceId === device.deviceId}
              className={`w-full text-left px-3 py-1.5 text-sm text-white hover:bg-white/10 flex items-center justify-between ${
                device.deviceId === selectedDeviceId ? 'bg-white/5' : ''
              }`}
              onClick={() => {
                setSelectedDeviceId(device.deviceId);
                setOpen(false);
              }}
              title={device.label}
            >
              <span className="truncate pr-2">
                {index === 0 ? 'Default mic' : device.label || 'Unknown mic'}
              </span>
              {device.deviceId === selectedDeviceId && (
                <svg
                  className="w-4 h-4 text-[#00C3FF] flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
