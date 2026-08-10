import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A local static server for the fixture pages.
 *
 * The browser tests go over HTTP rather than `file://` on purpose: the domain
 * model only accepts http(s) URLs, and same-origin behaviour, response codes,
 * and navigation timing all differ under `file://`. Testing against the
 * protocol the tool actually audits keeps the fixtures honest.
 *
 * It also gives us routes that misbehave deliberately — a hang and a 500 — which
 * static files cannot express.
 */

const PAGES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages");

export type FixtureServer = {
  /** Origin, no trailing slash. */
  readonly origin: string;
  /** `${origin}/${page}` for a fixture file. */
  url(page: string): string;
  close(): Promise<void>;
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const pending = new Set<ReturnType<typeof setTimeout>>();

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    // Never resolves. Used to prove navigation timeouts are enforced rather
    // than merely configured.
    if (url.pathname === "/slow") {
      const timer = setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><title>Late</title>");
      }, 60_000);
      pending.add(timer);
      return;
    }

    if (url.pathname === "/boom") {
      response.writeHead(500, { "content-type": "text/html" });
      response.end("<!doctype html><title>Boom</title><h1>Server error</h1>");
      return;
    }

    // Path traversal is not a real risk here, but a fixture server that serves
    // whatever it is asked for is a bad habit to leave lying around.
    const name = path.basename(url.pathname);
    if (name === "" || name === "/") {
      response.writeHead(404).end("not found");
      return;
    }

    void readFile(path.join(PAGES_DIR, name), "utf8")
      .then((body) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server did not bind to a port");
  }

  const origin = `http://localhost:${address.port}`;

  return {
    origin,
    url: (page: string) => `${origin}/${page}`,
    close: async () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      // closeAllConnections, or a client still parked on /slow keeps the
      // process alive and the test run never exits.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
