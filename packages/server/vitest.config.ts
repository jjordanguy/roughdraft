import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@roughdraft/rfm": path.resolve(dirname, "../rfm/src/index.ts"),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "../../coverage/server",
      exclude: ["dist/**", "src/**/*.test.ts", "defaults.d.mts"],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test-setup.ts"],
  },
});
