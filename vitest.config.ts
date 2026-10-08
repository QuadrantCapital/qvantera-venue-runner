import { defineConfig } from 'vitest/config'

// `dir`: since vitest 4 the default exclude no longer skips dist/, whose compiled tests would run too.
export default defineConfig({ test: { dir: 'src' } })
