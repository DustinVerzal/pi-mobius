import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const REQUIRED_JS_TS_TOOLS = [
  "code_intel_repo_map",
  "code_intel_ast_search",
  "code_intel_definition",
  "code_intel_references",
  "code_intel_hover",
] as const;

export function hasCodeIntelTooling(pi: Pick<ExtensionAPI, "getAllTools">): boolean {
  const knownToolNames = new Set(pi.getAllTools().map((tool) => tool.name));
  return REQUIRED_JS_TS_TOOLS.every((toolName) => knownToolNames.has(toolName));
}

export function buildCodeIntelRoutingInstructions(): string {
  return [
    "Tool routing guidance for better code exploration:",
    "- Use ls/find for filesystem discovery.",
    "- Use grep for exact text matches, non-code files, or plain-text search.",
    "- For JS/TS code understanding, do not start with grep unless exact text matching is required.",
    "- Use code_intel_repo_map for JS/TS repo or subtree orientation before reading many files.",
    "- Use code_intel_ast_search for JS/TS symbol lookup or structural patterns instead of grep.",
    "- Use code_intel_definition, code_intel_references, and code_intel_hover for TS/TSX/JS semantic navigation when a location is known.",
    "- After code-intel narrows the target, use read on the few relevant files.",
  ].join("\n");
}

export default function codeIntelGuidance(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    if (!hasCodeIntelTooling(pi)) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildCodeIntelRoutingInstructions()}`,
    };
  });
}
