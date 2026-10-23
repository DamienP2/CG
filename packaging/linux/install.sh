#!/bin/sh
# Strata Graphics — Linux installer (systemd). Usage: sudo ./install.sh [--bind 0.0.0.0:8080] [--data-dir DIR]
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo $0 $*" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required (run 'strata-server run' under your own init system otherwise)" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX=/opt/strata

# Re-install / upgrade: stop the running service first, keep the data.
if [ -f /etc/systemd/system/strata-graphics.service ]; then
  "$PREFIX/strata-server" service uninstall >/dev/null 2>&1 || true
fi
# An install from before the rename (Pulse CG): stop it; the service
# install below moves its data and removes its service account.
if [ -f /etc/systemd/system/pulse-cg.service ]; then
  systemctl stop pulse-cg 2>/dev/null || true
fi
install -d "$PREFIX"
install -m 0755 "$HERE/strata-server" "$PREFIX/strata-server"
cp "$HERE"/*.md "$HERE"/OFL.txt "$PREFIX/" 2>/dev/null || true
# ffmpeg shipped with the package (streams, inputs, video conversion).
if [ -d "$HERE/bin" ]; then install -d "$PREFIX/bin" && cp "$HERE"/bin/* "$PREFIX/bin/" && chmod 0755 "$PREFIX/bin/ffmpeg"; fi
ln -sf "$PREFIX/strata-server" /usr/local/bin/strata-server

"$PREFIX/strata-server" service install "$@"
rm -rf /opt/pulse-cg
rm -f /usr/local/bin/cg-server
# Web updates (Settings > Updates) replace the program in place: let the
# service account write its own folder (and nothing else on the system).
chown -R strata:strata "$PREFIX"
echo "Logs: journalctl -u strata-graphics -f"
