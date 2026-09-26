import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";

const [root, host] = process.argv.slice(2);
assert(root && /^\d+\.\d+\.\d+\.\d+$/.test(host) && process.getuid() === 0);
const server = createServer({ key: await readFile(`${root}/server.key`), cert: await readFile(`${root}/server.pem`) }, (request, response) => {
	if (request.method !== "GET" || request.url !== "/trust-proof") { response.writeHead(404); response.end(); return; }
	response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
	response.end('{"schema":"qorpera.office-image-tls-proof/v1"}\n');
});
server.headersTimeout = 5000;
server.requestTimeout = 5000;
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
const address = server.address();
assert(address && typeof address !== "string");
await writeFile(`${root}/listener.json`, `${JSON.stringify({ host, port: address.port })}\n`, { mode: 0o600, flag: "wx" });
process.once("SIGTERM", () => { server.close(); server.closeAllConnections(); });

