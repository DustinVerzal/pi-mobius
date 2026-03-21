import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PROMPT_MASTER_SKILL = "prompt-master";

function buildPromptMasterRequest(request: string, targetTool?: string): string {
  const target = targetTool?.trim() || "GPT-5.4";
  return `/skill:${PROMPT_MASTER_SKILL} Generate a single paste-ready prompt for ${target}. Optimize it for immediate use. User request: ${request.trim()}`;
}

function dispatchPromptMaster(pi: ExtensionAPI, ctx: ExtensionContext, request: string, targetTool?: string): void {
  const message = buildPromptMasterRequest(request, targetTool);
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  }
}

export default function promptMasterInjection(pi: ExtensionAPI): void {
  pi.registerCommand("prompt-improve", {
    description: "Use the packaged prompt-master skill to improve a prompt request.",
    handler: async (args, ctx) => {
      const initial = args.trim();
      const request = initial || (await ctx.ui.editor("Prompt to improve", ""))?.trim();
      if (!request) {
        ctx.ui.notify("No prompt request provided.", "info");
        return;
      }

      dispatchPromptMaster(pi, ctx, request, "GPT-5.4 / Pi / agentic planning");
    },
  });

  pi.registerCommand("pm", {
    description: "Alias for /prompt-improve.",
    handler: async (args, ctx) => {
      const request = args.trim() || (await ctx.ui.editor("Prompt to improve", ""))?.trim();
      if (!request) {
        ctx.ui.notify("No prompt request provided.", "info");
        return;
      }

      dispatchPromptMaster(pi, ctx, request, "GPT-5.4 / Pi / agentic planning");
    },
  });

  pi.registerTool({
    name: "prompt_improve",
    label: "Prompt Improve",
    description: "Use the packaged prompt-master skill to improve a prompt request for a target tool.",
    promptSnippet: "Improve a prompt request with the packaged prompt-master skill.",
    promptGuidelines: [
      "Use prompt_improve when the user explicitly asks to improve, rewrite, tighten, or optimize a prompt."
    ],
    parameters: Type.Object({
      request: Type.String({ description: "The prompt request to improve." }),
      targetTool: Type.Optional(Type.String({ description: "Optional target AI tool or workflow." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      dispatchPromptMaster(pi, ctx, params.request, params.targetTool);
      const target = params.targetTool?.trim() || "the current tool";
      return {
        content: [{ type: "text", text: `Queued prompt-master to improve the prompt for ${target}.` }],
        details: {
          queued: true,
          target,
        },
      };
    },
  });
}
