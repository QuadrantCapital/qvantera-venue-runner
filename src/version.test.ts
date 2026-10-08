import { describe, expect, it } from 'vitest'
import { RUNNER_VERSION } from './version.js'

describe('RUNNER_VERSION', () => {
  it('is the package version, as semver', () => {
    expect(RUNNER_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
