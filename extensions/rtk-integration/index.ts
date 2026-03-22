import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { createRtkSpawnHook, createRtkStatusSnapshot, formatRtkStatusReport, rewriteModeSeverity } from "./rewrite.js";

export default function rtkIntegration(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const bashTool = createBashTool(cwd, {
    spawnHook: createRtkSpawnHook(),
  });

  pi.registerTool({
    ...bashTool,
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      return bashTool.execute(toolCallId, params, signal, onUpdate);
    },
  });

  pi.registerCommand("rtk-status", {
    description: "Show whether RTK-backed bash rewriting is active or safely falling back to normal bash execution",
    handler: async (_args, ctx) => {
      const snapshot = createRtkStatusSnapshot({ cwd: ctx.cwd, env: process.env });
      const report = formatRtkStatusReport(snapshot);

      if (ctx.hasUI) {
        ctx.ui.notify(report, rewriteModeSeverity(snapshot));
        return;
      }

      console.log(report);
    },
  });
}
