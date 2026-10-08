#!/usr/bin/env bash
# Promote the image dev built for this tree (M-351). main never builds: it finds
# `<package>:tree-<tree>` and gives that exact manifest the tags `:latest` — what the pilot
# pulls — and `:sha-<sha>`, this commit. The manifest is copied byte for byte through the
# registry API, so the digest is the one dev pushed and the promotion's e2e ran.
# `docker buildx imagetools create` would wrap a single manifest in a new index, with a new
# digest — measured against a local registry, which is why this is not a one-liner.
#
# Usage: promote-image.sh <package> <tree> <sha>
# Env:   GHCR_USER, GHCR_TOKEN — write on the package (the job's own GITHUB_TOKEN).
set -euo pipefail

package="$1" tree="$2" sha="$3"
repo="quadrantcapital/${package}"
api="https://ghcr.io/v2/${repo}/manifests"
accept='application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json'
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

header() { tr -d '\r' <"${work}/$1" | awk -v k="$2" 'BEGIN { FS = ": " } tolower($1) == k { print $2 }'; }

token="$(curl -fsS -u "${GHCR_USER}:${GHCR_TOKEN}" "https://ghcr.io/token?scope=repository:${repo}:pull,push" | jq -r .token)"

code="$(curl -sS -o "${work}/manifest" -D "${work}/source" -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" -H "Accept: ${accept}" "${api}/tree-${tree}")"
if [ "${code}" = 404 ]; then
  echo "::error::no artifact for this tree: ghcr.io/${repo}:tree-${tree} does not exist. main never builds — promote from dev, whose every push builds its tree, or build a hotfix on its hotfix/* branch first."
  exit 1
fi
if [ "${code}" != 200 ]; then
  echo "::error::ghcr.io answered ${code} for ${repo}:tree-${tree}"
  exit 1
fi
digest="$(header source docker-content-digest)"
type="$(header source content-type)"

for tag in latest "sha-${sha}"; do
  curl -fsS -X PUT -H "Authorization: Bearer ${token}" -H "Content-Type: ${type}" \
    --data-binary "@${work}/manifest" "${api}/${tag}" >/dev/null
done

curl -fsS -I -o /dev/null -D "${work}/moved" \
  -H "Authorization: Bearer ${token}" -H "Accept: ${accept}" "${api}/latest"
moved="$(header moved docker-content-digest)"
if [ "${moved}" != "${digest}" ]; then
  echo "::error::ghcr.io/${repo}:latest is ${moved} after the copy, not ${digest}"
  exit 1
fi
echo "ghcr.io/${repo}:latest and :sha-${sha} -> ${digest} (tree ${tree}; the dev build, not rebuilt)"
