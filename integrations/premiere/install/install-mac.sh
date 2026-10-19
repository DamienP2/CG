#!/bin/sh
# Installs the Strata panel for Premiere Pro (current user).
# Usage: ./install/install-mac.sh   (from the unzipped folder)
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/io.pulsecg.premiere"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$HERE/CSXS" "$HERE/host" "$HERE/index.html" "$HERE/panel.js" "$HERE/panel.css" "$HERE/.debug" "$DEST/"
# The panel is not signed by Adobe Exchange: allow unsigned extensions.
for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
echo "Installed in $DEST"
echo "Restart Premiere Pro, then open Window > Extensions > Strata."
