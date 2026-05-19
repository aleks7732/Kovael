/**
 * Agent Cards for VantagePoint Command Core
 * Defines the identity, capabilities, and resource requirements for the Nyx Team.
 */

export interface AgentCard {
  id: string;
  name: string;
  provider: string;
  description: string;
  mcp_capabilities: string[];
  vram_requirements: string;
  trust_tier: number;
}

export const AgentCards: Record<string, AgentCard> = {
  "nyx-antigravity": {
    id: "nyx-antigravity",
    name: "Nyx-Antigravity",
    provider: "Google DeepMind",
    description: "Primary supervisor agent with full MCP orchestration and creative suite.",
    mcp_capabilities: ["comfyui", "blender", "browser", "desktop"],
    vram_requirements: "32GB (RTX 5090)",
    trust_tier: 1
  },
  "nyx-cli": {
    id: "nyx-cli",
    name: "Nyx-CLI",
    provider: "Anthropic / Gemini CLI",
    description: "Autonomous CLI agent specialized in code analysis and system operations.",
    mcp_capabilities: ["terminal", "filesystem", "git", "recursive-memory"],
    vram_requirements: "8GB",
    trust_tier: 1
  },
  "nyx-openclaw": {
    id: "nyx-openclaw",
    name: "Nyx-OpenClaw",
    provider: "OpenAI Codex",
    description: "Elevated sandbox specialist for game development and rapid prototyping.",
    mcp_capabilities: ["sandbox-execution", "game-dev-pack"],
    vram_requirements: "16GB",
    trust_tier: 2
  },
  "shaev": {
    id: "shaev",
    name: "Shaev",
    provider: "VantagePoint Local",
    description: "Visual synthesis and identity specialist for high-fidelity character generation.",
    mcp_capabilities: ["visual-synthesis", "identity-lock", "lora-training"],
    vram_requirements: "24GB",
    trust_tier: 3
  }
};
