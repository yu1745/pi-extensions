import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

let patched = false;

export default function (pi: ExtensionAPI) {
  if (patched) return;
  patched = true;

  const originalHandleInput = CustomEditor.prototype.handleInput;

  CustomEditor.prototype.handleInput = function (data: string) {
    const kb = (this as any).keybindings;

    // 捕获 Ctrl+C（匹配 app.clear）
    if (kb && kb.matches(data, "app.clear")) {
      const tui = (this as any).tui;

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
