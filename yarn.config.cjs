// `yarn constraints`, run in CI (M-701c, DELIVERY-01).
//
// Every dependency resolves to a version: a semver version or range, or one of this repository's own
// workspaces. Never `latest`, `*`, a tag, a git ref, a URL or a path — the lockfile would be the only
// thing between a build and whatever those name today. And a package of ours from another repository
// is pinned exactly, so a release changes nothing here until a pull request moves the pin.

const VERSION = /^[\^~]?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

module.exports = {
  async constraints({ Yarn }) {
    const ours = new Set(Yarn.workspaces().map((w) => w.ident))
    for (const dep of Yarn.dependencies()) {
      if (ours.has(dep.ident)) {
        if (!dep.range.startsWith('workspace:')) dep.error(`${dep.ident} is this repository's own workspace: depend on it as workspace:^`)
      } else if (!VERSION.test(dep.range)) {
        dep.error(`${dep.ident}@${dep.range} does not resolve to a version: a semver version or range only, never latest, *, a tag, a git ref, a URL or a path`)
      } else if (dep.ident.startsWith('@quadrantcapital/') && !EXACT.test(dep.range)) {
        dep.error(`${dep.ident}@${dep.range} is another repository's package: pin it exactly`)
      }
    }
  },
}
