#!/bin/sh
# Wraps the installer in a disk image with the Pulse CG icon on the volume
# and on the package (icons survive the download inside a .dmg, not a .zip).
# Usage: packaging/macos/pkg/make-dmg.sh <installer.pkg> <version> <output.dmg>
set -eu
PKG=$1 VERSION=$2 OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
WORK=$(mktemp -d)
trap 'hdiutil detach "$WORK/mnt" -quiet 2>/dev/null; rm -rf "$WORK"' EXIT

# Icon from the artwork.
mkdir -p "$WORK/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icons/pulse-cg-macos-1024.png" --out "$WORK/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$ROOT/assets/icons/pulse-cg-macos-1024.png" --out "$WORK/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/icon.iconset" -o "$WORK/icon.icns"

STAGE="$WORK/stage"
mkdir -p "$STAGE"
NAME="Install Pulse CG $VERSION.pkg"
cp "$PKG" "$STAGE/$NAME"
# Custom Finder icon on the package file.
osascript -l JavaScript -e "ObjC.import('AppKit'); \$.NSWorkspace.sharedWorkspace.setIconForFileOptions(\$.NSImage.alloc.initWithContentsOfFile('$WORK/icon.icns'), '$STAGE/$NAME', 0)" >/dev/null

hdiutil create -quiet -fs HFS+ -volname "Pulse CG $VERSION" -srcfolder "$STAGE" -format UDRW "$WORK/rw.dmg"
mkdir -p "$WORK/mnt"
hdiutil attach -quiet -nobrowse -noautoopen -mountpoint "$WORK/mnt" "$WORK/rw.dmg"
cp "$WORK/icon.icns" "$WORK/mnt/.VolumeIcon.icns"
SetFile -a C "$WORK/mnt" 2>/dev/null || xattr -wx com.apple.FinderInfo "0000000000000000040000000000000000000000000000000000000000000000" "$WORK/mnt"
hdiutil detach -quiet "$WORK/mnt"
rm -f "$OUT"
hdiutil convert -quiet "$WORK/rw.dmg" -format UDZO -o "$OUT"
echo "built $OUT"
