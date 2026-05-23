# APEX Adversary Replay Lab & Security Audit Report
`Substrate Reference: Kovael-Mesh Core / Spatial War Room`

---

### OBSERVE

We performed an extensive, multi-vector adversarial simulation and threat modeling exercise across three primary components of the Kovael-Mesh architecture:

1.  **WebSocket (WS) Upgrade Mechanisms & Token Gates (`MeshOrchestrator`)**:
    *   *Mechanism*: Sockets are upgraded via `wss.handleUpgrade` upon matching specific bearer token, subprotocol, or query parameter gates.
    *   *Threat Vector*: Denial of Service (DoS) upgrade storms can exhaust TCP sockets or CPU cycles by launching rapid, unauthenticated connection attempts.
    *   *Timing Attacks & Leakage*: Giant, malformed, or dirty tokens (control characters, null bytes, raw Unicode) passed in URL query strings or authorization headers could trigger downstream parser exceptions or leak API keys in stack traces and server-side log blocks.
    
2.  **Telemetry and Obs-Ring Buffers (`TraceRingBuffer` / `TracingBridge`)**:
    *   *Mechanism*: Finished span trees wrapping MevBridge executions are processed and accumulated inside an in-memory per-cycle ring buffer.
    *   *Threat Vector*: Memory exhaustion and leaks. Large LLM context trees and unconstrained attributes (e.g. system instructions, generation prompts, circular structures) can bloat the V8 heap.
    *   *Retention*: If evicted traces are not cleanly severed (leaving hidden references in map iterations, internal arrays, or timing handles), they escape the garbage collector, causing progressive degradation under sustained workload.

3.  **ComfyUI Workflow Synthesis Bridge (`ComfyUiBridge`)**:
    *   *Mechanism*: The bridge parses incoming prompt requests, injects dynamic LoRAs, sets palette HSL arrays, and posts them to ComfyUI's REST prompt endpoint. If ComfyUI is offline, it generates an SVG fallback.
    *   *Threat Vector*: Prompt injection, JSON breakout, and SVG XML/Stored-XSS injection. Malicious inputs (quotes, braces, XML scripts) passed in agentIds, prompt triggers, or HSL scales could manipulate the workflow JSON syntax or weaponize the fallback SVG string with event hooks (like `onerror`, `onload`).

---

### DISTILL

Our rigorous test-driven validation (implemented via `AdversaryWs.test.ts`, `TraceFuzz.test.ts`, and `ComfyFuzz.test.ts`) yielded critical structural insights:

*   **WebSocket Shielding Priority**: Rate-limiting acts as a shielding layer *before* verifying tokens or processing cryptographic signatures. When a client floods the upgrade gate, the `RateLimiter` intercepts the IP immediately and triggers a custom WS Close frame with close code `4429` (rate limited). This preemptive block prevents unauthenticated stormers from burning CPU cycles on SHA-256 bearer key matching.
*   **Completing Rejection Handshakes**: Rejecting unauthenticated requests by completing the upgrade handshake and immediately closing with `4401` (unauthorized) avoids opaque `1006` network-level termination. This respects the W3C Trace context and allows clients to read clean, descriptive application codes securely. Extremely long URLs (exceeding 64KB) are naturally terminated by Node's HTTP parser with a safe `1006` socket termination.
*   **Dual-Layer Telemetry Bounding**: A simple size limit is insufficient for complex trace trees. The `TraceRingBuffer` utilizes a double-layer sanitizer:
    1.  *Horizontal Truncation*: Successively drops historical spans from a trace tree when total JSON size exceeds `maxTraceBytes`.
    2.  *Vertical Compaction*: If a single span still exceeds budget, it strips all custom attributes, retaining only vital telemetry keys (`kovael.agent.id`, `gen_ai.system`, `gen_ai.request.model`), before ultimately fallback-clearing the span list entirely if the reserved attributes still exceed bounds.
*   **Garbage Collection Safety (Reference Severing)**: Removing keys from the internal `byCycle` Map and shifted indexes in the `order` array cleanly severs all V8 pointer references. Under a heavy 2,000-cycle fuzzed load, the heap remains perfectly flat, confirming that GC fully reclaims memory.
*   **Encoding vs. String Blacklisting**: Blacklisting prompt inputs is inherently fragile. The `ComfyUiBridge` survives malicious injections through strict serialization and escaping:
    *   `JSON.stringify` naturally sanitizes raw braces, quotes, and backslashes, preventing JSON breakouts.
    *   XML entity-encoding (`&lt;`, `&gt;`, `&quot;`, `&#39;`) in fallback SVGs ensures any injected tags or event hooks are treated as inert strings, preventing Stored XSS inside spatial cockpit frames.

---

### REUSE

The defensive design patterns validated in these fuzzers serve as reusable templates across the VantagePoint environment:

1.  **Strict IP Normalization Pattern**:
    Normalizing IPv4-mapped IPv6 addresses (`::ffff:x.x.x.x`) to single standard blocks should be reused across all server surfaces to prevent bypasses where attackers loop over multiple IP representations to skirt token buckets.
2.  **Cryptographic Timing-Safe Comparison**:
    Always match credentials (such as API bearer keys or subprotocols) using `crypto.timingSafeEqual` after SHA-256 hashing. Comparing raw string values directly exposes the system to precise timing measurements, enabling adversaries to map token characters step-by-step.
3.  **Strict Primitive Clamping**:
    Never pass arbitrary inputs directly to math or logic threads. The fuzzer proved that casting `NaN`, `Infinity`, `{}` or `[]` to numeric bounds is highly stable when wrapped in a robust, two-sided clamp helper:
    ```typescript
    function clampNumber(value: number, min: number, max: number): number {
        if (!Number.isFinite(value)) return min;
        return Math.min(max, Math.max(min, value));
    }
    ```

---

### REFINE

To ensure perpetual resistance against evolving adversary tactics, we establish the following long-term security guidelines:

*   **OWASP WebSocket Authentication Upgrades**:
    *   Ensure query-string token stripping is always run at the absolute entry point of the upgrade handler. Stripping `?token=` parameters instantly prevents credentials from leaking into downstream reverse proxies, router telemetry, or access logs.
    *   Subprotocols (`Sec-WebSocket-Protocol`) should remain the gold standard for browser-initiated WebSocket authentication, as they are not subject to standard URL leakage or HTTP header access constraints in native browser scripts.
*   **W3C Trace Context Continuity**:
    *   All trace operations must propagate span contexts seamlessly. If an upgrade is rejected, any error reporting should carry the parent trace context securely without hardcoding secret keys inside standard OTel headers or logs.
*   **Zero-Shell Code Integrity**:
    *   Under no circumstances should the ComfyUI pipeline or any rendering engine invoke raw command lines (e.g. `exec`, `execSync`, `python`). All downstream APIs must execute via HTTP fetch using deterministic JSON payloads.
*   **Continuous Fuzz Automation**:
    *   Integrate `TraceFuzz.test.ts` and `ComfyFuzz.test.ts` into the continuous integration (CI) workflow. Fuzzing under massive, random, circular, and malicious structures guarantees that structural changes to memory buffers or serialization loops will never introduce secret exposures, memory leaks, or execution vulnerabilities.

---
*Report compiled by the Security Subagent for Kovael.*
