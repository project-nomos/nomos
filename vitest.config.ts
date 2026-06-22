import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "eval/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
