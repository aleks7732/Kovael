import { create } from 'zustand';
import {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';

export interface TelemetryData {
  status?: string;
  cpu?: number;
  mem?: number;
  lastSeen?: string;
  [key: string]: any;
}

export interface Task {
  id: string;
  name: string;
  progress: number;
  subTasks?: Task[];
}

export interface WarRoomNodeData extends Record<string, unknown> {
  label: string;
  status?: string;
  telemetry?: TelemetryData;
  tasks?: Task[];
  receipts?: any[];
  agentCard?: any;
}

export type WarRoomNode = Node<WarRoomNodeData>;

export interface WarRoomState {
  nodes: WarRoomNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  setNodes: (nodes: WarRoomNode[]) => void;
  setEdges: (edges: Edge[]) => void;
  updateNodeTelemetry: (id: string, telemetry: TelemetryData) => void;
  addVerificationReceipt: (nodeId: string, receipt: any) => void;
  upsertAgentNode: (card: any) => void;
  addTask: (task: any) => void;
}

export const useWarRoomStore = create<WarRoomState>((set, get) => ({
  nodes: [],
  edges: [],
  
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
  
  updateNodeTelemetry: (id: string, telemetry: TelemetryData) => {
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id === id) {
          return { 
            ...node, 
            data: { 
              ...node.data, 
              status: telemetry.status || node.data.status,
              telemetry: { ...node.data.telemetry, ...telemetry } 
            } 
          };
        }
        return node;
      }),
    }));
  },

  addVerificationReceipt: (nodeId: string, receipt: any) => {
    set((state) => ({
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
      const exists = state.nodes.find(n => n.id === card.id);
      if (exists) {
        return {
          nodes: state.nodes.map(n => n.id === card.id ? { ...n, data: { ...n.data, agentCard: card } } : n)
        };
      }
      const newNode: WarRoomNode = {
        id: card.id,
        type: 'agentHeartbeat',
        position: { x: Math.random() * 200, y: Math.random() * 200 },
        data: { label: card.name, agentCard: card, status: 'ONLINE' }
      };
      return { nodes: [...state.nodes, newNode] };
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
}));
