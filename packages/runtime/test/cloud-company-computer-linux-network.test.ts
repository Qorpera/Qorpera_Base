import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plumbCompanyComputerNetwork } from "@qorpera/runtime/cloud-company-computer-linux-network";
import { afterEach, describe, expect, it } from "vitest";

// The client side of the root plumber; the plumber, the firewall and the
// namespaces themselves run in the Linux proof (--shell).
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function plumber(answer: (request: string) => string | undefined) {
	const root = await mkdtemp(join(await realpath(tmpdir()), "pl-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const requests: string[] = [];
	const server: Server = createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (text: string) => {
			buffer += text;
			if (!buffer.includes("\n")) return;
			const request = buffer.slice(0, buffer.indexOf("\n"));
			requests.push(request);
			const reply = answer(request);
			if (reply === undefined) socket.destroy();
			else socket.end(reply);
		});
	});
	const path = join(root, "plumb.sock");
	await new Promise<void>((resolve) => server.listen(path, resolve));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	return { path, requests };
}

describe("asking the root plumber for a computer's network", () => {
	it("asks for exactly one namespace and returns its address", async () => {
		const p = await plumber(() => "ok 10.253.3.2\n");
		expect(await plumbCompanyComputerNetwork({ ordinal: 3, role: "shell", pid: 4242, socket: p.path })).toBe(
			"10.253.3.2",
		);
		expect(p.requests).toEqual(["plumb 3 shell 4242"]);
		expect(await plumbCompanyComputerNetwork({ ordinal: 3, role: "desktop", pid: 4243, socket: p.path })).toBe(
			"10.253.3.2",
		);
		expect(p.requests[1]).toBe("plumb 3 desktop 4243");
	});

	it("starts without a network, never with an unknown one, when the plumber refuses, is missing or answers oddly", async () => {
		const refusing = await plumber(() => "refused namespace\n");
		expect(await plumbCompanyComputerNetwork({ ordinal: 1, role: "shell", pid: 7, socket: refusing.path })).toBe(
			undefined,
		);
		const odd = await plumber(() => "ok 192.168.1.40\n");
		expect(await plumbCompanyComputerNetwork({ ordinal: 1, role: "shell", pid: 7, socket: odd.path })).toBe(
			undefined,
		);
		const silent = await plumber(() => undefined);
		expect(await plumbCompanyComputerNetwork({ ordinal: 1, role: "shell", pid: 7, socket: silent.path })).toBe(
			undefined,
		);
		expect(
			await plumbCompanyComputerNetwork({ ordinal: 1, role: "shell", pid: 7, socket: "/nonexistent/plumb.sock" }),
		).toBe(undefined);
		const slow = await plumber(() => "");
		expect(
			await plumbCompanyComputerNetwork({ ordinal: 1, role: "shell", pid: 7, socket: slow.path, timeoutMs: 100 }),
		).toBe(undefined);
	});

	it.each([
		{ ordinal: 0, pid: 7 },
		{ ordinal: 33, pid: 7 },
		{ ordinal: 1, pid: 0 },
		{ ordinal: 1.5, pid: 7 },
	])("never asks for an invalid computer or process: %j", async ({ ordinal, pid }) => {
		const p = await plumber(() => "ok 10.253.1.2\n");
		expect(await plumbCompanyComputerNetwork({ ordinal, role: "shell", pid, socket: p.path })).toBe(undefined);
		expect(p.requests).toEqual([]);
	});
});
