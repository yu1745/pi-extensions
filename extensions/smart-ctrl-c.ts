import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

/**
 * Fullscreen mouse-wheel scrolling no longer needs a patch: pi 1.0 ships it
 * natively via the `fullscreenWheelScrollLines` setting (number or "auto"),
 * with Alt+wheel 5x built into pi-tui. The old TuiAltScreen prototype patch
 * was removed — its `getWheelScrollLines` hook disappeared in pi-tui 1.0.
 */

/**
 * Same reload guard for the Ctrl+C patch below.
 *
 * It must live on the prototype, not in a module-level `let`: /reload re-evaluates
 * this module (which resets module state) but keeps the shared CustomEditor
 * prototype, so a module-level flag would let the wrapper be installed again on
 * every reload, stacking one layer per reload.
 */
const CTRL_C_PATCHED = Symbol.for("yu1745.pi-extensions.smart-ctrl-c.ctrl-c");

type CtrlCProto = {
  handleInput(data: string): unknown;
  [CTRL_C_PATCHED]?: boolean;
};

export default function (pi: ExtensionAPI) {
  const proto = CustomEditor.prototype as unknown as CtrlCProto;
  if (proto[CTRL_C_PATCHED]) return;
  proto[CTRL_C_PATCHED] = true;

  const originalHandleInput = CustomEditor.prototype.handleInput;

  CustomEditor.prototype.handleInput = function (data: string) {
    const tui = (this as any).tui;
    const kb = (this as any).keybindings;

    // 捕获 Ctrl+C（匹配 app.clear）
    if (kb && kb.matches(data, "app.clear")) {
      // 1. 如果全屏模式下有鼠标选中文本，执行复制
      if (tui && typeof tui.hasActiveSelection === "function" && tui.hasActiveSelection()) {
        const copyHandler = (this as any).actionHandlers?.get("app.message.copy");
        if (copyHandler) {
          copyHandler();
          return;
        }
      }

      // 2. 如果输入框内有文字，清空输入框
      const text = this.getText();
      if (text && text.length > 0) {
        const clearHandler = (this as any).actionHandlers?.get("app.clear");
        if (clearHandler) {
          clearHandler();
          return;
        }
      }

      // 3. 如果输入框本来就为空，直接退出程序
      const exitHandler = (this as any).actionHandlers?.get("app.exit") ?? (this as any).onCtrlD;
      if (exitHandler) {
        exitHandler();
        return;
      }
      process.exit(0);
      return;
    }

    return originalHandleInput.call(this, data);
  };
}
