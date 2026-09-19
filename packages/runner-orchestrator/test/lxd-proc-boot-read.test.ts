import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";

const bootId = "f8e6a597-05c9-4c55-99ea-5b1e4911b04c";
const operationId = "01a09290-cec4-7151-9a99-09e004c5f844";
const instance = "/1.0/instances/office";
const operationPath = `/1.0/operations/${operationId}`;
const log = `${instance}/logs/exec-output/exec_${operationId}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(failure = "", content = "", kernelValue = `${bootId}\n`, afterContent?: string) {
	const directory = await mkdtemp(join(tmpdir(), "q-boot-"));
	const socket = join(directory, "s");
	const calls: { method: string; path: string; body: unknown }[] = [];
	let reads = 0;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks).toString();
		calls.push({ method: request.method!, path: request.url!, body: bytes ? JSON.parse(bytes) : null });
		const url = new URL(request.url!, "http://local");
		const send = (body: unknown, status = 200) => {
			response.writeHead(status);
			response.end(JSON.stringify(body));
		};
		if (url.searchParams.get("project") !== "company") return send({}, 404);
		if (url.pathname === `${instance}/files`) {
			reads++;
			response.writeHead(200, {
				"x-lxd-type": "file",
				"x-lxd-uid": failure === "owner" ? "1000" : "0",
				"x-lxd-gid": "0",
				"x-lxd-mode": failure === "mode" || (failure === "metadata changed" && reads === 2) ? "0644" : "0444",
			});
			return response.end(
				reads === 2 && afterContent !== undefined
					? afterContent
					: failure === "content changed" && reads === 2
						? `${operationId}\n`
						: content,
			);
		}
		const metadata = {
			entity_url: `${instance}?project=company`,
			return: failure === "exit" ? 1 : 0,
			output: {
				"1": failure === "foreign output" ? "/1.0/instances/other/logs/private" : `${log}.stdout`,
				"2": `${log}.stderr`,
			},
		};
		const operation = {
			id: failure === "operation identity" ? bootId : operationId,
			class: "task",
			resources: {},
			metadata,
			status_code: 200,
			status: "Success",
			err: "",
		};
		if (url.pathname === `${instance}/exec` && request.method === "POST")
			return send(
				{
					type: "async",
					status_code: 100,
					operation: failure === "operation URL" ? "/1.0/operations/../../private" : operationPath,
					metadata: operation,
				},
				202,
			);
		if (url.pathname === `${operationPath}/wait`)
			return send({
				type: "sync",
				status_code: 200,
				metadata: { ...operation, ...(failure === "not completed" ? { status_code: 103, status: "Running" } : {}) },
			});
		if ([`${log}.stdout`, `${log}.stderr`].includes(url.pathname)) {
			if (request.method === "DELETE") return send({}, failure === "cleanup" ? 500 : 200);
			response.writeHead(200);
			return response.end(
				url.pathname.endsWith("stderr")
					? failure === "stderr"
						? "x"
						: ""
					: failure === "oversized"
						? "x".repeat(65)
						: failure === "invalid UUID"
							? "invalid\n"
							: kernelValue,
			);
		}
		send({}, 404);
	});
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true });
	});
	const client = new LxdUnixClient(socket);
	return {
		calls,
		read: (path = "/proc/sys/kernel/random/boot_id", maximum = 64, signal?: AbortSignal) =>
			client.readInstanceFile("company", "office", path, maximum, signal),
	};
}

describe("LXD procfs boot identity read", () => {
	it("reads the kernel value as nobody when LXD serves zero bytes and removes only its scoped logs", async () => {
		const f = await fixture();
		await expect(f.read()).resolves.toEqual({ content: Buffer.from(`${bootId}\n`), uid: 0, gid: 0, mode: 0o444 });
		expect(f.calls.filter((call) => call.method === "POST")).toEqual([
			{
				method: "POST",
				path: `${instance}/exec?project=company`,
				body: {
					command: ["/usr/bin/cat", "--", "/proc/sys/kernel/random/boot_id"],
					interactive: false,
					"wait-for-websocket": false,
					"record-output": true,
					user: 65534,
					group: 65534,
					cwd: "/",
					environment: {},
				},
			},
		]);
		expect(f.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
			`${log}.stdout?project=company`,
			`${log}.stderr?project=company`,
		]);
		expect(f.calls.filter((call) => call.path.includes("/files?")).length).toBe(2);
	});
	it("does not execute for an ordinary empty file", async () => {
		const f = await fixture();
		expect((await f.read("/etc/empty")).content.length).toBe(0);
		expect(f.calls).toHaveLength(1);
	});
	it("preserves a directly readable boot file without fallback", async () => {
		const f = await fixture("", `${bootId}\n`);
		expect((await f.read()).content.toString()).toBe(`${bootId}\n`);
		expect(f.calls).toHaveLength(1);
	});
	it.each([
		"owner",
		"mode",
		"operation identity",
		"operation URL",
		"not completed",
		"exit",
		"foreign output",
		"stderr",
		"oversized",
		"invalid UUID",
		"cleanup",
		"metadata changed",
		"content changed",
	])("refuses %s without replaying the command", async (failure) => {
		const f = await fixture(failure);
		await expect(f.read()).rejects.toThrow("LXD_INSTANCE_FILE_UNCONFIRMED");
		expect(f.calls.filter((call) => call.method === "POST").length).toBeLessThanOrEqual(1);
		expect(f.calls.every((call) => !call.path.includes("other") && !call.path.includes("private"))).toBe(true);
		if (["owner", "mode"].includes(failure)) expect(f.calls).toHaveLength(1);
	});
	it("does not dispatch after cancellation or a caller bound smaller than the kernel value", async () => {
		const f = await fixture();
		await expect(f.read(undefined, 36)).rejects.toThrow("LXD_INSTANCE_FILE_UNCONFIRMED");
		await expect(f.read(undefined, 64, AbortSignal.abort())).rejects.toThrow("LXD_INSTANCE_FILE_UNCONFIRMED");
		expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
	});
});

describe("LXD public proc uptime read", () => {
	it("uses the fixed unprivileged uptime read and conservatively retains the earlier valid clock", async () => {
		const f = await fixture("", "", "100.12 500.33\n", "100.13 500.34\n");
		expect(await f.read("/proc/uptime", 128)).toEqual({
			content: Buffer.from("100.12 500.33\n"),
			uid: 0,
			gid: 0,
			mode: 0o444,
		});
		expect(f.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([
			expect.objectContaining({
				command: ["/usr/bin/cat", "--", "/proc/uptime"],
				user: 65534,
				group: 65534,
				environment: {},
			}),
		]);
		expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
	});
	it.each(["", "0", "NaN 0\n", "1e3 0\n", "-1.00 1.00\n", "1.00 0.00", "9007199254740.99 0.00\n"])(
		"rejects malformed uptime %j without replay",
		async (value) => {
			const f = await fixture("", "", value);
			await expect(f.read("/proc/uptime", 128)).rejects.toThrow("LXD_INSTANCE_FILE_UNCONFIRMED");
			expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
		},
	);
	it("refuses a backwards clock across readback and undersized bounds", async () => {
		const f = await fixture("", "", "100.00 50.00\n", "1.00 0.00\n");
		await expect(f.read("/proc/uptime", 128)).rejects.toThrow("LXD_INSTANCE_FILE_UNCONFIRMED");
		const g = await fixture();
		await expect(g.read("/proc/uptime", 9)).rejects.toThrow("LXD_INSTANCE_FILE_UNCONFIRMED");
		expect(g.calls.filter((call) => call.method === "POST")).toHaveLength(0);
	});
	it("does not execute when the uptime file is directly readable", async () => {
		const f = await fixture("", "100.00 50.00\n");
		expect((await f.read("/proc/uptime", 128)).content.toString()).toBe("100.00 50.00\n");
		expect(f.calls).toHaveLength(1);
	});
});
