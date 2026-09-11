#!/usr/bin/env bash
# tree-sitter@0.25.x ships a linux-x64 prebuilt (`prebuilds/linux-x64/tree-sitter.node`)
# that dynamically links the system `libnode.so` (e.g. Debian's node-20 package).
# Under a *different* Node (nvm's node 22) that drags a SECOND Node runtime into the
# process, which SEGFAULTS the moment tree-sitter coexists with another native addon
# (better-sqlite3) — i.e. every ingest+store path and the whole mcp test suite.
#
# Fix: recompile tree-sitter from source against the RUNNING Node's headers, so it
# resolves Node symbols from the host process (no libnode link). `pnpm install`
# re-fetches the broken prebuilt, so this must run after every install (it does, via
# the root "postinstall"; dev-setup.sh also calls it).
set -euo pipefail
cd "$(dirname "$0")/.."

# The conflict is linux-only (macOS/Windows prebuilts don't link a shared libnode).
[ "$(uname -s)" = "Linux" ] || exit 0

pkg="$(find node_modules/.pnpm -maxdepth 3 -type d -path '*/tree-sitter@*/node_modules/tree-sitter' 2>/dev/null | head -1)"
[ -n "${pkg:-}" ] || exit 0   # tree-sitter not installed yet

nodedir="$(dirname "$(dirname "$(command -v node)")")"
echo "recompiling tree-sitter from source (avoids the libnode-linked prebuilt)…"
if ( cd "$pkg" && rm -rf build prebuilds && npm_config_nodedir="$nodedir" npx --yes node-gyp rebuild >/dev/null 2>&1 ); then
  bin="$(find "$pkg/build" -name '*.node' 2>/dev/null | head -1)"
  if [ -n "${bin:-}" ] && ldd "$bin" 2>/dev/null | grep -qi libnode; then
    echo "  ! rebuilt binary still links libnode — investigate the build toolchain" >&2
    exit 1
  fi
  echo "  ✓ tree-sitter built from source against $(node -v)"
else
  echo "  ! tree-sitter source build failed — ensure python3, make and g++ are installed" >&2
  exit 1
fi
