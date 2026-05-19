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

/**
 * TelemetryData
 * Specific structure for high-frequency tactical data.
 */
export interface TelemetryData {
  status?: string;
  cpu?: number;
  mem?: number;
  lastSeen?: string;
  [key: string]: any;
}

/**
 * Task
 * Structure for recursive task groupings.
 */
export interface Task {
  id: string;
  name: string;
  progress: number;
  subTasks?: Task[];
}

/**
 * WarRoomNodeData
 * Data structure for nodes in the Spatial War Room.
 */
export interface WarRoomNodeData extends Record<string, unknown> {
  label: string;
  status?: string;
  telemetry?: TelemetryData;
  tasks?: Task[];
}

export type WarRoomNode = Node<WarRoomNodeData>;

/**
 * WarRoomState
 * Zustand store interface for managing spatial tactical state.
 */
export interface WarRoomState {
  nodes: WarRoomNode[];
  edges: Edge[];
  
  // Core React Flow Actions
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  setNodes: (nodes: WarRoomNode[]) => void;
  setEdges: (edges: Edge[]) => void;
  
  // Tactical Actions
  updateNodeTelemetry: (id: string, telemetry: TelemetryData) => void;
  
  /**
   * batchUpdate
   * Optimized for high-frequency telemetry updates from multiple nodes.
   * Processes all updates in a single state transition to minimize re-renders.
   */
  batchUpdate: (updates: { id: string; telemetry: TelemetryData }[]) => void;
  
  addTask: (task: any) => void;
}

/**
 * useWarRoomStore
 * Central state management for the Spatial War Room.
 */
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

  batchUpdate: (updates: { id: string; telemetry: TelemetryData }[]) => {
    set((state) => {
      // Create a map for O(1) lookup during update
      const updateMap = new Map(updates.map(u => [u.id, u.telemetry]));
      
      let hasChanges = false;
      const newNodes = state.nodes.map(node => {
        const telemetryUpdate = updateMap.get(node.id);
        if (telemetryUpdate) {
          hasChanges = true;
          return { 
            ...node, 
            data: { 
              ...node.data, 
              status: telemetryUpdate.status || node.data.status, 
              telemetry: { ...node.data.telemetry, ...telemetryUpdate } 
            } 
          };
        }
        return node;
      });
      
      return hasChanges ? { nodes: newNodes } : state;
    });
  },
  
  addTask: (task: any) => {
    const newNode: WarRoomNode = {
      id: task.id || `task-${Date.now()}`,
      type: 'taskCluster',
      position: task.position || { x: Math.random() * 400, y: Math.random() * 400 },
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

/**
 * Selectors
 * Memoized-style selectors to prevent global re-renders when only specific data is needed.
 */

// Selects a single node by ID
export const selectNode = (id: string) => (state: WarRoomState) => 
  state.nodes.find((n) => n.id === id);

// Selects only the data of a specific node
export const selectNodeData = (id: string) => (state: WarRoomState) => 
  state.nodes.find((n) => n.id === id)?.data;

// Selects only the telemetry of a specific node
export const selectNodeTelemetry = (id: string) => (state: WarRoomState) => 
  state.nodes.find((n) => n.id === id)?.data.telemetry;
