import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CloudCodingCommandExecution,
	CloudCodingCommandServiceOptions,
} from "../src/cloud-coding-command-http.ts";
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
	const hidden = vi.fn<CloudCodingCommandExecution["hidden"]>(async () => undefined);
	const execute = vi.fn<CloudCodingCommandServiceOptions["execute"]>(async () => ({ receipt, hidden }));
	// G2-6b: the database's lease proof stands in here (its own test is 986): only the run's own lease token, as
	// `job.<the binding's job>.<lease token>`, proves a request's binding.
	const lease = randomBytes(32).toString("base64url");
	const holder = `job.${binding.jobId}.${lease}`;
	const proveBinding = vi.fn<NonNullable<CloudCodingCommandServiceOptions["proveBinding"]>>(
		async (presented, identity) => {
			if (identity !== `job.${presented.jobId.toLowerCase()}.${lease}`)
				throw new Error("native binding proof is refused");
		},
	);
	const service = new HttpCloudCodingCommandService({ token, proveBinding, authorize, execute, ...changes });
	const port = await service.start();
	cleanups.push(() => service.close());
	const url = `http://127.0.0.1:${port}`;
	const clientAuthorize = vi.fn(async () => undefined);
	const client = createHttpCloudCodingCommandGateway({
		url,
		token,
		binding,
		holder: () => holder,
		authorize: clientAuthorize,
		allowLoopback: true,
	});
	const request = { schema: "qorpera.coding-command-http/v1", binding, scope, action: "start", input };
	return {
		token,
		binding,
		scope,
		input,
		receipt,
		authorize,
		hidden,
		execute,
		service,
		url,
		client,
		clientAuthorize,
		request,
		lease,
		holder,
		proveBinding,
	};
}
async function raw(
	f: Awaited<ReturnType<typeof fixture>>,
	value: unknown,
	route = "start",
	token = f.token,
	// `null` sends no holder (an omitted argument sends the run's own).
	identity: string | null = f.holder,
) {
	return fetch(`${f.url}/v1/coding-commands/${route}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...(identity === null ? {} : { "x-qorpera-identity": identity }),
		},
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
	it("serves a command only after the run's own lease proves its binding (G2-6b)", async () => {
		const f = await fixture();
		// No holder, a malformed one, another run's, or another lease token for this run's job: refused before the
		// command's authorization is asked anything, and the reply carries nothing of the holder.
		for (const identity of [
			null,
			"",
			f.lease,
			`identity.${f.lease}`,
			`${f.holder}x`,
			`job.${f.binding.jobId.toUpperCase()}.${f.lease}`,
			`job.${randomUUID()}.${f.lease}`,
			`job.${f.binding.jobId}.${"W".repeat(43)}`,
		])
			for (const route of ["start", "read", "cancel"]) {
				const input = route === "start" ? f.input : { commandId: f.input.commandId };
				const refused = await raw(f, { ...f.request, action: route, input }, route, f.token, identity);
				expect(refused.status).toBe(403);
				expect(await refused.text()).not.toContain(f.lease);
			}
		expect(f.authorize).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
		// Only a well-formed holder reaches the proof, with the request's own binding.
		expect(f.proveBinding).toHaveBeenCalledTimes(6);
		expect(
			f.proveBinding.mock.calls.every(([binding]) => JSON.stringify(binding) === JSON.stringify(f.binding)),
		).toBe(true);
		// The run's own lease is served, its proof first.
		f.proveBinding.mockClear();
		expect(await f.client.start(f.scope, f.input, new AbortController().signal)).toEqual(f.receipt);
		expect(f.proveBinding).toHaveBeenCalledWith(f.binding, f.holder, expect.any(AbortSignal));
		expect(f.proveBinding.mock.invocationCallOrder[0]).toBeLessThan(f.authorize.mock.invocationCallOrder[0] ?? 0);
	});
	it("takes no holder on the executors' peer listener, whose token only executors hold", async () => {
		const f = await fixture({ proveBinding: null });
		const response = await raw(f, f.request, "start", f.token, null);
		expect(response.status).toBe(200);
		expect(f.authorize).toHaveBeenCalledTimes(2);
		expect(f.proveBinding).not.toHaveBeenCalled();
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
				input: { ...f.request, input: { ...f.input, timeoutMs: 999 } },
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
		expect(f.hidden).not.toHaveBeenCalled();
	});
	// F3 5g-5: what of the command the receipt shows is decided once, after the call's final authorization.
	const shown = {
		state: "succeeded",
		exitCode: 0,
		output: "secret",
		truncated: false,
		log: { offset: 0, nextOffset: 6, totalBytes: 6, limitBytes: 67108864, limitReached: false },
	};
	const nothing = (state: string) => ({
		state,
		exitCode: null,
		output: "",
		truncated: false,
		log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
	});
	it("shows nothing of a command whose machine was rebuilt during the call's final authorization (F3 5g-5)", async () => {
		const f = await fixture();
		f.execute.mockResolvedValue({ receipt: { ...f.receipt, ...shown }, hidden: f.hidden });
		let rebuilt = false;
		f.authorize.mockResolvedValueOnce({ inputSha256: f.input.inputSha256 }).mockImplementationOnce(async () => {
			rebuilt = true;
			return { inputSha256: f.input.inputSha256 };
		});
		f.hidden.mockImplementation(async () => (rebuilt ? "machine_stopped" : undefined));
		for (const action of ["read", "cancel"] as const)
			expect(
				await (action === "read"
					? f.client.read(f.scope, { commandId: f.input.commandId }, new AbortController().signal)
					: f.client.cancel(f.scope, f.input.commandId, new AbortController().signal)),
			).toStrictEqual({ ...f.receipt, ...nothing("machine_stopped") });
		expect(f.hidden).toHaveBeenCalledTimes(2);
		expect(f.hidden.mock.invocationCallOrder[0]).toBeGreaterThan(f.authorize.mock.invocationCallOrder[1] ?? 0);
		// The machine's own word for one it can say nothing of now; a shown command is answered as it is.
		f.hidden.mockResolvedValueOnce("unconfirmed").mockResolvedValueOnce(undefined);
		expect(await f.client.start(f.scope, f.input, new AbortController().signal)).toStrictEqual({
			...f.receipt,
			...nothing("unconfirmed"),
		});
		expect(await f.client.start(f.scope, f.input, new AbortController().signal)).toStrictEqual({
			...f.receipt,
			...shown,
		});
		// Any other answer is refused, one the receipt could carry included.
		f.hidden.mockResolvedValueOnce("running" as never);
		await expect(f.client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow("unavailable");
		f.hidden.mockRejectedValueOnce(new Error("disk unknown"));
		await expect(f.client.start(f.scope, f.input, new AbortController().signal)).rejects.toThrow("unavailable");
	});
	it("answers a paged read across a rebuild as machine_stopped, not unavailable (F3 5g-5)", async () => {
		const f = await fixture();
		f.execute.mockResolvedValueOnce({
			receipt: {
				...f.receipt,
				output: "first",
				truncated: true,
				log: { offset: 0, nextOffset: 5, totalBytes: 13, limitBytes: 67108864, limitReached: false },
			},
			hidden: f.hidden,
		});
		const first = await f.client.read(
			f.scope,
			{ commandId: f.input.commandId, limit: 5 },
			new AbortController().signal,
		);
		expect(first).toMatchObject({ output: "first", log: { nextOffset: 5 } });
		// The machine is rebuilt before the next page: its executor reads it at the page asked, and the service shows
		// nothing of it, whatever page that was.
		f.execute.mockResolvedValueOnce({
			receipt: {
				...f.receipt,
				output: "still",
				truncated: true,
				log: { offset: 5, nextOffset: 10, totalBytes: 13, limitBytes: 67108864, limitReached: false },
			},
			hidden: async () => "machine_stopped",
		});
		expect(
			await f.client.read(
				f.scope,
				{ commandId: f.input.commandId, offset: 5, limit: 5 },
				new AbortController().signal,
			),
		).toStrictEqual({ ...f.receipt, ...nothing("machine_stopped") });
		expect(f.execute.mock.calls[1]?.[0]).toMatchObject({ input: { offset: 5, limit: 5 } });
	});
	it("still refuses a receipt for another page unless it shows nothing at all (F3 5g-5)", async () => {
		const f = await fixture();
		const page = { commandId: f.input.commandId, offset: 5, limit: 64 };
		for (const receipt of [
			{ ...f.receipt, log: { ...f.receipt.log, offset: 0 } },
			// Shows no output, but how much it printed.
			{
				...f.receipt,
				...nothing("machine_stopped"),
				log: { ...nothing("").log, offset: 13, nextOffset: 13, totalBytes: 13 },
			},
			// Shows nothing but how it ended.
			{ ...f.receipt, ...nothing("unconfirmed"), state: "failed", exitCode: 1 },
		]) {
			f.execute.mockResolvedValueOnce({ receipt, hidden: f.hidden });
			await expect(f.client.read(f.scope, page, new AbortController().signal)).rejects.toThrow("unavailable");
		}
		f.execute.mockResolvedValueOnce({ receipt: { ...f.receipt, ...nothing("unconfirmed") }, hidden: f.hidden });
		expect(await f.client.read(f.scope, page, new AbortController().signal)).toMatchObject({ state: "unconfirmed" });
	});
	it("rejects a protected receipt for another worker", async () => {
		const f = await fixture();
		f.execute.mockResolvedValue({ receipt: { ...f.receipt, workerId: randomUUID() }, hidden: f.hidden });
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
					proveBinding: null,
					authorize: async () => ({ inputSha256: "a".repeat(64) }),
					execute: async () => ({ receipt: null, hidden: async () => undefined }),
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
			holder: () => f.holder,
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
