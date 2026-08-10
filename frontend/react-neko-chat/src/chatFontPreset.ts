export const CHAT_FONT_PRESET_STORAGE_KEY = 'neko.reactChatWindow.fontPreset';
export const CHAT_FONT_PRESET_ATTRIBUTE = 'data-neko-chat-font-preset';

export type ChatFontPreset = 'system' | 'handwritten';

export function normalizeChatFontPreset(value: unknown): ChatFontPreset {
  return value === 'system' ? 'system' : 'handwritten';
}

export function readChatFontPreset(): ChatFontPreset {
  if (typeof window === 'undefined') return 'handwritten';
  try {
    return normalizeChatFontPreset(window.localStorage.getItem(CHAT_FONT_PRESET_STORAGE_KEY));
  } catch (_) {
    return 'handwritten';
  }
}

export function applyChatFontPreset(value: unknown): ChatFontPreset {
  const preset = normalizeChatFontPreset(value);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute(CHAT_FONT_PRESET_ATTRIBUTE, preset);
  }
  return preset;
}

let chatFontPresetSyncInstalled = false;

export function installChatFontPresetSync(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  applyChatFontPreset(readChatFontPreset());
  if (chatFontPresetSyncInstalled) return;
  chatFontPresetSyncInstalled = true;

  window.addEventListener('storage', (event) => {
    if (event.key === CHAT_FONT_PRESET_STORAGE_KEY) {
      applyChatFontPreset(event.newValue);
    }
  });
  window.addEventListener('neko:chat-font-preset-changed', (event) => {
    const detail = (event as CustomEvent<{ preset?: unknown }>).detail;
    applyChatFontPreset(detail?.preset ?? readChatFontPreset());
  });
}
