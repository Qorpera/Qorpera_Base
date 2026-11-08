import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LxdSubmissionRefused, LxdUnixClient } from "../src/lxd-client.ts";
import { withShortDeadline } from "./helpers/short-deadline.ts";

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
	it("rebuilds a VM from a local image and tracks the rebuild like any other operation", async () => {
		const calls: Array<{ method: string; url: string; body: unknown }> = [];
		const client = await fixture((request, response, body) => {
			calls.push({ method: request.method ?? "", url: request.url ?? "", body });
			send(response, request.method === "GET" ? envelope() : accepted(), request.method === "GET" ? 200 : 202);
		});
		const fingerprint = "b".repeat(64);
		await expect(
			client.submitInstanceOperation("offices", { action: "rebuild", name: "office-test", fingerprint }, signal()),
		).resolves.toEqual(reference);
		await expect(client.inspectInstanceOperation(reference, signal())).resolves.toBe("pending");
		expect(calls[0]).toEqual({
			method: "POST",
			url: "/1.0/instances/office-test/rebuild?project=offices",
			body: { source: { type: "image", fingerprint } },
		});
		for (const bad of ["B".repeat(64), "b".repeat(63), `${"b".repeat(64)}?project=other`]) {
			await expect(
				client.submitInstanceOperation(
					"offices",
					{ action: "rebuild", name: "office-test", fingerprint: bad },
					signal(),
				),
			).rejects.toThrow(/^LXD_OPERATION_SUBMISSION_UNCONFIRMED$/);
		}
		expect(calls).toHaveLength(2);
	});
	it("tells a present image from one LXD no longer has, and nothing else", async () => {
		const fingerprint = "c".repeat(64);
		const urls: string[] = [];
		const answers: Array<[unknown, number]> = [
			[{ type: "sync", status_code: 200, metadata: { fingerprint, type: "virtual-machine" } }, 200],
			[{ type: "error", status_code: 0, error_code: 404, error: "Image not found" }, 404],
		];
		const client = await fixture((request, response) => {
			urls.push(request.url ?? "");
			const [body, status] = answers.shift() ?? [{}, 500];
			send(response, body, status);
		});
		await expect(client.hasImage("offices", fingerprint, signal())).resolves.toBe(true);
		await expect(client.hasImage("offices", fingerprint, signal())).resolves.toBe(false);
		expect(urls).toEqual([
			`/1.0/images/${fingerprint}?project=offices`,
			`/1.0/images/${fingerprint}?project=offices`,
		]);
		for (const [body, status] of [
			[{ type: "sync", status_code: 200, metadata: { fingerprint: "d".repeat(64) } }, 200],
			[{ type: "sync", status_code: 200, metadata: null }, 200],
			[{ type: "error", status_code: 0, error_code: 404 }, 500],
			[{ type: "error", status_code: 0, error_code: 500 }, 404],
			[{ type: "sync", status_code: 200, metadata: { fingerprint } }, 404],
			[{ type: "error", status_code: 0, error_code: 403 }, 403],
		] as const) {
			const other = await fixture((_request, response) => send(response, body, status));
			await expect(other.hasImage("offices", fingerprint, signal())).rejects.toThrow(/^LXD_IMAGE_UNCONFIRMED$/);
		}
		let calls = 0;
		const unused = await fixture((_request, response) => {
			calls++;
			send(response, {}, 500);
		});
		await expect(unused.hasImage("offices", "C".repeat(64), signal())).rejects.toThrow(/^LXD_IMAGE_UNCONFIRMED$/);
		await expect(unused.hasImage("bad?project=x", fingerprint, signal())).rejects.toThrow(/^LXD_IMAGE_UNCONFIRMED$/);
		expect(calls).toBe(0);
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
	it("keeps LXD's own refusal of a submission, its status, code and message on one line, and still calls it unconfirmed", async () => {
		// As node02's coding project refused a coding machine's agent card on 24 Oct 2026 (C8 C4-1).
		const refusal = {
			type: "error",
			status: "",
			status_code: 0,
			operation: "",
			error_code: 403,
			error: 'Failed checking if instance creation allowed:\nInvalid device "network": Only managed network devices are allowed\u0007',
			metadata: null,
		};
		const answers: Array<[unknown, number]> = [
			[refusal, 403],
			[{ ...refusal, error_code: "403", error: `${"x".repeat(600)}\u{1F600}` }, 400],
		];
		const client = await fixture((_request, response) => {
			const [body, status] = answers.shift() ?? [{}, 500];
			send(response, body, status);
		});
		const submit = () =>
			client.submitInstanceOperation("offices", { action: "start", name: "office-test" }, signal()).then(
				() => {
					throw new Error("accepted");
				},
				(error: unknown) => error,
			);
		const refused = await submit();
		expect(refused).toBeInstanceOf(LxdSubmissionRefused);
		expect(refused).toMatchObject({
			message: "LXD_OPERATION_SUBMISSION_UNCONFIRMED",
			status: 403,
			lxdCode: 403,
			lxdMessage:
				'Failed checking if instance creation allowed: Invalid device "network": Only managed network devices are allowed',
		});
		// A code that is not a number is left out; a long message is cut to 500 characters.
		expect(await submit()).toMatchObject({ status: 400, lxdCode: null, lxdMessage: "x".repeat(500) });
		// Anything but LXD's error answer keeps nothing: no answer, another type, a status that is no error.
		for (const [body, status] of [
			[{ ...refusal, type: "sync" }, 403],
			[refusal, 200],
			[refusal, 302],
			["not an envelope", 500],
		] as const) {
			const other = await fixture((_request, response) => send(response, body, status));
			const error = await other
				.submitInstanceOperation("offices", { action: "delete", name: "office-test" }, signal())
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(LxdSubmissionRefused);
			expect((error as Error).message).toBe("LXD_OPERATION_SUBMISSION_UNCONFIRMED");
		}
	});
	it.each([
		[{ restricted: "true", "restricted.devices.nic": "managed" }, false],
		[{ restricted: "true" }, false],
		[{ restricted: "true", "restricted.devices.nic": "allow" }, true],
		[{ restricted: "true", "restricted.devices.nic": "allow", "restricted.networks.access": "coding-net" }, false],
		[
			{ restricted: "true", "restricted.devices.nic": "allow", "restricted.networks.access": "coding-net, qagent0" },
			true,
		],
		[{ restricted: "false", "restricted.devices.nic": "managed" }, true],
		[{}, true],
	])("reads, and only reads, whether a project allows the agent card: %j", async (config, allowed) => {
		const calls: string[] = [];
		const client = await fixture((request, response) => {
			calls.push(`${request.method} ${request.url}`);
			send(response, { type: "sync", status_code: 200, metadata: { name: "coding", config, used_by: [] } });
		});
		await expect(client.allowsAgentCard("coding", signal())).resolves.toBe(allowed);
		expect(calls).toEqual(["GET /1.0/projects/coding"]);
	});
	it("reads a project however many instances it holds, and calls one it cannot read unconfirmed", async () => {
		const used = Array.from(
			{ length: 2000 },
			(_, i) => `/1.0/instances/qorpera-coding-machine-${i.toString(16).padStart(32, "0")}?project=coding`,
		);
		const config = { restricted: "true", "restricted.devices.nic": "allow" };
		const big = await fixture((_request, response) =>
			send(response, { type: "sync", status_code: 200, metadata: { name: "coding", config, used_by: used } }),
		);
		await expect(big.allowsAgentCard("coding", signal())).resolves.toBe(true);
		for (const [body, status] of [
			[{ type: "error", status_code: 0, error_code: 404, error: "Project not found" }, 404],
			[{ type: "sync", status_code: 200, metadata: { name: "other", config } }, 200],
			[{ type: "sync", status_code: 200, metadata: { name: "coding", config: { restricted: true } } }, 200],
			[{ type: "sync", status_code: 200, metadata: null }, 200],
		] as const) {
			const other = await fixture((_request, response) => send(response, body, status));
			await expect(other.allowsAgentCard("coding", signal())).rejects.toThrow(/^LXD_PROJECT_UNCONFIRMED$/);
		}
		let calls = 0;
		const unused = await fixture((_request, response) => {
			calls++;
			send(response, {}, 500);
		});
		await expect(unused.allowsAgentCard("bad?project=x", signal())).rejects.toThrow(/^LXD_PROJECT_UNCONFIRMED$/);
		expect(calls).toBe(0);
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
	it.each(["create", "start", "stop", "delete", "rebuild"] as const)(
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
					action === "create"
						? { action, request: create }
						: action === "rebuild"
							? { action, name: "office-test", fingerprint: "a".repeat(64) }
							: { action, name: "office-test" },
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
		const deadlines = await withShortDeadline(5000, () =>
			expect(client.inspectInstanceOperation(reference, signal())).rejects.toThrow(/^LXD_OPERATION_UNCONFIRMED$/),
		);
		expect(deadlines).toBeGreaterThan(0);
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
