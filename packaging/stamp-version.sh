#!/usr/bin/env bash
# Release builds take their version from the tag (v1.2.3 → 1.2.3), so the
# binaries always report the version they are published under (the OTA
# updater compares it with the latest release).
set -euo pipefail
[ "${GITHUB_REF_TYPE:-}" = tag ] || exit 0
V=${GITHUB_REF_NAME#v}
perl -pi -e 's/^version = "[^"]*"/version = "'"$V"'"/ if $. < 10' Cargo.toml
perl -0pi -e 's/(name = "cg-[a-z-]+"\nversion = ")[^"]+/${1}'"$V"'/g' Cargo.lock
perl -pi -e 's/"version": "[^"]*"/"version": "'"$V"'"/ if $. < 6' web/package.json
perl -pi -e 's/(Extension(?:Bundle)?Version|Version)="[0-9][^"]*"/$1="'"$V"'"/g if /ExtensionManifest|Extension Id/' integrations/premiere/CSXS/manifest.xml
echo "version stamped: $V"
