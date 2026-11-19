// `yarn constraints`, run in CI.
//
// Every dependency, development dependency, peer dependency and resolution is an exact version —
// the one yarn.lock resolves — or one of this repository's own workspaces, as `workspace:*`. Never
// a range, `latest`, `*`, a tag, a git ref, a URL or a path: the manifest says what is installed,
// and the lockfile only records it. A package of ours from another repository is pinned the same
// way, so a release changes nothing here until a pull request moves the pin.

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

module.exports = {
  async constraints({ Yarn }) {
    const ours = new Set(Yarn.workspaces().map((w) => w.ident))
    for (const dep of Yarn.dependencies()) {
      if (ours.has(dep.ident)) {
        if (dep.range !== 'workspace:*') dep.error(`${dep.ident} is this repository's own workspace: depend on it as workspace:*`)
      } else if (!EXACT.test(dep.range)) {
        dep.error(`${dep.ident}@${dep.range} is not an exact version: write the version yarn.lock resolves, never a range, latest, *, a tag, a git ref, a URL or a path`)
      }
    }
    for (const workspace of Yarn.workspaces()) {
      for (const [ident, range] of Object.entries(workspace.manifest.resolutions ?? {})) {
        if (!EXACT.test(range)) workspace.error(`resolutions ${ident}@${range} is not an exact version`)
      }
    }
  },
}
