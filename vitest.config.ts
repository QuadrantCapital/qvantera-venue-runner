import { defineConfig } from 'vitest/config'

// Tests run as QV_ENV=test (M-800). A test that needs production sets it before importing.
// `dir`: since vitest 4 the default exclude no longer skips dist/, whose compiled tests would run too.
export default defineConfig({ test: { dir: 'src', env: { QV_ENV: 'test' } } })
