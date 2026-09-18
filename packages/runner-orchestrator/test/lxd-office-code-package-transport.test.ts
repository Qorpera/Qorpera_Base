import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { OFFICE_CODE_PACKAGE_LOADER, officeCodePackageStage } from "../src/lxd-office-code-package-loader.ts";

const roots: string[] = [],
	servers: Server[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
	sha = "a".repeat(64),
	signal = () => new AbortController().signal;
async function fixture(handle: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void) {
	const root = await mkdtemp(join(tmpdir(), "code-package-transport-"));
	roots.push(root);
	const socket = join(root, "s"),
		calls: string[] = [],
		failures: unknown[] = [];
	const server = createServer((request, response) => {
		calls.push(`${request.method} ${request.url}`);
		const chunks: Buffer[] = [];
		request.on("data", (b: Buffer) => chunks.push(b));
		request.on("end", () => {
			try {
				handle(request, response, Buffer.concat(chunks));
			} catch (error) {
				failures.push(error);
				response.writeHead(500);
				response.end();
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	return { client: new LxdUnixClient(socket), calls, failures };
}
const send = (response: ServerResponse, body: unknown) => {
	response.writeHead((body as { type?: string }).type === "async" ? 202 : 200, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
};
const success = { type: "sync", status_code: 200, status: "Success" };
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe("closed code package transport", () => {
	it("discovers the sole root-owned package directory", async () => {
		const f = await fixture((_q, r) => {
			r.setHeader("x-lxd-type", "directory");
			r.setHeader("x-lxd-uid", "0");
			r.setHeader("x-lxd-gid", "0");
			r.setHeader("x-lxd-mode", "0700");
			send(r, { ...success, metadata: [id(1)] });
		});
		expect(await f.client.discoverOfficeCodePackage("offices", "office-test", signal())).toBe(id(1));
	});
	it("distinguishes definite missing directory from failures", async () => {
		const f = await fixture((_q, r) => {
			r.writeHead(404);
			r.end(JSON.stringify({ type: "error", error_code: 404, error: "not found" }));
		});
		expect(await f.client.discoverOfficeCodePackage("offices", "office-test", signal())).toBeUndefined();
	});
	it.each([
		{ metadata: [] },
		{ metadata: [id(1), id(2)] },
		{ metadata: ["../outside"] },
		{ metadata: [id(1)], uid: "1000" },
		{ metadata: [id(1)], mode: "0755" },
		{ metadata: [id(1)], type: "file" },
	])("holds malformed/ambiguous or unsafe package directory %j", async (value) => {
		const f = await fixture((_q, r) => {
			r.setHeader("x-lxd-type", value.type ?? "directory");
			r.setHeader("x-lxd-uid", value.uid ?? "0");
			r.setHeader("x-lxd-gid", "0");
			r.setHeader("x-lxd-mode", value.mode ?? "0700");
			send(r, { ...success, metadata: value.metadata });
		});
		await expect(f.client.discoverOfficeCodePackage("offices", "office-test", signal())).rejects.toThrow();
	});
	it("holds HTTP failures instead of selecting legacy measurement", async () => {
		const f = await fixture((_q, r) => {
			r.writeHead(503);
			r.end(JSON.stringify({ type: "error", error_code: 503, error: "unavailable" }));
		});
		await expect(f.client.discoverOfficeCodePackage("offices", "office-test", signal())).rejects.toThrow();
	});

	it("creates only the per-provision private stage and artifact directories", async () => {
		const f = await fixture((request, response) => {
			expect(request.headers["x-lxd-mode"]).toBe("0700");
			expect(request.headers["x-lxd-type"]).toBe("directory");
			expect(request.headers["x-lxd-uid"]).toBe("0");
			send(response, success);
		});
		for (const directory of ["root", "artifacts"] as const)
			await f.client.pushOfficeCodePackageDirectory("offices", "office-test", id(1), directory, signal());
		expect(f.calls).toHaveLength(2);
		await expect(
			f.client.pushOfficeCodePackageDirectory("offices", "office-test", id(1), "../outside" as never, signal()),
		).rejects.toThrow();
		expect(f.calls).toHaveLength(2);
		expect(f.failures).toEqual([]);
	});
	it.each(COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS)("stages fixed %s as root-owned immutable code", async (file) => {
		const content = Buffer.from("reviewed bytes");
		const f = await fixture((request, response, body) => {
			expect(request.headers["x-lxd-mode"]).toBe("0400");
			expect(body).toEqual(content);
			expect(decodeURIComponent(request.url!)).toContain(`${officeCodePackageStage(id(1))}/artifacts/${file}`);
			send(response, success);
		});
		await f.client.pushOfficeCodePackageFile("offices", "office-test", id(1), `artifacts/${file}`, content, signal());
		expect(f.failures).toEqual([]);
	});
	it.each([
		"../outside",
		"artifacts/../../config.json",
		"artifacts/unknown.mjs",
		"capability.json",
		"installed.json",
		`observation-${id(2)}.json`,
	])("refuses upload to %s before HTTP", async (file) => {
		const f = await fixture((_q, r) => send(r, success));
		await expect(
			f.client.pushOfficeCodePackageFile("offices", "office-test", id(1), file, Buffer.from("x"), signal()),
		).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});
	it("reads escaped preparation packets above 64KiB but refuses the fixed4MiB bound", async () => {
		const content = Buffer.alloc(100000, 32),
			f = await fixture((_q, r) => {
				r.writeHead(200, {
					"content-type": "application/octet-stream",
					"x-lxd-type": "file",
					"x-lxd-uid": "0",
					"x-lxd-gid": "0",
					"x-lxd-mode": "0400",
				});
				r.end(content);
			});
		expect(
			(
				await f.client.readOfficeCodePackageFile(
					"offices",
					"office-test",
					id(1),
					"packet.json",
					4 * 1024 ** 2,
					signal(),
				)
			).content,
		).toEqual(content);
		await expect(
			f.client.readOfficeCodePackageFile(
				"offices",
				"office-test",
				id(1),
				"packet.json",
				4 * 1024 ** 2 + 1,
				signal(),
			),
		).rejects.toThrow();
		expect(f.calls).toHaveLength(1);
	});
	it.each([
		["bootstrap", ["preflight", sha, sha, id(2)]],
		["bootstrap", ["install", sha, sha, id(2), id(3), "5000"]],
		["measure", ["probe", sha, sha, id(2), id(3)]],
		["measure", ["observation", sha, sha, id(2), id(3), "4000", sha]],
		["measure", ["invocation", sha, sha, id(2), id(3), "4000", sha]],
	] as const)("uses the fixed verified loader for %s %j", async (purpose, args) => {
		const f = await fixture((_request, response, bytes) => {
			const body = JSON.parse(bytes.toString());
			expect(body.command).toEqual([
				"/usr/bin/node",
				"-e",
				OFFICE_CODE_PACKAGE_LOADER,
				purpose,
				id(1),
				sha,
				"123",
				...args,
			]);
			expect(body.environment).toEqual({});
			send(response, {
				type: "async",
				status_code: 100,
				operation: `/1.0/operations/${id(50)}`,
				metadata: {
					id: id(50),
					class: "task",
					status: "Running",
					status_code: 103,
					err: "",
					resources: {},
					metadata: { entity_url: "/1.0/instances/office-test?project=offices" },
				},
			});
		});
		await expect(
			f.client.submitOfficeCodePackageTool(
				"offices",
				"office-test",
				id(1),
				purpose,
				{ bytes: 123, sha256: sha },
				args,
				signal(),
			),
		).resolves.toMatchObject({ operationId: id(50) });
		expect(f.failures).toEqual([]);
	});
	it.each(
		[
			["install", sha, sha, id(2), id(3), "5001"],
			["install", sha, sha, id(2), id(3), "0"],
			["--locked"],
			["preflight", sha, sha],
			["install", sha, sha, "../../file", id(3), "5000"],
		].map((args) => ({ args })),
	)("rejects arbitrary/expired args $args without exec", async ({ args }) => {
		const f = await fixture((_q, r) => send(r, success));
		await expect(
			f.client.submitOfficeCodePackageTool(
				"offices",
				"office-test",
				id(1),
				"bootstrap",
				{ bytes: 123, sha256: sha },
				args,
				signal(),
			),
		).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});
});
