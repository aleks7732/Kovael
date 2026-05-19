# MISSION MANIFEST: Scaling the Sovereign Mesh [FINAL]

**To:** NyxClaude Code (Canonical Chair)  
**From:** Nyx in Gemini CLI  
**Mission Duration:** 0.5 Work-Day Cycle  

---

## 1. MISSION OBJECTIVE: COGNITIVE INFRASTRUCTURE SCALING
You are the **Lead Implementation Engineer**. Your mission is to scale the **Kovael Sovereign Agentic Mesh** into a high-throughput **Cognitive Control Plane**. You will focus on performance at 1,000 nodes, hardware-aware task orchestration, and high-density protocol rendering.

---

## 2. CORE MISSION MODULES

### MODULE A: The Telemetry Pressure Valve (1,000 Node Scalability)
- **Problem:** WebSocket telemetry flooding triggers excessive React re-renders, causing the UI to lag at high node counts.
- **Implementation:** Update `useWarRoomStore.ts` to implement **Action Batching**. 
- **Requirement:** Buffer incoming telemetry and commit to the Zustand state only once every 100ms.
- **Constraint:** All new components MUST strictly follow the **Dumb Node / Aggressive Memoization** pattern (React.memo).

### MODULE B: VRAM-Aware Orchestration (The 5090 Guard)
- **Problem:** Concurrent high-parameter model usage (Shaev/Nyx) can lead to VRAM fragmentation and OOM crashes.
- **Implementation:** Create `src/services/HardwareMonitor.ts`. Use a child process to call `nvidia-smi` and broadcast VRAM metrics.
- **Integration:** Update `MevBridge.ts` to implement a **Hardware-Gated Router**. Route heavy architectural tasks to Shaev only when >= 8GB VRAM is verified free.

### MODULE C: ANX High-Density Rendering & Context Sharding
- **Problem:** Mission SOPs are currently flat strings; they require high-density, structured visualization.
- **Implementation:** Implement `ANXDisplay.tsx` to detect and render `<mission_manifest>`, `<provenance>`, and `<adversarial_critique>` tags.
- **Optimization:** Implement **Context Sharding** in the handoff protocol. Prune agent memory to the last 3 turns + the ANX manifest before every dispatch to minimize VRAM overhead.

---

## 3. DESIGN SYSTEM (OBSIDIAN EMBER)
- **Palette:** Crail Orange (#C15F3C), Warm White (#F5F5DC), Warm Obsidian (#0A0A09).
- **Typography:** Inter (Sans), Space Grotesk (Display), JetBrains Mono (Tactical).
- **Aesthetic:** Radius-lg (16px), 12px glass-blur, ambient ember radial gradients.

---

## 4. COMMANDER'S INTENT (HARD RULES)
1. **PII Sanctity:** You MUST run the `pii-sanitizer` skill before every `git commit`. 
2. **Sovereignty:** No external API dependencies. All logic must reside within the `vantagepoint-command-core` directory.
3. **Receipts:** End your cycle with a **Verification Receipt** (SHA-256 hash) and a detailed **Delta Watch** report delivered **exclusively to this terminal.**

`Nyx mev Alks, dhorev.`
