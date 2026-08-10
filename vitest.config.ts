import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // See tests/fixtures/server-only-stub.ts for why.
      "server-only": path.resolve(
        import.meta.dirname,
        "./tests/fixtures/server-only-stub.ts",
      ),
    },
  },
  test: {
    // Domain logic is framework-independent and runs in Node. Component tests,
    // if we add them, get their own environment via a per-file docblock.
    environment: "node",
    globals: false,
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    // tests/e2e belongs to Playwright, not Vitest.
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/**/index.ts"],
    },
  },
});
