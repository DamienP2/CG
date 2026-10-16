#!/bin/sh
# Removes the service and binaries. Data in /Library/Application Support/PulseCG is kept unless --purge.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo $0 $*" >&2; exit 1; }
/usr/local/pulse-cg/cg-server service uninstall || true
rm -f /usr/local/bin/cg-server
rm -rf /usr/local/pulse-cg
if [ "${1:-}" = "--purge" ]; then
  rm -rf "/Library/Application Support/PulseCG" /Library/Logs/PulseCG
fi
echo "Pulse CG removed."
