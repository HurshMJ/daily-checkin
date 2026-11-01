import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      reactRouter(),
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Read by test/setup.ts to rebuild the schema before every test.
            TEST_MIGRATIONS: migrations,
            // Real PBKDF2, but cheap enough for many logins per test run.
            // Production uses the 100000 in wrangler.jsonc.
            PBKDF2_ITERATIONS: "1000",
          },
        },
      }),
    ],
    resolve: { tsconfigPaths: true },
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
