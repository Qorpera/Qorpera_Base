// P3's stand-in for the test database's PostgREST, inside the proof's throwaway node (test/prove-coding-session-vm.sh).
// The node's folder service reaches its core over HTTPS only (packages/object-gateway/src/folder-service/core.ts), and
// the node has no network card: this serves its origin on a loopback address the node's /etc/hosts names, with a
// certificate from the node's own CA, and hands each request to the proof's driver over stdio ("rest" lines), which
// runs it as service_role on the test database and answers with PostgREST's status and body. Protocol lines on stdout
// start with "P3 "; every log line goes to stderr.
//   node p3-postgrest.mjs <address> <certificate> <key>
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createInterface } from "node:readline";

const [address, certificate, key] = process.argv.slice(2);
if (!key) throw new Error("usage: p3-postgrest.mjs <address> <certificate> <key>");
const send = (value) => process.stdout.write(`P3 ${JSON.stringify(value)}\n`);
const log = (value) => process.stderr.write(`${JSON.stringify(value)}\n`);
const MAX_BODY = 8 * 1024 * 1024;
const pending = new Map();
let next = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return log({ event: "p3-postgrest-bad-line" });
	}
	const answer = pending.get(message.id);
	pending.delete(message.id);
	answer?.(message);
}).on("close", () => process.exit(0));

createServer({ cert: readFileSync(certificate), key: readFileSync(key) }, (request, reply) => {
	const chunks = [];
	let size = 0;
	request.on("data", (chunk) => {
		size += chunk.length;
		if (size > MAX_BODY) request.destroy();
		else chunks.push(chunk);
	});
	request.on("end", () => {
		const id = ++next;
		const timer = setTimeout(() => {
			pending.delete(id);
			log({ event: "p3-postgrest-timeout", method: request.method, path: request.url });
			reply.writeHead(504).end();
		}, 60_000);
		pending.set(id, (message) => {
			clearTimeout(timer);
			reply.writeHead(message.status, { "content-type": "application/json; charset=utf-8" }).end(message.body);
		});
		send({ t: "rest", id, method: request.method, path: request.url, body: Buffer.concat(chunks).toString("utf8") });
	});
}).listen(443, address, () => send({ t: "ready" }));
