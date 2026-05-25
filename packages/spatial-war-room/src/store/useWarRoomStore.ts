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
  [key: string]: unknown;
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

export interface VerificationReceipt {
  id: string;
  status: string;
  timestamp: string | number;
}

export interface AgentCardPayload {
  id: string;
  name: string;
  provider: string;
  description?: string;
  mcp_capabilities?: string[];
  vram_requirements?: string;
  trust_tier?: number;
  portrait_url?: string;
  accent_hex?: string;
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
    inboxUrl?: string;
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
    inboxUrl?: string;
  };
}

export interface ChairRosterSnapshot {
  chairs: Array<ChairEventPayload['chair']>;
  stats?: { total: number; online: number; stale: number };
}

export type AgentLifecycleAction = 'start' | 'stop' | 'restart';
export type AgentRuntimeLifecycleStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unknown';
export type AgentHubHealthStatus = 'ok' | 'stale' | 'missing' | 'error' | 'unknown';

export interface AgentRuntimeEntry {
  agentId: string;
  runtime: string;
  running: boolean;
  pid: number | null;
  hubPath?: string;
  status: AgentRuntimeLifecycleStatus;
  managed: boolean;
  lastError?: string;
  updatedAt?: number;
}

export interface AgentRuntimeSnapshot {
  enabled: boolean;
  parkOnIdle: boolean;
  configured: number;
  running: number;
  agents: Record<string, AgentRuntimeEntry>;
  updatedAt: number;
}

export interface ResourceModeSnapshot {
  enabled: boolean;
  mode: 'active' | 'idle';
  idleAfterMs: number;
  sweepIntervalMs: number;
  lastActivityAt: number;
  lastActivityReason: string;
  idleForMs: number;
  trimCount: number;
  lastTrimmedAt: number | null;
  updatedAt: number;
}

export interface AgentHubHealth {
  agentId: string;
  status: AgentHubHealthStatus;
  dispatches?: number;
  accepted?: number;
  running?: number;
  succeeded?: number;
  failed?: number;
  memories?: number;
  checkedAt?: number;
  lastWriteAt?: number | null;
  schemaVersion?: string;
  hubPath?: string;
  error?: string;
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

export interface CommitteeVotePayload {
  agentId: string;
  role: 'proponent' | 'critic' | 'judge';
  verdict: 'approve' | 'reject' | 'abstain';
  confidence: number;
  rationale: string;
}

export interface CommitteeVerdictPayload {
  id: string;
  status: 'accepted' | 'failed' | 'needs_sidecar';
  supportScore: number;
  confidenceMean: number;
  sidecars: string[];
  dissent: CommitteeVotePayload[];
  trace?: { mergeParentId?: string; lanes?: Array<{ laneId?: string; traceparent?: string }> };
}

export interface CommitteeEvent {
  type: 'committee.started' | 'committee.vote' | 'committee.verdict' | 'committee.failed';
  topicId: string;
  receivedAt: number;
  vote?: CommitteeVotePayload;
  verdict?: CommitteeVerdictPayload;
}

export interface ChairCircuitEvent {
  type: 'chair.circuit_open' | 'chair.circuit_recovered' | 'chair.circuit_half_open' | 'chair.circuit_failure';
  agentId: string;
  state: 'closed' | 'open' | 'half_open';
  failures: number;
  lastReason?: string;
  timestamp: number;
}

export interface SelfHealEvent {
  type: 'self_heal.skipped' | 'self_heal.patch_applied' | 'self_heal.patch_reverted' | 'self_heal.failed';
  cycleId: string;
  taskHash: string;
  attempt: number;
  reason?: string;
  timestamp: number;
}

export interface ComfyPreview {
  id: string;
  agentId: string;
  source: 'comfyui' | 'fallback';
  width: number;
  height: number;
  mimeType: string;
  promptId?: string;
  svg?: string;
  streamUrl?: string;
  receivedAt: number;
}

export interface InterAgentMessage {
  id: string;
  timestamp: number;
  senderId: string;
  senderName: string;
  recipientId: string;
  recipientName: string;
  content: string;
}

export interface WarRoomNodeData extends Record<string, unknown> {
  label: string;
  status?: string;
  telemetry?: TelemetryData;
  tasks?: Task[];
  receipts?: VerificationReceipt[];
  agentCard?: AgentCardPayload;
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
  committeeEvents: CommitteeEvent[];
  committeeVerdicts: Record<string, CommitteeVerdictPayload>;
  chairCircuits: Record<string, ChairCircuitEvent>;
  selfHealEvents: SelfHealEvent[];
  comfyPreviews: ComfyPreview[];
  retryPendingCount: number;
  reconcileActions: ReconcileAction[];
  /** True when the cockpit's WS to the orchestrator is OPEN. False during reconnect. */
  wsConnected: boolean;
  /** Cycle currently shown in the Cycle Inspector drawer, or null when closed. */
  selectedCycleId: string | null;
  hookEvents: HookEvent[];
  tokenTotals: TokenTotals;
  rateLimits: Record<string, RateLimitSnapshot>;
  agentRuntimes: AgentRuntimeSnapshot | null;
  resourceMode: ResourceModeSnapshot | null;
  hubHealthByAgent: Record<string, AgentHubHealth>;
  pendingLifecycleActions: Record<string, AgentLifecycleAction>;
  lifecycleErrors: Record<string, string | undefined>;
  flushCount: number;
  receiptsIssued: number;
  interAgentChatEnabled: boolean;
  interAgentChatMode: 'technical' | 'interests';
  interAgentMessages: InterAgentMessage[];
  activeTopicId: string | null;
  topics: ConversationTopic[];
  messagesByTopic: Record<string, ConversationMessage[]>;
  conversationStoppingCriterion: Record<string, { agentId: string; reason: string; confidence: number } | null>;
  activeTab: 'canvas' | 'theater';
  setActiveTab: (tab: 'canvas' | 'theater') => void;
  openConversation: (topic: ConversationTopic) => void;
  applyMessageDelta: (topicId: string, messageId: string, senderId: string, role: 'system' | 'user' | 'assistant', delta: string, isEnd: boolean, usage?: unknown) => void;
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
  addVerificationReceipt: (nodeId: string, receipt: VerificationReceipt) => void;
  upsertAgentNode: (card: AgentCardPayload) => void;
  addTask: (task: Partial<Task> & { tasks?: Task[] } & Record<string, unknown>) => void;
  addANXBriefing: (raw: string) => void;
  recordPhaseEvent: (evt: PhaseEvent) => void;
  recordClaimEvent: (evt: ClaimEvent) => void;
  recordRetryEvent: (evt: Omit<RetryEvent, 'receivedAt'>) => void;
  recordCommitteeEvent: (evt: Omit<CommitteeEvent, 'receivedAt'>) => void;
  recordCircuitEvent: (evt: ChairCircuitEvent) => void;
  recordSelfHealEvent: (evt: SelfHealEvent) => void;
  recordComfyPreview: (preview: Omit<ComfyPreview, 'id' | 'receivedAt'>) => void;
  recordReconcileAction: (action: ReconcileAction) => void;
  recordHookEvent: (evt: Omit<HookEvent, 'receivedAt'>) => void;
  recordTokenUpdate: (totals: TokenTotals) => void;
  recordRateLimit: (snapshot: RateLimitSnapshot) => void;
  recordChairEvent: (evt: ChairEventPayload) => void;
  applyChairRoster: (snapshot: ChairRosterSnapshot) => void;
  applyStateSnapshot: (snapshot: unknown) => void;
  setAgentRuntimeSnapshot: (snapshot: unknown) => void;
  recordAgentRuntimeEvent: (evt: unknown) => void;
  setResourceModeSnapshot: (snapshot: unknown) => void;
  applyHubHealthSnapshot: (snapshot: unknown) => void;
  recordHubHealthEvent: (evt: unknown) => void;
  setLifecyclePending: (agentId: string, action: AgentLifecycleAction) => void;
  clearLifecyclePending: (agentId: string) => void;
  recordLifecycleError: (agentId: string, error: string) => void;
  setWsConnected: (connected: boolean) => void;
  setSelectedCycle: (cycleId: string | null) => void;
  setInterAgentChatEnabled: (enabled: boolean) => void;
  setInterAgentChatMode: (mode: 'technical' | 'interests') => void;
  addInterAgentMessage: (msg: InterAgentMessage) => void;
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
  committeeEvents: [],
  committeeVerdicts: {},
  chairCircuits: {},
  selfHealEvents: [],
  comfyPreviews: [],
  retryPendingCount: 0,
  reconcileActions: [],
  hookEvents: [],
  tokenTotals: { input: 0, output: 0, total: 0, runtimeMs: 0, cycles: 0 },
  rateLimits: {},
  agentRuntimes: null,
  resourceMode: null,
  hubHealthByAgent: {},
  pendingLifecycleActions: {},
  lifecycleErrors: {},
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
    postTraceReroute(connection);
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

  addVerificationReceipt: (nodeId: string, receipt: VerificationReceipt) => {
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

  upsertAgentNode: (card: AgentCardPayload) => {
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
            inboxUrl: evt.chair?.inboxUrl ?? card.chair?.inboxUrl,
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
            inboxUrl: chair.inboxUrl,
          },
        };
      });
      return { agentRoster: nextRoster };
    });
  },

  applyStateSnapshot: (snapshot) => {
    const patch = stateSnapshotPatch(snapshot);
    if (Object.keys(patch).length > 0) set(patch);
  },

  setAgentRuntimeSnapshot: (snapshot) => {
    const normalized = normalizeAgentRuntimeSnapshot(snapshot);
    if (normalized) set({ agentRuntimes: normalized });
  },

  recordAgentRuntimeEvent: (evt) => {
    const event = asRecord(evt);
    if (!event) return;

    const nestedSnapshot = event.snapshot ?? event.agentRuntimes ?? event.agentRuntimeSnapshot;
    const normalizedSnapshot = normalizeAgentRuntimeSnapshot(nestedSnapshot);
    if (normalizedSnapshot) {
      set({ agentRuntimes: normalizedSnapshot });
      return;
    }

    const agentPayload = asRecord(event.agent) ?? event;
    const normalized = normalizeAgentRuntimeEntry(agentPayload, Date.now());
    if (!normalized) return;

    set((state) => {
      const current = state.agentRuntimes ?? {
        enabled: true,
        parkOnIdle: true,
        configured: 0,
        running: 0,
        agents: {},
        updatedAt: Date.now(),
      };
      const agents = { ...current.agents, [normalized.agentId]: normalized };
      const lifecycleErrors = { ...state.lifecycleErrors };
      if (normalized.lastError) lifecycleErrors[normalized.agentId] = normalized.lastError;
      else delete lifecycleErrors[normalized.agentId];
      const pendingLifecycleActions = { ...state.pendingLifecycleActions };
      delete pendingLifecycleActions[normalized.agentId];

      return {
        agentRuntimes: {
          ...current,
          configured: Math.max(current.configured, Object.keys(agents).length),
          running: Object.values(agents).filter((agent) => agent.running).length,
          agents,
          updatedAt: normalized.updatedAt ?? Date.now(),
        },
        lifecycleErrors,
        pendingLifecycleActions,
      };
    });
  },

  setResourceModeSnapshot: (snapshot) => {
    const normalized = normalizeResourceModeSnapshot(snapshot);
    if (normalized) set({ resourceMode: normalized });
  },

  applyHubHealthSnapshot: (snapshot) => {
    const normalized = normalizeHubHealthSnapshot(snapshot);
    if (normalized) set({ hubHealthByAgent: normalized });
  },

  recordHubHealthEvent: (evt) => {
    const event = asRecord(evt);
    if (!event) return;
    const nestedSnapshot = event.snapshot ?? event.hubHealthByAgent ?? event.agentHubHealth;
    const normalizedSnapshot = normalizeHubHealthSnapshot(nestedSnapshot);
    if (normalizedSnapshot) {
      set({ hubHealthByAgent: normalizedSnapshot });
      return;
    }

    const health = normalizeHubHealthEntry(event, undefined);
    if (!health) return;
    set((state) => ({
      hubHealthByAgent: { ...state.hubHealthByAgent, [health.agentId]: health },
    }));
  },

  setLifecyclePending: (agentId, action) => {
    set((state) => {
      const lifecycleErrors = { ...state.lifecycleErrors };
      delete lifecycleErrors[agentId];
      return {
        pendingLifecycleActions: { ...state.pendingLifecycleActions, [agentId]: action },
        lifecycleErrors,
      };
    });
  },

  clearLifecyclePending: (agentId) => {
    set((state) => {
      const pendingLifecycleActions = { ...state.pendingLifecycleActions };
      delete pendingLifecycleActions[agentId];
      return { pendingLifecycleActions };
    });
  },

  recordLifecycleError: (agentId, error) => {
    set((state) => ({
      lifecycleErrors: { ...state.lifecycleErrors, [agentId]: error },
    }));
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

  recordCommitteeEvent: (evt) => {
    set((state) => {
      const enriched: CommitteeEvent = { ...evt, receivedAt: Date.now() };
      const nextVerdicts = evt.verdict
        ? { ...state.committeeVerdicts, [evt.topicId]: evt.verdict }
        : state.committeeVerdicts;
      return {
        committeeEvents: [enriched, ...state.committeeEvents].slice(0, 80),
        committeeVerdicts: nextVerdicts,
      };
    });
  },

  recordCircuitEvent: (evt) => {
    set((state) => ({
      chairCircuits: { ...state.chairCircuits, [evt.agentId]: evt },
    }));
  },

  recordSelfHealEvent: (evt) => {
    set((state) => ({
      selfHealEvents: [evt, ...state.selfHealEvents].slice(0, 40),
    }));
  },

  recordComfyPreview: (preview) => {
    set((state) => ({
      comfyPreviews: [
        { ...preview, id: `comfy-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, receivedAt: Date.now() },
        ...state.comfyPreviews,
      ].slice(0, 12),
    }));
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

  addTask: (task) => {
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
  addInterAgentMessage: (msg: InterAgentMessage) => {
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

function stateSnapshotPatch(snapshot: unknown): Partial<WarRoomState> {
  const record = asRecord(snapshot);
  if (!record) return {};

  const patch: Partial<WarRoomState> = {};
  const runtime = normalizeAgentRuntimeSnapshot(record.agentRuntimes ?? record.agentRuntimeSnapshot);
  if (runtime) patch.agentRuntimes = runtime;

  const resourceMode = normalizeResourceModeSnapshot(record.resourceMode);
  if (resourceMode) patch.resourceMode = resourceMode;

  const hubHealth = normalizeHubHealthSnapshot(
    record.hubHealthByAgent ??
      record.agentHubHealth ??
      record.agentHubs ??
      record.hubHealth,
  );
  if (hubHealth) patch.hubHealthByAgent = hubHealth;

  return patch;
}

function normalizeAgentRuntimeSnapshot(value: unknown): AgentRuntimeSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;

  const updatedAt = numberValue(record.updatedAt) ?? Date.now();
  const rawAgents = runtimeAgentItems(record.agents);
  const agents: Record<string, AgentRuntimeEntry> = {};
  for (const raw of rawAgents) {
    const normalized = normalizeAgentRuntimeEntry(raw, updatedAt);
    if (normalized) agents[normalized.agentId] = normalized;
  }

  const configured = numberValue(record.configured) ?? rawAgents.length;
  const running = numberValue(record.running) ?? Object.values(agents).filter((agent) => agent.running).length;

  return {
    enabled: booleanValue(record.enabled, false),
    parkOnIdle: booleanValue(record.parkOnIdle ?? record.park_on_idle, true),
    configured,
    running,
    agents,
    updatedAt,
  };
}

function normalizeAgentRuntimeEntry(value: unknown, updatedAt: number): AgentRuntimeEntry | null {
  const record = asRecord(value);
  if (!record) return null;
  const agentId = stringValue(record.agentId ?? record.agent_id ?? record.id);
  if (!agentId) return null;

  const rawStatus = stringValue(record.status ?? record.state ?? record.kind ?? record.type);
  const running = typeof record.running === 'boolean'
    ? record.running
    : rawStatus === 'running' || rawStatus === 'started' || rawStatus === 'agent_runtime_started';
  const status = normalizeRuntimeStatus(rawStatus, running);

  return {
    agentId,
    runtime: stringValue(record.runtime) ?? 'unknown',
    running,
    pid: numberOrNull(record.pid),
    hubPath: stringValue(record.hubPath ?? record.hub_path),
    status,
    managed: typeof record.managed === 'boolean' ? record.managed : true,
    lastError: stringValue(record.lastError ?? record.error ?? record.reason),
    updatedAt: numberValue(record.updatedAt ?? record.timestamp) ?? updatedAt,
  };
}

function runtimeAgentItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return record ? Object.values(record) : [];
}

function normalizeRuntimeStatus(value: string | undefined, running: boolean): AgentRuntimeLifecycleStatus {
  const normalized = value?.trim().toLowerCase();
  if (normalized?.includes('start') && !normalized.includes('started')) return 'starting';
  if (normalized?.includes('stop') && !normalized.includes('stopped')) return 'stopping';
  if (normalized === 'running' || normalized === 'started' || normalized === 'agent_runtime_started') return 'running';
  if (normalized === 'stopped' || normalized === 'exited' || normalized === 'agent_runtime_stopped' || normalized === 'agent_runtime_exited') return 'stopped';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'spawn_failed' || normalized === 'agent_runtime_spawn_failed') return 'failed';
  return running ? 'running' : 'stopped';
}

function normalizeResourceModeSnapshot(value: unknown): ResourceModeSnapshot | null {
  const record = asRecord(value);
  if (!record) return null;
  const mode = stringValue(record.mode);
  if (mode !== 'active' && mode !== 'idle') return null;

  return {
    enabled: booleanValue(record.enabled, true),
    mode,
    idleAfterMs: numberValue(record.idleAfterMs) ?? 0,
    sweepIntervalMs: numberValue(record.sweepIntervalMs) ?? 0,
    lastActivityAt: numberValue(record.lastActivityAt) ?? 0,
    lastActivityReason: stringValue(record.lastActivityReason) ?? 'unknown',
    idleForMs: numberValue(record.idleForMs) ?? 0,
    trimCount: numberValue(record.trimCount) ?? 0,
    lastTrimmedAt: numberOrNull(record.lastTrimmedAt),
    updatedAt: numberValue(record.updatedAt) ?? Date.now(),
  };
}

function normalizeHubHealthSnapshot(value: unknown): Record<string, AgentHubHealth> | null {
  if (Array.isArray(value)) {
    const out: Record<string, AgentHubHealth> = {};
    for (const entry of value) {
      const health = normalizeHubHealthEntry(entry, undefined);
      if (health) out[health.agentId] = health;
    }
    return out;
  }

  const record = asRecord(value);
  if (!record) return null;

  const nestedAgents = record.agents ?? record.items ?? record.hubs;
  if (Array.isArray(nestedAgents)) return normalizeHubHealthSnapshot(nestedAgents);

  const out: Record<string, AgentHubHealth> = {};
  for (const [agentId, entry] of Object.entries(record)) {
    const health = normalizeHubHealthEntry(entry, agentId);
    if (health) out[health.agentId] = health;
  }
  return out;
}

function normalizeHubHealthEntry(value: unknown, fallbackAgentId: string | undefined): AgentHubHealth | null {
  const record = asRecord(value);
  if (!record) return null;
  const agentId = stringValue(record.agentId ?? record.agent_id ?? record.id) ?? fallbackAgentId;
  if (!agentId) return null;
  const status = normalizeHubHealthStatus(stringValue(record.status ?? record.health ?? record.state));

  return {
    agentId,
    status,
    dispatches: numberValue(record.dispatches),
    accepted: numberValue(record.accepted),
    running: numberValue(record.running),
    succeeded: numberValue(record.succeeded),
    failed: numberValue(record.failed),
    memories: numberValue(record.memories),
    checkedAt: numberValue(record.checkedAt ?? record.timestamp),
    lastWriteAt: numberOrNull(record.lastWriteAt ?? record.updatedAt),
    schemaVersion: stringValue(record.schemaVersion ?? record.schema_version),
    hubPath: stringValue(record.hubPath ?? record.hub_path ?? record.dbPath),
    error: stringValue(record.error ?? record.reason),
  };
}

function normalizeHubHealthStatus(value: string | undefined): AgentHubHealthStatus {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'ok' || normalized === 'healthy') return 'ok';
  if (normalized === 'stale') return 'stale';
  if (normalized === 'missing' || normalized === 'not_found') return 'missing';
  if (normalized === 'error' || normalized === 'failed') return 'error';
  return 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function postTraceReroute(connection: Connection): void {
  if (typeof fetch !== 'function') return;
  const source = safeConnectionId(connection.source);
  const target = safeConnectionId(connection.target);
  if (!source || !target) return;
  void fetch('http://localhost:8080/api/v1/traces/reroute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source,
      target,
      sourceHandle: safeConnectionId(connection.sourceHandle),
      targetHandle: safeConnectionId(connection.targetHandle),
    }),
  }).catch(() => {});
}

function safeConnectionId(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(trimmed) ? trimmed : undefined;
}
