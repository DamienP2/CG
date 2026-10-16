#!/bin/sh
# Removes the service and binaries. Data in /var/lib/pulse-cg is kept unless --purge.
set -eu
[ "$(id -u)" -eq 0 ] || { echo "Please run as root: sudo $0 $*" >&2; exit 1; }
/opt/pulse-cg/cg-server service uninstall || true
rm -f /usr/local/bin/cg-server
rm -rf /opt/pulse-cg
if [ "${1:-}" = "--purge" ]; then
  rm -rf /var/lib/pulse-cg
  userdel pulse-cg 2>/dev/null || true
fi
echo "Pulse CG removed."
