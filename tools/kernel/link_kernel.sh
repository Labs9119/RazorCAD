#!/usr/bin/env bash
# Step 2 of building RazorCAD's geometry kernel: replicad's bindings plus RazorCAD's (build-config/, with
# tools/native/surface-patch.cpp) linked against the image from build_image.sh.
#   bash tools/kernel/link_kernel.sh single|multi
# Output: tools/kernel/dist/replicad_<kind>.{js,wasm} (not tracked by git). About 16 minutes each.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
kind="${1:-}"
case "$kind" in single|multi) ;; *) echo "usage: link_kernel.sh single|multi"; exit 2 ;; esac
image="${IMAGE:-razorcad/opencascade.js:v310occt-$kind}"
work="${WORK:-$HOME/razorcad-kernel}/link-$kind"
rm -rf "$work"; mkdir -p "$work"
cp -r "$HERE/build-config/." "$work/"
cp "$HERE/../native/surface-patch.cpp" "$work/wrappers/"
cd "$work"
start=$(date +%s)
docker run --rm -v "$work:/src" -u "$(id -u):$(id -g)" "$image" link "custom_build_$kind.yml" > link.log 2>&1 || { tail -60 link.log; exit 1; }
echo "linked in $(( $(date +%s) - start )) s"
out="$HERE/dist"
mkdir -p "$out"
cp "replicad_$kind.js" "replicad_$kind.wasm" "$out/"
cp link.log "$out/link-$kind.log"
sha256sum "replicad_$kind.wasm" "replicad_$kind.js"
