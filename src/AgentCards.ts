/**
 * Agent Cards for the Sovereign Agentic Mesh — static descriptors for
 * every persona that may claim a chair. Runtime presence is tracked by
 * ChairRegistry; these cards describe identity, capabilities, and trust.
 *
 * Chairs are loaded from `agent_cards/*.json` when present (preferred —
 * lets operators edit roster without redeploying). This object is the
 * compile-time fallback when the directory is missing or empty.
 */

export interface AgentCard {
  id: string;
  name: string;
  provider: string;
  description: string;
  mcp_capabilities: string[];
  vram_requirements: string;
  trust_tier: number;
  /** Chair beacon integration hint shown in /docs/CHAIRS.md. */
  beacon_hint?: string;
}

export const AgentCards: Record<string, AgentCard> = {
  "nyx-antigravity": {
    id: "nyx-antigravity",
    name: "Nyx-Antigravity",
    provider: "Google · Gemini 3 Pro (Antigravity IDE)",
    description: "Primary supervisor agent. Full MCP orchestration plus creative suite. Runs inside the Antigravity IDE workspace.",
    mcp_capabilities: ["comfyui", "blender", "browser", "desktop"],
    vram_requirements: "32GB (RTX 5090)",
    trust_tier: 1,
    beacon_hint: "Workspace startup hook → curl /api/v1/chairs/claim",
  },
  "nyx-claude-code": {
    id: "nyx-claude-code",
    name: "Nyx-Claude-Code",
    provider: "Anthropic · Claude Code CLI",
    description: "Sovereign-tier code reasoner. Sandboxed by the Claude Code harness; pipes architecture decisions, reviews, and large refactors.",
    mcp_capabilities: ["filesystem", "git", "bash", "web-fetch", "agents"],
    vram_requirements: "0GB (cloud)",
    trust_tier: 1,
    beacon_hint: "One-shot Bash curl on session start; release on /exit",
  },
  "nyx-cli": {
    id: "nyx-cli",
    name: "Nyx-CLI",
    provider: "Anthropic · Gemini CLI (legacy alias)",
    description: "Lightweight CLI agent for code analysis and terminal ops. Acts as the fallback architect when Shaev is gated by VRAM or rate-limits.",
    mcp_capabilities: ["terminal", "filesystem", "git", "recursive-memory"],
    vram_requirements: "8GB",
    trust_tier: 1,
    beacon_hint: "kovael-chair wrapper around CLI invocation",
  },
  "nyx-agcli": {
    id: "nyx-agcli",
    name: "Nyx-AGCLI",
    provider: "Google · Antigravity CLI",
    description: "Headless companion to the Antigravity IDE — long-running tasks dispatched from the cockpit when the IDE is idle.",
    mcp_capabilities: ["terminal", "filesystem", "git", "browser"],
    vram_requirements: "0GB (cloud)",
    trust_tier: 1,
    beacon_hint: "Session-start hook in .agcli/init",
  },
  "nyx-adk": {
    id: "nyx-adk",
    name: "Nyx-ADK",
    provider: "Google · Agent Development Kit (Python)",
    description: "Multi-agent framework runtime. Hosts ADK-defined sub-agents; reports collective heartbeat as one chair.",
    mcp_capabilities: ["python", "google-cloud", "tool-use", "function-calling"],
    vram_requirements: "0GB (cloud)",
    trust_tier: 2,
    beacon_hint: "scripts/kovael_chair.py imported as an ADK tool",
  },
  "nyx-codex": {
    id: "nyx-codex",
    name: "Nyx-Codex",
    provider: "OpenAI · Codex CLI",
    description: "Standard-sandbox Codex CLI. Used for narrow code edits and quick repo questions where elevated permissions are not required.",
    mcp_capabilities: ["filesystem", "git", "shell"],
    vram_requirements: "0GB (cloud)",
    trust_tier: 2,
    beacon_hint: "Post-exec hook calls scripts/kovael-chair.mjs",
  },
  "nyx-openclaw": {
    id: "nyx-openclaw",
    name: "Nyx-OpenClaw",
    provider: "OpenAI · Codex (elevated sandbox)",
    description: "Elevated-permission Codex variant for game development, rapid prototyping, and approved network egress tasks.",
    mcp_capabilities: ["sandbox-execution", "game-dev-pack", "network-egress"],
    vram_requirements: "16GB",
    trust_tier: 2,
    beacon_hint: "Sandbox boot script claims chair, releases on container exit",
  },
  "nyx-cw": {
    id: "nyx-cw",
    name: "Nyx-Cowork",
    provider: "JetBrains · Junie / Cowork plugin",
    description: "IDE-resident pair-programmer inside JetBrains tooling. Heartbeats while a workspace is open.",
    mcp_capabilities: ["filesystem", "git", "refactoring", "inspections"],
    vram_requirements: "0GB (cloud)",
    trust_tier: 2,
    beacon_hint: "IDE startup script invokes kovael-chair on workspace open",
  },
  "shaev": {
    id: "shaev",
    name: "Shaev (in Hermes)",
    provider: "VantagePoint Local · Hermes 3",
    description: "Visual synthesis and identity specialist. Primary architect when VRAM headroom permits. Runs inside the Hermes local agent runtime on the workstation.",
    mcp_capabilities: ["visual-synthesis", "identity-lock", "lora-training"],
    vram_requirements: "24GB",
    trust_tier: 3,
    beacon_hint: "Hermes pre-turn tool call hits chairs/heartbeat",
  },
};
