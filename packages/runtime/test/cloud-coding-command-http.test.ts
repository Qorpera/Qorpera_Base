import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCodingCommandServiceOptions } from "../src/cloud-coding-command-http.ts";
import {
	createHttpCloudCodingCommandGateway,
	HttpCloudCodingCommandService,
	parseCloudCodingCommandUrl,
} from "../src/cloud-coding-command-http.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(changes: Partial<CloudCodingCommandServiceOptions> = {}) {
	const token = randomBytes(32).toString("base64url");
	const binding = {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
		provider: "openai" as const,
		nativeHarness: "codex-cli" as const,
		model: "gpt-5.4",
	};
	const scope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 2 };
	const input = { commandId: randomUUID(), inputSha256: "a".repeat(64), command: "npm run check", timeoutMs: 120000 };
	const receipt = {
		schema: "qorpera.coding-command-result/v2",
		workerId: scope.workerId,
		commandId: input.commandId,
		inputSha256: input.inputSha256,
		state: "running",
		exitCode: null,
		output: "still running",
		truncated: false,
		log: { offset: 0, nextOffset: 13, totalBytes: 13, limitBytes: 67108864, limitReached: false },
	};
	const authorize = vi.fn<CloudCodingCommandServiceOptions["authorize"]>(async (request) => {
		expect(request.binding).toEqual(binding);
		expect(request.scope).toEqual(scope);
		return { inputSha256: input.inputSha256 };
	});
	const execute = vi.fn<CloudCodingCommandServiceOptions["execute"]>(async () => receipt);
	const service = new HttpCloudCodingCommandService({ token, authorize, execute, ...changes });
	const port = await service.start();
	cleanups.push(() => service.close());
	const url = `http://127.0.0.1:${port}`;
	const clientAuthorize = vi.fn(async () => undefined);
	const client = createHttpCloudCodingCommandGateway({
		url,
		token,
		binding,
		authorize: clientAuthorize,
		allowLoopback: true,
	});
	const request = { schema: "qorpera.coding-command-http/v1", binding, scope, action: "start", input };
	return { token, binding, scope, input, receipt, authorize, execute, service, url, client, clientAuthorize, request };
}
async function raw(f: Awaited<ReturnType<typeof fixture>>, value: unknown, route = "start", token = f.token) {
	return fetch(`${f.url}/v1/coding-commands/${route}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(value),
	});
}

describe("isolated coding command HTTP gateway", () => {
	it("round-trips a long running protected receipt after exact authority checks on both sides of execution", async () => {
		const f = await fixture();
		expect(await f.client.start(f.scope, f.input, new AbortController().signal)).toEqual(f.receipt);
		expect(f.authorize).toHaveBeenCalledTimes(2);
		expect(f.execute).toHaveBeenCalledTimes(1);
		expect(f.execute.mock.calls[0]?.[0]).toEqual(f.request);
		expect(f.clientAuthorize).not.toHaveBeenCalled();
	});
	it("uses fixed read and cancel routes without offering a host shell", async () => {
		const f = await fixture();
		await f.client.read(f.scope, { commandId: f.input.commandId }, new AbortController().signal);
		await f.client.cancel(f.scope, f.input.commandId, new AbortController().signal);
		expect(f.execute.mock.calls.map((call) => call[0])).toEqual([
			{ ...f.request, action: "read", input: { commandId: f.input.commandId, offset: 0, limit: 4096 } },
			{ ...f.request, action: "cancel", input: { commandId: f.input.commandId } },
		]);
	});
	it("transports bounded tail requests and rejects ambiguous page cursors before authority", async () => {
		const f = await fixture();
		await f.client.read(
			f.scope,
			{ commandId: f.input.commandId, tail: true, limit: 64 },
			new AbortController().signal,
		);
		expect(f.execute.mock.calls[0][0]).toMatchObject({
			action: "read",
			input: { commandId: f.input.commandId, tail: true, limit: 64 },
		});
		f.authorize.mockClear();
		f.execute.mockClear();
		expect(
			(
				await raw(
					f,
					{ ...f.request, action: "read", input: { commandId: f.input.commandId, tail: true, offset: 1 } },
					"read",
				)
			).status,
		).toBe(403);
		expect(f.authorize).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("never dispatches with a wrong bearer token or a noncanonical route", async () => {
		const f = await fixture();
		for (const response of [
			await raw(f, f.request, "start", randomBytes(32).toString("base64url")),
			await raw(f, f.request, "start?retry=1"),
		]) {
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "coding_command_unavailable" });
		}
		expect(f.authorize).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	});
	it.each(["extra", "scope", "binding", "action", "input", "size"])(
		"rejects closed request violation %s before authority or execution",
		async (kind) => {
			const f = await fixture();
			const variants = {
				extra: { ...f.request, token: "forbidden" },
				scope: { ...f.request, scope: { ...f.scope, vmId: "../host" } },
				binding: { ...f.request, binding: { ...f.binding, shell: "bash" } },
				action: { ...f.request, action: "cancel" },
				input: { ...f.request, input: { ...f.input, timeoutMs: 1800001 } },
				size: { ...f.request, input: { ...f.input, command: "x".repeat(131073) } },
			};
			expect((await raw(f, variants[kind as keyof typeof variants])).status).toBe(403);
			expect(f.authorize).not.toHaveBeenCalled();
			expect(f.execute).not.toHaveBeenCalled();
		},
	);
	it("stops before effects when current SQL authority rejects and redacts the rejection", async () => {
		const f = await fixture({
			authorize: async () => {
				throw new Error("private connection credential");
			},
		});
		await expect(f.client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow(
			"Coding command gateway unavailable",
		);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("rejects mismatched receipt digest before execution", async () => {
		const f = await fixture({ authorize: async () => ({ inputSha256: "b".repeat(64) }) });
		await expect(f.client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow("unavailable");
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("suppresses a result when authority changes during execution without retrying", async () => {
		const f = await fixture();
		f.authorize.mockRejectedValueOnce(new Error("revoked"));
		await expect(f.client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow("unavailable");
		f.authorize
			.mockResolvedValueOnce({ inputSha256: f.input.inputSha256 })
			.mockRejectedValueOnce(new Error("revoked after"));
		await expect(f.client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow("unavailable");
		expect(f.execute).toHaveBeenCalledTimes(1);
	});
	it("rejects a protected receipt for another worker", async () => {
		const f = await fixture();
		f.execute.mockResolvedValue({ ...f.receipt, workerId: randomUUID() });
		await expect(f.client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow("unavailable");
		expect(f.execute).toHaveBeenCalledTimes(1);
	});
	it("refuses insecure origins, URL paths, and noncanonical private credentials", () => {
		for (const url of [
			"http://example.org",
			"http://127.0.0.1:80",
			"https://host/exec",
			"https://user:password@host",
			"https://host/?x=1",
		]) {
			expect(() => parseCloudCodingCommandUrl(url)).toThrow();
		}
		expect(parseCloudCodingCommandUrl("https://coding.example.org/")).toBe("https://coding.example.org");
		expect(
			() =>
				new HttpCloudCodingCommandService({
					token: "z".repeat(43),
					authorize: async () => ({ inputSha256: "a".repeat(64) }),
					execute: async () => null,
				}),
		).toThrow();
	});
	it("does not follow redirects carrying service credentials", async () => {
		const f = await fixture();
		let requests = 0;
		const server: Server = createServer((_request, reply) => {
			requests++;
			reply.writeHead(307, { location: `${f.url}/v1/coding-commands/start` });
			reply.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture port");
		const client = createHttpCloudCodingCommandGateway({
			url: `http://127.0.0.1:${address.port}`,
			token: f.token,
			binding: f.binding,
			authorize: f.clientAuthorize,
			allowLoopback: true,
		});
		await expect(client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow("unavailable");
		expect(requests).toBe(1);
		expect(f.execute).not.toHaveBeenCalled();
	});
	it("awaits listening and closes its socket when the lifetime is aborted", async () => {
		const abort = new AbortController();
		const f = await fixture();
		await f.service.close();
		const port = await f.service.start(abort.signal);
		expect(port).toBeGreaterThan(0);
		abort.abort();
		await f.service.close();
		await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
	});
});
