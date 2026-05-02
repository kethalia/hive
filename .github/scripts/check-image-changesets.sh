#!/usr/bin/env bash
# Per-image changeset coverage check.
#
# For each deployable docker image, this script computes which source paths
# would invalidate its build (the image's own dir + its workspace deps). If
# any of those paths changed in the PR diff, the image's changeset package
# MUST appear in `pnpm changeset status` output. Otherwise the workflow
# fails with an actionable message.
#
# Run locally:  .github/scripts/check-image-changesets.sh origin/main
set -euo pipefail

BASE="${1:-origin/main}"

# image-pkg-name | space-separated watched path prefixes
IMAGES=(
  "hive-web|src/ public/ prisma/ packages/auth/ Dockerfile next.config.ts package.json"
  "hive-auth|services/auth/ packages/auth/"
  "hive-terminal|services/terminal-proxy/ packages/auth/"
)

CHANGED=$(git diff --name-only "$BASE"...HEAD)
echo "Changed files vs $BASE:"
echo "$CHANGED" | sed 's/^/  /'
echo

STATUS_FILE="$(mktemp)"
trap 'rm -f "$STATUS_FILE"' EXIT
if ! pnpm changeset status --since="$BASE" --output="$STATUS_FILE" >/dev/null 2>&1; then
  # `changeset status` exits non-zero when there are no changesets at all.
  # That is itself a failure if any image needs a bump — handled below.
  echo "[]" > "$STATUS_FILE" || true
fi
PENDING=$(jq -r '.releases[]?.name' "$STATUS_FILE" 2>/dev/null || true)
echo "Packages bumped by pending changesets:"
echo "${PENDING:-  (none)}" | sed 's/^/  /'
echo

failed=0
for entry in "${IMAGES[@]}"; do
  pkg="${entry%%|*}"
  paths="${entry#*|}"

  needs_bump=false
  triggered_by=""
  for path in $paths; do
    if echo "$CHANGED" | grep -qE "^${path}"; then
      needs_bump=true
      triggered_by="$path"
      break
    fi
  done

  if ! $needs_bump; then
    echo "· $pkg: no source changes — skip"
    continue
  fi

  if echo "$PENDING" | grep -qx "$pkg"; then
    echo "✓ $pkg: changes under '$triggered_by' covered by changeset"
  else
    echo "::error::$pkg has source changes under '$triggered_by' but no changeset bumps it. Add a changeset entry: \`'$pkg': patch\` (or minor/major)."
    failed=1
  fi
done

exit $failed
