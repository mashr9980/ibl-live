import { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  ConnectionQuality,
  LiveAvatarSession,
  SessionState,
  SessionEvent,
  VoiceChatEvent,
  VoiceChatState,
  SessionDisconnectReason,
  AgentEventsEnum,
} from '@heygen/liveavatar-web-sdk';
import { LiveAvatarSessionMessage, MessageSender } from '../types';

type LiveAvatarContextProps = {
  sessionRef: React.RefObject<LiveAvatarSession | null>;
  initHandlers: () => void;

  maxSessionDuration: number | null;

  isMuted: boolean;
  voiceChatState: VoiceChatState;

  sessionState: SessionState;
  isStreamReady: boolean;
  connectionQuality: ConnectionQuality;

  isUserTalking: boolean;
  isAvatarTalking: boolean;

  messages: LiveAvatarSessionMessage[];

  apiUrl?: string;
};

const LiveAvatarContext = createContext<LiveAvatarContextProps>({
  sessionRef: { current: null },
  initHandlers: () => {},
  maxSessionDuration: null,
  connectionQuality: ConnectionQuality.UNKNOWN,
  isMuted: true,
  voiceChatState: VoiceChatState.INACTIVE,
  sessionState: SessionState.DISCONNECTED,
  isStreamReady: false,
  isUserTalking: false,
  isAvatarTalking: false,
  messages: [],
  apiUrl: undefined,
});

const useSessionState = (sessionRef: React.RefObject<LiveAvatarSession | null>) => {
  const [sessionState, setSessionState] = useState<SessionState>(
    sessionRef.current?.state || SessionState.INACTIVE,
  );
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>(
    sessionRef.current?.connectionQuality || ConnectionQuality.UNKNOWN,
  );
  const [isStreamReady, setIsStreamReady] = useState(false);
  const [maxSessionDuration, setMaxSessionDuration] = useState<number | null>(
    sessionRef.current?.maxSessionDuration || null,
  );

  const init = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.on(SessionEvent.SESSION_STATE_CHANGED, (state) => {
        setSessionState(state);
        if (state === SessionState.CONNECTED) {
          setMaxSessionDuration(sessionRef.current?.maxSessionDuration || null);
        }
        if (state === SessionState.DISCONNECTED) {
          setIsStreamReady(false);
          setMaxSessionDuration(null);
          setConnectionQuality(ConnectionQuality.UNKNOWN);
        }
      });
      sessionRef.current.on(SessionEvent.SESSION_DISCONNECTED, () => {
        sessionRef.current?.removeAllListeners();
        sessionRef.current?.voiceChat.removeAllListeners();
      });
      sessionRef.current.on(SessionEvent.SESSION_STREAM_READY, () => setIsStreamReady(true));
      sessionRef.current.on(SessionEvent.SESSION_CONNECTION_QUALITY_CHANGED, setConnectionQuality);
    }
  }, [sessionRef]);

  return {
    sessionState,
    isStreamReady,
    connectionQuality,
    maxSessionDuration,
    init,
  };
};

const useVoiceChatState = (sessionRef: React.RefObject<LiveAvatarSession | null>) => {
  const [isMuted, setIsMuted] = useState(true);
  const [voiceChatState, setVoiceChatState] = useState<VoiceChatState>(
    sessionRef.current?.voiceChat.state || VoiceChatState.INACTIVE,
  );

  const init = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.voiceChat.on(VoiceChatEvent.STATE_CHANGED, (state) => {
        setVoiceChatState(state);
        if (state === VoiceChatState.INACTIVE) {
          setIsMuted(true);
        }
      });
      sessionRef.current.voiceChat.on(VoiceChatEvent.MUTED, () => {
        setIsMuted(true);
      });
      sessionRef.current.voiceChat.on(VoiceChatEvent.UNMUTED, () => {
        setIsMuted(false);
      });
      sessionRef.current.voiceChat.on(VoiceChatEvent.STATE_CHANGED, setVoiceChatState);
      sessionRef.current.on(SessionEvent.SESSION_DISCONNECTED, () => {
        setIsMuted(true);
        setVoiceChatState(VoiceChatState.INACTIVE);
      });
    }
  }, [sessionRef]);

  return { isMuted, voiceChatState, init };
};

const useTalkingState = (sessionRef: React.RefObject<LiveAvatarSession | null>) => {
  const [isUserTalking, setIsUserTalking] = useState(false);
  const [isAvatarTalking, setIsAvatarTalking] = useState(false);

  const init = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.on(AgentEventsEnum.USER_SPEAK_STARTED, () => {
        setIsUserTalking(true);
      });
      sessionRef.current.on(AgentEventsEnum.USER_SPEAK_ENDED, () => {
        setIsUserTalking(false);
      });
      sessionRef.current.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        setIsAvatarTalking(true);
      });
      sessionRef.current.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        setIsAvatarTalking(false);
      });
    }
  }, [sessionRef]);

  return { isUserTalking, isAvatarTalking, init };
};

const useChatHistoryState = (sessionRef: React.RefObject<LiveAvatarSession | null>) => {
  const [messages, setMessages] = useState<LiveAvatarSessionMessage[]>([]);

  const init = useCallback(() => {
    setMessages([]);
    if (sessionRef.current) {
      const handleMessage = (
        sender: MessageSender,
        { event_id, message }: { event_id: string; message: string },
      ) => {
        setMessages((prev) => [
          ...prev,
          {
            id: event_id,
            sender: sender,
            message,
            timestamp: Date.now(),
            isCompleted: false,
          },
        ]);
      };

      sessionRef.current.on(AgentEventsEnum.USER_TRANSCRIPTION, (data) => {
        handleMessage(MessageSender.USER, { event_id: data.event_id, message: data.text });
      });
      sessionRef.current.on(AgentEventsEnum.AVATAR_TRANSCRIPTION, (data) =>
        handleMessage(MessageSender.AVATAR, { event_id: data.event_id, message: data.text }),
      );
    }
  }, [sessionRef]);

  return { messages, init };
};

type LiveAvatarContextProviderProps = {
  children: React.ReactNode;
  apiUrl?: string;
  onDisconnect?: (reason?: SessionDisconnectReason) => void;
};

export const LiveAvatarContextProvider = ({
  children,
  apiUrl,
  onDisconnect,
}: LiveAvatarContextProviderProps) => {
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const {
    sessionState,
    isStreamReady,
    connectionQuality,
    maxSessionDuration,
    init: initSessionStateHandlers,
  } = useSessionState(sessionRef);
  const {
    isMuted,
    voiceChatState,
    init: initVoiceChatStateHandlers,
  } = useVoiceChatState(sessionRef);
  const {
    isUserTalking,
    isAvatarTalking,
    init: initTalkingStateHandlers,
  } = useTalkingState(sessionRef);
  const { messages, init: initChatHistoryStateHandlers } = useChatHistoryState(sessionRef);

  const initErrorHandler = useCallback(() => {
    sessionRef.current?.on(SessionEvent.SESSION_DISCONNECTED, (reason) => {
      if (onDisconnect) {
        onDisconnect(reason);
      }
    });
  }, [onDisconnect]);

  const initHandlers = useCallback(() => {
    initSessionStateHandlers();
    initVoiceChatStateHandlers();
    initTalkingStateHandlers();
    initChatHistoryStateHandlers();
    initErrorHandler();
  }, [
    initSessionStateHandlers,
    initVoiceChatStateHandlers,
    initTalkingStateHandlers,
    initChatHistoryStateHandlers,
    initErrorHandler,
  ]);

  return (
    <LiveAvatarContext.Provider
      value={{
        sessionRef,
        initHandlers,
        sessionState,
        isStreamReady,
        connectionQuality,
        isMuted,
        voiceChatState,
        isUserTalking,
        isAvatarTalking,
        messages,
        maxSessionDuration,
        apiUrl,
      }}
    >
      {children}
    </LiveAvatarContext.Provider>
  );
};

export const useLiveAvatarContext = () => {
  const context = useContext(LiveAvatarContext);
  if (!context) {
    throw new Error('Live Avatar React hooks must be used within a LiveAvatarContextProvider');
  }
  return context;
};
