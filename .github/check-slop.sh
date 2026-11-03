#!/usr/bin/env bash
# Refuses a backlog key, a decision id or a ClickUp id in code, comments and documents: rule T1 of
# AGENTS.md § "No slop". The other rules are a reviewer's; no script can judge them.
#
#   check-slop.sh [--base <rev>]  the lines added since <rev> (default: the merge base with origin/dev)
#   check-slop.sh --all           every line of the tree
#   check-slop.sh --self-test     this script against throwaway repositories
#
# Diff mode lets a repository adopt the check before its old citations are gone. In CI the checkout of
# a pull request is the merge commit, so the base is its first parent: --base HEAD^1.
set -euo pipefail

# Per repository. roots limits the check to those paths (empty: the whole tree); repo_excludes adds
# pathspecs for files this repository's own generators write.
roots=()
repo_excludes=()

# A set locale changes what [A-Za-z] matches, and a pathspec setting in the environment changes what
# the excludes below mean.
unset CDPATH GREP_OPTIONS GIT_LITERAL_PATHSPECS GIT_NOGLOB_PATHSPECS
export LC_ALL=C

ids='(M-[0-9]{2,}[a-z]?|TASK-[0-9]+|(ALERT|CLOUD|COMPLIANCE|DATA|DELIVERY|ENG|FE|HIST|OBS|REPO|REPORT|SCALE|SDK|SEC|TRADE)-[0-9]{2}|D-[0-9]{2}|124jd[a-z0-9]{3,})'
tab=$'\t'
# \b is not portable to BSD grep. The second form reads the diff's path<TAB>line<TAB>text lines and
# matches the text only, so an identifier in a path is not a hit.
pattern="(^|[^A-Za-z0-9_])${ids}([^A-Za-z0-9_]|\$)"
diff_pattern="^[^${tab}]*${tab}[0-9]+${tab}(.*[^A-Za-z0-9_])?${ids}([^A-Za-z0-9_]|\$)"

die() { echo "check-slop: $*" >&2; exit 2; }
usage() { die "usage: check-slop.sh [--base <rev>] | --all | --self-test"; }

build_specs() {
  local glob
  if [[ ${#roots[@]} -eq 0 ]]; then specs=(.); else specs=("${roots[@]}"); fi
  for glob in \
    '**/*.lock' '**/package-lock.json' '**/pnpm-lock.yaml' \
    '**/CHANGELOG.md' '**/ROLLOUT.md' 'rollout/**' \
    '**/*_pb.ts' '**/*_pb.js' '**/*_pb.d.ts' '**/*_pb2.py' '**/*_pb2.pyi' '**/api-schema.d.ts' \
    'openapi/**' 'compat/baseline/**' '**/drizzle/meta/**'; do
    specs+=(":(exclude,glob)${glob}")
  done
  # The script's own fixtures cite identifiers.
  specs+=(':(exclude).github/check-slop.sh')
  # bash 3.2 and 4.3 abort on "${a[@]}" under set -u when a is empty.
  for glob in ${repo_excludes[@]+"${repo_excludes[@]}"}; do
    specs+=("$glob")
  done
}

# Prints path<TAB>line<TAB>text for every added line of a zero-context diff. A line that starts with
# "+++ " is a file header only outside a hunk: an added line whose text begins "++ " reads the same.
parse_diff() {
  awk '
    function first(s, t) { t = s; sub(/^[+-]/, "", t); sub(/,.*/, "", t); return t + 0 }
    function count(s, t) {
      t = s; sub(/^[+-]/, "", t)
      if (index(t, ",") == 0) return 1
      sub(/.*,/, "", t)
      return t + 0
    }
    BEGIN { old_left = 0; new_left = 0 }
    old_left == 0 && new_left == 0 {
      if (substr($0, 1, 6) == "+++ b/") { path = substr($0, 7); sub(/\t$/, "", path) }
      else if ($1 == "@@") { old_left = count($2); line = first($3); new_left = count($3) }
      next
    }
    {
      kind = substr($0, 1, 1)
      if (kind == "+") { printf "%s\t%d\t%s\n", path, line, substr($0, 2); line++; new_left-- }
      else if (kind == "-") old_left--
    }
  '
}

report() {
  local hits=$1
  printf '%s\n' "$hits" | sed -E "s/^([^${tab}:]*)[${tab}:]([0-9]+)[${tab}:](.{0,160}).*\$/\1:\2: T1 \3/" >&2
  cat >&2 <<'EOF'

T1: a line cites a backlog key, a decision id or a ClickUp id. Those mean nothing to a reader outside
the tracker. Write the reason in a plain sentence; history belongs to git and the pull request.
EOF
  exit 1
}

check_diff() {
  local diff added hits counts st=0
  if [[ -z $base ]]; then
    base=$(git merge-base HEAD origin/dev 2>&1) || die "cannot resolve the base: $base (pass --base <rev>)"
  fi
  # Each step is captured before it is read: a failing git must not look like an empty diff.
  diff=$(git -c core.quotepath=off diff -U0 --no-color --no-ext-diff --no-textconv -M --diff-filter=ACMR \
    --src-prefix=a/ --dst-prefix=b/ "$base" -- "${specs[@]}") || die "git diff against '$base' failed"
  added=$(printf '%s\n' "$diff" | parse_diff) || die "cannot read the diff"
  hits=$(printf '%s\n' "$added" | grep -E -e "$diff_pattern") || st=$?
  [[ $st -le 1 ]] || die "grep failed"
  [[ $st -eq 1 ]] || report "$hits"
  counts=$(printf '%s' "$added" | awk -F'\t' 'NF { n++; files[$1] = 1 } END { f = 0; for (p in files) f++; print n + 0, f }') \
    || die "cannot count the added lines"
  echo "check-slop: no tracker identifier in ${counts% *} added lines of ${counts#* } files"
}

check_all() {
  local hits files st=0
  hits=$(git grep -nIE -e "$pattern" -- "${specs[@]}") || st=$?
  [[ $st -le 1 ]] || die "git grep failed"
  [[ $st -eq 1 ]] || report "$hits"
  files=$(git -c core.quotepath=off ls-files -- "${specs[@]}")
  echo "check-slop: no tracker identifier in $(printf '%s' "$files" | grep -c '') files"
}

self_test() {
  local self out st cases=0 case_fn d=${roots[0]:-src}
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/check-slop.XXXXXX")
  # tmp stays global: the trap runs after this function has returned.
  trap 'rm -rf "$tmp"' EXIT
  # The user's git configuration must not change what a case sees.
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1

  git_() { command git "$@" || die "self-test: git $* failed"; }
  commit() { git_ -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q "$@"; }
  # The identifiers are assembled so that this file does not cite one itself.
  ident() { printf '%s-%s' "$1" "$2"; }
  clickup_id() { printf '%s%s' 124jd "$1"; }
  fresh_repo() {
    cd "$tmp" && rm -rf repo && mkdir repo && cd repo
    git_ init -q
    git_ symbolic-ref HEAD refs/heads/master
    commit --allow-empty -m base
  }
  run() { st=0; out=$("$self" "$@" 2>&1) || st=$?; }
  fail() { echo "check-slop self-test: $1" >&2; printf '%s\n' "$out" >&2; exit 1; }
  expect_pass() {
    [[ $st -eq 0 ]] || fail "$1: exit $st"
    case $out in *"T1: "*) fail "$1: unexpected hit" ;; esac
  }
  expect_hit() {
    [[ $st -eq 1 ]] || fail "$1: exit $st"
    case $out in *"$2: T1 "*) ;; *) fail "$1: no hit at $2" ;; esac
  }

  case_added_line() {
    fresh_repo; mkdir -p "$d"
    printf 'x\n// %s\n' "$(ident M 12)" > "$d/a.ts"
    git_ add "$d" && commit -m a
    run --base HEAD~1; expect_hit "an added citation" "$d/a.ts:2"
  }
  case_excluded_paths() {
    fresh_repo; mkdir -p rollout "$d"
    for f in rollout/x.md "$d/CHANGELOG.md" "$d/yarn.lock" "$d/x_pb.ts"; do
      printf 'x\n// %s\n' "$(ident M 12)" > "$f"
    done
    git_ add . && commit -m a
    run --base HEAD~1; expect_pass "excluded paths"
  }
  case_old_citations() {
    fresh_repo; mkdir -p "$d"
    printf '// %s\nkeep\n' "$(ident M 12)" > "$d/removed.ts"
    printf 'a\n// %s\nb\n' "$(ident M 12)" > "$d/kept.ts"
    git_ add "$d" && commit -m a
    printf 'keep\n' > "$d/removed.ts"
    printf 'a\n// %s\nb\nclean\n' "$(ident M 12)" > "$d/kept.ts"
    git_ add "$d" && commit -m b
    run --base HEAD~1; expect_pass "a removed citation, and an old one left in a file that gained a clean line"
  }
  case_each_form() {
    fresh_repo; mkdir -p "$d"
    {
      printf '// %s\n' "$(ident M 12a)" "$(ident TASK 3)" "$(ident ENG 17)" "$(ident D 17)" "$(clickup_id ab3)"
      printf '%s\n' '// ABCD-33' '// SHA-256' '// M-5' '// ENG-1' '// D-333'
    } > "$d/ids.ts"
    git_ add "$d" && commit -m a
    run --base HEAD~1
    [[ $st -eq 1 ]] || fail "each form: exit $st"
    for n in 1 2 3 4 5; do
      case $out in *"${d}/ids.ts:$n: T1 "*) ;; *) fail "each form: line $n is not a hit" ;; esac
    done
    for n in 6 7 8 9 10; do
      case $out in *"${d}/ids.ts:$n: T1 "*) fail "each form: line $n is a hit" ;; esac
    done
  }
  case_plus_prefix() {
    fresh_repo; mkdir -p "$d"
    printf '++ // %s\n' "$(ident M 12)" > "$d/plus.ts"
    git_ add "$d" && commit -m a
    run --base HEAD~1; expect_hit "an added line that reads like a file header" "$d/plus.ts:1"
  }
  case_rename() {
    fresh_repo; mkdir -p "$d"
    printf '// %s\n' "$(ident M 12)" > "$d/old.ts"
    git_ add "$d" && commit -m a
    git_ mv "$d/old.ts" "$d/new.ts" && commit -m rename
    run --base HEAD~1; expect_pass "a rename"
  }
  merge_commit_with() {
    fresh_repo; mkdir -p "$d"
    printf 'clean\n' > "$d/a.ts"
    git_ add "$d" && commit -m a
    git_ checkout -q -b feature
    printf 'clean\n%s\n' "$1" > "$d/a.ts"
    git_ add "$d" && commit -m feature
    git_ checkout -q master
    git_ -c user.name=t -c user.email=t@t -c commit.gpgsign=false merge --no-ff -q -m merge feature
    run --base 'HEAD^1'
  }
  case_merge_commit() {
    merge_commit_with "// $(ident M 12)"; expect_hit "a pull request's merge commit" "$d/a.ts:2"
    merge_commit_with 'cleaner'; expect_pass "a clean pull request's merge commit"
  }
  case_unknown_base() {
    fresh_repo
    run --base no-such-revision
    [[ $st -eq 2 && -n $out ]] || fail "an unknown base: exit $st"
  }
  case_all() {
    fresh_repo; mkdir -p "$d"
    printf '// %s\n' "$(ident M 12)" > "$d/a.ts"
    git_ add "$d" && commit -m a
    run --all; expect_hit "--all on a citation" "$d/a.ts:1"
    fresh_repo; mkdir -p "$d"
    printf 'clean\n' > "$d/a.ts"
    git_ add "$d" && commit -m a
    run --all; expect_pass "--all on a clean tree"
    fresh_repo; mkdir -p "$d"
    printf '// %s\n' "$(ident M 12)" > "$d/CHANGELOG.md"
    git_ add "$d" && commit -m a
    run --all; expect_pass "--all on an excluded file"
    fresh_repo; mkdir -p "$d"
    printf '// ABCD-33\n// SHA-256\n// M-5\n// ENG-1\n// D-333\n' > "$d/a.ts"
    git_ add "$d" && commit -m a
    run --all; expect_pass "--all on text that only looks like an identifier"
  }
  case_path_is_not_text() {
    fresh_repo; mkdir -p "$d"
    printf 'clean\n' > "${d}/$(ident ENG 17)-notes.ts"
    git_ add "$d" && commit -m a
    run --base HEAD~1; expect_pass "an identifier in a path, in diff mode"
    run --all; expect_pass "an identifier in a path, with --all"
  }
  case_git_failure() {
    fresh_repo; mkdir -p "$d"
    printf 'clean\n' > "$d/a.ts"
    git_ add "$d" && commit -m a
    printf 'not an index' > .git/index
    run --all
    [[ $st -eq 2 ]] || fail "a git that fails, with --all: exit $st"
    run --base HEAD~1
    [[ $st -eq 2 ]] || fail "a git that fails, in diff mode: exit $st"
  }

  for case_fn in case_added_line case_excluded_paths case_old_citations case_each_form case_plus_prefix \
    case_rename case_merge_commit case_unknown_base case_all case_path_is_not_text case_git_failure; do
    "$case_fn"
    cases=$((cases + 1))
  done
  echo "check-slop self-test: $cases cases passed"
}

mode=diff
base=
while [[ $# -gt 0 ]]; do
  case $1 in
    --all) mode=all; shift ;;
    --self-test) mode=self-test; shift ;;
    --base) [[ $# -ge 2 && -n $2 ]] || usage; base=$2; shift 2 ;;
    *) usage ;;
  esac
done
[[ $mode == diff || -z $base ]] || usage

if [[ $mode == self-test ]]; then
  self_test
  exit 0
fi
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "not a git work tree"
cd "$top"
build_specs
if [[ $mode == all ]]; then check_all; else check_diff; fi
