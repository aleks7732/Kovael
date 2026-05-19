import React, { useEffect } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  Panel,
  ReactFlowProvider,
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
    addVerificationReceipt,
    upsertAgentNode,
    addTask 
  } = useWarRoomStore();

  useEffect(() => {
    const ws = new WebSocket('ws://localhost:8080');

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        switch (message.type) {
          case 'telemetry':
            updateNodeTelemetry(message.nodeId, message.data);
            break;
          case 'new_task':
            addTask(message.task);
            break;
          case 'agent_card':
            upsertAgentNode(message.data);
            break;
          case 'verification_receipt':
            addVerificationReceipt(message.nodeId, message.data);
            break;
        }
      } catch (err) {
        console.error('Failed to parse WS message', err);
      }
    };

    return () => ws.close();
  }, [updateNodeTelemetry, addTask, addVerificationReceipt, upsertAgentNode]);

  return (
    <div className="war-room-container w-full h-full bg-[#0A0A0A] relative overflow-hidden">
      <div className="grid-overlay" />
      <div className="scanline" />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        onlyRenderVisibleElements={true}
      >
        <Background color="#1e293b" gap={20} />
        <Controls />
        <Panel position="top-right" className="glass-panel p-4 m-4">
          <h2 className="text-blue-400 font-mono font-bold text-lg tracking-wider glow-text uppercase">Kovael War Room</h2>
          <div className="text-slate-400 text-[10px] mt-1 font-mono uppercase tracking-widest">
            Nodes: {nodes.length} | Mesh: <span className="text-blue-500 animate-pulse">Synchronized</span>
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
