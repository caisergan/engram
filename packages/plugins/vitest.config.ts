/// <reference types="vitest" />

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const globalSetup =
  process.env.VITEST_SKIP_PLUGIN_GLOBAL_SETUP === "true"
    ? []
    : [
        "./queue-restate/src/tests/setup/startContainers.ts",
        "./ratelimit-redis/src/tests/setup/startContainers.ts",
      ];

export default defineConfig({
  plugins: [tsconfigPaths({ skip: (dir) => dir === ".claude" })],
  test: {
    globalSetup,
    teardownTimeout: 30000,
    include: ["**/src/tests/**/*.test.ts"],
    testTimeout: 60000,
  },
});
