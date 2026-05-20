import { create } from 'zustand';
import {
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';

export interface TelemetryData {
  status?: string;
  cpu?: number;
  mem?: number;
  lastSeen?: string;
  label?: string;
  [key: string]: any;
}

export interface HardwareTelemetry {
  status: 'ok' | 'unavailable' | 'error';
  timestamp: number;
  freeMb: number;
  usedMb: number;
  totalMb: number;
  utilizationPct: number;
  devices: number;
  error?: string;
}

export interface Task {
  id: string;
  name: string;
  progress: number;
  subTasks?: Task[];
}

export interface ANXBriefing {
  id: string;
  raw: string;
  receivedAt: number;
}

export interface ConversationTopic {
  id: string;
  title: string;
  participants: string[];
  active: boolean;
}

export interface ConversationMessage {
  id: string;
  topicId: string;
  senderId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface PhaseEvent {
  cycleId: string;
  taskHash: string;
  phase: string;
  previous: string | null;
  timestamp: number;
  routedAgent?: string;
  note?: string;
}

export interface AgentRosterCard {
  id: string;
  name: string;
  provider: string;
  description?: string;
  mcp_capabilities?: string[];
  vram_requirements?: string;
  trust_tier?: number;
  status: 'online' | 'idle' | 'dispatching' | 'offline';
  lastSeen?: number;
  portrait_url?: string;
  accent_hex?: string;
  /** Chair Beacon Protocol presence — independent of dispatch status. */
  chair?: {
    sessionId: string;
    claimedAt: number;
    lastBeaconAt: number;
    presence: 'live' | 'stale' | 'absent';
    host?: string;
    note?: string;
  };
}

export interface ChairEventPayload {
  kind: 'claimed' | 'heartbeat' | 'released' | 'stale' | 'expired';
  agentId: string;
  sessionId: string;
  status: 'online' | 'stale' | 'offline';
  timestamp: number;
  reason?: string;
  chair?: {
    agentId: string;
    sessionId: string;
    provider: string;
    capabilities: string[];
    trustTier: number;
    claimedAt: number;
    lastBeaconAt: number;
    status: 'online' | 'stale' | 'offline';
    host?: string;
    note?: string;
  };
}

export interface ChairRosterSnapshot {
  chairs: Array<ChairEventPayload['chair']>;
  stats?: { total: number; online: number; stale: number };
}

export interface ClaimEvent {
  taskHash: string;
  previous: string | null;
  state: 'Unclaimed' | 'Claimed' | 'Running' | 'RetryQueued' | 'Released';
  timestamp: number;
  attempt: number;
  reason?: string;
  cycleId?: string;
}

export interface ClaimStats {
  Unclaimed: number;
  Claimed: number;
  Running: number;
  RetryQueued: number;
  Released: number;
}

export interface RateLimitSnapshot {
  agentId: string;
  inWindow: number;
  capacity: number;
  windowMs: number;
  blocked: boolean;
  resetAtMs?: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  total: number;
  runtimeMs: number;
  cycles: number;
}

export interface HookEvent {
  name: string;
  event: 'after_create' | 'before_run' | 'after_run' | 'before_remove';
  success: boolean;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  receivedAt: number;
}

export interface ReconcileAction {
  kind: 'stall_detected' | 'terminal_cleanup';
  taskHash: string;
  previousState: string;
  ageMs: number;
  timestamp: number;
}

export interface RetryEvent {
  kind: 'scheduled' | 'dispatching' | 'exhausted';
  taskHash?: string;
  attempts?: number;
  reason?: string;
  dispatch?: {
    taskHash: string;
    attempt: number;
    backoffMs: number;
    scheduledFor: number;
    reason: string;
  };
  receivedAt: number;
}

export interface WarRoomNodeData extends Record<string, unknown> {
  label: string;
  status?: string;
  telemetry?: TelemetryData;
  tasks?: Task[];
  receipts?: any[];
  agentCard?: any;
  anx?: ANXBriefing;
}

export type WarRoomNode = Node<WarRoomNodeData>;

export interface WarRoomState {
  nodes: WarRoomNode[];
  edges: Edge[];
  hardware: HardwareTelemetry | null;
  anxBriefings: ANXBriefing[];
  phaseEvents: PhaseEvent[];
  agentRoster: AgentRosterCard[];
  claimStats: ClaimStats;
  recentClaims: ClaimEvent[];
  retryEvents: RetryEvent[];
  retryPendingCount: number;
  reconcileActions: ReconcileAction[];
  /** True when the cockpit's WS to the orchestrator is OPEN. False during reconnect. */
  wsConnected: boolean;
  /** Cycle currently shown in the Cycle Inspector drawer, or null when closed. */
  selectedCycleId: string | null;
  hookEvents: HookEvent[];
  tokenTotals: TokenTotals;
  rateLimits: Record<string, RateLimitSnapshot>;
  flushCount: number;
  receiptsIssued: number;
  interAgentChatEnabled: boolean;
  interAgentChatMode: 'technical' | 'interests';
  interAgentMessages: Array<{
    id: string;
    timestamp: number;
    senderId: string;
    senderName: string;
    recipientId: string;
    recipientName: string;
    content: string;
  }>;
  activeTopicId: string | null;
  topics: ConversationTopic[];
  messagesByTopic: Record<string, ConversationMessage[]>;
  conversationStoppingCriterion: Record<string, { agentId: string; reason: string; confidence: number } | null>;
  activeTab: 'canvas' | 'theater';
  setActiveTab: (tab: 'canvas' | 'theater') => void;
  openConversation: (topic: ConversationTopic) => void;
  applyMessageDelta: (topicId: string, messageId: string, senderId: string, role: 'system' | 'user' | 'assistant', delta: string, isEnd: boolean, usage?: any) => void;
  closeConversation: (topicId: string) => void;
  selectTopic: (topicId: string | null) => void;
  recordStoppingCriterion: (topicId: string, agentId: string, reason: string, confidence: number) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  setNodes: (nodes: WarRoomNode[]) => void;
  setEdges: (edges: Edge[]) => void;
  enqueueTelemetry: (id: string, telemetry: TelemetryData) => void;
  enqueueHardware: (metrics: HardwareTelemetry) => void;
  flushPressureValve: () => void;
  addVerificationReceipt: (nodeId: string, receipt: any) => void;
  upsertAgentNode: (card: any) => void;
  addTask: (task: any) => void;
  addANXBriefing: (raw: string) => void;
  recordPhaseEvent: (evt: PhaseEvent) => void;
  recordClaimEvent: (evt: ClaimEvent) => void;
  recordRetryEvent: (evt: Omit<RetryEvent, 'receivedAt'>) => void;
  recordReconcileAction: (action: ReconcileAction) => void;
  recordHookEvent: (evt: Omit<HookEvent, 'receivedAt'>) => void;
  recordTokenUpdate: (totals: TokenTotals) => void;
  recordRateLimit: (snapshot: RateLimitSnapshot) => void;
  recordChairEvent: (evt: ChairEventPayload) => void;
  applyChairRoster: (snapshot: ChairRosterSnapshot) => void;
  setWsConnected: (connected: boolean) => void;
  setSelectedCycle: (cycleId: string | null) => void;
  setInterAgentChatEnabled: (enabled: boolean) => void;
  setInterAgentChatMode: (mode: 'technical' | 'interests') => void;
  addInterAgentMessage: (msg: any) => void;
}

const getInitialTab = (): 'canvas' | 'theater' => {
  if (typeof window !== 'undefined') {
    const tab = new URLSearchParams(window.location.search).get('tab');
    if (tab === 'theater') return 'theater';
  }
  return 'canvas';
};

/**
 * Telemetry Pressure Valve (Module A):
 * WebSocket packets arrive at 50-200 Hz under heavy load. Naively calling
 * `set()` on every packet would re-render the entire ReactFlow canvas at
 * the WS frequency. Instead we coalesce updates in module-scope buffers
 * (latest-wins per nodeId) and flush ONCE per 100ms via flushPressureValve.
 * Components subscribed via shallow selectors only re-render on the flush
 * tick — keeping the canvas at 60 FPS even with 1,000 active heartbeats.
 */
const pendingTelemetry: Map<string, TelemetryData> = new Map();
let pendingHardware: HardwareTelemetry | null = null;
let pendingHardwareDirty = false;

export const useWarRoomStore = create<WarRoomState>((set, get) => ({
  nodes: [
    {
      id: 'system-ready',
      type: 'agentHeartbeat',
      position: { x: 0, y: 0 },
      data: { label: 'VPC_SYSTEM_READY', status: 'SYNCHRONIZING' }
    }
  ],
  edges: [],
  hardware: null,
  anxBriefings: [],
  phaseEvents: [],
  agentRoster: [],
  claimStats: { Unclaimed: 0, Claimed: 0, Running: 0, RetryQueued: 0, Released: 0 },
  recentClaims: [],
  retryEvents: [],
  retryPendingCount: 0,
  reconcileActions: [],
  hookEvents: [],
  tokenTotals: { input: 0, output: 0, total: 0, runtimeMs: 0, cycles: 0 },
  rateLimits: {},
  flushCount: 0,
  receiptsIssued: 0,
  wsConnected: false,
  selectedCycleId: null,
  interAgentChatEnabled: false,
  interAgentChatMode: 'interests',
  interAgentMessages: [],
  activeTopicId: null,
  topics: [],
  messagesByTopic: {},
  conversationStoppingCriterion: {},
  activeTab: getInitialTab(),

  setActiveTab: (tab) => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tab);
      window.history.replaceState({}, '', url.toString());
    }
    set({ activeTab: tab });
  },


  onNodesChange: (changes: NodeChange[]) => {
    set({
      nodes: applyNodeChanges(changes, get().nodes) as WarRoomNode[],
    });
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
    });
  },

  onConnect: (connection: Connection) => {
    set({
      edges: addEdge(connection, get().edges),
    });
  },

  setNodes: (nodes: WarRoomNode[]) => set({ nodes }),
  setEdges: (edges: Edge[]) => set({ edges }),

  enqueueTelemetry: (id: string, telemetry: TelemetryData) => {
    const existing = pendingTelemetry.get(id);
    pendingTelemetry.set(id, existing ? { ...existing, ...telemetry } : telemetry);
  },

  enqueueHardware: (metrics: HardwareTelemetry) => {
    pendingHardware = metrics;
    pendingHardwareDirty = true;
  },

  flushPressureValve: () => {
    const telemetryDirty = pendingTelemetry.size > 0;
    if (!telemetryDirty && !pendingHardwareDirty) return;

    set((state) => {
      let nodes = state.nodes;

      if (telemetryDirty) {
        const known = new Set(nodes.map(n => n.id));
        const updates = new Map(pendingTelemetry);
        pendingTelemetry.clear();

        nodes = nodes.map((node) => {
          const t = updates.get(node.id);
          if (!t) return node;
          updates.delete(node.id);
          return {
            ...node,
            data: {
              ...node.data,
              status: t.status || node.data.status,
              telemetry: { ...node.data.telemetry, ...t },
            },
          };
        });

        for (const [id, t] of updates) {
          if (known.has(id)) continue;
          nodes = [
            ...nodes,
            {
              id,
              type: 'agentHeartbeat',
              position: { x: Math.random() * 600, y: Math.random() * 400 },
              data: {
                label: t.label || id,
                status: t.status || 'ONLINE',
                telemetry: t,
              },
            },
          ];
        }
      }

      const next: Partial<WarRoomState> = {
        nodes,
        flushCount: state.flushCount + 1,
      };
      if (pendingHardwareDirty && pendingHardware) {
        next.hardware = pendingHardware;
        pendingHardwareDirty = false;
      }
      return next as WarRoomState;
    });
  },

  addVerificationReceipt: (nodeId: string, receipt: any) => {
    set((state) => ({
      receiptsIssued: state.receiptsIssued + 1,
      nodes: state.nodes.map((node) => {
        if (node.id === nodeId) {
          return {
            ...node,
            data: {
              ...node.data,
              receipts: [receipt, ...(node.data.receipts || [])].slice(0, 5)
            }
          };
        }
        return node;
      })
    }));
  },

  upsertAgentNode: (card: any) => {
    set((state) => {
      const rosterCard: AgentRosterCard = {
        id: card.id,
        name: card.name,
        provider: card.provider,
        description: card.description,
        mcp_capabilities: card.mcp_capabilities,
        vram_requirements: card.vram_requirements,
        trust_tier: card.trust_tier,
        status: 'online',
        lastSeen: Date.now(),
        portrait_url: card.portrait_url,
        accent_hex: card.accent_hex,
      };
      const rosterExists = state.agentRoster.some(r => r.id === card.id);
      const nextRoster = rosterExists
        ? state.agentRoster.map(r => r.id === card.id ? { ...r, ...rosterCard } : r)
        : [...state.agentRoster, rosterCard];

      const exists = state.nodes.find(n => n.id === card.id);
      if (exists) {
        return {
          agentRoster: nextRoster,
          nodes: state.nodes.map(n => n.id === card.id ? { ...n, data: { ...n.data, agentCard: card } } : n)
        };
      }
      const newNode: WarRoomNode = {
        id: card.id,
        type: 'agentHeartbeat',
        position: { x: Math.random() * 200, y: Math.random() * 200 },
        data: { label: card.name, agentCard: card, status: 'ONLINE' }
      };
      return { agentRoster: nextRoster, nodes: [...state.nodes, newNode] };
    });
  },

  recordPhaseEvent: (evt: PhaseEvent) => {
    set((state) => {
      // Roster status follows the phase: routedAgent goes to 'dispatching'
      // while the cycle is in flight, and back to 'online' on any terminal
      // transition. Without this, every agent perma-sticks at 'dispatching'
      // after the first cycle.
      const TERMINAL_PHASES = new Set(['Succeeded', 'Failed', 'Stalled']);
      const isTerminal = TERMINAL_PHASES.has(evt.phase);

      const nextRoster = evt.routedAgent
        ? state.agentRoster.map(r => r.id === evt.routedAgent
            ? {
                ...r,
                status: (isTerminal ? 'online' : 'dispatching') as AgentRosterCard['status'],
                lastSeen: evt.timestamp,
              }
            : r)
        : state.agentRoster;
      return {
        phaseEvents: [evt, ...state.phaseEvents].slice(0, 80),
        agentRoster: nextRoster,
      };
    });
  },

  recordReconcileAction: (action) => {
    set((state) => ({
      reconcileActions: [action, ...state.reconcileActions].slice(0, 40),
    }));
  },

  recordHookEvent: (evt) => {
    set((state) => ({
      hookEvents: [{ ...evt, receivedAt: Date.now() }, ...state.hookEvents].slice(0, 40),
    }));
  },

  recordTokenUpdate: (totals) => {
    set(() => ({ tokenTotals: { ...totals } }));
  },

  recordRateLimit: (snapshot) => {
    set((state) => ({
      rateLimits: { ...state.rateLimits, [snapshot.agentId]: snapshot },
    }));
  },

  recordChairEvent: (evt: ChairEventPayload) => {
    set((state) => {
      const presence: 'live' | 'stale' | 'absent' =
        evt.kind === 'released' || evt.kind === 'expired'
          ? 'absent'
          : evt.status === 'stale'
            ? 'stale'
            : 'live';

      const nextRoster = state.agentRoster.map((card) => {
        if (card.id !== evt.agentId) return card;
        if (presence === 'absent') {
          // Drop chair presence but keep static card metadata. Dispatch
          // status remains whatever the triad last set so we don't blow
          // away in-flight work just because a beacon process exited.
          const { chair, ...rest } = card;
          void chair;
          return rest as AgentRosterCard;
        }
        return {
          ...card,
          chair: {
            sessionId: evt.sessionId,
            claimedAt: evt.chair?.claimedAt ?? card.chair?.claimedAt ?? evt.timestamp,
            lastBeaconAt: evt.chair?.lastBeaconAt ?? evt.timestamp,
            presence,
            host: evt.chair?.host ?? card.chair?.host,
            note: evt.chair?.note ?? card.chair?.note,
          },
        };
      });
      return { agentRoster: nextRoster };
    });
  },

  applyChairRoster: (snapshot: ChairRosterSnapshot) => {
    set((state) => {
      const byId = new Map<string, NonNullable<ChairEventPayload['chair']>>();
      for (const c of snapshot.chairs) {
        if (c) byId.set(c.agentId, c);
      }
      const nextRoster = state.agentRoster.map((card) => {
        const chair = byId.get(card.id);
        if (!chair) {
          if (card.chair) {
            const { chair: _drop, ...rest } = card;
            void _drop;
            return rest as AgentRosterCard;
          }
          return card;
        }
        return {
          ...card,
          chair: {
            sessionId: chair.sessionId,
            claimedAt: chair.claimedAt,
            lastBeaconAt: chair.lastBeaconAt,
            presence: chair.status === 'stale' ? 'stale' as const : 'live' as const,
            host: chair.host,
            note: chair.note,
          },
        };
      });
      return { agentRoster: nextRoster };
    });
  },

  recordRetryEvent: (evt) => {
    set((state) => {
      const enriched: RetryEvent = { ...evt, receivedAt: Date.now() };
      // pending count: increment on scheduled, decrement on dispatching/exhausted
      let pending = state.retryPendingCount;
      if (evt.kind === 'scheduled') pending += 1;
      else if (evt.kind === 'dispatching' || evt.kind === 'exhausted') pending = Math.max(0, pending - 1);
      return {
        retryEvents: [enriched, ...state.retryEvents].slice(0, 40),
        retryPendingCount: pending,
      };
    });
  },

  recordClaimEvent: (evt: ClaimEvent) => {
    set((state) => {
      // Stats are derived from the latest event per taskHash; we can't
      // accumulate from deltas because we may miss reconnect events.
      // Instead we adjust the bucket of the previous → current transition.
      const stats = { ...state.claimStats };
      if (evt.previous && stats[evt.previous as keyof ClaimStats] !== undefined) {
        stats[evt.previous as keyof ClaimStats] = Math.max(0, stats[evt.previous as keyof ClaimStats] - 1);
      }
      stats[evt.state] = (stats[evt.state] ?? 0) + 1;

      return {
        claimStats: stats,
        recentClaims: [evt, ...state.recentClaims].slice(0, 40),
      };
    });
  },

  addTask: (task: any) => {
    const newNode: WarRoomNode = {
      id: task.id || `task-${Date.now()}`,
      type: 'taskCluster',
      position: { x: 400 + Math.random() * 200, y: Math.random() * 400 },
      data: {
        label: task.name || 'New Task Cluster',
        tasks: task.tasks || [],
        ...task
      },
    };
    set((state) => ({
      nodes: [...state.nodes, newNode],
    }));
  },

  addANXBriefing: (raw: string) => {
    const briefing: ANXBriefing = {
      id: `anx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      raw,
      receivedAt: Date.now(),
    };
    const briefingNode: WarRoomNode = {
      id: briefing.id,
      type: 'anxBriefing',
      position: { x: -400 + Math.random() * 200, y: Math.random() * 400 },
      data: {
        label: 'ANX_MISSION_BRIEFING',
        anx: briefing,
      },
    };
    set((state) => ({
      anxBriefings: [briefing, ...state.anxBriefings].slice(0, 16),
      nodes: [...state.nodes, briefingNode],
    }));
  },

  setWsConnected: (connected: boolean) => set({ wsConnected: connected }),
  setSelectedCycle: (cycleId: string | null) => set({ selectedCycleId: cycleId }),
  setInterAgentChatEnabled: (enabled: boolean) => set({ interAgentChatEnabled: enabled }),
  setInterAgentChatMode: (mode: 'technical' | 'interests') => set({ interAgentChatMode: mode }),
  addInterAgentMessage: (msg: any) => {
    set((state) => ({
      interAgentMessages: [...state.interAgentMessages, msg].slice(-50),
    }));
  },
  openConversation: (topic) => {
    set((state) => {
      const exists = state.topics.some((t) => t.id === topic.id);
      return {
        topics: exists ? state.topics.map((t) => t.id === topic.id ? topic : t) : [...state.topics, topic],
        activeTopicId: topic.id,
      };
    });
  },
  applyMessageDelta: (topicId, messageId, senderId, role, delta, _isEnd, _usage) => {
    set((state) => {
      const topicMsgs = state.messagesByTopic[topicId] ? [...state.messagesByTopic[topicId]] : [];
      const idx = topicMsgs.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        const current = topicMsgs[idx];
        topicMsgs[idx] = {
          ...current,
          content: current.content + delta,
        };
      } else {
        topicMsgs.push({
          id: messageId,
          topicId,
          senderId,
          role,
          content: delta,
          timestamp: Date.now(),
        });
      }
      return {
        messagesByTopic: {
          ...state.messagesByTopic,
          [topicId]: topicMsgs.slice(-200),
        },
      };
    });
  },
  closeConversation: (topicId) => {
    set((state) => ({
      topics: state.topics.map((t) => t.id === topicId ? { ...t, active: false } : t),
    }));
  },
  selectTopic: (topicId) => {
    set({ activeTopicId: topicId });
  },
  recordStoppingCriterion: (topicId, agentId, reason, confidence) => {
    set((state) => ({
      conversationStoppingCriterion: {
        ...state.conversationStoppingCriterion,
        [topicId]: { agentId, reason, confidence },
      },
    }));
  },
}));
