#!/usr/bin/env bash
# Reproducible dev bootstrap for context-tree. Run from the repo root on either
# machine: `./scripts/dev-setup.sh`. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== context-tree dev setup =="

# 1. Node >= 22 (better-sqlite3's native ABI + the vitest worker pool need it;
#    on Node 20 the DB tests segfault). The version is pinned in .nvmrc.
have="$(node -v 2>/dev/null || echo none)"
major="$(printf '%s' "$have" | sed -E 's/^v?([0-9]+).*/\1/')"
if ! [[ "$major" =~ ^[0-9]+$ ]] || [ "$major" -lt 22 ]; then
  echo "Node is ${have}; need >= v22."
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo "→ using nvm and .nvmrc"
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm install
    nvm use
  else
    echo "!! Install Node >= 22 (e.g. 'nvm install 22' or your distro's nodejs 22) and re-run." >&2
    exit 1
  fi
fi
echo "node: $(node -v)"

# 2. pnpm — pinned by package.json \"packageManager\"; corepack provides the exact
#    version. This is why plain 'pnpm' may be missing: enable the shim once.
corepack enable
echo "pnpm: $(corepack pnpm --version)"

# 3. Install (fetches/builds the better-sqlite3 native binary for this Node).
#    The root "postinstall" recompiles tree-sitter from source (its linux prebuilt
#    links the system libnode and segfaults alongside better-sqlite3); run it here
#    strictly too, so a build-tool problem surfaces instead of being swallowed.
corepack pnpm install
bash scripts/rebuild-tree-sitter.sh

# 4. Sanity: the workspace typechecks (project references build).
corepack pnpm exec tsc -b tsconfig.json
echo "✓ typecheck clean"

echo
echo "Ready. Common commands:"
echo "  corepack pnpm exec vitest run              # full test suite"
echo "  corepack pnpm exec vitest run packages/core"
echo "  corepack pnpm exec tsc -b tsconfig.json    # typecheck"
echo "If a machine's vitest crashes on worker teardown, add:"
echo "  --pool=forks --poolOptions.forks.singleFork=true"
