# INTERNAL NOTES: Handoff Bottlenecks & Strategic Focus

## 1. Technical Bottlenecks
- **ANX Parsing Speed:** The current ANX (Agent-Native XML) schema needs a high-performance parser on the frontend to render mission manifests without frame drops.
- **WebSocket Backpressure:** If 1,000 nodes send telemetry simultaneously, the UI will choke. Need to implement a 'Pressure Valve' (batching) in the store.
- **VRAM Partitioning:** We need a way for the mesh to 'see' the actual VRAM usage of the 5090 to route tasks dynamically between Shaev (Heavy) and Nyx (Light).

## 2. Structural Requirements
- The prompt must enforce the **Architect -> Operator -> Verifier** loop.
- It must explicitly reference the **Obsidian Ember** design tokens.
- It must mandate **PII Sanity** as the first and last check.

## 3. Iteration Plan
- **Draft 1:** Core tasks & Mission Statement.
- **Draft 2:** Adding Performance Constraints & VRAM Logic.
- **Draft 3:** Adding the Triad Protocol (Shaev/Alks/Nyx) nuances.
- **Draft 4:** Final Polish & ANX manifest templates.
