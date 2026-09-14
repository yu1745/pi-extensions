import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

let patched = false;

export default function (pi: ExtensionAPI) {
  if (patched) return;
  patched = true;

  const originalHandleInput = CustomEditor.prototype.handleInput;

  CustomEditor.prototype.handleInput = function (data: string) {
    // 动态劫持并加速全屏滚轮为 4 行
    const tui = (this as any).tui;
    if (tui && tui.wheelScrollLines !== 4) {
      tui.wheelScrollLines = 4;
      const altScreenProto = Object.getPrototypeOf(tui);
      if (altScreenProto && altScreenProto.getWheelScrollLines) {
        altScreenProto.getWheelScrollLines = function (button: number) {
          const lines = this.wheelScrollLines ?? 4;
          return (button & 8) !== 0 ? lines * 5 : lines;
        };
      }
    }

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
