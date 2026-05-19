

To maintain an architectural standard capable of rendering 1,000 concurrent nodes seamlessly, Kovael strictly enforces the following performance rules [cite: 14, 15, 16]:
1.  **Component Memoization:** Every custom node template provided as a prop (e.g., `taskCluster` or `agentHeartbeat`) is aggressively wrapped in `React.memo()`. This ensures that even when a node is actively dragged across the screen, the contents inside the node do not recalculate [cite: 13, 16].
2.  **Function Referencing:** All listener functions (e.g., `onNodeClick`, `onNodesChange`) are strictly wrapped in `useCallback()` to prevent React from assigning new references on every render cycle [cite: 15, 16]. Passing anonymous inline functions into the `<ReactFlow>` component is strictly banned [cite: 15].
3.  **Array Decoupling:** Hooks are isolated from depending directly on the global `nodes` or `edges` array, preventing minor property updates from triggering cascading global re-renders [cite: 13, 14].

### Recursive Task Decomposition

When a new objective is injected into the canvas via a Task Node, it triggers an automated recursive decomposition cycle. The orchestrator analyzes the top-level goal, querying the shared memory to understand historical precedents. It then spawns a computing flow to automatically wire a graph of up to 20 granular sub-tasks. These tasks are then algorithmically routed to the most appropriate Nyx runtime or Shaev based on required capabilities and current VRAM availability.

## Technical Implementation and Codebase Synthesis

The technological foundation of Kovael strictly adheres to sovereign rules: a React/TypeScript/Vite frontend, a unified orchestration bus, and native hardware optimization. The following subsections provide the core implementation scripts required to bootstrap the architecture.

### Hardware Constraints and the Vector Database Solution

A critical implementation bottleneck for local deployment is the RTX 5090's 32GB VRAM limit. Running both Shaev and Nyx concurrently via high-parameter LLMs (e.g., Llama-3 70B quantized or dual 8B models) consumes the majority of this allocation. 

Therefore, "Which specific local vector database is being utilized, and how is its VRAM/RAM overhead calculated?" is a critical architectural question. To maximize VRAM efficiency, Kovael explicitly avoids heavyweight external databases (like Milvus or standalone Chroma instances). Instead, it leverages Node.js v22.5.0+'s newly introduced native `node:sqlite` module alongside community vector extensions (like `sqlite-vec`) [cite: 17, 18, 19].

The `node:sqlite` module, accessible via `import { DatabaseSync } from 'node:sqlite'`, allows for entirely serverless, in-memory databases initialized with `new DatabaseSync(':memory:')` [cite: 17, 20]. This approach requires zero network overhead, eliminates the need for node-gyp C++ recompilations, and strictly utilizes system RAM (consuming mere megabytes rather than gigabytes) [cite: 18, 19, 21]. This surgical choice leaves the full 32GB of VRAM dedicated purely to LLM inference [cite: 19].

### 1. MeshOrchestrator.ts: The Central Synchronization Hub

The `MeshOrchestrator` acts as the unified bus, connecting the React Flow frontend with the distributed AI runtimes via WebSockets. 

```typescript
// MeshOrchestrator.ts
import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite'; // Utilizing native Node 22 SQLite [cite: 17]

/**
 * Nyx-Orchestrator v2: Central bus for the Sovereign Agentic Mesh.
 * Handles telemetry, task routing, and shared memory synchronization.
 */
export class MeshOrchestrator extends EventEmitter {
    private wss: WebSocketServer;
    private memoryDb: DatabaseSync;

    constructor(port: number) {
        super();
        this.wss = new WebSocketServer({ port });
        // Native, zero-dependency, in-memory semantic storage [cite: 17, 20]
        this.memoryDb = new DatabaseSync(':memory:'); 
        this.initializeBus();
        this.initializeMemory();
    }

    private initializeMemory() {
        this.memoryDb.exec(`
            CREATE TABLE semantic_memory(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                vector_blob BLOB,
                relevance_weight REAL
            ) STRICT
        `);
    }

    private initializeBus() {
        this.wss.on('connection', (ws: WebSocket, request) => {
            const nodeId = this.extractNodeId(request);
            
            ws.on('message', async (data: string) => {
                const payload = JSON.parse(data);
                await this.handleTelemetry(nodeId, payload);
            });
        });
    }

    /**
     * Injects a top-level task and triggers recursive decomposition.
     */
    public async injectTask(goal: string): Promise<string[]> {
        // Decomposition logic utilizing Shaev for reasoning
        const subTasks = await this.requestDecompositionFromShaev(goal);
        
        subTasks.forEach(task => this.emit('task_routed', task));
        return subTasks.map(t => t.id);
    }
    
    // Additional boilerplate omitted for brevity
}
```

### 2. SpatialWarRoom.tsx: The Infinite Canvas

The UI layer relies on `@xyflow/react`. It utilizes custom node types to visualize the multi-agent telemetry and hierarchical task routing.

```tsx
// SpatialWarRoom.tsx
import React, { useState, useCallback, useEffect, memo } from 'react';
import { 
    ReactFlow, 
    Background, 
    Controls, 
    MiniMap,
    applyNodeChanges, 
    applyEdgeChanges,
    Node,
    Edge
} from '@xyflow/react';
import '@xyflow/react/dist/style.css'; 

// CRITICAL: Aggressive Memoization of Node Templates to maintain 60 FPS [cite: 13, 14]
const AgentHeartbeatNode = memo(({ data }) => (
    <div style={{ padding: 10, border: '1px solid #00ff00', background: '#222' }}>
        <strong>{data.label}</strong>
        <div>VRAM: {data.vram}</div>
    </div>
));

const nodeTypes = {
    agentHeartbeat: AgentHeartbeatNode,
};

export default function SpatialWarRoom() {
    const [nodes, setNodes] = useState<Node[]>([]);
    const [edges, setEdges] = useState<Edge[]>([]);

    // CRITICAL: Function references strictly wrapped in useCallback [cite: 15, 16]
    const onNodesChange = useCallback(
        (changes: any) => setNodes((nds) => applyNodeChanges(changes, nds)),
        []
    );
    const onEdgesChange = useCallback(
        (changes: any) => setEdges((eds) => applyEdgeChanges(changes, eds)),
        []
    );

    // Listen to MeshOrchestrator WebSocket for real-time node generation
    useEffect(() => {
        const ws = new WebSocket('ws://localhost:8080');
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'NEW_SUBTASK') {
                // Layout logic to place new task in appropriate "Cluster" space
                setNodes((nds) => [...nds, data.nodeData]);
            }
        };
        return () => ws.close();
    }, []);

    return (
        <div style={{ width: '100vw', height: '100vh', backgroundColor: '#0A0A0A' }}>
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                colorMode="dark"
                fitView
            >
                <Background color="#333" gap={16} />
                <Controls />
                <MiniMap nodeColor={(n) => (n.type === 'agentHeartbeat' ? '#00ff00' : '#444')} />
            </ReactFlow>
        </div>
    );
}
```

### 3. MevBridge.ts: The Triad Collaboration Protocol

```typescript
// MevBridge.ts
/**
 * Protocol managing the collaborative hand-offs between Shaev (reasoning) 
 * and Nyx (execution).
 */
export class MevBridge {
    private sharedContext: string;

    constructor() {
        this.sharedContext = "VPC_WORKSPACE_ROOT";
    }

    /**
     * Shaev generates a semantic blueprint, which is locked to prevent Nyx 
     * execution until architectural validation is complete.
     */
    public async commitBlueprint(shaevOutput: Blueprint): Promise<string> {
        const lockId = this.acquireWriteLock(shaevOutput.targetDomain);
        
        // Log to node:sqlite memory with high 'reinforcement' weight
        await MemorySys.index(shaevOutput, { importance: 0.95 });
        
        return lockId;
    }

    /**
     * Nyx consumes the blueprint and translates it into atomic CLI tools.
     */
    public async executeBlueprint(lockId: string, nyxRuntime: NyxInstance) {
        const blueprint = this.retrieveLockedBlueprint(lockId);
        const executionResult = await nyxRuntime.operate(blueprint);
        
        this.releaseWriteLock(lockId);
        return executionResult;
    }
}
```

### 4. SovereignProxy.ts: MCP Wrapper for Weak Tools

To integrate external cloud providers securely without compromising the mesh's integrity, Kovael utilizes the official `@modelcontextprotocol/sdk` to build a localized MCP server wrapper [cite: 10, 22]. 

```typescript
// SovereignProxy.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Sovereign Proxy: Wraps external/weak LLMs in an MCP-compliant execution environment.
 * Prevents direct filesystem access, forcing interactions through standard schemas.
 */
export class SovereignProxy {
    private server: McpServer;

    constructor() {
        this.server = new McpServer({
            name: "Nyx-Sovereign-Proxy",
            version: "1.0.0"
        });
        this.registerSecureTools();
    }

    private registerSecureTools() {
        // Registering a tightly controlled tool for external models to use
        this.server.tool(
            "request_mesh_data",
            "Allows external models to query mesh data safely.",
            {
                query: z.string().describe("Semantic query for the Nyx memory cluster"),
                maxResults: z.number().max(5).default(1)
            },
            async ({ query, maxResults }) => {
                const data = await OrchestratorBus.queryMemory(query, maxResults);
                return {
                    content: [{ type: "text", text: JSON.stringify(data) }]
                };
            }
        );
    }

    public async connect() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
    }
}
```

## Downstream Implications: Economics and Energy

Running a continuous Sovereign Agentic Mesh locally presents distinct downstream trade-offs. Economically, the system dramatically reduces OpEx by circumventing thousands of daily API calls to commercial LLMs, allowing the mesh to run recursive, high-iteration loops functionally "for free." However, environmentally, keeping a high-end RTX 5090 constantly active for local inference generates significant heat and continuous high wattage draw (often exceeding 350W under load). 

## Bootstrapping Guide: Initializing the Expanse

To initialize the VantagePoint Command Expanse from `vantagepoint-command-core`, developers must adhere to strict hardware and software prerequisites.

### Prerequisites and Engine Requirements
1.  **Hardware:** An NVIDIA RTX 5090 with 32GB VRAM. VRAM allocation should be partitioned: ~24GB for the primary Shaev/Nyx reasoning models, reserving the remaining 8GB for UI rendering and OS overhead.
2.  **Node.js Enforcement:** Node.js version 22.12.0 or higher is strictly required. Attempting to run specific plugins on earlier versions like 21.x will result in unsupported protocol errors and silent failures. This is primarily because Node.js 22.12.0 introduced `require(esm)` enabled by default, an essential capability that allows older CommonJS security scripts to natively interoperate with newer ECMAScript Modules (which MCP relies heavily upon) without throwing `ERR_REQUIRE_ESM` errors [cite: 23, 24, 25].
3.  **Package Managers:** Use `pnpm` to respect strict dependency hoisting required by the OpenClaw and MCP frameworks.

### Initialization Sequence

1.  **Initialize the Unified Bus:**
    Launch the core orchestrator. This binds the WebSocket servers and initializes the `node:sqlite` database for the biologically-inspired memory system.
    ```bash
    pnpm run start:orchestrator
    ```
2.  **Spawn the Cognitive Nodes:**
    Initialize the local models via vLLM or Ollama. Ensure the `MevBridge` registers Shaev and Nyx-Local to the Orchestrator's active node registry.
    ```bash
    pnpm run start:nyx-local --vram-limit=16gb
    pnpm run start:shaev-hermes --vram-limit=8gb
    ```
3.  **Deploy the Sovereign Proxy:**
    For workflows requiring external cloud assistance, instantiate the MCP wrapper to bridge external satellite agents safely into the local bus.
    ```bash
    pnpm run start:sovereign-proxy
    ```
4.  **Ignite the War Room:**
    Start the Vite development server to render the React Flow canvas.
    ```bash
    cd packages/spatial-war-room
    pnpm run dev
    ```

## Future Outlook: The Evolution of the Sovereign Mesh

The current instantiation of Kovael on a single RTX 5090 is merely the prototype stage. The future outlook of the Sovereign Agentic Mesh involves expanding beyond single-node physical limits. The architecture is slated to evolve toward distributed multi-node clusters utilizing WebRTC for ultra-low latency mesh networking across disparate geographic locations. Furthermore, as local Neural Processing Units (NPUs) become standardized alongside GPUs, the biologically-inspired memory algorithms currently calculated on CPU RAM will likely be entirely offloaded, enabling true self-modifying code architectures that refine their own internal logic in real time.

**Sources:**
1. [davidfdzmorilla.dev](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGoQGMLNJ-Sts11obWKby5uq46TncXK--qdayf3gFl0nOHNdgDDdWMltTRkXuqEe3GkkE0reHwKiO1G_XS0Q0uJbUKS7LY-UIhuj8Qf-R_TDpLR)
2. [arxiv.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHsaKT3QtmhJixg_z_1GoPM2bqjb1g0X2Gy4jTT8TfbKgv97URRgcfVbLfTNtuN8mJd5oqmbqmEU1hJ-To9-664GmjjPEvjopb211dRIsMFw4oql3VPhqDcFQ==)
3. [researchgate.net](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEt5cOCE0eGF5Eols2Uk_o0W2SCXvWm7o-MUl7igjXXVylPMA9nk_bpikkPzJMazMKApPDF8W0ZWdTwekH6NK8ziAwT5SGX-6OG8AYTyH41_NRyVIUxyi2cnvuovX-RONQ5pOmj38pEKpnjryHX2fo0rXKeIMwvJi4EB1ziktgAdnAtma-g2AFk_n2tlp4pjWnQopEmwVxG2oL-Yw48luO3NWI5dO_o64DTBWyuIYGeHAisZibAbJGNyQ==)
4. [arxiv.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF1D3y5hjOJuJ1DXEis6lUJUGnk1prgVEh1APhSRz0EeHMRTzMi77yhe98_Q4EpvLwdkPsdZjILx4niByIp9N9gbSIZK0VejRBtPwU6FnRmwmEOtgRl7A==)
5. [arxiv.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFU_htk32XKT1k3E3P0EKjhedmwixKeFuGlxWImoc1f0Za-E-_AVltZB2BP4p6kFyQW0m4GqHmLBcnZhb65ozqiSAI46y_IVlFZ5yOUESy990AkVEFLmuC9kg==)
6. [researchgate.net](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFzFw_eFGfkiiEdoKWin66vUT1LVt0_Ofk7sorWniY2iUbX3ja104fjrrhye0sjUbMU1Xnz6cwV4Ar_3ofthdMosqFFZoec0sJ_HkfXg7OtJasIK4KVtjDld0GRag7rUHnIqDzObLARK5QgSrlt4KBjDM3lQ-6qozFc1A7YpZ8_l_cQz7aCkkT9hGOG55LcmQTYU76-Y9V7lj5RDH9QJM9TCKdw1xVcUaFZSsXg)
7. [anthropic.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEFht2LvvwGa4sGTVPUDaOHE4XcP7lDZCFJbILuIqgBI91jillVaCA-wDac_shxBKLG0xCaPTKXPrq10kfzg9q9mbkvCJzGwLzsiFxDljevmZrGEn1wJ9Z8a2GOLfhbsUoIXDJssDBf)
8. [wikipedia.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHK48zr2kbT2CHN1KHB66rgOV3AEy1gIzbQQEMfagBntZaCBLnABiTGeaEg-gyl4mda7p2caWR_8YfEkNd0doGQy0fRY9HSSMgDchWu8EKGz9Tv34kYIOALrJIOIoqQwdLxe3Oy6J1OkHA2)
9. [modelcontextprotocol.io](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGQ7kRGiUTu9KexB5N86puKWQD57b_b1Z75ViNqtInEmZR_ww0Y7YEEkvxYIVQDpAM_SNIXrXhkUK2UQOW5ysxvRXGZBHGLWcUTxywcbM1U2Ozw_sMxqpxqywF5PNGOLw5GorZmbAlhpQpd9vWnXTM=)
10. [npmjs.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQHU-Cp8Vz-4O_XMm-ocZ_H6na1f_1wCAZgDuQZoHeUo7Xy3u7HIypf7WhJafRoIZFNZZK-QtmZ2H8ZZ0Pj_1hGmj9AWKAu4kxTZPjLh4esHKgWUmg0RyzE0H5FQAwRBI_sHXRkG9WXhpvM8chM-J90t4BLRE83B7GULvoloGkWldQ==)
11. [medium.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFIbPc3p9bPM1rvuXIqyDGUODG333JY4VNr1qviy-m0CVNHTLCy28VFIrj7zrtLcP2kNPQrEPlGEFfiY4hKzacLIO9Ocj7FFY7RJxgpBS2KYR8cRa3tzisvsQ3mvbzVDAJv_aTY_o5uiqJMX3L-hvnvI40uZsbG5KsjqrrenvxmVmIXBeeqB4hh97dVjb8QTwAWB2vvF24pRv9BfLlYMPTo6c4ZeEaA9kKu1XHaiAZmvLnv1w==)
12. [anthropic.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH88WS49PH2tO68qrJjyd4KZLabwghQlXUIS5nWqVZKj_YW_ZcNo-SEAu2l-IsJjF40L1_5pr1ZogO3kaybV78DMUhgvK1MZ_14u-eGi9YWG4DG2b1kxAFsBeykFxlhTPbCw5SYFC2blu5fBdBVmnVs1-Hd)
13. [website-files.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFgksCTJuP_h6YuX64u3FcfeQrgUf7moIgQTiv12RPTwNwflWGIxExOtbznxPXOuY_4Hxfj60xpoFd2bYDPsnJY3rvKwvnAXS0M5yUIFUAZ-pJgl0E17j7c05i2PIQrg2zja8F-Tms9ZwA_HWH0bHyGF3KUyOQBBFFQjmE-VphHJzGdgIG13ca8TdIfhkkeGLqfquInWZ2JeFXvrIHjoqPDYOcjUL8Laik4RF_TnuyPbV0=)
14. [synergycodes.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGcqDErm8YaeyRvxwB7UAMvrr6oZ1tE1krld5RcVP8JKd0r-ave_Chghrbegn6KZWR2z670olqp0z6-gL9Yzjl1_9JiPvo7DBQVrFnF-pRWiloqi1pUU9eZ6TXhiiZk9we3Uat2KVeX4OuT57kPBsltWL1UL2ZwqqnKCqEHnt8ozldlGnyI1BRriBSE)
15. [medium.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQERqFVDKfq05cLdHL_J-As35yYcke7PbUSsPWUnjFaLW2el7wZYWeZfef03mexq6dLIjXoFCawjxMmwCRPYdOGq6UYnJ-dtWEEc65nXv9eE_d0ra8mKnKlhxDygPVrosZxMrhwIjY-v6zNN6eE6LiAEpaU59fQZumiTnnhlORwwc9Wf1hy6qp5hit7CwDQZgXGh_L9nxrNuxPpYf7DFH3k0vDNrgksmWw==)
16. [reactflow.dev](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGzrIAYi6o-LMKOQNtBDpU-ZzGUJvVBwFnbgTD3gfr5Ins4YHHj3raySU_FqXyLdnnxfd_Gu8X1LEH3eK_qc87E8AufSTM0KfL3omlO-UCNxUUABi8ffH6D59GJqO6XaddPlYMVNhIe4dcI)
17. [nodejs.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEpjpEatCjsldif7IQSuTFFFd4fCPTzu8-IYTBkO-Tvm52IKV6PxJMfvLqWtaUq80W4Ke54BCmLePbIW0N_4V6SK45-vEGGzXhoQDA4Uxz07T4JLbnuLyyj9s21_iKzCz99DQhvQHblVaKjqUI5DtPvqsWNrg3R)
18. [mapsam.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH0EdmBYDVmUdw0vlBfQbkDufhqX-kCY3E1zGreQx95LACZ1Ry6vUr1G03RIlkbHHZqWfuw8aCJkyS6J35MDuuGDrgnbSJ2vxvvPns-Y2pTEFoeXEpoopq2n616j5L8Ug2D)
19. [logrocket.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGgmx_Dk06KaQE4t69fYmsdDL41t6LdroJys5m-DTZVtJRyVE_QSR2f9xjWHVPx811ZaXRPNXd7FYy1UDcvvDzMDOxdyUN0giNLeOryqjoddk7nKxur5RXHlZPhkskCVjHi6-qMoc8NqN4_AndLkH_jaAAGruf8)
20. [plainenglish.io](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFh_5mEE8Ig7cPh68SUURcpzGQ2avkYmX1ign2L6nMpLW7qY8CWvoCvn-MZlR3f6EG9Twsc1GMSCevhIs8mRODHEYqSbkkt2qzjig_ixgmRX_AW7ztH6iBgXP4hSPRiufO4Rxz5_otklE2sBtfPUwT3FhrQQzltvsI0HarSLjwDvnWSvSQVo4BjRcfCu8Fp)
21. [medium.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH7xYDtwlWv9_EhD-oRKmD2cGYa0SzsE4nZUI-qH7KHQSiUj1-4zhHJJSyp0NL7e-XCPO0QOjMYfQSqeuz3q0lGRHROhsnX-t2AsfbP7TCel7I-hGvhVJ_YklzdUE98m_0cGxjzUGmAPI5OCcNzPgX_W4xRZR7BTh-Wt8mMog==)
22. [openai.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFZXTiFgfsG6nZg5TxcxCr-VuAChZmkMWxtf03GtjOebK66tUY03MkMc8ZSdHg9fDNbGphls_LD2AYDFFQpkljGePQcNPdOxzXKGaoUjH24qJmfNRl9UdeqePevKo0NDnv-yqOyKcr__CzpIJI3)
23. [nodejs.org](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEP3PaMTcR276sFA0ZC6Ak-fQysA5Z6ACtnA8h_eJOLbupgaq4iwOuFEiKck8etRLGAx8-HFld-Yf5JN_yXPDLGUyYVGh4_exv_dFmv0XYU6SUKMJ52tbiVdz_9B_QaOwOi)
24. [github.com](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQGz7BrAVw0J__b9HGCYZ_HVyQc0N91u_wowm6V2jq9asdCT9PT8VzA_akr3xXm76eTRfzLopBjgLGF5xDXKjE173U6BfSE4CekEw6Xh_XeAulK_rbr6XLkpbIoOKsIQQHYZJ3bVtw==)
25. [socket.dev](https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE11MdbfhLLJgr2UNx4BHYrwPwMCUoYRZ7sB1aMBrTz5QkivPWz_czoeixYXwY5FojSzWYnr0fSPe3Q4uWGpJlWvCCUOYWU2FBhNGsB77-alTjYTKOKbqj317ODZsVuUEofc2GjCaGz-QZq81uXrYUzy-Y=)
