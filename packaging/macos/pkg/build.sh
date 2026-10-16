#!/bin/sh
# Builds a macOS installer package from a (universal) cg-server binary.
# Usage: packaging/macos/pkg/build.sh <cg-server binary> <pulse-cg-tray binary> <version> <output.pkg>
# Optional signing: MACOS_APP_IDENTITY ("Developer ID Application: …") for the
# binary and MACOS_INSTALLER_IDENTITY ("Developer ID Installer: …") for the package.
set -eu
BIN=$1 TRAY=$2 VERSION=$3 OUT=$4
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
WORK=$(mktemp -d)

PAYLOAD="$WORK/root/usr/local/pulse-cg"
mkdir -p "$PAYLOAD"
cp "$BIN" "$PAYLOAD/cg-server"
chmod 0755 "$PAYLOAD/cg-server"
cp "$ROOT/packaging/macos/uninstall.sh" "$ROOT/docs/INSTALL.md" "$ROOT/docs/outputs.example.json" "$ROOT/assets/fonts/OFL.txt" "$PAYLOAD/"

# Menu bar app bundle.
APP="$WORK/root/Applications/Pulse CG.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$TRAY" "$APP/Contents/MacOS/pulse-cg-tray"
chmod 0755 "$APP/Contents/MacOS/pulse-cg-tray"
cp "$ROOT/assets/icons/pulse-cg.icns" "$APP/Contents/Resources/AppIcon.icns"
sed "s/__VERSION__/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
mkdir -p "$WORK/root/Library/LaunchAgents"
cp "$HERE/com.pulsecg.tray.plist" "$WORK/root/Library/LaunchAgents/"

# Optional code signing (needed for notarization).
if [ -n "${MACOS_APP_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$MACOS_APP_IDENTITY" "$PAYLOAD/cg-server"
  codesign --force --options runtime --timestamp --sign "$MACOS_APP_IDENTITY" "$APP"
fi

# Always install the app in /Applications, even if a copy exists elsewhere.
pkgbuild --analyze --root "$WORK/root" "$WORK/component.plist"
/usr/libexec/PlistBuddy -c "Set :0:BundleIsRelocatable false" "$WORK/component.plist"

pkgbuild --root "$WORK/root" --component-plist "$WORK/component.plist" --scripts "$HERE/scripts" \
  --identifier com.pulsecg.server --version "$VERSION" --install-location / \
  "$WORK/component.pkg"
sed "s/__VERSION__/$VERSION/" "$HERE/Distribution.xml" > "$WORK/Distribution.xml"

SIGN=""
if [ -n "${MACOS_INSTALLER_IDENTITY:-}" ]; then SIGN="--sign"; fi
productbuild --distribution "$WORK/Distribution.xml" --resources "$HERE/resources" \
  --package-path "$WORK" ${SIGN:+$SIGN "$MACOS_INSTALLER_IDENTITY"} "$OUT"
rm -rf "$WORK"
echo "built $OUT"
