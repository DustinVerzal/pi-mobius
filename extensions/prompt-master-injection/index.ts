import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const PROMPT_MASTER_SKILL = "prompt-master";
export const DEFAULT_PROMPT_MASTER_TARGET = "GPT-5.4 / Pi / agentic planning";

const PLAN_STATE_ENTRY = "opencode-plan-state";
const PROMPT_MASTER_BLOCK_REASON = "Prompt improvement is disabled during an active plan workflow. Exit plan mode, then rerun /plan <request> to start a fresh planning session.";

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant" && Array.isArray(message.content);
}

function getAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function getLatestPlanMode(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i] as { type?: string; customType?: string; data?: { mode?: unknown } };
    if (entry?.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY) continue;
    return typeof entry.data?.mode === "string" ? entry.data.mode : undefined;
  }
  return undefined;
}

function getPromptMasterBlockReason(ctx: ExtensionContext): string | undefined {
  const mode = getLatestPlanMode(ctx);
  return mode && mode !== "normal" ? PROMPT_MASTER_BLOCK_REASON : undefined;
}

function normalizeExtractedPrompt(prompt: string): string | undefined {
  const normalized = prompt
    .trim()
    .replace(/^\*\*?prompt\*\*?:?\s*/i, "")
    .replace(/^prompt:?\s*/i, "")
    .trim();

  return normalized || undefined;
}

export function getPromptMasterTarget(targetTool?: string): string {
  return targetTool?.trim() || DEFAULT_PROMPT_MASTER_TARGET;
}

export function buildPromptMasterRequest(request: string, targetTool?: string): string {
  return `/skill:${PROMPT_MASTER_SKILL} Generate a single paste-ready prompt for ${getPromptMasterTarget(targetTool)}. Optimize it for immediate use. User request: ${request.trim()}`;
}

export function extractPromptMasterPrompt(text: string): string | undefined {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return undefined;

  const fencedBlocks = [...normalized.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  for (const block of fencedBlocks) {
    const extracted = normalizeExtractedPrompt(block[1] ?? "");
    if (extracted) return extracted;
  }

  const targetMatch = normalized.match(/(?:^|\n)🎯\s*Target\s*:/u);
  if (!targetMatch || targetMatch.index === undefined) {
    return undefined;
  }

  const extracted = normalized.slice(0, targetMatch.index).trim();
  return normalizeExtractedPrompt(extracted);
}

export function extractPromptMasterPromptFromMessage(message: AgentMessage): string | undefined {
  if (!isAssistantMessage(message)) return undefined;
  return extractPromptMasterPrompt(getAssistantText(message));
}

export function dispatchPromptMaster(pi: ExtensionAPI, ctx: ExtensionContext, request: string, targetTool?: string): string {
  const message = buildPromptMasterRequest(request, targetTool);
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
  }
  return message;
}

export default function promptMasterInjection(pi: ExtensionAPI): void {
  pi.registerCommand("prompt-improve", {
    description: "Use the packaged prompt-master skill to improve a prompt request.",
    handler: async (args, ctx) => {
      const blockReason = getPromptMasterBlockReason(ctx);
      if (blockReason) {
        ctx.ui.notify(blockReason, "warning");
        return;
      }

      const initial = args.trim();
      const request = initial || (await ctx.ui.editor("Prompt to improve", ""))?.trim();
      if (!request) {
        ctx.ui.notify("No prompt request provided.", "info");
        return;
      }

      dispatchPromptMaster(pi, ctx, request, DEFAULT_PROMPT_MASTER_TARGET);
    },
  });

  pi.registerCommand("pm", {
    description: "Alias for /prompt-improve.",
    handler: async (args, ctx) => {
      const blockReason = getPromptMasterBlockReason(ctx);
      if (blockReason) {
        ctx.ui.notify(blockReason, "warning");
        return;
      }

      const request = args.trim() || (await ctx.ui.editor("Prompt to improve", ""))?.trim();
      if (!request) {
        ctx.ui.notify("No prompt request provided.", "info");
        return;
      }

      dispatchPromptMaster(pi, ctx, request, DEFAULT_PROMPT_MASTER_TARGET);
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
      const blockReason = getPromptMasterBlockReason(ctx);
      if (blockReason) {
        throw new Error(blockReason);
      }

      dispatchPromptMaster(pi, ctx, params.request, params.targetTool);
      const target = getPromptMasterTarget(params.targetTool);
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
