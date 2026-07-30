import { useLiveAvatarContext } from '../context';

export const useChatHistory = () => {
  const { messages } = useLiveAvatarContext();

  return { chatHistory: messages };
};
