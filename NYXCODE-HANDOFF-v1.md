# MISSION MANIFEST: Scaling the Sovereign Mesh [FINAL]

**To:** NyxClaude Code (Canonical Chair)
**From:** Nyx in Gemini CLI
**Duration:** 0.5 Work-Day Cycle

---

## 1. OBJECTIVE: COGNITIVE INFRASTRUCTURE SCALING
You are the **Lead Engineer** for this cycle. Your mission is to scale the **Kovael Sovereign Agentic Mesh** from a validated prototype into a high-throughput **Cognitive Control Plane**. You will focus on performance at scale, hardware-aware task orchestration, and high-density protocol rendering.

---

## 2. CORE MISSION MODULES

### MODULE A: The Telemetry Pressure Valve
*   **Infrastructure:** Update `useWarRoomStore.ts` with a **Zustand Middleware** or internal buffer.
*   **Protocol:** Implement **Action Batching**. Incoming WebSocket events must be throttled to 10Hz (100ms ticks) to prevent React render-loop saturation.
*   **Enforcement:** Maintain the **Dumb Node / 60 FPS** mandate. No inline functions or direct array dependencies in custom node components.

### MODULE B: VRAM-Aware Orchestration (The 5090 Guard)
*   **Service:** Implement `src/services/HardwareMonitor.ts`. It must use `child_process` to query `nvidia-smi` every 5 seconds.
*   **Orchestration:** Update `MevBridge.ts` to implement a **Hardware-Gated Router**. 
    *   **Logic:** If `VRAM_FREE < 8GB`, architectural tasks remain in the "Queued" cluster. 
    *   **Logic:** Heavy reasoning (Shaev) is only invoked if VRAM headroom is verified green.

### MODULE C: ANX High-Density Rendering
*   **Component:** Implement `ANXDisplay.tsx` using Tailwind's `prose` and **Obsidian Ember** syntax tokens.
*   **Parsing:** Automatically detect and render `<mission_manifest>`, `<provenance>`, and `<adversarial_critique>` tags within the **TaskClusterNode**.
*   **Optimization:** Implement **Context Sharding** in the handoff logic. Prune historical context to the last 3 turns + the ANX manifest before every inter-agent dispatch.

---

## 3. DESIGN SYSTEM (OBSIDIAN EMBER)
*   **Palette:** Crail Orange (#C15F3C), Warm White (#F5F5DC), Warm Obsidian (#0A0A09).
*   **Typography:** Inter (Sans), Space Grotesk (Display), JetBrains Mono (Tactical).
*   **Aesthetic:** Radius-lg (16px), 12px blur, ambient ember radial gradients.

---

## 4. COMMANDER'S INTENT (HARD RULES)
1.  **PII Sanctity:** You MUST run the `pii-sanitizer` skill before every `git commit`. 
2.  **Sovereignty:** No external API dependencies. All logic must reside within the `vantagepoint-command-core` directory.
3.  **Handoff:** End your cycle with a **Verification Receipt** containing the SHA-256 hash of your last commit and a detailed **Delta Watch** report.

`Nyx mev Alks, dhorev.`
