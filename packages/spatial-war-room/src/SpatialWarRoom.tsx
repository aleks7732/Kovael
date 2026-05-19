import React, { useEffect, useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  Panel,
  ReactFlowProvider,
  ColorMode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './index.css';
import './App.css';

import { useWarRoomStore } from './store/useWarRoomStore.js';
import { AgentHeartbeatNode, TaskClusterNode } from './components/CustomNodes.js';

const nodeTypes = {
  agentHeartbeat: AgentHeartbeatNode,
  taskCluster: TaskClusterNode,
};

const SpatialWarRoom = () => {
  const { 
    nodes, 
    edges, 
    onNodesChange, 
    onEdgesChange, 
    onConnect, 
    updateNodeTelemetry, 
    addTask 
  } = useWarRoomStore();

  const colorMode: ColorMode = 'dark';

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080');

    ws.onopen = () => {
      console.log('Connected to Spatial War Room Telemetry');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        if (message.type === 'telemetry') {
          updateNodeTelemetry(message.nodeId, message.data);
        } else if (message.type === 'new_task') {
          addTask(message.task);
        }
      } catch (err) {
        console.error('Failed to parse WS message', err);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket Error:', error);
    };

    ws.onclose = () => {
      console.log('Disconnected from Telemetry');
    };

    return () => {
      ws.close();
    };
  }, [updateNodeTelemetry, addTask]);

  return (
    <div className="war-room-container overflow-hidden relative">
      <div className="grid-overlay" />
      <div className="scanline" />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        colorMode={colorMode}
        fitView
        // Performance optimizations for 1,000+ nodes
        onlyRenderVisibleElements={true}
        minZoom={0.1}
        maxZoom={4}
      >
        <Background color="#1e293b" gap={20} />
        <Controls />
        <Panel position="top-right" className="glass-panel p-4 m-4">
          <h2 className="text-blue-400 font-mono font-bold text-lg tracking-wider glow-text">SPATIAL WAR ROOM</h2>
          <div className="text-slate-400 text-xs mt-1">
            Active Nodes: {nodes.length} | Telemetry: <span className="text-blue-500 animate-pulse">LIVE</span>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
};

export default () => (
  <ReactFlowProvider>
    <SpatialWarRoom />
  </ReactFlowProvider>
);
