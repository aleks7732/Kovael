import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  ReactFlowProvider,
  MiniMap,
  BackgroundVariant,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './index.css';
import './App.css';

import { useWarRoomStore } from './store/useWarRoomStore.js';
import { AgentHeartbeatNode, TaskClusterNode, ANXBriefingNode } from './components/CustomNodes.js';
import { TopBar } from './components/TopBar.js';
import { MissionBriefPanel } from './components/MissionBriefPanel.js';
import { AgentRosterPanel } from './components/AgentRosterPanel.js';
import { PhaseFeed } from './components/PhaseFeed.js';

const nodeTypes = {
  agentHeartbeat: AgentHeartbeatNode,
  taskCluster: TaskClusterNode,
  anxBriefing: ANXBriefingNode,
};

const PRESSURE_VALVE_INTERVAL_MS = 100;
const ORCHESTRATOR_URL = 'ws://localhost:8080';

const SpatialWarRoom = () => {
  const nodes = useWarRoomStore((s) => s.nodes);
  const edges = useWarRoomStore((s) => s.edges);
  const hardware = useWarRoomStore((s) => s.hardware);
  const anxBriefings = useWarRoomStore((s) => s.anxBriefings);
  const phaseEvents = useWarRoomStore((s) => s.phaseEvents);
  const agentRoster = useWarRoomStore((s) => s.agentRoster);
  const receiptsIssued = useWarRoomStore((s) => s.receiptsIssued);
  const onNodesChange = useWarRoomStore((s) => s.onNodesChange);
  const onEdgesChange = useWarRoomStore((s) => s.onEdgesChange);
  const onConnect = useWarRoomStore((s) => s.onConnect);
  const enqueueTelemetry = useWarRoomStore((s) => s.enqueueTelemetry);
  const enqueueHardware = useWarRoomStore((s) => s.enqueueHardware);
  const flushPressureValve = useWarRoomStore((s) => s.flushPressureValve);
  const addVerificationReceipt = useWarRoomStore((s) => s.addVerificationReceipt);
  const upsertAgentNode = useWarRoomStore((s) => s.upsertAgentNode);
  const addTask = useWarRoomStore((s) => s.addTask);
  const addANXBriefing = useWarRoomStore((s) => s.addANXBriefing);
  const recordPhaseEvent = useWarRoomStore((s) => s.recordPhaseEvent);

  const meshStatus = useMemo<'live' | 'syncing' | 'offline'>(() => {
    if (agentRoster.length === 0 && nodes.length <= 1) return 'syncing';
    return 'live';
  }, [agentRoster.length, nodes.length]);

  // 100ms Telemetry Pressure Valve — Module A
  useEffect(() => {
    const id = setInterval(flushPressureValve, PRESSURE_VALVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [flushPressureValve]);

  const wsRef = useRef<WebSocket | null>(null);

  const injectMission = useCallback((goal: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'mission_inject', goal, origin: 'cockpit' }));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(ORCHESTRATOR_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case 'telemetry':
            enqueueTelemetry(message.nodeId, message.data);
            break;
          case 'hardware_telemetry':
            enqueueHardware(message.data);
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
          case 'anx_briefing':
            if (typeof message.data === 'string') addANXBriefing(message.data);
            break;
          case 'phase_change':
            recordPhaseEvent(message.data);
            break;
        }
      } catch (err) {
        console.error('Failed to parse WS message', err);
      }
    };

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [enqueueTelemetry, enqueueHardware, addTask, addVerificationReceipt, upsertAgentNode, addANXBriefing, recordPhaseEvent]);

  return (
    <div className="cockpit-grid h-screen w-screen overflow-hidden text-command-warm-white">
      <TopBar
        meshStatus={meshStatus}
        connectedClients={1}
        receiptsIssued={receiptsIssued}
        activeAgents={agentRoster.length}
        nodeCount={nodes.length}
        onInjectMission={injectMission}
      />

      <div className="flex flex-1 min-h-0">
        <MissionBriefPanel briefings={anxBriefings} />

        <main className="flex-1 relative min-w-0">
          <div className="grid-overlay pointer-events-none" />
          <div className="ember-ambient pointer-events-none" />
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.25 }}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="rgba(245,245,220,0.06)"
            />
            <Controls
              className="!bg-black/40 !backdrop-blur-md !border !border-white/5 !shadow-none"
              showInteractive={false}
            />
            <MiniMap
              pannable
              zoomable
              className="!bg-black/30 !backdrop-blur-md !border !border-white/5"
              maskColor="rgba(0,0,0,0.6)"
              nodeColor={(n) => {
                if (n.type === 'agentHeartbeat') return '#C15F3C';
                if (n.type === 'taskCluster') return '#F5F5DC';
                if (n.type === 'anxBriefing') return '#34d399';
                return '#666';
              }}
            />
          </ReactFlow>
        </main>

        <AgentRosterPanel roster={agentRoster} hardware={hardware} />
      </div>

      <PhaseFeed events={phaseEvents} />
    </div>
  );
};

export default () => (
  <ReactFlowProvider>
    <SpatialWarRoom />
  </ReactFlowProvider>
);
