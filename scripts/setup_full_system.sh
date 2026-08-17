#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPUTE_WORKER_DIR="$ROOT_DIR/python/compute-worker"
COMPUTE_WORKER_VENV="$COMPUTE_WORKER_DIR/.venv"

need_cmd() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 127
  fi
}

echo "==> Checking required runtimes"
for command_name in node npm python3; do
  need_cmd "$command_name"
done
node --version
npm --version
python3 --version

echo "==> Installing TypeScript workspace dependencies"
cd "$ROOT_DIR"
npm install

echo "==> Creating or refreshing the compute-worker virtual environment"
python3 -m venv "$COMPUTE_WORKER_VENV"
"$COMPUTE_WORKER_VENV/bin/python" -m pip install --upgrade "$COMPUTE_WORKER_DIR"

echo "==> Verifying the pinned Pi dependency set"
npm run verify:pi-dependencies

echo "==> Building the TypeScript platform"
npm run build

cat <<'MSG'

Setup complete.

Start the TypeScript platform from the repository root:

  npm start

MSG
