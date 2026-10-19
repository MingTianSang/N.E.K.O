import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import type { CompactChatState } from './message-schema';

/**
 * 紧凑输入态点击稳定性回归。
 *
 * Windows 实测（NEKO_TRACE_DIALOG_INPUT 取证）：进入输入态 ~230ms 后，原生宿主会产生一次
 * 瞬时窗口失焦并自行 refocus。立即执行的强制折叠会把输入态折回胶囊，下一次点击再拉回输入态，
 * 形成用户可见的闪烁。
 *
 * 契约：window blur 触发的强制折叠延迟执行；执行时页面已重新持有焦点（瞬时抖动）则放弃折叠。
 * 焦点未回归（真实失焦，如切换应用）时仍按原语义折叠；Escape / 岛外 pointerdown 的立即折叠
 * 语义不变。
 */

function renderControlledCompactInput() {
  const stateChanges: CompactChatState[] = [];
  function Harness() {
    const [compactChatState, setCompactChatState] = useState<CompactChatState>('input');
    return (
      <App
        chatSurfaceMode="compact"
        compactChatState={compactChatState}
        onCompactChatStateChange={(next) => {
          stateChanges.push(next);
          setCompactChatState(next);
        }}
      />
    );
  }
  render(<Harness />);
  return stateChanges;
}

async function renderFocusedCompactInput() {
  const stateChanges = renderControlledCompactInput();
  const input = (await screen.findByPlaceholderText('Type a message...')) as HTMLTextAreaElement;
  await act(async () => {
    input.focus();
  });
  expect(input).toHaveFocus();
  return { stateChanges, input };
}

describe('compact input state click stability', () => {
  it('keeps input state for a plain click on the focused textarea', async () => {
    const { stateChanges, input } = await renderFocusedCompactInput();

    fireEvent.pointerDown(input, { pointerId: 7, button: 0, buttons: 1, pointerType: 'mouse' });
    fireEvent.mouseDown(input, { button: 0, buttons: 1 });
    fireEvent.pointerUp(input, { pointerId: 7, button: 0, buttons: 0, pointerType: 'mouse' });
    fireEvent.mouseUp(input, { button: 0, buttons: 0 });
    fireEvent.click(input, { button: 0 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(stateChanges).toEqual([]);
  });

  it('absorbs a transient window blur whose focus returns before the collapse deadline', async () => {
    const { stateChanges } = await renderFocusedCompactInput();
    const hasFocus = vi.spyOn(document, 'hasFocus');

    // 瞬时失焦：blur 后 ~几十毫秒内焦点回归（hasFocus 恢复 true）。
    hasFocus.mockReturnValue(false);
    fireEvent.blur(window);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    hasFocus.mockReturnValue(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    hasFocus.mockRestore();

    expect(stateChanges).toEqual([]);
    expect(screen.getByPlaceholderText('Type a message...')).toHaveFocus();
  });

  it('still collapses on window blur when focus does not return', async () => {
    const { stateChanges } = await renderFocusedCompactInput();
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    fireEvent.blur(window);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    hasFocus.mockRestore();

    expect(stateChanges).toEqual(['default']);
  });

  it('still collapses when the pointer press starts outside the input island', async () => {
    const { stateChanges } = await renderFocusedCompactInput();

    fireEvent.pointerDown(document.body, { pointerId: 9, button: 0, buttons: 1, pointerType: 'mouse' });
    fireEvent.pointerUp(document.body, { pointerId: 9, button: 0, buttons: 0, pointerType: 'mouse' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(stateChanges).toEqual(['default']);
  });

  it('still collapses on Escape', async () => {
    const { stateChanges } = await renderFocusedCompactInput();

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(stateChanges).toEqual(['default']);
  });
});
