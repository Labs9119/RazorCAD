#!/usr/bin/env bash
# Step 1 of building RazorCAD's geometry kernel: taucad/opencascade.js v3.1.0 built from source into a Docker image of
# our own (its Dockerfile, as its CI does), with link-time optimisation and RazorCAD's two OpenCascade patches
# (occt_patches/, run by taucad's apply-patches step, so the OpenCascade libraries are compiled from patched sources).
#   bash tools/kernel/build_image.sh single|multi
# Linux (or WSL) with Docker and buildx; about 40 minutes each. Image: razorcad/opencascade.js:v310occt-<kind>.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SHA=341fa789f49ce73db76a0209d89ae518cc64a52d  # taucad/opencascade.js v3.1.0 (OpenCascade 8.0.1)
TAG=v310occt
PATCHES="patch_lab_mesh_classifier.py patch_lab_class3d_lazy.py"
kind="${1:-}"
case "$kind" in single) cfg=single-threaded ;; multi) cfg=multi-threaded ;; *) echo "usage: build_image.sh single|multi"; exit 2 ;; esac
work="${WORK:-$HOME/razorcad-kernel}"
src="$work/opencascade.js-$TAG"
if [ ! -d "$src/.git" ]; then
  rm -rf "$src"; mkdir -p "$work"; git init -q "$src"
  git -C "$src" remote add origin https://github.com/taucad/opencascade.js.git
fi
cd "$src"
if [ "$(git rev-parse HEAD 2>/dev/null || true)" != "$SHA" ]; then git fetch -q --depth 1 origin "$SHA"; git checkout -q FETCH_HEAD; fi
# (link-time optimisation on)
git checkout -q -- build-configs/configurations.json
python3 - "$cfg" <<'EOF'
import json, sys
p = 'build-configs/configurations.json'
d = json.load(open(p))
d[sys.argv[1]]['OCJS_LTO'] = '1'
json.dump(d, open(p, 'w'), indent=2)
EOF
# (RazorCAD's OpenCascade patches, after taucad's own)
git checkout -q -- build-wasm.sh
for p in $PATCHES; do
  cp "$HERE/occt_patches/$p" "src/patches/$p"
  sed -i "s|^  _ensure_standard_version_hxx\$|  echo \"  Applying RazorCAD patch $p...\"\n  \"\$OCJS_PYTHON\" src/patches/$p\n  _ensure_standard_version_hxx|" build-wasm.sh
  grep -q "src/patches/$p" build-wasm.sh || { echo "could not add $p to build-wasm.sh"; exit 1; }
done
epoch=$(git log -1 --format=%ct)
version=$(python3 -c "import json; print(json.load(open('package.json')).get('version', '0'))")
log="$work/image-$TAG-$kind.log"
start=$(date +%s)
DOCKER_BUILDKIT=1 docker buildx build --progress=plain --target "final-$kind" \
  --build-arg SOURCE_DATE_EPOCH=0 --build-arg REVISION="$SHA" --build-arg OCJS_SOURCE_DATE_EPOCH="$epoch" \
  --build-arg VERSION="$version" \
  -t "razorcad/opencascade.js:$TAG-$kind" --load . > "$log" 2>&1 \
  || { tail -60 "$log"; exit 1; }
echo "image built in $(( $(date +%s) - start )) s (log: $log)"
grep -c "Applying RazorCAD patch" "$log" | xargs echo "RazorCAD patches applied:"
