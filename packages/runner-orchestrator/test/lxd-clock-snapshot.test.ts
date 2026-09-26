import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";

const bootId = "f8e6a597-05c9-4c55-99ea-5b1e4911b04c";
const otherBoot = "d8e6a597-05c9-4c55-99ea-5b1e4911b04c";
const operationId = "01a09290-cec4-7151-9a99-09e004c5f844";
const instance = "/1.0/instances/office";
const operationPath = `/1.0/operations/${operationId}`;
const log = `${instance}/logs/exec-output/exec_${operationId}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(failure = "", direct = false) {
	const directory = await mkdtemp(join(tmpdir(), "q-clock-"));
	const socket = join(directory, "s");
	const calls: { method: string; path: string; body: unknown }[] = [];
	const reads = new Map<string, number>();
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
			const path = url.searchParams.get("path")!;
			if (!["/proc/sys/kernel/random/boot_id", "/proc/uptime"].includes(path)) return send({}, 404);
			const count = (reads.get(path) ?? 0) + 1;
			reads.set(path, count);
			response.writeHead(200, {
				"x-lxd-type": "file",
				"x-lxd-uid": failure === "owner" ? "1000" : "0",
				"x-lxd-gid": failure === "group" ? "1000" : "0",
				"x-lxd-mode": failure === "mode" || (failure === "metadata changed" && count === 2) ? "0644" : "0444",
			});
			return response.end(
				direct
					? path === "/proc/uptime"
						? failure === "uptime moved backwards" && count === 2
							? "123.40 0.00\n"
							: "123.45 0.00\n"
						: `${failure === "direct boot changed" && count === 2 ? otherBoot : bootId}\n`
					: "",
			);
		}
		const metadata = {
			entity_url: `${failure === "instance" ? "/1.0/instances/other" : instance}?project=${failure === "project" ? "other" : "company"}`,
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
						? "x".repeat(257)
						: failure === "invalid UUID"
							? `invalid\n123.45 0.00\ninvalid\n`
							: failure === "invalid uptime"
								? `${bootId}\n1e3 0\n${bootId}\n`
								: failure === "extra output"
									? `${bootId}\n123.45 0.00\n${bootId}\nextra\n`
									: `${bootId}\n123.45 0.00\n${failure === "boot changed" ? otherBoot : bootId}\n`,
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
	return { calls, read: (signal?: AbortSignal) => client.readInstanceClock("company", "office", signal) };
}

describe("LXD bounded guest clock snapshot", () => {
	it.each([false, true])(
		"uses one fixed unprivileged exec and retains before/after custody (direct metadata content: %s)",
		async (direct) => {
			const f = await fixture("", direct);
			await expect(f.read()).resolves.toEqual({ bootId, uptimeMs: 123450 });
			expect(f.calls.filter((call) => call.method === "POST")).toEqual([
				{
					method: "POST",
					path: `${instance}/exec?project=company`,
					body: {
						command: [
							"/usr/bin/cat",
							"--",
							"/proc/sys/kernel/random/boot_id",
							"/proc/uptime",
							"/proc/sys/kernel/random/boot_id",
						],
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
			expect(f.calls.filter((call) => call.path.includes("/files?")).length).toBe(4);
			expect(
				f.calls
					.filter((call) => call.method === "DELETE")
					.map((call) => call.path)
					.sort(),
			).toEqual([`${log}.stderr?project=company`, `${log}.stdout?project=company`]);
		},
	);
	it.each([
		"owner",
		"group",
		"mode",
		"operation identity",
		"operation URL",
		"instance",
		"project",
		"not completed",
		"exit",
		"foreign output",
		"stderr",
		"oversized",
		"invalid UUID",
		"invalid uptime",
		"extra output",
		"boot changed",
		"cleanup",
		"metadata changed",
	])("refuses %s without replay or arbitrary reads", async (failure) => {
		const f = await fixture(failure);
		await expect(f.read()).rejects.toThrow("LXD_INSTANCE_CLOCK_UNCONFIRMED");
		expect(f.calls.filter((call) => call.method === "POST").length).toBeLessThanOrEqual(1);
		expect(f.calls.every((call) => !call.path.includes("other") && !call.path.includes("private"))).toBe(true);
	});
	it.each(["direct boot changed", "uptime moved backwards"])(
		"refuses contradictory direct metadata: %s",
		async (failure) => {
			const f = await fixture(failure, true);
			await expect(f.read()).rejects.toThrow("LXD_INSTANCE_CLOCK_UNCONFIRMED");
		},
	);
	it("does not dispatch after cancellation", async () => {
		const f = await fixture();
		await expect(f.read(AbortSignal.abort())).rejects.toThrow("LXD_INSTANCE_CLOCK_UNCONFIRMED");
		expect(f.calls).toHaveLength(0);
	});
});
