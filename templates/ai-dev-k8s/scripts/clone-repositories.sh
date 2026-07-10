#!/bin/bash
set -uo pipefail

repositories=(
  "MadsLorentzen/ai-job-search|ai-job-search"
  "kethalia/pearl-mining-web|cansitki/pearl-mining-web"
  "cansitki/salad|cansitki/salad"
  "chillwhales/.github|chillwhales/.github"
  "chillwhales/chillpass|chillwhales/chillpass"
  "chillwhales/chillwhales-frontend|chillwhales/chillwhales-frontend"
  "chillwhales/lsp-indexer|chillwhales/lsp-indexer"
  "chillwhales/LSPs|chillwhales/LSPs"
  "chillwhales/realm-of-chill|chillwhales/realm-of-chill"
  "chillwhales/rng-request-listener|chillwhales/rng-request-listener"
  "kethalia/.github|kethalia/.github"
  "kethalia/business-indexer|kethalia/business-indexer"
  "kethalia/github-runners|kethalia/github-runners"
  "kethalia/hive|kethalia/hive"
  "kethalia/house-of-slabs|kethalia/house-of-slabs"
  "kethalia/house-of-slabs-new|kethalia/house-of-slabs-new"
  "kethalia/job-hunter|kethalia/job-hunter"
  "kethalia/k8s-cluster|kethalia/k8s-cluster"
  "kethalia/marketing|kethalia/marketing"
  "kethalia/second-brain|kethalia/second-brain"
  "kethalia/top-decor|kethalia/top-decor"
  "kethalia/workflows|kethalia/workflows"
  "phlox-labs/contracts|phlox-labs/contracts"
  "phlox-labs/deployment-docs|phlox-labs/deployment-docs"
  "phlox-labs/service-routing-api|phlox-labs/service-routing-api"
)

mkdir -p "$HOME/projects"
failures=()

for entry in "${repositories[@]}"; do
  repository="${entry%%|*}"
  relative_destination="${entry#*|}"
  destination="$HOME/projects/$relative_destination"
  if [ -d "$destination/.git" ]; then
    printf '[skip] %s already exists\n' "$repository"
    continue
  fi

  mkdir -p "$(dirname "$destination")"
  printf '[clone] %s\n' "$repository"
  if ! gh repo clone "$repository" "$destination"; then
    failures+=("$repository")
  fi
done

if ((${#failures[@]} > 0)); then
  printf '[warn] failed to clone: %s\n' "${failures[*]}" >&2
  printf '[warn] verify GitHub external authentication, then rerun %s\n' "$HOME/clone-repositories.sh" >&2
  exit 1
fi

printf '[ok] repository bootstrap complete\n'
