import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import upstreamSubagents from "@tintinweb/pi-subagents/dist/index.js";

export default function subagentsBridge(pi: ExtensionAPI): void {
  // Load the upstream extension inside our package instead of registering it
  // as a separate top-level Pi extension. This keeps the dependency managed
  // by our package while still exposing the same tools/commands.
  //
  // Important: this bridge is intended to be the single owner of the upstream
  // subagent tool registrations for this package. Loading a standalone
  // npm:@tintinweb/pi-subagents package in the same Pi scope will cause
  // duplicate tool/command registration conflicts.
  upstreamSubagents(pi);

  // Extension point for local customizations. We keep a small, non-invasive
  // command here so the wrapper adds value without forking the upstream code.
  pi.registerCommand("subagents-info", {
    description: "Show bundled subagent bridge information",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Bundled @tintinweb/pi-subagents is loaded through the local bridge. If you see duplicate Agent or /agents conflicts, remove or shadow any standalone npm:@tintinweb/pi-subagents package in this scope.",
        "info",
      );
    },
  });
}
