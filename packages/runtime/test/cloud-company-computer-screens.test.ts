import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { waitForCompanyComputerScreenReady } from "@qorpera/runtime/cloud-company-computer-screens";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("bounded RFB readiness probe (private Unix socket component test)", () => {
	it.each([true, false])("requires the actual 3.8 banner, not merely a listening socket: %s", async (valid) => {
		const server = createServer((socket) => {
			socket.on("error", () => undefined);
			socket.end(valid ? "RFB 003.008\n" : "HTTP/1.1 200 OK\r\n");
		});
		servers.push(server);
		const root = await mkdtemp(join(await realpath("/tmp"), "office-probe-"));
		roots.push(root);
		const socketPath = join(root, "rfb.sock");
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		const ready = waitForCompanyComputerScreenReady(socketPath, new AbortController().signal, valid ? 500 : 30);
		if (valid) await expect(ready).resolves.toBeUndefined();
		else await expect(ready).rejects.toThrow();
	});
});
