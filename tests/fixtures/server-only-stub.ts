/**
 * Stand-in for the `server-only` marker package under Vitest.
 *
 * `server-only` resolves to a module that throws unless the bundler applies the
 * `react-server` export condition — which Next does and Vitest does not. The
 * package has no runtime behaviour beyond that guard, so replacing it with an
 * empty module lets us unit-test server modules directly.
 *
 * The real guard still applies where it matters: Next resolves the actual
 * package, so importing a server module from a client component remains a build
 * error.
 */
export {};
