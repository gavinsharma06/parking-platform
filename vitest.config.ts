import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
  resolve: {
    alias: {
      // Mirror the @/ alias from tsconfig so imports work in tests
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
