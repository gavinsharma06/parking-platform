import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    // Worker threads cannot change the timezone at runtime, so the TZ tests
    // run in a forked process where process.env.TZ takes effect
    poolMatchGlobs: [["**/timezone-independence.test.ts", "forks"]],
  },
  resolve: {
    alias: {
      // Mirror the @/ alias from tsconfig so imports work in tests
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
