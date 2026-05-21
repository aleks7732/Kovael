#!/usr/bin/env bash
# End-to-end verification: build the orchestrator image, load it into a
# kind cluster, apply deploy/k8s, and probe /livez + /readyz. Tears the
# cluster down on exit (success or failure) unless KEEP_CLUSTER=1.
#
# Usage:
#   ./scripts/apply-to-kind.sh
#
# Env knobs:
#   CLUSTER_NAME   default: kovael-test
#   IMAGE          default: kovael:0.1.0  (must match deploy/k8s/deployment.yaml)
#   KEEP_CLUSTER   set to 1 to skip teardown (debugging)
#   SKIP_BUILD     set to 1 to reuse an existing local image

set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-kovael-test}"
IMAGE="${IMAGE:-kovael:0.1.0}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n=== %s ===\n' "$*"; }

require() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "missing required tool: $1" >&2
        exit 127
    }
}

cleanup() {
    local code=$?
    if [[ -n "${PF_PID:-}" ]] && kill -0 "$PF_PID" 2>/dev/null; then
        kill "$PF_PID" 2>/dev/null || true
        wait "$PF_PID" 2>/dev/null || true
    fi
    if [[ "${KEEP_CLUSTER:-0}" != "1" ]]; then
        log "deleting kind cluster ${CLUSTER_NAME}"
        kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true
    else
        log "KEEP_CLUSTER=1 — leaving ${CLUSTER_NAME} running"
    fi
    exit "$code"
}
trap cleanup EXIT INT TERM

require docker
require kubectl
require kind

cd "$REPO_ROOT"

log "step 1/8 create or reuse kind cluster '${CLUSTER_NAME}'"
if kind get clusters | grep -qx "$CLUSTER_NAME"; then
    echo "cluster '${CLUSTER_NAME}' already exists — reusing"
else
    kind create cluster --name "$CLUSTER_NAME"
fi
kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    log "step 2/8 build image ${IMAGE}"
    docker build -t "$IMAGE" .
else
    log "step 2/8 SKIP_BUILD=1 — reusing existing ${IMAGE}"
fi

log "step 3/8 load image into kind node"
kind load docker-image "$IMAGE" --name "$CLUSTER_NAME"

log "step 4/8 apply deploy/k8s manifests"
kubectl apply -f deploy/k8s/

log "step 5/8 wait for rollout (timeout 120s)"
kubectl rollout status deployment/kovael-orchestrator --timeout=120s

log "step 6/8 assert pod readiness"
READY=$(kubectl get pod \
    -l app.kubernetes.io/name=kovael-orchestrator \
    -o jsonpath='{.items[*].status.containerStatuses[*].ready}')
echo "container ready states: ${READY}"
if [[ "$READY" != "true true" ]]; then
    echo "expected 'true true', got '${READY}'" >&2
    exit 1
fi

log "PodDisruptionBudget state"
kubectl describe pdb kovael-orchestrator | grep -E 'Allowed disruptions|Min available|Status'

log "HorizontalPodAutoscaler state"
kubectl describe hpa kovael-orchestrator | grep -E 'Reference|Min replicas|Max replicas|Deployment pods'

log "step 7/8 probe /livez and /readyz via port-forward"
kubectl port-forward svc/kovael-orchestrator 8080:8080 >/dev/null 2>&1 &
PF_PID=$!
# wait for the local listener
for _ in $(seq 1 20); do
    if curl -sf -o /dev/null http://127.0.0.1:8080/livez; then break; fi
    sleep 1
done

LIVEZ=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/livez)
READYZ=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/readyz)
echo "/livez  -> ${LIVEZ}"
echo "/readyz -> ${READYZ}"

if [[ "$LIVEZ" != "200" || "$READYZ" != "200" ]]; then
    echo "health probes did not both return 200" >&2
    exit 1
fi

log "step 8/8 verification PASSED"
echo "kovael-orchestrator is healthy on kind cluster '${CLUSTER_NAME}'"
