import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, chown, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";

// A transport fault injector, not a fake LXD endpoint. Every unstalled byte
// passes to the actual daemon; stalled connections receive no response.
assert.equal(process.getuid(), 0);
const uid = Number(process.argv[2]);
const gid = Number(process.argv[3]);
assert(Number.isSafeInteger(uid) && uid > 0 && Number.isSafeInteger(gid) && gid > 0);
const root = "/run/qorpera-paid-lxd-proxy";
const sockets = new Set();
let stalledConnections = 0;
const server = createServer((client) => {
	sockets.add(client);
	client.on("error", () => {});
	client.once("close", () => sockets.delete(client));
	if (existsSync(`${root}/stall`)) {
		stalledConnections++;
		void writeFile(`${root}/stalled.json`, JSON.stringify({ stalledConnections }), { mode: 0o600 });
		client.resume();
		return;
	}
	const upstream = createConnection("/var/snap/lxd/common/lxd/unix.socket");
	sockets.add(upstream);
	upstream.once("close", () => { sockets.delete(upstream); client.destroy(); });
	client.once("close", () => upstream.destroy());
	upstream.on("error", () => client.destroy());
	client.pipe(upstream);
	upstream.pipe(client);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(`${root}/control.sock`, resolve); });
await chown(`${root}/control.sock`, uid, gid);
await chmod(`${root}/control.sock`, 0o600);
await writeFile(`${root}/ready`, "ready\n", { mode: 0o600 });
process.on("SIGTERM", () => { for (const socket of sockets) socket.destroy(); server.close(); });
