import { useCallback } from 'react';
import { useLiveAvatarContext } from '../context';
import { SessionConfig, LiveAvatarSession, SessionState } from '@heygen/liveavatar-web-sdk';

export const useSession = () => {
  const {
    sessionRef,
    sessionState,
    isStreamReady,
    connectionQuality,
    initHandlers,
    maxSessionDuration,
    apiUrl,
  } = useLiveAvatarContext();

  const startSession = useCallback(
    async (sessionToken: string, config: SessionConfig) => {
      if (
        sessionRef.current &&
        sessionRef.current.state !== SessionState.INACTIVE &&
        sessionRef.current.state !== SessionState.DISCONNECTED
      ) {
        console.error('Session already started');
        return;
      }

      sessionRef.current = new LiveAvatarSession(sessionToken, { apiUrl, ...config });
      initHandlers();
      try {
        await sessionRef.current.start();
      } catch (error) {
        console.error('Failed to start session', error);
        sessionRef.current = null;
        throw error;
      }
    },
    [sessionRef, initHandlers, apiUrl],
  );

  const attachStream = useCallback(
    (element: HTMLMediaElement) => {
      if (!sessionRef.current) {
        return;
      }
      sessionRef.current.attach(element);
    },
    [sessionRef],
  );

  const stopSession = useCallback(async () => {
    if (!sessionRef.current) {
      return;
    }

    try {
      await sessionRef.current?.stop();
      sessionRef.current = null;
    } catch (error) {
      console.error('Failed to stop session', error);
      sessionRef.current = null;
    }
  }, [sessionRef]);

  const keepAlive = useCallback(async () => {
    return await sessionRef.current?.keepAlive();
  }, [sessionRef]);

  return {
    sessionState,
    isStreamReady,
    connectionQuality,
    attachStream,
    startSession,
    stopSession,
    keepAlive,
    maxSessionDuration,
  };
};
