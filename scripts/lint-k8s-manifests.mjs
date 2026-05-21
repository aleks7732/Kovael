#!/usr/bin/env node
// Daemon-free K8s manifest lint. Asserts the production-readiness
// invariants from .claude/notes/2026-05-20-loop-06-k8s-manifests.md.
// No yaml dependency — manifests are small and stable; grep is enough.
//
// Run: node scripts/lint-k8s-manifests.mjs
// Exit 0 on pass, 1 on fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const deployment = readFileSync(resolve(repo, 'deploy/k8s/deployment.yaml'), 'utf8');
const service = readFileSync(resolve(repo, 'deploy/k8s/service.yaml'), 'utf8');
const hpa = readFileSync(resolve(repo, 'deploy/k8s/hpa.yaml'), 'utf8');
const pdb = readFileSync(resolve(repo, 'deploy/k8s/pdb.yaml'), 'utf8');

const checks = [
    {
        name: 'Deployment image does not use :latest',
        pass: /image:\s*[^\s:]+:[^\s]+/.test(deployment) && !/image:\s*\S+:latest/.test(deployment),
    },
    {
        name: 'Deployment exposes a containerPort named http',
        pass: /name:\s*http\s*\n\s*containerPort:\s*8080/.test(deployment),
    },
    {
        name: 'Liveness probe targets /livez',
        pass: /livenessProbe:[\s\S]*?path:\s*\/livez/.test(deployment),
    },
    {
        name: 'Readiness probe targets /readyz',
        pass: /readinessProbe:[\s\S]*?path:\s*\/readyz/.test(deployment),
    },
    {
        name: 'Liveness/readiness probe cadence is production-safe',
        pass:
            /livenessProbe:[\s\S]*?periodSeconds:\s*10[\s\S]*?failureThreshold:\s*3/.test(deployment) &&
            /readinessProbe:[\s\S]*?periodSeconds:\s*5[\s\S]*?failureThreshold:\s*3/.test(deployment),
    },
    {
        name: 'Startup probe present (orchestrator cold-start is slow)',
        pass: /startupProbe:[\s\S]*?path:\s*\/livez/.test(deployment),
    },
    {
        name: 'Pod-level runAsNonRoot: true',
        pass: /securityContext:[\s\S]*?runAsNonRoot:\s*true/.test(deployment),
    },
    {
        name: 'Container readOnlyRootFilesystem: true',
        pass: /readOnlyRootFilesystem:\s*true/.test(deployment),
    },
    {
        name: 'Container capabilities.drop includes ALL',
        pass: /capabilities:\s*\n\s*drop:\s*\n\s*-\s*ALL/.test(deployment),
    },
    {
        name: 'allowPrivilegeEscalation: false',
        pass: /allowPrivilegeEscalation:\s*false/.test(deployment),
    },
    {
        name: 'seccompProfile RuntimeDefault',
        pass: /seccompProfile:[\s\S]*?type:\s*RuntimeDefault/.test(deployment),
    },
    {
        name: 'CPU + memory requests AND limits set',
        pass:
            /requests:[\s\S]*?cpu:[\s\S]*?memory:/.test(deployment) &&
            /limits:[\s\S]*?cpu:[\s\S]*?memory:/.test(deployment),
    },
    {
        name: 'Service is ClusterIP only (no LoadBalancer/NodePort)',
        pass: /type:\s*ClusterIP/.test(service) && !/type:\s*(LoadBalancer|NodePort)/.test(service),
    },
    {
        name: 'Service targetPort references the http port name',
        pass: /targetPort:\s*http/.test(service),
    },
    {
        name: 'HPA scaleTargetRef.name matches the Deployment',
        pass: /scaleTargetRef:[\s\S]*?name:\s*kovael-orchestrator/.test(hpa),
    },
    {
        name: 'HPA minReplicas is 2 for baseline HA',
        pass: /minReplicas:\s*2/.test(hpa),
    },
    {
        name: 'HPA tracks both CPU and memory',
        pass: /resource:[\s\S]*?name:\s*cpu/.test(hpa) && /resource:[\s\S]*?name:\s*memory/.test(hpa),
    },
    {
        name: 'HPA scaleDown has a stabilization window (avoid thrashing)',
        pass: /scaleDown:[\s\S]*?stabilizationWindowSeconds:/.test(hpa),
    },
    {
        name: 'Prometheus scrape annotations point at /metrics on 8080',
        pass:
            /prometheus\.io\/scrape:\s*"true"/.test(deployment) &&
            /prometheus\.io\/path:\s*\/metrics/.test(deployment) &&
            /prometheus\.io\/port:\s*"8080"/.test(deployment),
    },
    {
        name: 'PodDisruptionBudget keeps at least one pod available',
        pass:
            /kind:\s*PodDisruptionBudget/.test(pdb) &&
            /name:\s*kovael-orchestrator/.test(pdb) &&
            /minAvailable:\s*1/.test(pdb),
    },
];

let failed = 0;
for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    process.stdout.write(`[${tag}] ${c.name}\n`);
    if (!c.pass) failed += 1;
}

process.stdout.write(`\n${checks.length - failed}/${checks.length} passed\n`);
process.exit(failed === 0 ? 0 : 1);
