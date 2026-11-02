#!/usr/bin/env bash
# What an image carries, and what lets main promote it (DELIVERY-01, docs/engineering/supply-chain.md).
#
#   scan    <image@digest>           A CycloneDX SBOM of the image, then the vulnerability gate: a Critical
#                                    with a fix fails. Findings of every severity are printed.
#   release <image@digest> <tag>…    scan; attach the SBOM as a signed attestation; sign the image; verify
#                                    what was just written; and only then give the digest its tags. A
#                                    failed step leaves the digest without a tag that anything resolves.
#   verify  <image@digest>           What `promote` demands of a tree dev built: a signature and the SBOM
#                                    attestation by this repository's key (.github/cosign.pub), and the
#                                    SLSA provenance BuildKit put in the index.
#   pins    <file>…                  Every base image of a Dockerfile and every third-party image of a
#                                    Compose file is named by digest.
#   no-oidc <dir>…                   No workflow in the directories asks for an OIDC token or runs a
#                                    keyless signing action: nothing could sign without the key.
#
# Signed with this repository's own cosign key (owner, 2026-11-02): the private key and its password are
# secrets of the `signing` environment, open to dev and hotfix/* only, and only the job that calls
# `release` reads them. The public key is cosign.pub next to this script. Nothing reaches a public
# transparency log: cosign is given an empty signing config (no Fulcio, Rekor or timestamp service), and
# without one, `--key` would fetch Sigstore's public-good config and log the signature in Rekor.
# The signature covers the index digest, so it covers the provenance inside the index; `promote` copies
# the manifest byte for byte and the digest, and with it the signature, is unchanged.
# Needs syft, grype, cosign and docker on PATH, and `docker login` to the registry.
set -euo pipefail

# The one severity that fails the gate. High is printed but does not fail: the runtime images still
# carry the base image's npm, whose Highs are not fixed by ignoring npm's findings (ClickUp Backlog).
GATE=critical
PUBKEY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cosign.pub"

die() { echo "::error::supply-chain.sh: $*" >&2; exit 1; }

mode="${1:-}"
case "${mode}" in scan | release | verify | pins | no-oidc) ;; *) die "usage: supply-chain.sh scan|verify <image@sha256:digest> | release <image@sha256:digest> <tag>… | pins <file>… | no-oidc <dir>…" ;; esac

# images_of <file>: the images a Dockerfile builds on, or a Compose file runs. A reference with `${…}`
# is a first-party tag `promote` writes; a stage alias and `scratch` name no registry image.
images_of() {
  if [[ "$1" == *Dockerfile* ]]; then
    awk 'toupper($1) == "FROM" {
      for (i = 2; i <= NF; i++) if ($i !~ /^--/) { if ($i != "scratch" && !($i in stage)) print $i; break }
      for (i = 2; i < NF; i++) if (toupper($i) == "AS") stage[$(i + 1)] = 1
    }' "$1"
  else
    sed -n 's/^[[:space:]]*image:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$1"
  fi
}

# pins: no image a build or a deploy resolves can change under the same file.
if [ "${mode}" = pins ]; then
  shift
  [ $# -gt 0 ] || die "pins needs the files to check"
  status=0
  for file in "$@"; do
    while IFS= read -r image; do
      # shellcheck disable=SC2016 # a literal `${` is how Compose writes a variable
      [[ "${image}" == *'${'* || "${image}" == *@sha256:* || "${image}" == qvantera-e2e:ci ]] && continue
      echo "::error file=${file}::${image} is not named by digest: image@sha256:…" >&2
      status=1
    done < <(images_of "${file}")
  done
  exit "${status}"
fi

# no-oidc: a workflow that can get an OIDC token can sign keyless, and keyless signing logs in a public
# transparency log. The bracketed letters keep this file out of its own search.
if [ "${mode}" = no-oidc ]; then
  shift
  [ $# -gt 0 ] || die "no-oidc needs the workflow directories to check"
  if grep -rnE --include='*.yml' --include='*.yaml' 'id-toke[n]|attest-build-provenanc[e]|gh-action-sigstor[e]' "$@"; then
    die "a workflow asks for an OIDC token or runs a keyless signing action (the lines above): signing is by the repository's key only"
  fi
  exit 0
fi

ref="${2:-}"
[[ "${ref}" == *@sha256:* ]] || die "${ref:-an image} is not named by digest: a tag can move between the build and the signature"
digest="${ref#*@}"
repo="${ref%@*}"

tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
sbom="${tmp}/sbom-$$.cdx.json"
nolog="${tmp}/signing-config-$$.json"
trap 'rm -f "${sbom}" "${nolog}"' EXIT

scan() {
  syft "registry:${ref}" --quiet -o "cyclonedx-json=${sbom}"
  grype "sbom:${sbom}" --quiet --only-fixed --fail-on "${GATE}" -o table
}

# Provenance is in the index as an attestation manifest, written by BuildKit; no provenance shows as {}.
has_provenance() {
  docker buildx imagetools inspect "${ref}" --format '{{json .Provenance}}' | jq -e '.SLSA.buildDefinition != null' >/dev/null ||
    die "${ref} carries no SLSA provenance: it was not built with provenance: mode=max"
}

# check_signed: the signature and the SBOM attestation, by the key committed next to this script. There
# is no log entry to look up, so the log check is off.
check_signed() {
  [ -s "${PUBKEY}" ] || die "no public key at ${PUBKEY}"
  cosign verify --key "${PUBKEY}" --insecure-ignore-tlog=true "${ref}" >/dev/null ||
    die "${ref} has no signature by this repository's key"
  cosign verify-attestation --key "${PUBKEY}" --insecure-ignore-tlog=true --type cyclonedx "${ref}" >/dev/null ||
    die "${ref} has no CycloneDX attestation by this repository's key"
}

case "${mode}" in
  scan) scan ;;
  release)
    [ $# -ge 3 ] || die "release needs the tags to give ${ref}"
    [ -n "${COSIGN_PRIVATE_KEY:-}" ] || die "COSIGN_PRIVATE_KEY is unset: release runs in the job that holds the signing environment"
    [ -n "${COSIGN_PASSWORD:-}" ] || die "COSIGN_PASSWORD is unset: the key is encrypted"
    scan
    cosign signing-config create --out "${nolog}"
    sign_with=(--yes --key env://COSIGN_PRIVATE_KEY --signing-config "${nolog}")
    cosign attest "${sign_with[@]}" --type cyclonedx --predicate "${sbom}" "${ref}"
    cosign sign "${sign_with[@]}" "${ref}"
    has_provenance
    # Against the committed public key: a secret from another repository, or a rotation that did not
    # commit the new key, fails here and nothing is tagged.
    check_signed
    # The index is copied as it is, so the new tag is the digest that was signed (an index source keeps
    # its digest; `imagetools create` re-wraps only a single manifest). Anything else is refused.
    for tag in "${@:3}"; do
      docker buildx imagetools create --tag "${repo}:${tag}" "${ref}"
      moved="$(docker buildx imagetools inspect "${repo}:${tag}" --format '{{json .Manifest}}' | jq -r .digest)"
      [ "${moved}" = "${digest}" ] || die "${repo}:${tag} is ${moved} after the copy, not ${digest}"
    done
    echo "signed, verified and tagged ${*:3}: ${ref}"
    ;;
  verify)
    has_provenance
    check_signed
    echo "verified: ${ref}"
    ;;
esac
