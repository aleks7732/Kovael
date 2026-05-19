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
  flushCount: number;
  receiptsIssued: number;
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
}

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
  flushCount: 0,
  receiptsIssued: 0,

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
      const nextRoster = evt.routedAgent
        ? state.agentRoster.map(r => r.id === evt.routedAgent
            ? { ...r, status: 'dispatching' as const, lastSeen: evt.timestamp }
            : r)
        : state.agentRoster;
      return {
        phaseEvents: [evt, ...state.phaseEvents].slice(0, 80),
        agentRoster: nextRoster,
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
}));
