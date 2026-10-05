#!/bin/bash
set -euo pipefail
umask 077
mcp_project="$(cd "$(dirname "$0")/.." && pwd)"
mcp_state="${MCP_STATE_DIR:-$mcp_project/.trial}"
mcp_bin="${TUNNEL_CLIENT_BIN:-$mcp_state/bin/tunnel-client}"
mcp_rotate=false
mcp_save=false
case "${1:-}" in
  '') ;;
  --rotate-key) mcp_rotate=true ;;
  --save-key) mcp_save=true ;;
  *) printf 'Usage: bash scripts/connect.sh [--rotate-key|--save-key]\n' >&2; exit 2 ;;
esac
mkdir -p "$mcp_state"
mcp_state="$(cd "$mcp_state" && pwd)"
mcp_secret="$mcp_state/runtime.key"
if [[ ! -x "$mcp_bin" ]]; then
  mcp_bin="$(command -v tunnel-client || true)"
fi
if [[ -z "$mcp_bin" || ! -x "$mcp_bin" ]]; then
  printf 'Install the official tunnel-client first. See SETUP.md.\n' >&2; exit 1
fi
if [[ -f "$mcp_state/tunnel-id" ]]; then
  read -r mcp_tunnel_id < "$mcp_state/tunnel-id"
else
  read -r -p 'Paste the private tunnel ID: ' mcp_tunnel_id
fi
if [[ ! "$mcp_tunnel_id" =~ ^tunnel_[a-zA-Z0-9_-]+$ ]]; then
  printf 'Invalid tunnel ID.\n' >&2; exit 1
fi
printf '%s\n' "$mcp_tunnel_id" > "$mcp_state/tunnel-id"
mcp_temp=''
trap '[[ -z "$mcp_temp" ]] || rm -f "$mcp_temp"' EXIT
if [[ ! -s "$mcp_secret" || "$mcp_rotate" == true ]]; then
  printf 'Create a runtime key at https://platform.openai.com/settings/organization/api-keys\n'
  printf 'Use Tunnels Read + Use. Select an expiration suitable for ongoing use within your organization policy.\n'
  read -r -s -p 'Paste the runtime key (hidden): ' mcp_key
  printf '\n'
  if [[ -z "$mcp_key" || "$mcp_key" == *[[:space:]]* ]]; then
    printf 'Empty keys and whitespace are not accepted. Existing key preserved.\n' >&2; exit 1
  fi
  mcp_temp="$(mktemp "$mcp_state/runtime-key.XXXXXX")"
  printf '%s' "$mcp_key" > "$mcp_temp"
  chmod 600 "$mcp_temp"
  mv -f "$mcp_temp" "$mcp_secret"
  mcp_temp=''
  unset mcp_key
else
  printf 'Reusing the saved runtime key. No new key is needed for an ordinary restart.\n'
fi
chmod 600 "$mcp_secret"
if [[ "$mcp_save" == true ]]; then
  printf 'Credential and tunnel ID saved. Install the standalone tunnel service next.\n'
  exit 0
fi
if [[ -f "$mcp_state/standalone-tunnel" ]]; then
  launchctl kickstart -k "gui/$(id -u)/local.repo-mcp.tunnel"
  # Wait for a new health URL and a successful poll, not the old process status.
  sleep 2
  node "$mcp_project/scripts/tunnel-status.mjs" --health-file "$mcp_state/standalone-tunnel-health.url"
  exit $?
fi
# The managed runtime may reuse a running process with the old credential loaded.
# Stop it explicitly so reconnect always reads the current key file.
"$mcp_bin" runtimes stop repo-mcp > "$mcp_state/stop-result.json" 2> "$mcp_state/stop-error.log" || true
# Capture upstream output privately; never echo raw credential-bearing diagnostics.
if ! "$mcp_bin" runtimes connect \
  --alias repo-mcp --profile repo-mcp \
  --profile-dir "$mcp_state/tunnel-profiles" \
  --tunnel-id "$mcp_tunnel_id" \
  --mcp-server-url "${MCP_SERVER_URL:-http://127.0.0.1:8787/mcp}" \
  --runtime-api-key "file:$mcp_secret" --json > "$mcp_state/connect-result.json" 2> "$mcp_state/connect-error.log"; then
  printf 'Connection failed; checking status for an actionable diagnosis.\n' >&2
fi
if ! "$mcp_bin" runtimes status repo-mcp --json > "$mcp_state/status-result.json" 2> "$mcp_state/status-error.log"; then
  printf 'Status command reported a failure.\n' >&2
fi
node "$mcp_project/scripts/tunnel-status.mjs" "$mcp_state/status-result.json"
