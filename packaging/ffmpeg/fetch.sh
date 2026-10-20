#!/usr/bin/env bash
# Downloads a static ffmpeg to ship with Strata: stream outputs (SRT, UDP,
# RTMP, HLS), live inputs and video conversion go through it. The server
# looks for it in bin/ next to itself (crates/cg-output/src/ffmpeg.rs).
#
# Usage: packaging/ffmpeg/fetch.sh <platform> <out-dir>
#   platform: linux-x86_64 | linux-arm64 | windows-x86_64 |
#             macos-arm64 | macos-x86_64 | macos (universal)
# Writes <out-dir>/ffmpeg (ffmpeg.exe on Windows) and its licence notice.
# FFMPEG_URL overrides the download (one archive, one architecture).
# A failed download only warns: the package is built without ffmpeg (the
# server then uses the one on the PATH).
#
# Builds used: BtbN/FFmpeg-Builds (Linux, Windows; GPL, with libx264,
# libx265, libsrt) and Martin Riedl's macOS builds (arm64 and x86_64, joined
# into one universal binary).
set -uo pipefail
PLATFORM=$1 OUT=$2
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

warn() { echo "::warning::ffmpeg not bundled: $*"; exit 0; }

BTBN=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest
RIEDL=https://ffmpeg.martin-riedl.de/redirect/latest/macos

# Downloads and unpacks an archive, prints where the ffmpeg binary is.
fetch() { # url name
  local url=$1 dir="$WORK/$2"
  mkdir -p "$dir"
  curl -fsSL --retry 3 -o "$dir/archive" "$url" || return 1
  case "$url" in
    *.zip) (cd "$dir" && unzip -q archive) || return 1 ;;
    *) tar xf "$dir/archive" -C "$dir" || return 1 ;;
  esac
  find "$dir" -type f \( -name ffmpeg -o -name ffmpeg.exe \) | head -1
}

EXE=ffmpeg
case "$PLATFORM" in
  linux-x86_64) URL=${FFMPEG_URL:-$BTBN/ffmpeg-master-latest-linux64-gpl.tar.xz} ;;
  linux-arm64) URL=${FFMPEG_URL:-$BTBN/ffmpeg-master-latest-linuxarm64-gpl.tar.xz} ;;
  windows-x86_64) URL=${FFMPEG_URL:-$BTBN/ffmpeg-master-latest-win64-gpl.zip}; EXE=ffmpeg.exe ;;
  macos-arm64) URL=${FFMPEG_URL:-$RIEDL/arm64/release/ffmpeg.zip} ;;
  macos-x86_64) URL=${FFMPEG_URL:-$RIEDL/amd64/release/ffmpeg.zip} ;;
  macos)
    ARM=$(fetch "$RIEDL/arm64/release/ffmpeg.zip" arm64) || warn "arm64 download failed"
    X86=$(fetch "$RIEDL/amd64/release/ffmpeg.zip" x86_64) || warn "x86_64 download failed"
    [ -n "$ARM" ] && [ -n "$X86" ] || warn "ffmpeg not found in the archives"
    lipo -create -output "$OUT/ffmpeg" "$ARM" "$X86" || warn "lipo failed"
    URL="$RIEDL/{arm64,amd64}/release/ffmpeg.zip"
    ;;
  *) echo "usage: $0 <linux-x86_64|linux-arm64|windows-x86_64|macos-arm64|macos-x86_64|macos> <out-dir>" >&2; exit 2 ;;
esac

if [ "$PLATFORM" != macos ]; then
  BIN=$(fetch "$URL" one) || warn "download failed ($URL)"
  [ -n "$BIN" ] || warn "ffmpeg not found in $URL"
  cp "$BIN" "$OUT/$EXE"
  # The licence that comes with the build.
  find "$(dirname "$(dirname "$BIN")")" -maxdepth 1 -iname 'LICENSE*' -type f -exec cp {} "$OUT/FFMPEG-LICENSE.txt" \; 2>/dev/null
fi
chmod 0755 "$OUT/$EXE"

cat > "$OUT/FFMPEG-NOTICE.txt" <<NOTICE
This package includes FFmpeg (https://ffmpeg.org), a separate program that
Strata runs for video streams and conversions. This build is licensed under
the GNU General Public License version 3 (it includes libx264 and libx265).
Source code: https://ffmpeg.org/download.html and the build scripts of
https://github.com/BtbN/FFmpeg-Builds (Linux, Windows) or
https://ffmpeg.martin-riedl.de (macOS).
Downloaded from: $URL
NOTICE

# What it can do (on a build machine of the same kind).
if "$OUT/$EXE" -hide_banner -version >/dev/null 2>&1; then
  "$OUT/$EXE" -hide_banner -version | head -1
  PROTOCOLS=$("$OUT/$EXE" -hide_banner -protocols 2>/dev/null)
  ENCODERS=$("$OUT/$EXE" -hide_banner -encoders 2>/dev/null)
  for p in srt rtmp; do
    grep -qw "$p" <<<"$PROTOCOLS" || echo "::warning::bundled ffmpeg has no $p protocol"
  done
  grep -qw libx264 <<<"$ENCODERS" || echo "::warning::bundled ffmpeg has no libx264 encoder"
fi
echo "ffmpeg bundled in $OUT:"
ls -la "$OUT"
