import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4173;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

export function createLocalServer({ distDir = fileURLToPath(new URL("../dist", import.meta.url)) } = {}) {
  const root = path.resolve(distDir);
  return createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname === "/api/relay/status") {
        if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });
        return json(response, 200, { ok: true, service: "yanlan-local-relay" });
      }
      if (url.pathname === "/api/relay") return await relayRequest(request, response, url);
      if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed" });
      return await serveStatic(request, response, url, root);
    } catch (error) {
      if (!response.headersSent) json(response, error?.statusCode || 500, { error: error?.publicMessage || "Local gateway request failed" });
      else response.destroy();
    }
  });
}

async function relayRequest(request, response, requestUrl) {
  if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
  if (!validLocalRequest(request)) return json(response, 403, { error: "Local same-origin requests only" });

  const rawTarget = requestUrl.searchParams.get("url");
  let target;
  try {
    target = new URL(rawTarget || "");
  } catch {
    return json(response, 400, { error: "Invalid target URL" });
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    return json(response, 400, { error: "Only credential-free HTTP(S) target URLs are allowed" });
  }
  if (isGatewayTarget(target, request.headers.host)) return json(response, 400, { error: "The gateway cannot relay to itself" });

  const body = await readLimitedBody(request, MAX_REQUEST_BYTES);
  const headers = new Headers();
  for (const name of ["authorization", "content-type", "api-key", "x-api-key"]) {
    const value = request.headers[name];
    if (typeof value === "string" && value) headers.set(name, value);
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError";
    return json(response, timeout ? 504 : 502, { error: timeout ? "Upstream request timed out" : "Upstream API is unreachable" });
  }

  const output = await readLimitedResponse(upstream.body, MAX_RESPONSE_BYTES).catch(() => null);
  if (!output) return json(response, 502, { error: "Upstream response is too large" });
  response.statusCode = upstream.status;
  response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(output);
}

function validLocalRequest(request) {
  const host = String(request.headers.host || "");
  const hostname = host.replace(/^\[/, "").replace(/\](?=:|$)/, "").split(":")[0];
  if (hostname !== "127.0.0.1" && hostname !== "localhost") return false;
  const origin = request.headers.origin;
  return typeof origin === "string" && origin === `http://${host}`;
}

function isGatewayTarget(target, requestHost) {
  return (target.hostname === "127.0.0.1" || target.hostname === "localhost") && target.host === requestHost;
}

async function readLimitedBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      error.publicMessage = `Request body exceeds ${Math.floor(limit / 1024 / 1024)} MiB`;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readLimitedResponse(body, limit) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Response body too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function serveStatic(request, response, url, root) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return json(response, 400, { error: "Invalid path" });
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return json(response, 403, { error: "Forbidden" });
  let fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    filePath = path.join(root, "index.html");
    fileStat = await stat(filePath).catch(() => null);
  }
  if (!fileStat?.isFile()) return json(response, 503, { error: "Frontend build not found. Run npm run build first." });
  response.statusCode = 200;
  response.setHeader("Content-Type", MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream");
  response.setHeader("Content-Length", fileStat.size);
  response.setHeader("Cache-Control", path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
  if (request.method === "HEAD") return response.end();
  createReadStream(filePath).pipe(response);
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

export function listenLocalServer(server, { host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createLocalServer();
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const address = await listenLocalServer(server, { port });
  console.log(`Yanlan local gateway: http://${address.address}:${address.port}`);
}
