import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

/** Lines moved per mouse-wheel notch in fullscreen mode (pi-tui default is 1). */
const FULLSCREEN_WHEEL_LINES = 4;
/** Mirrors pi-tui's ALT_WHEEL_SCROLL_MULTIPLIER, which is not exported. */
const ALT_WHEEL_MULTIPLIER = 5;

/** Guards against re-patching when the extension is reloaded (jiti uses moduleCache: false). */
const WHEEL_PATCHED = Symbol.for("yu1745.pi-extensions.smart-ctrl-c.wheel");

/**
 * Same reload guard for the Ctrl+C patch below.
 *
 * It must live on the prototype, not in a module-level `let`: /reload re-evaluates
 * this module (which resets module state) but keeps the shared CustomEditor
 * prototype, so a module-level flag would let the wrapper be installed again on
 * every reload, stacking one layer per reload.
 */
const CTRL_C_PATCHED = Symbol.for("yu1745.pi-extensions.smart-ctrl-c.ctrl-c");

type WheelScrollProto = {
  getWheelScrollLines(button: number): number;
  [WHEEL_PATCHED]?: boolean;
};

type CtrlCProto = {
  handleInput(data: string): unknown;
  [CTRL_C_PATCHED]?: boolean;
};

/**
 * Speed up fullscreen mouse-wheel scrolling.
 *
 * `TuiAltScreen` assigns `this.wheelScrollLines` from its constructor options
 * (`options.wheelScrollLines ?? 1`), and pi's `createInteractiveTui` never passes
 * that option. So the field is always a number, and overriding it per instance
 * only affects the renderer that happens to exist at that moment. Patching the
 * prototype instead covers the initial renderer, every renderer rebuilt by
 * `/tui-mode` switches, and new sessions alike.
 */
function installWheelScrollPatch(): void {
  const proto = (TuiAltScreen as unknown as { prototype?: WheelScrollProto } | undefined)?.prototype;
  if (!proto || typeof proto.getWheelScrollLines !== "function" || proto[WHEEL_PATCHED]) return;
  proto.getWheelScrollLines = function (button: number): number {
    return (button & 8) !== 0 ? FULLSCREEN_WHEEL_LINES * ALT_WHEEL_MULTIPLIER : FULLSCREEN_WHEEL_LINES;
  };
  proto[WHEEL_PATCHED] = true;
}

export default function (pi: ExtensionAPI) {
  // Install at load time: wheel input is consumed by TuiAltScreen's own input
  // listener, so it never reaches CustomEditor.handleInput.
  installWheelScrollPatch();

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
