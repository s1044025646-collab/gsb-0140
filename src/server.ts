import { createServer, type Server } from "node:http";
import { openDatabase, seedReferenceData, defaultClock } from "./db/database.ts";
import { mapError, route } from "./api/router.ts";

export interface StartOptions {
  dbPath: string;
  /** Preferred port. 0 lets the OS assign an ephemeral loopback port. */
  port?: number;
  host?: string;
  clock?: typeof defaultClock;
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start the API server. It binds only to loopback (127.0.0.1) and defaults
 * to port 0 (OS-assigned ephemeral port) so nothing is exposed off-machine.
 */
export function startServer(options: StartOptions): Promise<StartedServer> {
  const host = options.host ?? "127.0.0.1";
  const db = openDatabase(options.dbPath, options.clock ?? defaultClock);
  const defaults = seedReferenceData(db, options.clock ?? defaultClock);
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", `http://${host}`);
      if ((req.headers["content-type"] ?? "").includes("application/json") === false && rawBody) {
        res.writeHead(415, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" },
        }));
        return;
      }
      const result = await route(req.method ?? "GET", url.pathname, url, rawBody, {
        db,
        clock: options.clock ?? defaultClock,
        defaults,
      });
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (error) {
      const mapped = mapError(error);
      res.writeHead(mapped.status, { "content-type": "application/json" });
      res.end(JSON.stringify(mapped.body));
    }
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) rejectClose(error);
              else {
                db.close();
                resolveClose();
              }
            });
          }),
      });
    });
  });
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const dbPath = process.env.PEPTIDEMATCH_DB ?? "data/peptidematch.sqlite";
  const port = Number(process.env.PORT ?? "0");
  startServer({ dbPath, port }).then((started) => {
    console.log(`[peptidematch] API listening on http://127.0.0.1:${started.port}`);
    console.log(`[peptidematch] database: ${dbPath}`);
  });
}
