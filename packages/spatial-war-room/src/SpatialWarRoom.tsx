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
import { ClaimsStrip } from './components/ClaimsStrip.js';
import { ConnectionBanner } from './components/ConnectionBanner.js';
import { ToastStack } from './components/ToastStack.js';
import { CycleInspector } from './components/CycleInspector.js';
import { StatusLegend } from './components/StatusLegend.js';

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
  const hookEvents = useWarRoomStore((s) => s.hookEvents);
  const retryEvents = useWarRoomStore((s) => s.retryEvents);
  const reconcileActions = useWarRoomStore((s) => s.reconcileActions);
  const agentRoster = useWarRoomStore((s) => s.agentRoster);
  const receiptsIssued = useWarRoomStore((s) => s.receiptsIssued);
  const onNodesChange = useWarRoomStore((s) => s.onNodesChange);
  const onEdgesChange = useWarRoomStore((s) => s.onEdgesChange);
  const onConnect = useWarRoomStore((s) => s.onConnect);
  const flushPressureValve = useWarRoomStore((s) => s.flushPressureValve);
  const tokenTotals = useWarRoomStore((s) => s.tokenTotals);
  const rateLimits = useWarRoomStore((s) => s.rateLimits);
  const claimStats = useWarRoomStore((s) => s.claimStats);
  const retryPendingCount = useWarRoomStore((s) => s.retryPendingCount);
  const interAgentChatEnabled = useWarRoomStore((s) => s.interAgentChatEnabled);
  const interAgentChatMode = useWarRoomStore((s) => s.interAgentChatMode);
  const interAgentMessages = useWarRoomStore((s) => s.interAgentMessages);

  const wsConnected = useWarRoomStore((s) => s.wsConnected);
  const selectedCycleId = useWarRoomStore((s) => s.selectedCycleId);
  const setSelectedCycle = useWarRoomStore((s) => s.setSelectedCycle);
  const meshStatus = useMemo<'live' | 'syncing' | 'offline'>(() => {
    // Offline if the WS is down — that's the only state where the cockpit
    // genuinely has no live data. Syncing covers the cold-start window
    // where WS is up but the orchestrator hasn't pushed agent cards yet.
    if (!wsConnected) return 'offline';
    if (agentRoster.length === 0 && nodes.length <= 1) return 'syncing';
    return 'live';
  }, [wsConnected, agentRoster.length, nodes.length]);

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

  const toggleInterAgentChat = useCallback((enabled: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'toggle_inter_agent_chat', enabled }));
  }, []);

  const changeInterAgentChatMode = useCallback((mode: 'technical' | 'interests') => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'set_inter_agent_chat_mode', mode }));
  }, []);

  useEffect(() => {
    let active = true;
    let reconnectTimeout: any = null;
    let currentWs: WebSocket | null = null;
    // Exponential backoff with full jitter so a fleet of dropped clients
    // doesn't synchronize their reconnect attempts onto the same tick.
    // Schedule: ~0.5s, 1s, 2s, 4s, 8s, 16s, 30s (cap). On a successful
    // open the attempt counter resets so the next outage starts fresh.
    const RECONNECT_BASE_MS = 500;
    const RECONNECT_MAX_MS = 30_000;
    let reconnectAttempt = 0;

    const scheduleReconnect = () => {
      const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
      // Full jitter: pick uniformly from [0, exp). Cheap thundering-herd guard.
      const delay = Math.floor(Math.random() * exp);
      reconnectAttempt += 1;
      console.log(`WebSocket reconnect attempt ${reconnectAttempt} in ${delay}ms (window ${exp}ms)`);
      reconnectTimeout = setTimeout(connect, delay);
    };

    const connect = () => {
      console.log('Connecting to WebSocket...');
      const ws = new WebSocket(ORCHESTRATOR_URL);
      currentWs = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        reconnectAttempt = 0;
        useWarRoomStore.getState().setWsConnected(true);
      };

      ws.onmessage = (event) => {
        if (!active) return;
        try {
          const message = JSON.parse(event.data);
          const store = useWarRoomStore.getState();

          switch (message.type) {
            case 'telemetry':
              store.enqueueTelemetry(message.nodeId, message.data);
              break;
            case 'hardware_telemetry':
              store.enqueueHardware(message.data);
              break;
            case 'new_task':
              store.addTask(message.task);
              break;
            case 'agent_card':
              store.upsertAgentNode(message.data);
              break;
            case 'verification_receipt':
              store.addVerificationReceipt(message.nodeId, message.data);
              break;
            case 'anx_briefing':
              if (typeof message.data === 'string') store.addANXBriefing(message.data);
              break;
            case 'phase_change':
              store.recordPhaseEvent(message.data);
              break;
            case 'claim_event':
              store.recordClaimEvent(message.data);
              break;
            case 'retry_event':
              store.recordRetryEvent(message.data);
              break;
            case 'reconcile_event':
              store.recordReconcileAction(message.data);
              break;
            case 'hook_event':
              store.recordHookEvent(message.data);
              break;
            case 'token_update':
              if (message.data?.totals) store.recordTokenUpdate(message.data.totals);
              break;
            case 'rate_limit_update':
              if (message.data?.agentId) store.recordRateLimit(message.data);
              break;
            case 'inter_agent_chat_state':
              if (message.data) {
                if (typeof message.data.enabled === 'boolean') {
                  store.setInterAgentChatEnabled(message.data.enabled);
                }
                if (message.data.mode) {
                  store.setInterAgentChatMode(message.data.mode);
                }
              }
              break;
            case 'inter_agent_message':
              if (message.data) {
                store.addInterAgentMessage(message.data);
              }
              break;
            case 'chair_event':
              if (message.data) store.recordChairEvent(message.data);
              break;
            case 'chair_roster_snapshot':
              if (message.data) store.applyChairRoster(message.data);
              break;
          }
        } catch (err) {
          console.error('Failed to parse WS message', err);
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        useWarRoomStore.getState().setWsConnected(false);
        if (active) {
          scheduleReconnect();
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (currentWs) {
        currentWs.close();
      }
      if (wsRef.current === currentWs) {
        wsRef.current = null;
      }
    };
  }, []);

  return (
    <div className="cockpit-grid h-screen w-screen overflow-hidden text-command-warm-white">
      <ConnectionBanner wsConnected={wsConnected} />
      <TopBar
        meshStatus={meshStatus}
        connectedClients={1}
        receiptsIssued={receiptsIssued}
        activeAgents={agentRoster.length}
        nodeCount={nodes.length}
        tokenTotals={tokenTotals}
        onInjectMission={injectMission}
      />

      <ClaimsStrip stats={claimStats} retryPending={retryPendingCount} />

      <div className="flex flex-1 min-h-0">
        <MissionBriefPanel briefings={anxBriefings} phaseEvents={phaseEvents} />

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

        <AgentRosterPanel
          roster={agentRoster}
          hardware={hardware}
          rateLimits={rateLimits}
          interAgentChatEnabled={interAgentChatEnabled}
          interAgentChatMode={interAgentChatMode}
          interAgentMessages={interAgentMessages}
          onToggleInterAgentChat={toggleInterAgentChat}
          onChangeInterAgentChatMode={changeInterAgentChatMode}
        />
      </div>

      <PhaseFeed
        phaseEvents={phaseEvents}
        hookEvents={hookEvents}
        retryEvents={retryEvents}
        reconcileActions={reconcileActions}
        onSelectCycle={setSelectedCycle}
      />

      <ToastStack phaseEvents={phaseEvents} />
      <CycleInspector
        cycleId={selectedCycleId}
        phaseEvents={phaseEvents}
        hookEvents={hookEvents}
        onClose={() => setSelectedCycle(null)}
      />
      <StatusLegend />
    </div>
  );
};

export default () => (
  <ReactFlowProvider>
    <SpatialWarRoom />
  </ReactFlowProvider>
);
