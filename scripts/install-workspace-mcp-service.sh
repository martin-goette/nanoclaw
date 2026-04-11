#!/usr/bin/env bash
#
# Install or update the systemd user service that runs the Google Workspace
# MCP server as a persistent HTTP endpoint bound to 127.0.0.1 (loopback only).
#
# Why loopback? NanoClaw containers use `--network=host` on Linux, so they
# reach the host over 127.0.0.1 directly — no bridge, no public port, no
# firewall rule needed. The internet cannot connect to a 127.0.0.1 listener.
#
# Why a persistent server? The previous setup spawned `uvx workspace-mcp`
# inside each container as a stdio subprocess. A single handshake hiccup
# would poison the session: the Claude Agent SDK marks the tools as gone
# via `deferred_tools_delta` and every resume of that session inherits the
# "MCP offline" state until rotation. Running the server out-of-process
# replaces per-container stdio spawns with one long-lived HTTP connection.
#
# Idempotent: safe to re-run to pick up uvx upgrades or env changes.
#
# To uninstall:
#   systemctl --user disable --now nanoclaw-workspace-mcp.service
#   rm ~/.config/systemd/user/nanoclaw-workspace-mcp.service
#   systemctl --user daemon-reload

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_NAME="nanoclaw-workspace-mcp.service"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
PORT="${WORKSPACE_MCP_PORT:-8765}"
BIND_HOST="127.0.0.1"

# Resolve uvx path now so the unit doesn't depend on $PATH at boot.
UVX="$(command -v uvx || true)"
if [[ -z "$UVX" ]]; then
  echo "error: uvx not found on PATH — install uv first (https://docs.astral.sh/uv/)" >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "error: $REPO_ROOT/.env not found — create it and set GOOGLE_OAUTH_CLIENT_ID/SECRET" >&2
  exit 1
fi

if ! grep -q '^GOOGLE_OAUTH_CLIENT_ID=' "$REPO_ROOT/.env"; then
  echo "error: GOOGLE_OAUTH_CLIENT_ID missing from $REPO_ROOT/.env" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR" "$REPO_ROOT/logs"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=NanoClaw Google Workspace MCP (loopback HTTP, $BIND_HOST:$PORT)
After=network.target

[Service]
Type=simple
ExecStart=$UVX workspace-mcp --transport streamable-http --single-user --tool-tier core
WorkingDirectory=$HOME
# Pulls GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from the repo .env.
# The later Environment= lines override anything the .env might set for the
# WORKSPACE_MCP_* vars, which is what we want — loopback binding is not
# negotiable.
EnvironmentFile=$REPO_ROOT/.env
Environment=WORKSPACE_MCP_HOST=$BIND_HOST
Environment=WORKSPACE_MCP_PORT=$PORT
Environment=WORKSPACE_MCP_CREDENTIALS_DIR=$HOME/.google_workspace_mcp/credentials
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
StandardOutput=append:$REPO_ROOT/logs/workspace-mcp.log
StandardError=append:$REPO_ROOT/logs/workspace-mcp.log

[Install]
WantedBy=default.target
EOF

echo "Wrote $UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME" >/dev/null
systemctl --user restart "$UNIT_NAME"

# Give the service time to bind the socket. First-time startup is slow
# (~5s) because uv has to resolve the tool cache and FastMCP imports all
# 43 tools before uvicorn starts listening. 20s is generous headroom.
for _ in $(seq 1 40); do
  if ss -ltn "sport = :$PORT" 2>/dev/null | awk 'NR>1' | grep -q .; then
    break
  fi
  sleep 0.5
done

# Refuse to leave a server running unless it is bound to loopback only.
# If anything is listening on 0.0.0.0, ::, or any non-127.0.0.1 address, stop
# the service and fail loud — we'd rather have a broken digest than an open
# port to the network.
BINDS="$(ss -ltn "sport = :$PORT" 2>/dev/null | awk 'NR>1 {print $4}')"
if [[ -z "$BINDS" ]]; then
  echo "error: nothing is listening on port $PORT — the service failed to start" >&2
  echo "recent log:" >&2
  journalctl --user -u "$UNIT_NAME" -n 30 --no-pager 2>/dev/null | tail -30 >&2 || true
  tail -30 "$REPO_ROOT/logs/workspace-mcp.log" 2>/dev/null >&2 || true
  exit 1
fi

BAD_BINDS="$(echo "$BINDS" | grep -vE "^127\.0\.0\.1:$PORT\$" || true)"
if [[ -n "$BAD_BINDS" ]]; then
  echo "error: workspace-mcp is bound to a non-loopback address — stopping service" >&2
  echo "observed binds:" >&2
  echo "$BINDS" >&2
  systemctl --user stop "$UNIT_NAME" || true
  exit 1
fi

echo
echo "✓ workspace-mcp is running on $BIND_HOST:$PORT (loopback-only)"
echo
systemctl --user status "$UNIT_NAME" --no-pager 2>/dev/null | head -12 || true
