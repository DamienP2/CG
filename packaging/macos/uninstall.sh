#!/bin/sh
# Removes Strata (service, menu bar app, uninstaller, command line tool).
# Data in /Library/Application Support/PulseCG is kept unless --purge.
set -u
[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo $0 $*" >&2; exit 1; }

/usr/local/pulse-cg/cg-server service uninstall 2>/dev/null || launchctl bootout system/com.pulsecg.server 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.pulsecg.server.plist

USER_ID=$(stat -f %u /dev/console 2>/dev/null || echo 0)
[ "$USER_ID" != "0" ] && launchctl bootout "gui/$USER_ID/com.pulsecg.tray" 2>/dev/null
pkill -x pulse-cg-tray 2>/dev/null
rm -f /Library/LaunchAgents/com.pulsecg.tray.plist

rm -rf "/Applications/Strata Graphics" "/Applications/Strata" "/Applications/Pulse CG" "/Applications/Pulse CG.app"
rm -f /usr/local/bin/cg-server
rm -f /etc/sudoers.d/strata-graphics
rm -rf /usr/local/pulse-cg
pkgutil --forget com.pulsecg.server >/dev/null 2>&1

if [ "${1:-}" = "--purge" ]; then
  rm -rf "/Library/Application Support/PulseCG" /Library/Logs/PulseCG
  echo "Strata and its data have been removed."
else
  echo "Strata removed. Data kept in /Library/Application Support/PulseCG."
fi
exit 0
