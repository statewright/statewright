import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Native SDK fixtures use node:test and are run explicitly by test:native.
    include: ["src/**/*.{test,spec}.ts"],
  },
})
