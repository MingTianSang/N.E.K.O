import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHAT_FONT_PRESET_ATTRIBUTE,
  CHAT_FONT_PRESET_STORAGE_KEY,
  applyChatFontPreset,
  installChatFontPresetSync,
  normalizeChatFontPreset,
  readChatFontPreset,
} from './chatFontPreset';

describe('chat font preset', () => {
  beforeEach(() => {
    window.localStorage.removeItem(CHAT_FONT_PRESET_STORAGE_KEY);
    document.documentElement.removeAttribute(CHAT_FONT_PRESET_ATTRIBUTE);
  });

  it('keeps the existing handwritten font as the compatibility default', () => {
    expect(normalizeChatFontPreset(undefined)).toBe('handwritten');
    expect(normalizeChatFontPreset('invalid')).toBe('handwritten');
    expect(readChatFontPreset()).toBe('handwritten');
  });

  it('applies the system font preset to the document root', () => {
    window.localStorage.setItem(CHAT_FONT_PRESET_STORAGE_KEY, 'system');

    expect(readChatFontPreset()).toBe('system');
    expect(applyChatFontPreset(readChatFontPreset())).toBe('system');
    expect(document.documentElement).toHaveAttribute(CHAT_FONT_PRESET_ATTRIBUTE, 'system');
  });

  it('responds to a live Electron preset change event', () => {
    installChatFontPresetSync();
    window.dispatchEvent(new CustomEvent('neko:chat-font-preset-changed', {
      detail: { preset: 'system' },
    }));

    expect(document.documentElement).toHaveAttribute(CHAT_FONT_PRESET_ATTRIBUTE, 'system');
  });
});
