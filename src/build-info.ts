import { readFileSync } from 'node:fs'

/**
 * The build this image was made from (M-500): the Dockerfile writes `/build-info.json` from the CI
 * build args. A file rather than the environment, because anyone can set an environment variable
 * on any image; a file baked into the image cannot be configured into existence. Without one — a
 * local build — every field is `unknown`.
 */
export type BuildInfo = { sha: string; tree: string; time: string }

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/
const UNKNOWN: BuildInfo = { sha: 'unknown', tree: 'unknown', time: 'unknown' }

export function loadBuildInfo(file = '/build-info.json'): BuildInfo {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>
    if (typeof raw.sha === 'string' && GIT_OBJECT_ID.test(raw.sha) && typeof raw.tree === 'string' && GIT_OBJECT_ID.test(raw.tree)) {
      return { sha: raw.sha, tree: raw.tree, time: typeof raw.time === 'string' ? raw.time : 'unknown' }
    }
  } catch {
    // No file, or not JSON: a build CI did not make.
  }
  return UNKNOWN
}
