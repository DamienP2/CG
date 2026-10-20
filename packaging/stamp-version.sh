#!/usr/bin/env bash
# Release builds take their version from the tag (v1.2.3 → 1.2.3), so the
# binaries always report the version they are published under (the OTA
# updater compares it with the latest release).
set -euo pipefail
[ "${GITHUB_REF_TYPE:-}" = tag ] || exit 0
V=${GITHUB_REF_NAME#v}
perl -pi -e 's/^version = "[^"]*"/version = "'"$V"'"/ if $. < 10' Cargo.toml
perl -0pi -e 's/(name = "cg-[a-z-]+"\r?\nversion = ")[^"]+/${1}'"$V"'/g' Cargo.lock
perl -pi -e 's/"version": "[^"]*"/"version": "'"$V"'"/ if $. < 6' web/package.json
# Premiere panel: the bundle and extension versions only. The manifest's own
# Version is the CEP schema (9.0): Premiere rejects the panel if it changes.
M=integrations/premiere/CSXS/manifest.xml
perl -pi -e 's/ExtensionBundleVersion="[^"]*"/ExtensionBundleVersion="'"$V"'"/' "$M"
perl -pi -e 's/(<Extension Id="[^"]*" Version=)"[^"]*"/$1"'"$V"'"/' "$M"
grep -q '<ExtensionManifest Version="9.0"' "$M" || { echo "manifest schema version changed" >&2; exit 1; }
echo "version stamped: $V"
