#!/bin/sh
# Pulse CG — Linux installer (systemd). Usage: sudo ./install.sh [--bind 0.0.0.0:8080] [--data-dir DIR]
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo $0 $*" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required (run 'cg-server run' under your own init system otherwise)" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX=/opt/pulse-cg

# Re-install / upgrade: stop the running service first, keep the data.
if [ -f /etc/systemd/system/pulse-cg.service ]; then
  "$PREFIX/cg-server" service uninstall >/dev/null 2>&1 || true
fi
install -d "$PREFIX"
install -m 0755 "$HERE/cg-server" "$PREFIX/cg-server"
cp "$HERE"/*.md "$HERE"/OFL.txt "$PREFIX/" 2>/dev/null || true
ln -sf "$PREFIX/cg-server" /usr/local/bin/cg-server

"$PREFIX/cg-server" service install "$@"
# Web updates (Settings > Updates) replace the program in place: let the
# service account write its own folder (and nothing else on the system).
chown -R pulse-cg:pulse-cg "$PREFIX"
echo "Logs: journalctl -u pulse-cg -f"
