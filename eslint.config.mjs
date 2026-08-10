import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

/**
 * Server-only modules. These must never end up in a browser bundle: Playwright
 * drives a real browser and the AI client holds the user's API key.
 * See SECURITY.md.
 */
const SERVER_ONLY_IMPORTS = [
  {
    name: "playwright",
    message: "Playwright is server-only. Use it from src/lib/browser.",
  },
  {
    name: "playwright-core",
    message: "Playwright is server-only. Use it from src/lib/browser.",
  },
  {
    name: "@playwright/test",
    message: "@playwright/test belongs in tests/e2e only.",
  },
  { name: "server-only", message: "server-only may only be imported by server modules." },
];

const SERVER_ONLY_PATTERNS = [
  {
    group: ["@/lib/browser", "@/lib/browser/*", "@/lib/ai", "@/lib/ai/*"],
    message:
      "Browser automation and AI code are server-only. Reach them through an API route handler or a server component, never from client code.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // Client-side code must not reach server-only modules.
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: SERVER_ONLY_IMPORTS, patterns: SERVER_ONLY_PATTERNS },
      ],
    },
  },

  // Playwright is the only module allowed to talk to a browser, and only from
  // src/lib/browser and the e2e suite.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/browser/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "playwright",
              message:
                "Only src/lib/browser may import Playwright. Everything else goes through the browser driver.",
            },
            {
              name: "playwright-core",
              message:
                "Only src/lib/browser may import Playwright. Everything else goes through the browser driver.",
            },
          ],
        },
      ],
    },
  },

  // Prettier last: turns off stylistic rules that would fight the formatter.
  prettier,

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "runs/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
