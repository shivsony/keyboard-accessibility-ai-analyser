import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

/**
 * Import boundaries.
 *
 * Two vendor SDKs are confined to one directory each: Playwright drives a real
 * browser, and the AI SDK holds the user's API key. Neither may end up in a
 * browser bundle, and neither may spread through the codebase — the whole point
 * of the driver and provider abstractions is that swapping them stays local.
 * See SECURITY.md and ARCHITECTURE.md §2.
 *
 * Note on flat config: for a given file, the LAST matching block's value for a
 * rule wins outright — values do not merge. So each block below restates the
 * full set it wants, minus its own exception. Adding a block that only lists
 * the new restriction would silently drop the others.
 */

const PLAYWRIGHT = [
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
];

const AI_SDK = [
  {
    name: "openai",
    message:
      "Only src/lib/ai/openai-provider.ts may import the OpenAI SDK. Everything else depends on the AIProvider interface.",
  },
];

const CLIENT_FORBIDDEN = [
  ...PLAYWRIGHT,
  ...AI_SDK,
  {
    name: "@playwright/test",
    message: "@playwright/test belongs in tests/e2e only.",
  },
  {
    name: "server-only",
    message: "server-only may only be imported by server modules.",
  },
];

const CLIENT_FORBIDDEN_PATTERNS = [
  {
    group: ["@/lib/browser", "@/lib/browser/*", "@/lib/ai", "@/lib/ai/*"],
    message:
      "Browser automation and AI code are server-only. Reach them through an API route handler or a server component, never from client code.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  // The codebase uses a leading underscore to mean "deliberately unused" —
  // omitted destructuring targets, ignored callback parameters. Without this the
  // convention produces a warning every time it is used correctly.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },

  // Baseline for everything under src: no vendor SDKs.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: [...PLAYWRIGHT, ...AI_SDK] }],
    },
  },

  // The browser driver may import Playwright, and only Playwright.
  {
    files: ["src/lib/browser/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: AI_SDK }],
    },
  },

  // The OpenAI provider may import the OpenAI SDK, and only that.
  {
    files: ["src/lib/ai/openai-provider.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: PLAYWRIGHT }],
    },
  },

  // Client components may reach none of it. Last, so it wins for components.
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: CLIENT_FORBIDDEN, patterns: CLIENT_FORBIDDEN_PATTERNS },
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
