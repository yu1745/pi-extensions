import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Alias for /new - start a new session",
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
}