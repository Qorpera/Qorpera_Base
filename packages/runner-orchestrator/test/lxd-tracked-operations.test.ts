import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";

const roots: string[] = [];
const servers: Server[] = [];
const operationId = "10000000-0000-4000-8000-000000000001";
const reference = { project: "offices", instanceName: "office-test", operationId };
const operation = (overrides: Record<string, unknown> = {}) => ({
	id: operationId,
	class: "task",
	status: "Running",
	status_code: 103,
	err: "",
	resources: { instances: ["/1.0/instances/office-test?project=offices"] },
	...overrides,
});
const envelope = (metadata = operation()) => ({ type: "sync", status_code: 200, metadata });
const accepted = () => ({
	type: "async",
	status_code: 100,
	operation: `/1.0/operations/${operationId}`,
	metadata: operation(),
});
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(handle: (request: IncomingMessage, response: ServerResponse, body: unknown) => void) {
	const root = await mkdtemp(join(tmpdir(), "lxd-op-"));
	roots.push(root);
	const path = join(root, "socket");
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () =>
			handle(request, response, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined),
		);
	});
	servers.push(server);
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(path, resolveListen);
	});
	return new LxdUnixClient(path, 30);
}
function send(response: ServerResponse, body: unknown, status = 200) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}
const signal = () => new AbortController().signal;

describe("journalable LXD operations over a real Unix HTTP socket", () => {
	it.each(["create", "start", "stop", "delete"] as const)(
		"submits %s once and returns its identity without waiting",
		async (action) => {
			const calls: Array<{ method: string; url: string; body: unknown }> = [];
			const client = await fixture((request, response, body) => {
				calls.push({ method: request.method ?? "", url: request.url ?? "", body });
				send(response, accepted(), 202);
			});
			const create = {
				name: "office-test",
				type: "virtual-machine" as const,
				profiles: [],
				config: {},
				devices: {},
				source: { type: "image" as const, fingerprint: "a".repeat(64) },
			};
			await expect(
				client.submitInstanceOperation(
					"offices",
					action === "create" ? { action, request: create } : { action, name: "office-test" },
					signal(),
				),
			).resolves.toEqual(reference);
			expect(calls).toHaveLength(1);
			expect(calls[0].method).toBe(action === "create" ? "POST" : action === "delete" ? "DELETE" : "PUT");
			expect(calls[0].url).toBe(
				action === "create"
					? "/1.0/instances?project=offices"
					: `/1.0/instances/office-test${action === "delete" ? "" : "/state"}?project=offices`,
			);
			if (action === "create") expect(calls[0].body).toEqual(create);
			if (action === "start" || action === "stop")
				expect(calls[0].body).toEqual({ action, timeout: 30, force: false, stateful: false });
		},
	);
	it("powers a VM off only when the stop asks for force (coding VMs)", async () => {
		const calls: unknown[] = [];
		const client = await fixture((_request, response, body) => {
			calls.push(body);
			send(response, accepted(), 202);
		});
		await client.submitInstanceOperation("offices", { action: "stop", name: "office-test", force: true }, signal());
		await client.submitInstanceOperation("offices", { action: "stop", name: "office-test" }, signal());
		expect(calls).toEqual([
			{ action: "stop", timeout: 30, force: true, stateful: false },
			{ action: "stop", timeout: 30, force: false, stateful: false },
		]);
	});
	it.each([
		[100, "Operation created", "pending"],
		[103, "Running", "pending"],
		[104, "Cancelling", "pending"],
		[105, "Pending", "pending"],
		[200, "Success", "succeeded"],
		[400, "Failure", "failed"],
		[401, "Cancelled", "failed"],
	])("reads operation status %s without issuing another mutation", async (status_code, status, expected) => {
		const client = await fixture((request, response) => {
			expect(request.method).toBe("GET");
			expect(request.url).toBe(`/1.0/operations/${operationId}?project=offices`);
			send(response, envelope(operation({ status_code, status })));
		});
		await expect(client.inspectInstanceOperation(reference, signal())).resolves.toBe(expected);
	});
	it.each([
		{ id: "20000000-0000-4000-8000-000000000001" },
		{ class: "token" },
		{ resources: { instances: ["/1.0/instances/office-test?project=other"] } },
		{ resources: { instances: ["/1.0/instances/other"] } },
		{ resources: {} },
		{ resources: { instances: ["/1.0/instances/office-test", "/1.0/instances/other"] } },
		{ status_code: 299, status: "Success" },
		{ status_code: 200, status: "Running" },
		{ status_code: 200, status: "Success", err: "private daemon detail" },
		{ err: null },
	])("rejects mismatched or malformed operation metadata (%#)", async (metadata) => {
		const client = await fixture((_request, response) => send(response, envelope(operation(metadata))));
		await expect(client.inspectInstanceOperation(reference, signal())).rejects.toThrow(/^LXD_OPERATION_UNCONFIRMED$/);
	});
	it.each([
		"https://evil.invalid/",
		`/1.0/operations/${operationId}/wait`,
		`/1.0/operations/${operationId}?project=other`,
		"/1.0/operations/../instances",
	])("never follows an unvalidated response operation URL %s", async (url) => {
		let calls = 0;
		const client = await fixture((_request, response) => {
			calls++;
			send(response, { ...accepted(), operation: url }, 202);
		});
		await expect(
			client.submitInstanceOperation("offices", { action: "start", name: "office-test" }, signal()),
		).rejects.toThrow(/^LXD_OPERATION_SUBMISSION_UNCONFIRMED$/);
		expect(calls).toBe(1);
	});
	it.each([200, 301, 404, 409, 500])("does not mistake HTTP %s for an accepted submission", async (status) => {
		const client = await fixture((_request, response) => send(response, { ...accepted(), error: "private" }, status));
		await expect(
			client.submitInstanceOperation("offices", { action: "delete", name: "office-test" }, signal()),
		).rejects.toThrow(/^LXD_OPERATION_SUBMISSION_UNCONFIRMED$/);
	});
	it.each([301, 404, 500])("keeps an unavailable operation (%s) unconfirmed", async (status) => {
		const client = await fixture((_request, response) => send(response, envelope(), status));
		await expect(client.inspectInstanceOperation(reference, signal())).rejects.toThrow(/^LXD_OPERATION_UNCONFIRMED$/);
	});
	it("names only LXD's own 404 for an operation it no longer knows", async () => {
		const notFound = {
			type: "error",
			status: "",
			status_code: 0,
			operation: "",
			error_code: 404,
			error: "Operation not found",
		};
		const client = await fixture((_request, response) => send(response, notFound, 404));
		await expect(client.inspectInstanceOperation(reference, signal())).rejects.toThrow(/^LXD_OPERATION_UNKNOWN$/);
		for (const [body, status] of [
			[{ ...notFound, error_code: 500 }, 404],
			[{ ...notFound, error_code: 404 }, 500],
			[{ ...notFound, type: "sync" }, 404],
		] as const) {
			const other = await fixture((_request, response) => send(response, body, status));
			await expect(other.inspectInstanceOperation(reference, signal())).rejects.toThrow(
				/^LXD_OPERATION_UNCONFIRMED$/,
			);
		}
	});
	it("accepts the older bare resource URL for the already project-scoped operation", async () => {
		const client = await fixture((_request, response) =>
			send(response, envelope(operation({ resources: { instances: ["/1.0/instances/office-test"] } }))),
		);
		await expect(client.inspectInstanceOperation(reference, signal())).resolves.toBe("pending");
	});
	it.each(["create", "start", "stop", "delete"] as const)(
		"supports LXD 6.9 entity metadata for %s submission and observation",
		async (action) => {
			const client = await fixture((request, response) => {
				const metadata = operation({
					resources: {},
					metadata: { entity_url: "/1.0/instances/office-test?project=offices" },
				});
				send(
					response,
					request.method === "GET" ? envelope(metadata) : { ...accepted(), metadata },
					request.method === "GET" ? 200 : 202,
				);
			});
			const create = {
				name: "office-test",
				type: "virtual-machine" as const,
				profiles: [],
				config: {},
				devices: {},
				source: { type: "image" as const, fingerprint: "a".repeat(64) },
			};
			await expect(
				client.submitInstanceOperation(
					"offices",
					action === "create" ? { action, request: create } : { action, name: "office-test" },
					signal(),
				),
			).resolves.toEqual(reference);
			await expect(client.inspectInstanceOperation(reference, signal())).resolves.toBe("pending");
		},
	);
	it.each([
		{ resources: {}, metadata: { entity_url: "/1.0/instances/office-test?project=other" } },
		{ resources: {}, metadata: { entity_url: "/1.0/instances/other?project=offices" } },
		{ resources: {}, metadata: { entity_url: "/1.0/instances/office-test" } },
		{ metadata: { entity_url: "/1.0/instances/office-test?project=other" } },
		{
			resources: { instances: ["/1.0/instances/other"] },
			metadata: { entity_url: "/1.0/instances/office-test?project=offices" },
		},
		{ resources: {}, metadata: { entity_url: ["/1.0/instances/office-test?project=offices"] } },
		{ resources: {}, metadata: null },
	])("rejects conflicting or unscoped entity metadata (%#)", async (metadata) => {
		const client = await fixture((_request, response) => send(response, envelope(operation(metadata))));
		await expect(client.inspectInstanceOperation(reference, signal())).rejects.toThrow(/^LXD_OPERATION_UNCONFIRMED$/);
	});
	it("bounds a stalled operation read even when the caller has no timeout", async () => {
		const client = await fixture((_request, response) => {
			response.writeHead(200);
			response.write('{"metadata":');
		});
		await expect(client.inspectInstanceOperation(reference, signal())).rejects.toThrow(/^LXD_OPERATION_UNCONFIRMED$/);
	}, 8000);
	it("rejects a truncated response instead of waiting forever or treating it as completion", async () => {
		const client = await fixture((_request, response) => {
			response.writeHead(200, { "content-length": "9999" });
			response.write(JSON.stringify(envelope()));
			response.destroy();
		});
		await expect(client.inspectInstanceOperation(reference, signal())).rejects.toThrow(/^LXD_OPERATION_UNCONFIRMED$/);
	});
	it("cancels before transmission and validates stored references before making a request", async () => {
		let calls = 0;
		const client = await fixture((_request, response) => {
			calls++;
			send(response, envelope());
		});
		const stop = new AbortController();
		stop.abort();
		await expect(
			client.submitInstanceOperation("offices", { action: "start", name: "office-test" }, stop.signal),
		).rejects.toThrow("UNCONFIRMED");
		await expect(
			client.inspectInstanceOperation({ ...reference, operationId: "../escape" }, signal()),
		).rejects.toThrow("UNCONFIRMED");
		await expect(
			client.inspectInstanceOperation({ ...reference, project: "bad?project=other" }, signal()),
		).rejects.toThrow("UNCONFIRMED");
		expect(calls).toBe(0);
	});
});
