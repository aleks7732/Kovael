import { useWarRoomStore, type AgentRosterCard } from './useWarRoomStore';

let simulationIntervalId: ReturnType<typeof setInterval> | null = null;
let chatterIntervalId: ReturnType<typeof setInterval> | null = null;

const MOCK_AGENTS: AgentRosterCard[] = [
  {
    id: 'nyx-antigravity',
    name: 'Nyx Antigravity',
    provider: 'Google-AI-Ultra',
    description: 'Lead Triad Orchestrator. Coordinates the sovereign mesh and manages multi-agent consensus.',
    mcp_capabilities: ['openclaw-gateway', 'comfyui-generation', 'multimodal-audit'],
    vram_requirements: '32GB',
    trust_tier: 1,
    status: 'online',
    portrait_url: '/agents/nyx-antigravity.png',
    accent_hex: '#C15F3C',
    chair: {
      sessionId: 'sess-nyx-anti-0001',
      claimedAt: Date.now() - 3600000,
      lastBeaconAt: Date.now(),
      presence: 'live',
      host: 'localhost',
      note: 'Primary cognitive coordinator active'
    }
  },
  {
    id: 'nyx-cli',
    name: 'Nyx CLI',
    provider: 'local-Ollama',
    description: 'Sovereign proxy executor. Handles shell operations, file management, and system tasks.',
    mcp_capabilities: ['filesystem-ops', 'shell-sandbox', 'pi-deployment'],
    vram_requirements: '16GB',
    trust_tier: 1,
    status: 'idle',
    portrait_url: '/agents/nyx-cli.png',
    accent_hex: '#06B6D4',
    chair: {
      sessionId: 'sess-nyx-cli-0002',
      claimedAt: Date.now() - 3000000,
      lastBeaconAt: Date.now(),
      presence: 'live',
      host: 'localhost',
      note: 'Sovereign local executor ready'
    }
  },
  {
    id: 'nyx-openclaw',
    name: 'Nyx OpenClaw',
    provider: 'OpenAI-Codex',
    description: 'Security validator and system continuity agent. Audits code changes and verifies state machines.',
    mcp_capabilities: ['code-audit', 'adversary-test', 'security- continuité'],
    vram_requirements: '24GB',
    trust_tier: 2,
    status: 'online',
    portrait_url: '/agents/nyx-openclaw.png',
    accent_hex: '#A855F7',
    chair: {
      sessionId: 'sess-nyx-open-0003',
      claimedAt: Date.now() - 2500000,
      lastBeaconAt: Date.now(),
      presence: 'live',
      host: 'remote-host-01',
      note: 'Validator node initialized'
    }
  },
  {
    id: 'shaev',
    name: 'Shaev',
    provider: 'local-Hermes-13B',
    description: 'Local multi-agent router. Focuses on workflow execution and performance optimization.',
    mcp_capabilities: ['routing-policy', 'performance-audit', 'hardware-monitor'],
    vram_requirements: '12GB',
    trust_tier: 3,
    status: 'idle',
    portrait_url: '/agents/shaev.png',
    accent_hex: '#10B981',
    chair: {
      sessionId: 'sess-shaev-0004',
      claimedAt: Date.now() - 2000000,
      lastBeaconAt: Date.now(),
      presence: 'live',
      host: 'localhost',
      note: 'Performance optimizer active'
    }
  }
];

const CONVERSATIONS_MOCK = [
  {
    senderId: 'nyx-antigravity',
    senderName: 'Nyx Antigravity',
    recipientId: 'shaev',
    recipientName: 'Shaev',
    content: "Initiating performance validation of the cognitive loop. Shaev, check the VRAM metrics on the RTX 5090."
  },
  {
    senderId: 'shaev',
    senderName: 'Shaev',
    recipientId: 'nyx-antigravity',
    recipientName: 'Nyx Antigravity',
    content: "rtx-5090 is reporting 74% free VRAM. The pressure valve is successfully queuing the 200Hz telemetry stream."
  },
  {
    senderId: 'nyx-antigravity',
    senderName: 'Nyx Antigravity',
    recipientId: 'nyx-openclaw',
    recipientName: 'Nyx OpenClaw',
    content: "OpenClaw, run the security validation on the active claims strip. Make sure all T1 nodes are authorized."
  },
  {
    senderId: 'nyx-openclaw',
    senderName: 'Nyx OpenClaw',
    recipientId: 'nyx-antigravity',
    recipientName: 'Nyx Antigravity',
    content: "Claims strip validated. ZTNP verification receipts have been issued for all active cycles."
  },
  {
    senderId: 'nyx-cli',
    name: 'Nyx CLI',
    senderName: 'Nyx CLI',
    recipientId: 'nyx-antigravity',
    recipientName: 'Nyx Antigravity',
    content: "Deploying latest telemetry instrumentation patch to local client node."
  }
];

export function startDemoSimulation() {
  stopDemoSimulation();

  const store = useWarRoomStore.getState();

  // 1. Hydrate Store
  store.setWsConnected(true);
  store.setInterAgentChatEnabled(true);
  store.setInterAgentChatMode('technical');

  // Load agent cards to roster
  useWarRoomStore.setState({
    agentRoster: MOCK_AGENTS
  });

  // Mock nodes and edges for ReactFlow canvas
  const mockNodes = MOCK_AGENTS.map((agent, i) => ({
    id: agent.id,
    type: 'agentNode',
    position: { x: 100 + i * 280, y: 150 },
    data: {
      label: agent.name,
      status: agent.status,
      agentCard: {
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        description: agent.description,
        mcp_capabilities: agent.mcp_capabilities,
        vram_requirements: agent.vram_requirements,
        trust_tier: agent.trust_tier,
        portrait_url: agent.portrait_url,
        accent_hex: agent.accent_hex
      },
      telemetry: {
        status: agent.status,
        cpu: Math.floor(Math.random() * 40) + 10,
        mem: Math.floor(Math.random() * 30) + 20,
        lastSeen: new Date().toISOString()
      }
    }
  }));

  const mockEdges = [
    { id: 'edge-1', source: 'nyx-antigravity', target: 'shaev', animated: true },
    { id: 'edge-2', source: 'nyx-antigravity', target: 'nyx-openclaw', animated: true },
    { id: 'edge-3', source: 'nyx-cli', target: 'nyx-antigravity', animated: false }
  ];

  store.setNodes(mockNodes);
  store.setEdges(mockEdges);

  // Initial stats
  useWarRoomStore.setState({
    claimStats: { Unclaimed: 12, Claimed: 2, Running: 1, RetryQueued: 0, Released: 85 },
    tokenTotals: { input: 124500, output: 95400, total: 219900, runtimeMs: 145000, cycles: 98 },
    receiptsIssued: 84
  });

  // 2. Start high-frequency telemetry loop (100ms interval for stable 10Hz updates, pressure-valve simulated)
  let tick = 0;
  simulationIntervalId = setInterval(() => {
    tick++;
    const currentStore = useWarRoomStore.getState();

    // Randomize hardware VRAM / Util spikes
    const utilizationPct = Math.min(100, Math.max(0, 45 + Math.floor(Math.sin(tick / 10) * 15) + Math.floor(Math.random() * 10)));
    const freeMb = Math.min(32768, Math.max(8192, 16384 + Math.floor(Math.cos(tick / 15) * 4096) + Math.floor(Math.random() * 512)));
    const usedMb = 32768 - freeMb;

    currentStore.enqueueHardware({
      status: 'ok',
      timestamp: Date.now(),
      freeMb,
      usedMb,
      totalMb: 32768,
      utilizationPct,
      devices: 1
    });

    // Update active agent CPU/Mem nodes
    const updatedNodes = currentStore.nodes.map((node) => {
      if (node.data.agentCard) {
        return {
          ...node,
          data: {
            ...node.data,
            telemetry: {
              status: node.data.status,
              cpu: Math.min(100, Math.max(0, (node.data.telemetry?.cpu ?? 20) + (Math.random() > 0.5 ? 2 : -2))),
              mem: Math.min(100, Math.max(0, (node.data.telemetry?.mem ?? 40) + (Math.random() > 0.5 ? 1 : -1))),
              lastSeen: new Date().toISOString()
            }
          }
        };
      }
      return node;
    });
    currentStore.setNodes(updatedNodes);

    // Dynamic Claims simulation
    if (tick % 25 === 0) {
      const runningCount = Math.random() > 0.6 ? 2 : 1;
      const unclaimedCount = Math.floor(Math.random() * 8) + 8;
      const claimedCount = Math.floor(Math.random() * 3) + 1;
      const releasedCount = currentStore.claimStats.Released + 1;

      useWarRoomStore.setState({
        claimStats: {
          Unclaimed: unclaimedCount,
          Claimed: claimedCount,
          Running: runningCount,
          RetryQueued: Math.random() > 0.85 ? 1 : 0,
          Released: releasedCount
        },
        receiptsIssued: currentStore.receiptsIssued + 1,
        tokenTotals: {
          ...currentStore.tokenTotals,
          total: currentStore.tokenTotals.total + Math.floor(Math.random() * 2000) + 500,
          cycles: currentStore.tokenTotals.cycles + 1
        }
      });

      // Periodic hook events
      const hookSuccess = Math.random() > 0.96;
      currentStore.recordHookEvent({
        name: `hook_cycle_${releasedCount}`,
        event: 'after_run',
        success: hookSuccess,
        durationMs: Math.floor(Math.random() * 400) + 100,
        timedOut: false,
        error: hookSuccess ? undefined : 'Triad consensus gate failed'
      });
    }

    // Update agent lastSeen beacons
    const nextRoster = currentStore.agentRoster.map((agent) => {
      if (agent.chair) {
        return {
          ...agent,
          chair: {
            ...agent.chair,
            lastBeaconAt: Date.now()
          }
        };
      }
      return agent;
    });
    useWarRoomStore.setState({ agentRoster: nextRoster });

  }, 100);

  // 3. Simulating Banter messages and Theater dialogues
  let banterIndex = 0;
  chatterIntervalId = setInterval(() => {
    const currentStore = useWarRoomStore.getState();
    const banter = CONVERSATIONS_MOCK[banterIndex];

    currentStore.addInterAgentMessage({
      id: `msg-${Date.now()}-${banterIndex}`,
      timestamp: Date.now(),
      senderId: banter.senderId,
      senderName: banter.senderName,
      recipientId: banter.recipientId,
      recipientName: banter.recipientName,
      content: banter.content
    });

    // Speak in the theater conversation topic
    const topicId = 'perf-debate';
    const topic = currentStore.topics.find((t) => t.id === topicId);
    if (!topic) {
      // Create initial conversation topic
      const defaultTopic = {
        id: topicId,
        title: 'Cognitive Loop Optimization',
        participants: ['nyx-antigravity', 'shaev', 'nyx-openclaw'],
        active: true
      };
      currentStore.openConversation(defaultTopic);
    }

    // Set speaking status of the sender and add message
    const messageId = `dialog-${Date.now()}`;
    currentStore.applyMessageDelta(
      topicId,
      messageId,
      banter.senderId,
      'assistant',
      banter.content,
      true
    );

    // Randomize dispatch statuses in the roster
    const activeRoster = currentStore.agentRoster.map((agent) => ({
      ...agent,
      status: (agent.id === banter.senderId ? 'dispatching' : 'online') as AgentRosterCard['status']
    }));
    useWarRoomStore.setState({ agentRoster: activeRoster });

    banterIndex = (banterIndex + 1) % CONVERSATIONS_MOCK.length;
  }, 4000);
}

export function stopDemoSimulation() {
  if (simulationIntervalId) {
    clearInterval(simulationIntervalId);
    simulationIntervalId = null;
  }
  if (chatterIntervalId) {
    clearInterval(chatterIntervalId);
    chatterIntervalId = null;
  }
}
