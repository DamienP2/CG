#!/bin/sh
# Removes the service and binaries. Data in /Library/Application Support/PulseCG is kept unless --purge.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo $0 $*" >&2; exit 1; }
/usr/local/pulse-cg/cg-server service uninstall || true
USER_ID=$(stat -f %u /dev/console 2>/dev/null || echo 0)
[ "$USER_ID" != "0" ] && launchctl bootout "gui/$USER_ID/com.pulsecg.tray" 2>/dev/null || true
rm -f /Library/LaunchAgents/com.pulsecg.tray.plist
rm -rf "/Applications/Pulse CG.app"
rm -f /usr/local/bin/cg-server
rm -rf /usr/local/pulse-cg
pkgutil --forget com.pulsecg.server >/dev/null 2>&1 || true
if [ "${1:-}" = "--purge" ]; then
  rm -rf "/Library/Application Support/PulseCG" /Library/Logs/PulseCG
fi
echo "Pulse CG removed."
