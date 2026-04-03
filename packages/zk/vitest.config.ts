import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    globals: false,
    pool: "forks",       // snarkjs/ffjavascript Worker compat
    poolOptions: { forks: { singleFork: true } },
  },
})
