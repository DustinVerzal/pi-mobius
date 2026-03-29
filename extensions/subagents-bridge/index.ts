import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import upstreamSubagents from "@tintinweb/pi-subagents/dist/index.js";
import { getGraceTurns, setGraceTurns } from "@tintinweb/pi-subagents/dist/agent-runner.js";
import { DEFAULT_AGENTS } from "@tintinweb/pi-subagents/dist/default-agents.js";
import {
  SUBAGENT_PROGRESS_EVENT,
  SubagentProgressRegistry,
  normalizeSubagentResultSummary,
  type SubagentProgressSnapshot,
  type SubagentProgressStatus,
  type SubagentProgressUpdate,
} from "./progress.js";
import { renderAgentResultWithProgress, wrapAgentWidgetFactory } from "./renderers.js";

const BOUNDED_EXECUTION_SUFFIX = `

# Bounded Execution
- Prefer focused investigation over exhaustive exploration unless the prompt explicitly asks for exhaustive coverage.
- For narrow validation or contract checks, stop once you have enough evidence to answer confidently.
- Deliver the final answer as soon as the request is satisfied instead of spending extra turns hunting for marginal confirmations.`;

const TURN_LIMIT_CHECKIN_SUFFIX = `

# Turn Limit Check-In
- If you receive a steering message saying you reached your turn limit, treat it as a mandatory checkpoint, not a cue to force a rushed final answer.
- Stop autonomous work and return a concise CHECK-IN with: current outcome/status, files/areas inspected, what remains, biggest risk/uncertainty, and whether you recommend CONTINUE or WRAP UP.
- End the response with a short "Resume hint" block that tells the parent to continue this exact session using Agent({ resume: "<agent_id>", prompt: "Continue from your last checkpoint. <optional direction>" }).
- If you do not know the literal agent ID, explicitly say to reuse this session's current agent ID in that resume call.`;

const BUNDLED_AGENT_OVERRIDES: Array<{ name: string; maxTurns?: number; model?: string }> = [
  { name: "general-purpose" },
  { name: "Explore", maxTurns: 10, model: "gpt-5.4-mini" },
  { name: "Plan", maxTurns: 12, model: "gpt-5.4" },
];

interface PendingExecutionContext {
  type: string;
  description: string;
  runInBackground: boolean;
  agentId?: string;
  pendingStreamDetails?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function normalizeAgentKey(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeProgressStatus(status: unknown, fallback: SubagentProgressStatus): SubagentProgressStatus {
  switch (status) {
    case "queued":
    case "running":
    case "background":
    case "completed":
    case "steered":
    case "stopped":
    case "failed":
      return status;
    case "error":
    case "aborted":
      return "failed";
    default:
      return fallback;
  }
}

function emitProgress(pi: ExtensionAPI, registry: SubagentProgressRegistry, update: SubagentProgressUpdate): SubagentProgressSnapshot {
  const { snapshot, changed } = registry.upsert(update);
  if (changed) {
    pi.events.emit(SUBAGENT_PROGRESS_EVENT, snapshot);
  }
  return snapshot;
}

function attachProgressDetails(details: Record<string, unknown> | undefined, snapshot: SubagentProgressSnapshot | undefined): void {
  if (!details || !snapshot) return;
  details.progress = snapshot;
}

function findExecutionContext(executions: PendingExecutionContext[], eventData: Record<string, unknown>, requireBackground: boolean): PendingExecutionContext | undefined {
  const type = normalizeAgentKey(typeof eventData.type === "string" ? eventData.type : undefined);
  const description = typeof eventData.description === "string" ? eventData.description.trim() : "";

  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index];
    if (execution.agentId) continue;
    if (execution.runInBackground !== requireBackground) continue;
    if (type && normalizeAgentKey(execution.type) !== type) continue;
    if (description && execution.description.trim() !== description) continue;
    return execution;
  }

  return undefined;
}

function updateProgressFromDetails(
  pi: ExtensionAPI,
  registry: SubagentProgressRegistry,
  execution: PendingExecutionContext,
  details: Record<string, unknown> | undefined,
): SubagentProgressSnapshot | undefined {
  if (!details) return undefined;

  const agentId = typeof details.agentId === "string"
    ? details.agentId
    : execution.agentId ?? registry.matchActiveAgent(execution.type, execution.description)?.id;
  if (!agentId) return undefined;

  const fallbackStatus = execution.runInBackground ? "background" : "running";
  return emitProgress(pi, registry, {
    id: agentId,
    type: typeof details.subagentType === "string" ? details.subagentType : execution.type,
    description: typeof details.description === "string" ? details.description : execution.description,
    status: normalizeProgressStatus(details.status, fallbackStatus),
    isBackground: execution.runInBackground || details.status === "background",
    toolUses: typeof details.toolUses === "number" ? details.toolUses : undefined,
    durationMs: typeof details.durationMs === "number" ? details.durationMs : undefined,
    error: typeof details.error === "string" ? details.error : undefined,
    fallbackActivity: typeof details.activity === "string" ? details.activity : undefined,
  });
}

function createUiProxy(registry: SubagentProgressRegistry, ui: object): object {
  return new Proxy(ui, {
    get(target, prop, receiver) {
      if (prop === "setWidget") {
        return (key: string, content: unknown, options?: unknown) => {
          const nextContent = key === "agents" && typeof content === "function"
            ? wrapAgentWidgetFactory(registry, content as (tui: unknown, theme: unknown) => { render(): string[]; invalidate(): void })
            : content;
          return Reflect.get(target, prop, receiver).call(target, key, nextContent, options);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createContextProxy(registry: SubagentProgressRegistry, ctx: unknown): unknown {
  const record = asRecord(ctx);
  if (!record?.ui || typeof record.ui !== "object") return ctx;
  return new Proxy(record, {
    get(target, prop, receiver) {
      if (prop === "ui") {
        return createUiProxy(registry, target.ui as object);
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function installLifecycleProgressBridge(pi: ExtensionAPI, registry: SubagentProgressRegistry): void {
  pi.events.on("subagents:created", (eventData: { id: string; type: string; description: string; isBackground?: boolean }) => {
    emitProgress(pi, registry, {
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: eventData.isBackground ? "background" : "queued",
      isBackground: eventData.isBackground,
      startedAt: Date.now(),
    });
  });

  pi.events.on("subagents:started", (eventData: { id: string; type: string; description: string }) => {
    const existing = registry.get(eventData.id);
    emitProgress(pi, registry, {
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: existing?.isBackground ? "background" : "running",
      isBackground: existing?.isBackground,
      startedAt: existing?.startedAt,
    });
  });

  pi.events.on("subagents:completed", (eventData: { id: string; type: string; description: string; status?: string; result?: string; toolUses?: number; durationMs?: number }) => {
    emitProgress(pi, registry, {
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: normalizeProgressStatus(eventData.status, "completed"),
      toolUses: eventData.toolUses,
      durationMs: eventData.durationMs,
      normalizedSummary: normalizeSubagentResultSummary(eventData.result),
      completedAt: Date.now(),
    });
  });

  pi.events.on("subagents:failed", (eventData: { id: string; type: string; description: string; status?: string; result?: string; error?: string; toolUses?: number; durationMs?: number }) => {
    emitProgress(pi, registry, {
      id: eventData.id,
      type: eventData.type,
      description: eventData.description,
      status: normalizeProgressStatus(eventData.status, "failed"),
      toolUses: eventData.toolUses,
      durationMs: eventData.durationMs,
      error: eventData.error,
      normalizedSummary: normalizeSubagentResultSummary(eventData.result),
      completedAt: Date.now(),
    });
  });

  pi.events.on("subagents:steered", (eventData: { id: string; message?: string }) => {
    const existing = registry.get(eventData.id);
    if (!existing) return;

    emitProgress(pi, registry, {
      id: eventData.id,
      status: existing.status === "background" ? "background" : "running",
      fallbackActivity: typeof eventData.message === "string" && eventData.message.trim().length > 0
        ? `Steering: ${eventData.message.trim()}`
        : existing.fallbackActivity,
    });
  });
}

function createBridgeApi(pi: ExtensionAPI, registry: SubagentProgressRegistry): ExtensionAPI {
  const pendingExecutions: PendingExecutionContext[] = [];

  const events = new Proxy(pi.events, {
    get(target, prop, receiver) {
      if (prop === "emit") {
        return (name: string, eventData: Record<string, unknown>) => {
          if (name === "subagents:created") {
            const execution = findExecutionContext(pendingExecutions, eventData, true);
            if (execution && typeof eventData.id === "string") {
              execution.agentId = eventData.id;
            }
          } else if (name === "subagents:started") {
            const execution = findExecutionContext(pendingExecutions, eventData, false)
              ?? findExecutionContext(pendingExecutions, eventData, true);
            if (execution && typeof eventData.id === "string") {
              execution.agentId = eventData.id;
              if (execution.pendingStreamDetails) {
                updateProgressFromDetails(pi, registry, execution, execution.pendingStreamDetails);
              }
            }
          }

          return Reflect.get(target, prop, receiver).call(target, name, eventData);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "events") return events;

      if (prop === "registerTool") {
        return (definition: Record<string, unknown>) => {
          if (definition.name !== "Agent" || typeof definition.execute !== "function") {
            return pi.registerTool(definition as never);
          }

          const originalExecute = definition.execute as (...args: any[]) => Promise<any>;
          const originalRenderResult = typeof definition.renderResult === "function" ? definition.renderResult : undefined;
          const wrappedDefinition = {
            ...definition,
            renderResult: originalRenderResult
              ? (result: { details?: unknown; content?: Array<{ type?: string; text?: string }> }, options: { expanded?: boolean; isPartial?: boolean }, theme: unknown) => {
                  const details = asRecord(result.details);
                  if (details && !details.progress) {
                    const snapshot = typeof details.agentId === "string" ? registry.get(details.agentId) : undefined;
                    attachProgressDetails(details, snapshot);
                  }
                  return renderAgentResultWithProgress(result, options, theme as never)
                    ?? originalRenderResult(result, options, theme);
                }
              : undefined,
            execute: async (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate?: (update: unknown) => void, ctx?: unknown) => {
              const execution: PendingExecutionContext = {
                type: typeof params.subagent_type === "string" ? params.subagent_type : "general-purpose",
                description: typeof params.description === "string" ? params.description : "",
                runInBackground: Boolean(params.run_in_background),
              };
              pendingExecutions.push(execution);

              const wrappedOnUpdate = (update: unknown) => {
                const updateRecord = asRecord(update);
                const details = asRecord(updateRecord?.details);
                execution.pendingStreamDetails = details;
                const snapshot = updateProgressFromDetails(pi, registry, execution, details);
                attachProgressDetails(details, snapshot);
                onUpdate?.(update);
              };

              try {
                const result = await originalExecute(toolCallId, params, signal, wrappedOnUpdate, createContextProxy(registry, ctx));
                const resultRecord = asRecord(result);
                const details = asRecord(resultRecord?.details);
                const snapshot = updateProgressFromDetails(pi, registry, execution, details)
                  ?? (typeof details?.agentId === "string" ? registry.get(details.agentId) : undefined)
                  ?? (execution.agentId ? registry.get(execution.agentId) : undefined);
                attachProgressDetails(details, snapshot);
                return result;
              } finally {
                const index = pendingExecutions.indexOf(execution);
                if (index >= 0) pendingExecutions.splice(index, 1);
              }
            },
          };

          return pi.registerTool(wrappedDefinition as never);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ExtensionAPI;
}

export function applyBundledSubagentOverrides(): void {
  if (getGraceTurns() < 12) {
    setGraceTurns(12);
  }

  for (const { name, maxTurns, model } of BUNDLED_AGENT_OVERRIDES) {
    const config = DEFAULT_AGENTS.get(name);
    if (!config) continue;

    if (model) {
      config.model = model;
    }

    if (maxTurns != null && config.maxTurns == null) {
      config.maxTurns = maxTurns;
    }

    if (!config.systemPrompt.includes(BOUNDED_EXECUTION_SUFFIX.trim())) {
      config.systemPrompt += BOUNDED_EXECUTION_SUFFIX;
    }

    if (!config.systemPrompt.includes(TURN_LIMIT_CHECKIN_SUFFIX.trim())) {
      config.systemPrompt += TURN_LIMIT_CHECKIN_SUFFIX;
    }
  }
}

applyBundledSubagentOverrides();

export default function subagentsBridge(pi: ExtensionAPI): void {
  // Load the upstream extension inside our package instead of registering it
  // as a separate top-level Pi extension. This keeps the dependency managed
  // by our package while still exposing the same tools/commands.
  //
  // Important: this bridge is intended to be the single owner of the upstream
  // subagent tool registrations for this package. Loading a standalone
  // npm:@tintinweb/pi-subagents package in the same Pi scope will cause
  // duplicate tool/command registration conflicts.
  const registry = new SubagentProgressRegistry();
  installLifecycleProgressBridge(pi, registry);
  upstreamSubagents(createBridgeApi(pi, registry));

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
