#!/bin/sh
# Pulse CG — macOS installer (launchd). Usage: sudo ./install.sh [--bind 0.0.0.0:8080] [--data-dir DIR]
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo $0 $*" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX=/usr/local/pulse-cg

if [ -f /Library/LaunchDaemons/com.pulsecg.server.plist ]; then
  "$PREFIX/cg-server" service uninstall >/dev/null 2>&1 || true
fi
mkdir -p "$PREFIX" /usr/local/bin
cp "$HERE/cg-server" "$PREFIX/cg-server"
chmod 0755 "$PREFIX/cg-server"
cp "$HERE"/*.md "$HERE"/OFL.txt "$PREFIX/" 2>/dev/null || true
# NDI runtime shipped with the package.
if [ -d "$HERE/lib" ]; then mkdir -p "$PREFIX/lib" && cp "$HERE"/lib/* "$PREFIX/lib/"; fi
# Downloaded binaries are quarantined by Gatekeeper; the archive is not notarized yet.
xattr -dr com.apple.quarantine "$PREFIX" 2>/dev/null || true
ln -sf "$PREFIX/cg-server" /usr/local/bin/cg-server

"$PREFIX/cg-server" service install "$@"
echo "Logs: tail -f /Library/Logs/PulseCG/cg-server.log"
