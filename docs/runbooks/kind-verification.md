# kind Cluster Verification Runbook

End-to-end runbook for applying `deploy/k8s/*.yaml` to a local
[kind](https://kind.sigs.k8s.io/) cluster and validating that the
orchestrator reaches steady state.

The lint script (`scripts/lint-k8s-manifests.mjs`) covers structural
invariants, but it cannot prove the cluster actually schedules and
serves traffic. This runbook closes that gap.

## Status

| Date       | kubectl | kind   | Verified |
| ---------- | ------- | ------ | -------- |
| 2026-05-21 | absent  | absent | no — runbook only (sandbox lacks both binaries) |

When this runbook is executed on a host that has both binaries, append
a new row and tick the boxes in [Outcomes](#outcomes) with the
measured values.

## Prerequisites

- [ ] Docker daemon reachable (`docker version`)
- [ ] `kubectl` v1.29+ on PATH (`kubectl version --client`)
- [ ] `kind` v0.22+ on PATH (`kind version`)
- [ ] Repo built locally so the `kovael:local` image exists, OR a tagged
      image already loaded into the kind node.

## One-shot

For an unattended run, use the bundled script:

```bash
./scripts/apply-to-kind.sh
```

It performs every step below, fails fast on any error
(`set -euo pipefail`), and tears the cluster down on the way out.

## Manual sequence

### 1. Create (or reuse) the cluster

```bash
kind get clusters | grep -q '^kovael-test$' \
    || kind create cluster --name kovael-test
```

### 2. Build the orchestrator image and load it into kind

The deployment pins `image: kovael:0.1.0`. For local verification we
re-tag the locally built image so `imagePullPolicy: IfNotPresent`
finds it without contacting a registry.

```bash
docker build -t kovael:0.1.0 .
kind load docker-image kovael:0.1.0 --name kovael-test
```

### 3. Apply the manifests

```bash
kubectl apply -f deploy/k8s/
```

Expected output names: `deployment.apps/kovael-orchestrator`,
`service/kovael-orchestrator`,
`horizontalpodautoscaler.autoscaling/kovael-orchestrator`,
`poddisruptionbudget.policy/kovael-orchestrator`.

### 4. Wait for the rollout

```bash
kubectl rollout status deployment/kovael-orchestrator --timeout=120s
```

### 5. Assert both pods are ready

```bash
kubectl get pod \
    -l app.kubernetes.io/name=kovael-orchestrator \
    -o jsonpath='{.items[*].status.containerStatuses[*].ready}'
```

Expected: `true true` (two replicas, both ready).

### 6. Confirm the PDB allows exactly one disruption

```bash
kubectl describe pdb kovael-orchestrator | grep -E 'Allowed disruptions'
```

Expected: `Allowed disruptions:  1`.

### 7. Confirm the HPA is tracking metrics

```bash
kubectl describe hpa kovael-orchestrator
```

Expected: `Min replicas: 2`, `Max replicas: 5`, current replicas = 2.
The metrics-server is **not** installed by default in kind, so
`current` may show `<unknown>` for CPU/memory until one is installed.
That is acceptable for this verification — the HPA object itself must
be admitted and bound to the deployment.

### 8. Probe the health endpoints

```bash
kubectl port-forward svc/kovael-orchestrator 8080:8080 &
PF=$!
sleep 2
curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/livez
curl -sf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/readyz
kill $PF
```

Expected: `200` from both endpoints once chairs are claimed.
`/readyz` may briefly return `503` during startup until the
orchestrator finishes wiring its conversation bus — this is exactly
what the startup probe (30 × 5s = 150s budget) is for.

### 9. Cleanup

```bash
kind delete cluster --name kovael-test
```

## Outcomes

Fill in on the next real run.

- [ ] Rollout completed in under 120s
- [ ] Both pods `Ready=true`
- [ ] `Allowed disruptions: 1` confirmed
- [ ] HPA admitted (`Reference: Deployment/kovael-orchestrator`)
- [ ] `/livez` → 200
- [ ] `/readyz` → 200
- [ ] Cluster torn down cleanly

## Troubleshooting

- **`ImagePullBackOff`** — kind couldn't find `kovael:0.1.0`. Re-run
  `kind load docker-image kovael:0.1.0 --name kovael-test` and check
  `docker image ls | grep kovael`.
- **Readiness flaps** — distroless has no shell, so `kubectl exec` is
  useless for poking around. Inspect `kubectl logs -l
  app.kubernetes.io/name=kovael-orchestrator --tail=200` instead.
- **HPA shows `<unknown>`** — metrics-server isn't installed in a
  default kind cluster. Either install it (`kubectl apply -f
  https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`
  with `--kubelet-insecure-tls` patched in for kind) or accept that
  scaling can't be exercised locally.
- **PDB blocks drain in test** — `minAvailable: 1` with `replicas: 2`
  means draining one node at a time is fine, draining both is not.
  This is intentional.
