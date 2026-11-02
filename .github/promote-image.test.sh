#!/usr/bin/env bash
# promote-image.sh against a shim of curl and a stand-in for supply-chain.sh: a tree is promoted only
# once the manifest being copied has verified, and only that manifest is written.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
mkdir -p "${work}/bin" "${work}/.github"
cp "${here}/promote-image.sh" "${work}/.github/promote-image.sh"

# The stand-in records what it was asked to verify and answers as FAKE_VERIFY says.
cat >"${work}/.github/supply-chain.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"${FAKE_DIR}/verified"
[ "${FAKE_VERIFY:-0}" = 0 ]
STUB

# ghcr.io: a token, a manifest for `tree-*` (404 when FAKE_NO_TREE is set), a write for any other tag,
# and the digest a tag resolves to once written.
cat >"${work}/bin/curl" <<'SHIM'
#!/usr/bin/env bash
out="" hdr="" method=GET url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -D) hdr="$2"; shift ;;
    -X) method="$2"; shift ;;
    -I) method=HEAD ;;
    -H | -u | -w | --data-binary) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
digest="sha256:$(printf 'b%.0s' {1..64})"
case "${url}" in
  */token*) echo '{"token":"t"}' ;;
  */manifests/tree-*)
    if [ -n "${FAKE_NO_TREE:-}" ]; then
      [ -z "${out}" ] || : >"${out}"
      echo 404
    else
      echo '{"manifests":[]}' >"${out}"
      printf 'HTTP/2 200\r\ncontent-type: application/vnd.oci.image.index.v1+json\r\ndocker-content-digest: %s\r\n' "${digest}" >"${hdr}"
      echo 200
    fi ;;
  */manifests/*)
    if [ "${method}" = PUT ]; then
      echo "${url##*/}" >>"${FAKE_DIR}/written"
    else
      [ -z "${out}" ] || : >"${out}"
      printf 'HTTP/2 200\r\ndocker-content-digest: %s\r\n' "${digest}" >"${hdr}"
    fi ;;
esac
SHIM
chmod +x "${work}/bin/curl" "${work}/.github/supply-chain.sh"

export PATH="${work}/bin:${PATH}" FAKE_DIR="${work}" GHCR_USER=u GHCR_TOKEN=t
digest="sha256:$(printf 'b%.0s' {1..64})"

failures=0
code=0
run() { # run <VAR=value…> --
  rm -f "${work}/verified" "${work}/written"
  local envs=()
  while [ "$1" != -- ]; do envs+=("$1"); shift; done
  code=0
  env ${envs[@]+"${envs[@]}"} "${work}/.github/promote-image.sh" control-api treehash commithash >"${work}/out" 2>&1 || code=$?
}
check() { # check <name> <command…>
  local name="$1"
  shift
  if "$@"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}"
    sed 's/^/     | /' "${work}/out"
    failures=$((failures + 1))
  fi
}
succeeded() { [ "${code}" = 0 ]; }
failed() { [ "${code}" != 0 ]; }
wrote_both_tags() { grep -qx latest "${work}/written" && grep -qx sha-commithash "${work}/written"; }
wrote_nothing() { [ ! -e "${work}/written" ]; }
verified_the_manifest_in_hand() { grep -qx "verify ghcr.io/quadrantcapital/control-api@${digest}" "${work}/verified"; }
verified_nothing() { [ ! -e "${work}/verified" ]; }

run --
check "a tree that verifies is promoted" succeeded
check "  to :latest and :sha-<commit>" wrote_both_tags
check "  after verifying the digest it copies, not the tag" verified_the_manifest_in_hand

run FAKE_VERIFY=1 --
check "a tree that does not verify fails" failed
check "  and writes no tag" wrote_nothing

run FAKE_NO_TREE=1 --
check "a tree dev never built still fails \"no artifact for this tree\"" failed
check "  without verifying anything" verified_nothing
check "  and writes no tag" wrote_nothing

[ "${failures}" = 0 ] || { echo "${failures} failed"; exit 1; }
echo "promote-image.test.sh: all passed"
