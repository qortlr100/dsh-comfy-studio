// Two test projects. Background: docs/DSH.md "띄워서 확인하는 법".
//
//   unit         pnpm test              fast, no dsh process, runs before every commit
//   integration  pnpm test:integration  launches the real dsh with our bundle and a browser

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.{ts,tsx}",
            "scripts/**/*.test.ts",
            "tests/harness/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/harness/global-setup.ts"],
          // A launch takes about two seconds; the budget leaves room for a loaded machine.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
