#!/usr/bin/env bash
# Publish examples/hello-trynix into the site as a binary cache.
#
# The site is served by GitHub Pages, which sends
# `access-control-allow-origin: *` on every file, so a directory of
# narinfos and NARs under site/ is a binary cache any browser may read —
# and trynix reads it like any other. That is what the shared-cache
# example in the README boots: a package that exists in no public cache,
# fetched from a static directory next to the page.
#
# Only the paths cache.nixos.org does not already hold are copied. The
# rest of the closure is one of nixpkgs' own builds, and the page falls
# back to the default substituter for those, so committing them here
# would be megabytes of duplicate bytes.
#
#   nix run .#make-example-cache -- --secret-key ~/keys/trynix-examples.key
#
# The key signs the narinfos; its public half rides in the link, which is
# the only place a reader's browser looks for it. Generate a pair with
#
#   nix key generate-secret --key-name trynix-examples-1 > key
#   nix key convert-secret-to-public < key
#
# and keep the secret out of the repository.
set -euo pipefail

UPSTREAM=https://cache.nixos.org
SITE_URL=https://trynix.dev
CACHE_PATH=site/examples/cache
DIGEST_LENGTH=32

secret_key=""
root=$(git rev-parse --show-toplevel)

while [ $# -gt 0 ]; do
  case "$1" in
    --secret-key)
      secret_key="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$secret_key" ]; then
  echo "pass --secret-key <file>; see the comment at the top of this script" >&2
  exit 2
fi

# Build the example, and take its closure in dependency order.
out=$(nix build --no-link --print-out-paths "$root/examples/hello-trynix")
closure=$(nix path-info --recursive "$out")

# The whole closure first. `nix copy` will not write one path without
# its references — a cache that names a path it cannot serve is not a
# cache — so the trimming happens afterwards, on the files.
#
# xz because the bytes are committed and served forever, and a NAR here
# is written once and read many times.
cache="$root/$CACHE_PATH"
rm -rf "$cache"
mkdir -p "$cache"
nix copy --to "file://$cache?compression=xz&secret-key=$secret_key" "$out"

# Whatever cache.nixos.org already serves is not ours to serve: ask it
# for each path, and drop the narinfo and the NAR of every one it
# already has. What is left is the package itself, and the page reaches
# the rest of the closure through the default substituter — which is
# what makes this directory 80 KB rather than 36 MB.
missing=()
for path in $closure; do
  digest=$(basename "$path" | cut -c1-"$DIGEST_LENGTH")
  narinfo="$cache/$digest.narinfo"
  if ! curl --silent --fail --head "$UPSTREAM/$digest.narinfo" > /dev/null; then
    missing+=("$path")
    continue
  fi
  nar=$(awk '/^URL: /{print $2}' "$narinfo")
  rm -f "$narinfo" "$cache/$nar"
done

# `nix copy` makes a place for build logs and realisations; neither has
# anything in it here, and an empty directory is not something git can
# carry anyway.
rmdir "$cache/log" "$cache/realisations" 2> /dev/null || true

if [ ${#missing[@]} -eq 0 ]; then
  echo "every path is already on $UPSTREAM; nothing to publish" >&2
  exit 1
fi

public_key=$(nix key convert-secret-to-public < "$secret_key")
link="$SITE_URL/?path=$out&cache=$SITE_URL/examples/cache%20$public_key"

echo
echo "published ${#missing[@]} of $(echo "$closure" | wc -l) paths to $CACHE_PATH:"
for path in "${missing[@]}"; do
  echo "  $path"
done
echo
echo "the link, once the site is deployed:"
echo "  $link"
