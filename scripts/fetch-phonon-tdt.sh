#!/bin/sh
# Recover or verify the three committed greedy-TDT decoder slices from the pinned upstream archive.
set -eu

case "${1:-}" in
  '') mode=install ;;
  --verify) mode=verify ;;
  *) echo "usage: $0 [--verify]" >&2; exit 2 ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dest="$root/modules/phonon-stt/ios/PhononTDT.xcframework"
revision=48af304c8db8bcc25307c206c199612f48479954
archive_sha=633e97ca8d0c54b323ade42a3001feb507c4278c7cafe899d92ab30b9fde18ff
url="https://huggingface.co/FermionResearch/Phonon-2-CoreML/resolve/$revision/phonon-coreml-src.tgz"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/phonon-tdt.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

curl --fail --location --retry 2 --max-time 120 --silent --show-error "$url" -o "$tmp/source.tgz"
printf '%s  %s\n' "$archive_sha" "$tmp/source.tgz" | shasum -a 256 --check --status || {
  echo 'upstream archive SHA-256 mismatch' >&2
  exit 1
}
tar -xzf "$tmp/source.tgz" -C "$tmp"
src="$tmp/phonon-coreml/Binaries/PhononTDT.xcframework"
[ -f "$src/Info.plist" ] || { echo 'upstream xcframework missing Info.plist' >&2; exit 1; }

while read -r slice expected; do
  file="$src/$slice/libPhononTDT.a"
  [ -f "$file" ] || { echo "missing upstream slice: $slice" >&2; exit 1; }
  printf '%s  %s\n' "$expected" "$file" | shasum -a 256 --check --status || {
    echo "upstream slice SHA-256 mismatch: $slice" >&2
    exit 1
  }
  if [ "$mode" = verify ]; then
    cmp "$file" "$dest/$slice/libPhononTDT.a" || { echo "committed slice differs: $slice" >&2; exit 1; }
  else
    mkdir -p "$dest/$slice"
    install -m 0644 "$file" "$dest/$slice/libPhononTDT.a"
  fi
done <<'SLICES'
ios-arm64 538e354b04b8479aa8a043f314ec223a1dc4b5a72565c738cbeb970afb9a6c6a
ios-arm64_x86_64-simulator 44c792f0e62ab27d7d00c366d872c24459f342562cbcab1264e7305c566c910c
macos-arm64_x86_64 22fe6f7b949a4a56b4538f418b9b6142d6488e903a79eee9ad6bd8aca62930e5
SLICES

echo "phonon-coreml decoder slices: $mode OK ($revision)"
