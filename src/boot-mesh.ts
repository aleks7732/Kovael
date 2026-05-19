import { MeshOrchestrator } from './MeshOrchestrator.js';

async function bootstrap() {
    console.log('🚀 IGNITING KOVAEL SOVEREIGN MESH...');
    
    // 1. Start the Orchestrator on Port 8080
    const orchestrator = new MeshOrchestrator(8080);
    await orchestrator.ready();
    console.log('📡 MESH BUS LIVE: ws://localhost:8080');

    // 2. Graceful shutdown on SIGINT / SIGTERM (no leaked handles)
    let closing = false;
    const shutdown = (signal: string) => {
        if (closing) return;
        closing = true;
        console.log(`\n[boot-mesh] Received ${signal} — shutting down gracefully…`);
        orchestrator.close();
        console.log('[boot-mesh] Shutdown complete.');
        process.exit(0);
    };
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 3. Simulate Agent Heartbeats (Nyx-CLI and Shaev)
    setTimeout(() => {
        orchestrator.broadcast({
            nodeId: 'nyx-gemini-cli',
            type: 'telemetry',
            data: { status: 'ONLINE', cpu: 12, mem: 450, label: 'Nyx (Gemini CLI)' }
        });
        console.log('✅ Nyx-CLI Heartbeat Broadcasted');
    }, 2000);

    setTimeout(() => {
        orchestrator.broadcast({
            nodeId: 'shaev-hermes',
            type: 'telemetry',
            data: { status: 'ONLINE', cpu: 8, mem: 1200, label: 'Shaev (Hermes Agent)' }
        });
        console.log('✅ Shaev Heartbeat Broadcasted');
    }, 3000);

    // 4. Inject a "Proof of Life" Task
    setTimeout(async () => {
        console.log('⚡ INJECTING MISSION: Architect the Nyx Multiverse Cinematic Reveal...');
        const receipt = await orchestrator.injectTask('Architect the Nyx Multiverse Cinematic Reveal');
        console.log('📜 Mission Receipt Hash:', receipt.taskHash);
        console.log('✨ CHECK YOUR WAR ROOM BOARD: Recursive sub-tasks should be appearing.');
    }, 5000);
}

bootstrap().catch(console.error);
