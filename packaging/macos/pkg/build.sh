#!/bin/sh
# Builds a macOS installer package from a (universal) cg-server binary.
# Usage: packaging/macos/pkg/build.sh <cg-server binary> <version> <output.pkg>
# Optional signing: MACOS_APP_IDENTITY ("Developer ID Application: …") for the
# binary and MACOS_INSTALLER_IDENTITY ("Developer ID Installer: …") for the package.
set -eu
BIN=$1 VERSION=$2 OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
WORK=$(mktemp -d)

PAYLOAD="$WORK/root/usr/local/pulse-cg"
mkdir -p "$PAYLOAD"
cp "$BIN" "$PAYLOAD/cg-server"
chmod 0755 "$PAYLOAD/cg-server"
cp "$ROOT/packaging/macos/uninstall.sh" "$ROOT/docs/INSTALL.md" "$ROOT/docs/outputs.example.json" "$ROOT/assets/fonts/OFL.txt" "$PAYLOAD/"

# Optional code signing of the binary (needed for notarization).
if [ -n "${MACOS_APP_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$MACOS_APP_IDENTITY" "$PAYLOAD/cg-server"
fi

pkgbuild --root "$WORK/root" --scripts "$HERE/scripts" \
  --identifier com.pulsecg.server --version "$VERSION" --install-location / \
  "$WORK/component.pkg"
sed "s/__VERSION__/$VERSION/" "$HERE/Distribution.xml" > "$WORK/Distribution.xml"

SIGN=""
if [ -n "${MACOS_INSTALLER_IDENTITY:-}" ]; then SIGN="--sign"; fi
productbuild --distribution "$WORK/Distribution.xml" --resources "$HERE/resources" \
  --package-path "$WORK" ${SIGN:+$SIGN "$MACOS_INSTALLER_IDENTITY"} "$OUT"
rm -rf "$WORK"
echo "built $OUT"
