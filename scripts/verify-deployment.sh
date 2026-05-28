#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

NAMESPACE=""
RELEASE=""
CONTEXT=""
TIMEOUT="${TIMEOUT:-10m}"

log() {
  local level="$1"
  shift
  printf '[%s] [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$*" >&2
}

info() { log "INFO" "$@"; }
error() { log "ERROR" "$@"; }
fatal() {
  error "$@"
  exit 1
}

usage() {
  printf '%s\n' \
    "Usage: ${SCRIPT_NAME} --namespace <namespace> --release <helm-release> [OPTIONS]" \
    "" \
    "Verifies the Hive deployment rollout state for web, auth, terminal, and the" \
    "Prisma migration hook job when it is still present in the namespace." \
    "" \
    "Options:" \
    "  -n, --namespace <name>   Kubernetes namespace to inspect" \
    "  -r, --release <name>     Helm release name / app.kubernetes.io/instance label" \
    "      --context <name>     Optional kubeconfig context" \
    "      --timeout <duration> Rollout/wait timeout (default: ${TIMEOUT})" \
    "  -h, --help               Show this help"
}

require_arg_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == -* ]]; then
    error "${flag} requires a value"
    usage >&2
    exit 2
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--namespace)
        require_arg_value "$1" "${2:-}"
        NAMESPACE="$2"
        shift 2
        ;;
      -r|--release)
        require_arg_value "$1" "${2:-}"
        RELEASE="$2"
        shift 2
        ;;
      --context)
        require_arg_value "$1" "${2:-}"
        CONTEXT="$2"
        shift 2
        ;;
      --timeout)
        require_arg_value "$1" "${2:-}"
        TIMEOUT="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        error "Unknown option: $1"
        usage >&2
        exit 2
        ;;
    esac
  done

  if [[ -z "$NAMESPACE" || -z "$RELEASE" ]]; then
    error "--namespace and --release are required"
    usage >&2
    exit 2
  fi
}

require_tool() {
  local tool="$1"
  command -v "$tool" >/dev/null 2>&1 || {
    error "Required tool '${tool}' not found in PATH"
    exit 3
  }
}

k() {
  if [[ -n "$CONTEXT" ]]; then
    kubectl --context "$CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

check_deployment() {
  local component="$1"
  local selector="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/name=${component}"
  local name
  name="$(k -n "$NAMESPACE" get deployment -l "$selector" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"

  [[ -n "$name" ]] || fatal "No Deployment found for selector '${selector}' in namespace '${NAMESPACE}'"

  info "Checking rollout for deployment/${name}"
  k -n "$NAMESPACE" rollout status "deployment/${name}" --timeout="$TIMEOUT"

  local desired updated available ready
  desired="$(k -n "$NAMESPACE" get deployment "$name" -o jsonpath='{.spec.replicas}')"
  updated="$(k -n "$NAMESPACE" get deployment "$name" -o jsonpath='{.status.updatedReplicas}')"
  available="$(k -n "$NAMESPACE" get deployment "$name" -o jsonpath='{.status.availableReplicas}')"
  ready="$(k -n "$NAMESPACE" get deployment "$name" -o jsonpath='{.status.readyReplicas}')"

  [[ "${updated:-0}" == "${desired:-0}" ]] || fatal "deployment/${name} updated replicas ${updated:-0}/${desired:-0}"
  [[ "${available:-0}" == "${desired:-0}" ]] || fatal "deployment/${name} available replicas ${available:-0}/${desired:-0}"
  [[ "${ready:-0}" == "${desired:-0}" ]] || fatal "deployment/${name} ready replicas ${ready:-0}/${desired:-0}"

  info "deployment/${name} is ready (${ready}/${desired})"
}

check_pdb() {
  local component="$1"
  local selector="app.kubernetes.io/instance=${RELEASE},app.kubernetes.io/name=${component}"
  local pdbs
  pdbs="$(k -n "$NAMESPACE" get pdb -l "$selector" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"

  if [[ -z "$pdbs" ]]; then
    info "No PDB enabled for ${component}; this is expected for preview/one-replica releases"
    return
  fi

  while IFS= read -r pdb; do
    [[ -n "$pdb" ]] || continue
    local disruptions_allowed current_healthy desired_healthy
    disruptions_allowed="$(k -n "$NAMESPACE" get pdb "$pdb" -o jsonpath='{.status.disruptionsAllowed}')"
    current_healthy="$(k -n "$NAMESPACE" get pdb "$pdb" -o jsonpath='{.status.currentHealthy}')"
    desired_healthy="$(k -n "$NAMESPACE" get pdb "$pdb" -o jsonpath='{.status.desiredHealthy}')"
    info "pdb/${pdb}: disruptionsAllowed=${disruptions_allowed:-0}, healthy=${current_healthy:-0}/${desired_healthy:-0}"
  done <<< "$pdbs"
}

check_migrate_job() {
  local job="${RELEASE}-prisma-migrate"

  if ! k -n "$NAMESPACE" get job "$job" >/dev/null 2>&1; then
    info "Migration hook job/${job} is not present; successful Argo CD hooks are deleted after completion"
    return
  fi

  info "Checking migration hook job/${job}"
  if k -n "$NAMESPACE" wait --for=condition=complete "job/${job}" --timeout="$TIMEOUT"; then
    info "job/${job} completed"
    return
  fi

  k -n "$NAMESPACE" describe "job/${job}" >&2 || true
  fatal "job/${job} did not complete"
}

main() {
  parse_args "$@"
  require_tool kubectl

  check_migrate_job
  check_deployment hive-web
  check_deployment hive-auth
  check_deployment hive-terminal
  check_pdb hive-web
  check_pdb hive-auth
  check_pdb hive-terminal

  info "Hive deployment verification passed for release '${RELEASE}' in namespace '${NAMESPACE}'"
}

main "$@"
