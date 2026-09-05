import { configDefaults, defineConfig } from "vitest/config"

// The self-hosted suite uses Node's test runner and its own built bundle.
// Keep the legacy Worker/Vitest pipeline independent of that installation.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "selfhost/**"] },
})
