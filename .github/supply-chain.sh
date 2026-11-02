#!/usr/bin/env bash
# What an image carries, and what lets main promote it (DELIVERY-01, docs/engineering/supply-chain.md).
#
#   scan    <image@digest>           A CycloneDX SBOM of the image, then the vulnerability gate: a Critical
#                                    with a fix fails. Findings of every severity are printed.
#   release <image@digest> <tag>…    scan; attach the SBOM as a signed attestation; sign the image; verify
#                                    what was just written; and only then give the digest its tags. A
#                                    failed step leaves the digest without a tag that anything resolves.
#   verify  <image@digest>           What `promote` demands of a tree dev built: a signature by this
#                                    repository's ci.yml on dev or a hotfix branch, the SBOM attestation,
#                                    and the SLSA provenance BuildKit put in the index.
#   pins    <file>…                  Every base image of a Dockerfile and every third-party image of a
#                                    Compose file is named by digest.
#
# Keyless: the signature is a Fulcio certificate for the workflow's GitHub identity, logged in Rekor.
# It covers the index digest, so it covers the provenance inside the index; `promote` copies the
# manifest byte for byte and the digest, and with it the signature, is unchanged.
# Needs syft, grype, cosign and docker on PATH, and `docker login` to the registry.
set -euo pipefail

# The one severity that fails the gate. High is printed but does not fail: the runtime images still
# carry the base image's npm, whose Highs are not fixed by ignoring npm's findings (ClickUp Backlog).
GATE=critical
ISSUER=https://token.actions.githubusercontent.com

die() { echo "::error::supply-chain.sh: $*" >&2; exit 1; }

mode="${1:-}"
case "${mode}" in scan | release | verify | pins) ;; *) die "usage: supply-chain.sh scan|verify <image@sha256:digest> | release <image@sha256:digest> <tag>… | pins <file>…" ;; esac

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

ref="${2:-}"
[[ "${ref}" == *@sha256:* ]] || die "${ref:-an image} is not named by digest: a tag can move between the build and the signature"
digest="${ref#*@}"
repo="${ref%@*}"

sbom="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/sbom-$$.cdx.json"
trap 'rm -f "${sbom}"' EXIT

scan() {
  syft "registry:${ref}" --quiet -o "cyclonedx-json=${sbom}"
  grype "sbom:${sbom}" --quiet --only-fixed --fail-on "${GATE}" -o table
}

# Provenance is in the index as an attestation manifest, written by BuildKit; no provenance shows as {}.
has_provenance() {
  docker buildx imagetools inspect "${ref}" --format '{{json .Provenance}}' | jq -e '.SLSA.buildDefinition != null' >/dev/null ||
    die "${ref} carries no SLSA provenance: it was not built with provenance: mode=max"
}

# check_signed <certificate identity flag…>: the signature and the SBOM attestation, by that identity.
check_signed() {
  cosign verify --certificate-oidc-issuer "${ISSUER}" "$@" "${ref}" >/dev/null ||
    die "${ref} has no signature from the expected workflow"
  cosign verify-attestation --type cyclonedx --certificate-oidc-issuer "${ISSUER}" "$@" "${ref}" >/dev/null ||
    die "${ref} has no CycloneDX attestation from the expected workflow"
}

case "${mode}" in
  scan) scan ;;
  release)
    [ $# -ge 3 ] || die "release needs the tags to give ${ref}"
    scan
    cosign attest --yes --type cyclonedx --predicate "${sbom}" "${ref}"
    cosign sign --yes "${ref}"
    has_provenance
    # Exactly this job: a signature by any other workflow would pass the pattern `verify` uses.
    check_signed --certificate-identity "https://github.com/${GITHUB_WORKFLOW_REF:?GITHUB_WORKFLOW_REF unset: release runs in CI}"
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
    check_signed --certificate-identity-regexp "^https://github\.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY unset}/\.github/workflows/ci\.yml@refs/heads/(dev|hotfix/.+)\$"
    echo "verified: ${ref}"
    ;;
esac
