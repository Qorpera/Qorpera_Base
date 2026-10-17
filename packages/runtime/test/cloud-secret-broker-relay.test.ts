import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CodingMcpSignInRequest,
	type CodingRepositoryFetchRequest,
	PostgresCloudSecretBrokerAuthority,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import type { CloudSecretRelayTarget } from "@qorpera/runtime/cloud-secret-broker-relay";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// 5j-6b: the broker's relay. A running coding session's MCP request goes on to its server with the sign-in's
// header, and its fetch goes on to GitHub with the company's token, so neither value leaves the broker. Real
// envelope sealing and opening; the kernel is a fake authority, and the upstream is a loopback server behind the
// injected transport, which the relay believes is the public address it resolved.

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
const upstreams: Server[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const upstream of upstreams.splice(0)) {
		upstream.closeAllConnections();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	}
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const KEY = "company-kek-1";
const PUBLIC_ADDRESS = "93.184.215.14";
const repository = { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" };
// Values the tests seal. None is a real secret, and none may ever reach an answer or an error.
const MCP_VALUE = "mcp-sign-in-CANARY-0123";
const GITHUB_TOKEN = "gho_relayCANARY0123456789abcdef";
const BASIC = `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")}`;
const notFound = { schema: "qorpera.cloud-secret-error/v1", error: "not_found" };
const unavailable = { schema: "qorpera.cloud-secret-error/v1", error: "unavailable" };

const signal = () => new AbortController().signal;

/** The custody methods these tests never reach. */
function unusedAuthority(): CloudSecretBrokerAuthority {
	const unused = () =>
		vi.fn(async (): Promise<never> => {
			throw new Error("unused");
		});
	return {
		describeCapture: unused(),
		completeCapture: unused(),
		authorizeOperation: unused(),
		authorizeRepositoryCredential: unused(),
	};
}

type Answer = Record<string, unknown>;

/** A broker whose fake kernel authorizes one MCP sign-in and the company's GitHub connection for the asking session;
 * `editMcp` and `editFetch` change the kernel's answers before the broker reads them. */
function brokerFixture(
	options: {
		readonly mcpFields?: Readonly<Record<string, string>>;
		readonly headerName?: string;
		readonly headerPrefix?: string;
		readonly editMcp?: (answer: Answer) => unknown;
		readonly editFetch?: (answer: Answer) => unknown;
	} = {},
) {
	const companyId = randomUUID();
	const environmentId = randomUUID();
	const keyring = new CloudSecretKeyring({ [KEY]: randomBytes(32) });
	keyrings.push(keyring);
	const sealed = (fields: Readonly<Record<string, string>>, version: number) => {
		const identity = { companyId, environmentId, secretId: randomUUID(), version, keyId: KEY };
		const envelope = Buffer.from(keyring.seal(fields, identity));
		return {
			secretId: identity.secretId,
			secretVersion: version,
			keyId: KEY,
			// PostgreSQL's encode(...,'base64') wraps lines; the broker accepts that.
			encryptedEnvelopeBase64: envelope.toString("base64").replace(/(.{76})/g, "$1\n"),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		};
	};
	const mcpSecret = sealed(options.mcpFields ?? { value: MCP_VALUE }, 1);
	const githubSecret = sealed({ access_token: GITHUB_TOKEN }, 2);
	const state = { signIn: true };
	const authorizeCodingMcpSignIn = vi.fn(async (request: CodingMcpSignInRequest) =>
		(options.editMcp ?? ((answer) => answer))({
			schema: "qorpera.coding-mcp-sign-in-authorization/v1",
			companyId,
			environmentId,
			workerId: request.workerId,
			origin: request.origin,
			signIn: state.signIn
				? {
						...mcpSecret,
						ownerKind: "member",
						kind: "api_key",
						headerName: options.headerName ?? "authorization",
						headerPrefix: options.headerPrefix ?? "Bearer ",
					}
				: null,
		}),
	);
	const authorizeCodingRepositoryFetch = vi.fn(async (request: CodingRepositoryFetchRequest) =>
		(options.editFetch ?? ((answer) => answer))({
			schema: "qorpera.coding-repository-fetch-authorization/v1",
			companyId,
			environmentId,
			...githubSecret,
			connectorId: "github",
			credentialName: "access_token",
			workerId: request.workerId,
			repository,
		}),
	);
	const broker = new CloudSecretBroker({
		authority: { ...unusedAuthority(), authorizeCodingMcpSignIn, authorizeCodingRepositoryFetch },
		keyring,
		adapters: [],
	});
	const binding = { workerId: randomUUID(), leaseToken: randomUUID(), executorOwner: "coding-node-02" };
	return { broker, companyId, state, authorizeCodingMcpSignIn, authorizeCodingRepositoryFetch, binding };
}

interface Seen {
	readonly method: string;
	readonly url: string;
	readonly headers: IncomingMessage["headers"];
	readonly body: Buffer;
}

/** The broker's HTTP service with the relay's transport pointed at a loopback upstream. `answer` is the upstream's
 * handler, called once the request's body has arrived. */
async function fixture(options: Parameters<typeof brokerFixture>[0] & { readonly executorToken?: boolean } = {}) {
	const f = brokerFixture(options);
	const seen: Seen[] = [];
	const upstreamCalls = { answer: (_request: IncomingMessage, reply: ServerResponse): void => void reply.end() };
	const upstream = createServer((request, reply) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			seen.push({
				method: request.method ?? "",
				url: request.url ?? "",
				headers: request.headers,
				body: Buffer.concat(chunks),
			});
			upstreamCalls.answer(request, reply);
		});
	});
	upstreams.push(upstream);
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
	const upstreamPort = (upstream.address() as AddressInfo).port;
	const addresses = [PUBLIC_ADDRESS];
	const targets: CloudSecretRelayTarget[] = [];
	const resolve = vi.fn(async (_host: string, _signal: AbortSignal) => [...addresses]);
	const runtimeToken = randomBytes(32).toString("base64url");
	const executorToken = randomBytes(32).toString("base64url");
	const service = new HttpCloudSecretBrokerService(f.broker, runtimeToken, {
		codingExecutorToken: options.executorToken === false ? undefined : executorToken,
		relayTransport: {
			resolve,
			request: (target) => {
				targets.push(target);
				return httpRequest({
					host: "127.0.0.1",
					port: upstreamPort,
					method: target.method,
					path: target.path,
					headers: target.headers,
					agent: false,
				});
			},
		},
	});
	services.push(service);
	const port = await service.start();
	const binding = {
		"x-qorpera-coding-worker": f.binding.workerId,
		"x-qorpera-coding-lease": f.binding.leaseToken,
		"x-qorpera-coding-executor": f.binding.executorOwner,
	};
	const call = (
		route: string,
		init: { method?: string; headers?: Record<string, string>; body?: Uint8Array | string } = {},
	) =>
		fetch(`http://127.0.0.1:${port}${route}${route.includes("?") ? "&" : "?"}company=${f.companyId}`, {
			method: init.method ?? "GET",
			headers: { authorization: `Bearer ${executorToken}`, ...binding, ...init.headers },
			body: init.body,
			redirect: "manual",
		});
	return {
		...f,
		seen,
		targets,
		resolve,
		addresses,
		upstreamCalls,
		runtimeToken,
		executorToken,
		call,
		answer(handler: (request: IncomingMessage, reply: ServerResponse) => void) {
			upstreamCalls.answer = handler;
		},
	};
}

const mcpHeaders = (url = "https://mcp.example.com/mcp") => ({
	"x-qorpera-mcp-url": url,
	accept: "application/json, text/event-stream",
});
const fetchHeaders = (name = "Qorpera/Qorpera_Base") => ({
	"x-qorpera-coding-repository": name,
	"git-protocol": "version=2",
});

async function expectUnavailable(answer: Response): Promise<void> {
	expect(answer.status).toBe(403);
	expect(answer.headers.get("cache-control")).toBe("no-store");
	expect(answer.headers.get("location")).toBeNull();
	expect(await answer.json()).toEqual(unavailable);
}

describe("the relay's gate", () => {
	it("is closed on a broker without the executor's token, and the runtime token never opens it", async () => {
		const bare = await fixture({ executorToken: false });
		const routes = [
			["GET", "/v1/coding-mcp"],
			["POST", "/v1/coding-mcp"],
			["DELETE", "/v1/coding-mcp"],
			["GET", "/v1/coding-repository-fetch/refs"],
			["POST", "/v1/coding-repository-fetch/upload-pack"],
		];
		for (const [method, route] of routes) {
			for (const token of [bare.executorToken, bare.runtimeToken]) {
				const closed = await bare.call(route, {
					method,
					headers: { authorization: `Bearer ${token}`, ...mcpHeaders(), ...fetchHeaders() },
				});
				expect(closed.status).toBe(404);
				expect(await closed.json()).toEqual(notFound);
			}
		}
		const f = await fixture();
		for (const [method, route] of routes) {
			for (const authorization of [
				`Bearer ${f.runtimeToken}`,
				`Bearer ${randomBytes(32).toString("base64url")}`,
				"",
			]) {
				const closed = await f.call(route, {
					method,
					headers: { authorization, ...mcpHeaders(), ...fetchHeaders() },
				});
				expect(closed.status).toBe(404);
				expect(await closed.json()).toEqual(notFound);
			}
		}
		for (const each of [bare, f]) {
			expect(each.authorizeCodingMcpSignIn).not.toHaveBeenCalled();
			expect(each.authorizeCodingRepositoryFetch).not.toHaveBeenCalled();
			expect(each.resolve).not.toHaveBeenCalled();
		}
	});

	it("answers only its own methods and paths, and nothing of receive-pack", async () => {
		const f = await fixture();
		const headers = { ...mcpHeaders(), ...fetchHeaders() };
		for (const [method, route] of [
			["PUT", "/v1/coding-mcp"],
			["PATCH", "/v1/coding-mcp"],
			["POST", "/v1/coding-repository-fetch/refs"],
			["GET", "/v1/coding-repository-fetch/upload-pack"],
			["POST", "/v1/coding-repository-fetch/receive-pack"],
			["POST", "/v1/coding-repository-fetch/git-receive-pack"],
			["GET", "/v1/coding-repository-fetch/info/refs"],
			["GET", "/v1/coding-mcp/sse"],
		]) {
			const closed = await f.call(route, { method, headers });
			expect(closed.status).toBe(404);
			expect(await closed.json()).toEqual(notFound);
		}
		// The routes take no query but the router's company, so no service is ever asked for.
		await expectUnavailable(await f.call("/v1/coding-repository-fetch/refs?service=git-receive-pack", { headers }));
		await expectUnavailable(await f.call("/v1/coding-mcp?service=git-upload-pack", { headers }));
		expect(f.authorizeCodingMcpSignIn).not.toHaveBeenCalled();
		expect(f.authorizeCodingRepositoryFetch).not.toHaveBeenCalled();
		expect(f.targets).toEqual([]);
	});
});

describe("an MCP request through the relay", () => {
	it("goes on to the sign-in's server with its header, its own path and query, and nothing else of the caller's", async () => {
		const f = await fixture();
		f.answer((_request, reply) => {
			reply.writeHead(200, {
				"content-type": "application/json",
				"mcp-session-id": "session-1",
				"set-cookie": "upstream=1",
				"www-authenticate": "Bearer",
				"x-upstream": "1",
			});
			reply.end('{"jsonrpc":"2.0","id":1,"result":{}}');
		});
		const body = '{"jsonrpc":"2.0","id":1,"method":"initialize"}';
		const answer = await f.call("/v1/coding-mcp", {
			method: "POST",
			headers: {
				...mcpHeaders("https://MCP.Example.com:443/v1/mcp?tenant=a&x=1"),
				"content-type": "application/json",
				"mcp-protocol-version": "2025-06-18",
				cookie: "caller=1",
				"x-api-key": "caller-own",
				"x-forwarded-for": "10.0.0.1",
			},
			body,
		});
		expect(answer.status).toBe(200);
		expect(await answer.text()).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
		// Back come the status, the content type and the session, never another header of the server's.
		expect(answer.headers.get("cache-control")).toBe("no-store");
		expect(answer.headers.get("content-type")).toBe("application/json");
		expect(answer.headers.get("mcp-session-id")).toBe("session-1");
		for (const name of ["set-cookie", "www-authenticate", "x-upstream", "content-length"])
			expect(answer.headers.get(name)).toBeNull();
		// The kernel is asked for the server's origin as the vault keeps it.
		expect(f.authorizeCodingMcpSignIn).toHaveBeenCalledExactlyOnceWith(
			{ ...f.binding, origin: "https://mcp.example.com" },
			expect.any(AbortSignal),
		);
		expect(f.resolve).toHaveBeenCalledExactlyOnceWith("mcp.example.com", expect.any(AbortSignal));
		expect(f.targets).toHaveLength(1);
		expect(f.targets[0]).toMatchObject({
			address: PUBLIC_ADDRESS,
			host: "mcp.example.com",
			port: 443,
			method: "POST",
		});
		const [sent] = f.seen;
		expect(sent.method).toBe("POST");
		expect(sent.url).toBe("/v1/mcp?tenant=a&x=1");
		expect(sent.body.toString()).toBe(body);
		expect(sent.headers).toMatchObject({
			host: "mcp.example.com",
			authorization: `Bearer ${MCP_VALUE}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
		});
		for (const name of [
			"cookie",
			"x-api-key",
			"x-forwarded-for",
			"user-agent",
			"accept-encoding",
			"sec-fetch-mode",
			"x-qorpera-mcp-url",
			"x-qorpera-coding-worker",
			"x-qorpera-coding-lease",
			"x-qorpera-coding-executor",
		])
			expect(sent.headers[name]).toBeUndefined();
		expect(JSON.stringify(sent.headers)).not.toContain(f.executorToken);
	});

	it("sends a sign-in under its own header name, and the caller's authorization never", async () => {
		const f = await fixture({ headerName: "x-api-key", headerPrefix: "" });
		f.answer((_request, reply) => {
			reply.writeHead(202);
			reply.end();
		});
		const answer = await f.call("/v1/coding-mcp", {
			method: "POST",
			headers: { ...mcpHeaders("https://mcp.example.com:8443/"), "content-type": "application/json" },
			body: "{}",
		});
		expect(answer.status).toBe(202);
		expect(await answer.text()).toBe("");
		expect(f.targets[0]).toMatchObject({ host: "mcp.example.com", port: 8443 });
		expect(f.seen[0].headers).toMatchObject({ host: "mcp.example.com:8443", "x-api-key": MCP_VALUE });
		expect(f.seen[0].headers.authorization).toBeUndefined();
		expect(f.authorizeCodingMcpSignIn.mock.calls[0][0].origin).toBe("https://mcp.example.com:8443");
	});

	it("streams an event stream chunk by chunk and carries the session both ways", async () => {
		const f = await fixture();
		let release = (): void => undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		f.answer((request, reply) => {
			if (request.method === "DELETE") {
				reply.writeHead(204);
				reply.end();
				return;
			}
			reply.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-7" });
			reply.write('event: message\ndata: {"n":1}\n\n');
			void released.then(() => reply.end('event: message\ndata: {"n":2}\n\n'));
		});
		const answer = await f.call("/v1/coding-mcp", {
			headers: { ...mcpHeaders(), accept: "text/event-stream", "mcp-session-id": "session-7", "last-event-id": "4" },
		});
		expect(answer.status).toBe(200);
		expect(answer.headers.get("content-type")).toBe("text/event-stream");
		expect(answer.headers.get("mcp-session-id")).toBe("session-7");
		const reader = (answer.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let text = "";
		// The first event arrives while the server still holds the stream open.
		while (!text.endsWith("\n\n")) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("The event stream ended early");
			text += decoder.decode(chunk.value);
		}
		expect(text).toBe('event: message\ndata: {"n":1}\n\n');
		release();
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
			text += decoder.decode(chunk.value);
		expect(text).toBe('event: message\ndata: {"n":1}\n\nevent: message\ndata: {"n":2}\n\n');
		expect(f.seen[0].headers).toMatchObject({ "mcp-session-id": "session-7", "last-event-id": "4" });
		// The session ends with a DELETE, which has no body.
		const ended = await f.call("/v1/coding-mcp", {
			method: "DELETE",
			headers: { ...mcpHeaders(), "mcp-session-id": "session-7" },
		});
		expect(ended.status).toBe(204);
		expect(f.seen[1]).toMatchObject({ method: "DELETE", url: "/mcp", headers: { "mcp-session-id": "session-7" } });
		expect(f.authorizeCodingMcpSignIn).toHaveBeenCalledTimes(2);
	});

	it("ends the server's connection when the caller goes away, and the caller's when the server does", async () => {
		const f = await fixture();
		let closed = (): void => undefined;
		const upstreamClosed = new Promise<void>((resolve) => {
			closed = resolve;
		});
		f.answer((_request, reply) => {
			reply.once("close", closed);
			reply.writeHead(200, { "content-type": "text/event-stream" });
			reply.write("data: 1\n\n");
		});
		const left = await f.call("/v1/coding-mcp", { headers: mcpHeaders() });
		const reader = (left.body as ReadableStream<Uint8Array>).getReader();
		await reader.read();
		await reader.cancel();
		await upstreamClosed;
		f.answer((_request, reply) => {
			reply.writeHead(200, { "content-type": "text/event-stream" });
			reply.write("data: 1\n\n", () => reply.destroy());
		});
		const dropped = await f.call("/v1/coding-mcp", { headers: mcpHeaders() });
		// A cut stream is never ended cleanly: the caller sees the failure, not a short answer.
		await expect(dropped.text()).rejects.toThrow();
	});

	it("refuses a session without a sign-in for the server, a private address and a redirect, the first two unconnected", async () => {
		const f = await fixture();
		f.state.signIn = false;
		await expectUnavailable(await f.call("/v1/coding-mcp", { headers: mcpHeaders() }));
		expect(f.authorizeCodingMcpSignIn).toHaveBeenCalledTimes(1);
		expect(f.resolve).not.toHaveBeenCalled();
		f.state.signIn = true;
		for (const addresses of [["10.0.0.5"], [PUBLIC_ADDRESS, "127.0.0.1"], ["169.254.169.254"], []]) {
			f.addresses.splice(0, f.addresses.length, ...addresses);
			await expectUnavailable(await f.call("/v1/coding-mcp", { headers: mcpHeaders() }));
		}
		expect(f.targets).toEqual([]);
		expect(f.seen).toEqual([]);
		f.addresses.splice(0, f.addresses.length, PUBLIC_ADDRESS);
		for (const status of [301, 302, 307, 308]) {
			f.answer((_request, reply) => {
				reply.writeHead(status, { location: "https://elsewhere.example/" });
				reply.end();
			});
			await expectUnavailable(await f.call("/v1/coding-mcp", { headers: mcpHeaders() }));
		}
		// An encoding the caller was never told of would arrive as garbage, so that is refused too.
		f.answer((_request, reply) => {
			reply.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
			reply.end(gzipSync("{}"));
		});
		await expectUnavailable(await f.call("/v1/coding-mcp", { headers: mcpHeaders() }));
		expect(f.seen).toHaveLength(5);
	});

	it("refuses a request whose server, binding or body it cannot send before the kernel is asked", async () => {
		const f = await fixture();
		for (const headers of [
			{ ...mcpHeaders("http://mcp.example.com/mcp") },
			{ ...mcpHeaders("https://user:pass@mcp.example.com/mcp") },
			{ ...mcpHeaders("https://mcp.example.com/mcp#part") },
			{ ...mcpHeaders("mcp.example.com/mcp") },
			{ ...mcpHeaders("https://mcp.example.com:0/mcp") },
			{ "x-qorpera-mcp-url": "", accept: "application/json" },
			{ accept: "application/json" },
			{ ...mcpHeaders(), "x-qorpera-coding-worker": "not-a-uuid" },
			{ ...mcpHeaders(), "x-qorpera-coding-executor": "coding node" },
			{ ...mcpHeaders(), "content-encoding": "gzip" },
		]) {
			await expectUnavailable(await f.call("/v1/coding-mcp", { method: "POST", headers, body: "{}" }));
		}
		// A GET or DELETE carries no body.
		await expectUnavailable(await f.call("/v1/coding-mcp", { method: "DELETE", headers: mcpHeaders(), body: "{}" }));
		expect(f.authorizeCodingMcpSignIn).not.toHaveBeenCalled();
		expect(f.targets).toEqual([]);
	});
});

describe("a repository fetch through the relay", () => {
	it("sends the advertisement and a negotiation round to GitHub with the company's token and git's protocol", async () => {
		const f = await fixture();
		const advertisement = "000eversion 2\n0000";
		const result = Buffer.from("0008NAK\n0000");
		f.answer((request, reply) => {
			reply.writeHead(200, {
				"content-type":
					request.method === "GET"
						? "application/x-git-upload-pack-advertisement"
						: "application/x-git-upload-pack-result",
				"x-github-request-id": "1",
			});
			reply.end(request.method === "GET" ? advertisement : result);
		});
		// GitHub compares owner and name without case; the upstream path is the kernel's spelling.
		const refs = await f.call("/v1/coding-repository-fetch/refs", {
			headers: { ...fetchHeaders("qorpera/qorpera_base"), accept: "*/*" },
		});
		expect(refs.status).toBe(200);
		expect(refs.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
		expect(refs.headers.get("cache-control")).toBe("no-store");
		expect(refs.headers.get("x-github-request-id")).toBeNull();
		expect(await refs.text()).toBe(advertisement);
		const body = gzipSync("0032want 0123456789012345678901234567890123456789\n0000");
		const pack = await f.call("/v1/coding-repository-fetch/upload-pack", {
			method: "POST",
			headers: {
				...fetchHeaders(),
				"content-type": "application/x-git-upload-pack-request",
				"content-encoding": "gzip",
				accept: "application/x-git-upload-pack-result",
			},
			body,
		});
		expect(pack.status).toBe(200);
		expect(pack.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
		expect(Buffer.from(await pack.arrayBuffer()).equals(result)).toBe(true);
		expect(f.authorizeCodingRepositoryFetch).toHaveBeenNthCalledWith(
			1,
			{ ...f.binding, repository: "qorpera/qorpera_base" },
			expect.any(AbortSignal),
		);
		expect(f.authorizeCodingRepositoryFetch).toHaveBeenCalledTimes(2);
		expect(f.resolve).toHaveBeenCalledWith("github.com", expect.any(AbortSignal));
		expect(f.targets.map(({ address, host, port }) => ({ address, host, port }))).toEqual([
			{ address: PUBLIC_ADDRESS, host: "github.com", port: 443 },
			{ address: PUBLIC_ADDRESS, host: "github.com", port: 443 },
		]);
		const [advertised, negotiated] = f.seen;
		expect(advertised).toMatchObject({
			method: "GET",
			url: "/Qorpera/Qorpera_Base.git/info/refs?service=git-upload-pack",
		});
		expect(negotiated).toMatchObject({ method: "POST", url: "/Qorpera/Qorpera_Base.git/git-upload-pack" });
		expect(negotiated.body.equals(body)).toBe(true);
		for (const sent of [advertised, negotiated]) {
			expect(sent.headers).toMatchObject({
				host: "github.com",
				authorization: BASIC,
				"git-protocol": "version=2",
				"user-agent": "qorpera-cloud-secret-broker",
			});
			expect(sent.headers["x-qorpera-coding-repository"]).toBeUndefined();
			expect(sent.headers["accept-encoding"]).toBeUndefined();
		}
		expect(negotiated.headers).toMatchObject({
			"content-type": "application/x-git-upload-pack-request",
			"content-encoding": "gzip",
			"content-length": String(body.length),
		});
	});

	it("refuses another repository before connecting, and any request or answer that is not upload-pack's", async () => {
		const f = await fixture();
		const answers: Response[] = [];
		// A submodule from another repository never gets the session's token.
		answers.push(
			await f.call("/v1/coding-repository-fetch/refs", { headers: fetchHeaders("Qorpera/Qorpera_Website") }),
		);
		expect(f.authorizeCodingRepositoryFetch).toHaveBeenCalledTimes(1);
		expect(f.resolve).not.toHaveBeenCalled();
		const negotiation = { ...fetchHeaders(), "content-type": "application/x-git-upload-pack-request" };
		for (const [route, headers] of [
			[
				"/v1/coding-repository-fetch/refs",
				{ ...fetchHeaders(), "content-type": "application/x-git-upload-pack-request" },
			],
			["/v1/coding-repository-fetch/refs", { ...fetchHeaders(), "git-protocol": "version=2:object-format=sha1" }],
			["/v1/coding-repository-fetch/refs", { "x-qorpera-coding-repository": "Qorpera/Qorpera_Base/extra" }],
			["/v1/coding-repository-fetch/refs", { "x-qorpera-coding-repository": "../Qorpera_Base" }],
			["/v1/coding-repository-fetch/refs", {}],
			[
				"/v1/coding-repository-fetch/upload-pack",
				{ ...negotiation, "content-type": "application/x-git-receive-pack-request" },
			],
			["/v1/coding-repository-fetch/upload-pack", { ...negotiation, "content-type": "application/json" }],
			["/v1/coding-repository-fetch/upload-pack", { ...negotiation, "content-encoding": "br" }],
			["/v1/coding-repository-fetch/upload-pack", fetchHeaders()],
		] as const) {
			const method = route.endsWith("/refs") ? "GET" : "POST";
			answers.push(await f.call(route, { method, headers, body: method === "POST" ? "0000" : undefined }));
		}
		expect(f.authorizeCodingRepositoryFetch).toHaveBeenCalledTimes(1);
		// An answer that is not an advertisement or a result, or a redirect, goes no further.
		for (const [status, type] of [
			[200, "text/html"],
			[200, "application/x-git-receive-pack-advertisement"],
			[302, "text/html"],
		] as const) {
			f.answer((_request, reply) => {
				reply.writeHead(status, { "content-type": type, location: "https://github.com/login" });
				reply.end(`<p>${GITHUB_TOKEN}</p>`);
			});
			answers.push(await f.call("/v1/coding-repository-fetch/refs", { headers: fetchHeaders() }));
		}
		for (const answer of answers) await expectUnavailable(answer);
		expect(f.seen).toHaveLength(3);
		// GitHub's own refusal goes back as it is, without its headers.
		f.answer((_request, reply) => {
			reply.writeHead(401, { "content-type": "text/plain", "www-authenticate": 'Basic realm="GitHub"' });
			reply.end("Invalid username or token.");
		});
		const refused = await f.call("/v1/coding-repository-fetch/refs", { headers: fetchHeaders() });
		expect(refused.status).toBe(401);
		expect(refused.headers.get("www-authenticate")).toBeNull();
		const text = await refused.text();
		expect(text).toBe("Invalid username or token.");
		for (const value of [GITHUB_TOKEN, BASIC.slice("Basic ".length), MCP_VALUE])
			expect(`${text}${JSON.stringify(Object.fromEntries(refused.headers))}`).not.toContain(value);
	});
});

describe("the broker's relay sign-ins", () => {
	it("opens an MCP sign-in to its header for the session's company and the asked origin only", async () => {
		const origin = "https://mcp.example.com";
		const f = brokerFixture();
		await expect(
			f.broker.codingMcpSignIn({ ...f.binding, origin }, signal(), f.companyId.toUpperCase()),
		).resolves.toEqual({ origin, path: "", headerName: "authorization", headerValue: `Bearer ${MCP_VALUE}` });
		// Another company's broker on the shared vault is refused.
		await expect(f.broker.codingMcpSignIn({ ...f.binding, origin }, signal(), randomUUID())).rejects.toThrow(
			"Coding MCP sign-in is unavailable",
		);
		const signIn = (answer: Answer, change: Record<string, unknown>) => ({
			...answer,
			signIn: { ...(answer.signIn as Answer), ...change },
		});
		const edits: ((answer: Answer) => unknown)[] = [
			(answer) => ({ ...answer, workerId: randomUUID() }),
			(answer) => ({ ...answer, origin: "https://other.example.com" }),
			(answer) => ({ ...answer, extra: true }),
			(answer) => signIn(answer, { extra: true }),
			// OAuth is 5j-7's.
			(answer) => signIn(answer, { kind: "oauth" }),
			(answer) => signIn(answer, { ownerKind: "agent" }),
			(answer) => signIn(answer, { headerName: "cookie" }),
			(answer) => signIn(answer, { headerName: "mcp-session-id" }),
			(answer) => signIn(answer, { headerName: "proxy-authorization" }),
			(answer) => signIn(answer, { headerName: "Authorization" }),
			(answer) => signIn(answer, { headerPrefix: "Bearer" }),
			(answer) => signIn(answer, { headerPrefix: "Bearer\r\n" }),
			(answer) => signIn(answer, { envelopeSha256: "0".repeat(64) }),
		];
		for (const editMcp of edits) {
			const edited = brokerFixture({ editMcp });
			const error = await edited.broker
				.codingMcpSignIn({ ...edited.binding, origin }, signal())
				.catch((failure: unknown) => failure);
			expect((error as Error).message).toBe("Coding MCP sign-in is unavailable");
			expect((error as Error).cause).toBeUndefined();
		}
		// A sealed value the relay could never send on one header line is not sent.
		for (const mcpFields of [
			{ token: MCP_VALUE },
			{ value: MCP_VALUE, other: "x" },
			{ value: `${MCP_VALUE}\r\nx: y` },
		] as Record<string, string>[]) {
			const sealed = brokerFixture({ mcpFields });
			const error = await sealed.broker
				.codingMcpSignIn({ ...sealed.binding, origin }, signal())
				.catch((failure: unknown) => failure);
			expect((error as Error).message).toBe("Coding MCP sign-in is unavailable");
			expect(`${(error as Error).stack}`).not.toContain(MCP_VALUE);
		}
	});

	it("opens the fetch's token only for the session's repository, and refuses on a broker that cannot ask", async () => {
		const f = brokerFixture();
		await expect(
			f.broker.codingRepositoryFetch({ ...f.binding, repository: "QORPERA/qorpera_base" }, signal(), f.companyId),
		).resolves.toEqual({
			origin: "https://github.com",
			path: "/Qorpera/Qorpera_Base.git",
			headerName: "authorization",
			headerValue: BASIC,
		});
		for (const editFetch of [
			(answer: Answer) => ({ ...answer, repository: { ...repository, name: "Qorpera_Website" } }),
			(answer: Answer) => ({ ...answer, connectorId: "linear" }),
			(answer: Answer) => ({ ...answer, credentialName: "refresh_token" }),
			(answer: Answer) => ({ ...answer, workerId: randomUUID() }),
			(answer: Answer) => ({ ...answer, extra: true }),
		]) {
			const edited = brokerFixture({ editFetch });
			await expect(
				edited.broker.codingRepositoryFetch({ ...edited.binding, repository: "Qorpera/Qorpera_Base" }, signal()),
			).rejects.toThrow("Coding repository fetch is unavailable");
		}
		const error = await f.broker
			.codingRepositoryFetch({ ...f.binding, repository: "Qorpera/Qorpera_Base" }, signal(), randomUUID())
			.catch((failure: unknown) => failure);
		expect((error as Error).message).toBe("Coding repository fetch is unavailable");
		expect(`${(error as Error).stack}`).not.toContain(GITHUB_TOKEN);
		const keyring = new CloudSecretKeyring({ [KEY]: randomBytes(32) });
		keyrings.push(keyring);
		const unable = new CloudSecretBroker({ authority: unusedAuthority(), keyring, adapters: [] });
		await expect(
			unable.codingMcpSignIn({ ...f.binding, origin: "https://mcp.example.com" }, signal()),
		).rejects.toThrow("Coding MCP sign-in is unavailable");
		await expect(
			unable.codingRepositoryFetch({ ...f.binding, repository: "Qorpera/Qorpera_Base" }, signal()),
		).rejects.toThrow("Coding repository fetch is unavailable");
	});

	it("asks the broker's database with the two static calls", async () => {
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const authorityId = randomUUID();
		const capability = randomBytes(32).toString("base64url");
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					queries.push({ text, values });
					return { rowCount: 1, rows: [{ result: { accepted: true } } as unknown as Row] };
				},
			},
			brokerAuthorityId: authorityId,
			brokerCapability: capability,
		});
		const binding = { workerId: randomUUID(), leaseToken: randomUUID(), executorOwner: "coding-node-02" };
		await expect(
			authority.authorizeCodingMcpSignIn({ ...binding, origin: "https://mcp.example.com" }, signal()),
		).resolves.toEqual({ accepted: true });
		await expect(
			authority.authorizeCodingRepositoryFetch({ ...binding, repository: "Qorpera/Qorpera_Base" }, signal()),
		).resolves.toEqual({ accepted: true });
		const bound = [
			authorityId,
			createHash("sha256").update(capability).digest("hex"),
			binding.workerId,
			binding.leaseToken,
			binding.executorOwner,
		];
		expect(queries).toEqual([
			{
				text: "select public.qorpera_authorize_coding_mcp_sign_in($1::uuid,$2::text,$3::uuid,$4::uuid,$5::text,$6::text) as result",
				values: [...bound, "https://mcp.example.com"],
			},
			{
				text: "select public.qorpera_authorize_coding_repository_fetch($1::uuid,$2::text,$3::uuid,$4::uuid,$5::text) as result",
				values: bound,
			},
		]);
	});
});

describe("capturing an MCP sign-in", () => {
	function captureFixture() {
		const keyring = new CloudSecretKeyring({ [KEY]: randomBytes(32) });
		keyrings.push(keyring);
		const description = {
			schema: "qorpera.cloud-secret-capture-description/v1",
			ticketId: randomUUID(),
			companyId: randomUUID(),
			environmentId: randomUUID(),
			secretId: randomUUID(),
			version: 1,
			ownerKind: "member",
			ownerUserId: randomUUID(),
			connectorId: "mcp",
			secretName: "mcp-mcp-example-com-0123456789abcdef",
			purpose: "A coding session's MCP server sign-in",
			keyId: KEY,
			expiresAt: "2099-08-29T12:00:00.000Z",
		};
		const describeCapture = vi.fn(async () => description);
		const completeCapture = vi.fn(async () => ({
			schema: "qorpera.cloud-secret-descriptor/v1",
			secretId: description.secretId,
			version: description.version,
			connectorId: "mcp",
			secretName: description.secretName,
			purpose: description.purpose,
			ownerKind: "member",
			ownerUserId: description.ownerUserId,
			status: "active",
		}));
		const broker = new CloudSecretBroker({
			authority: { ...unusedAuthority(), describeCapture, completeCapture },
			keyring,
			adapters: [],
		});
		const capture = (fields: Readonly<Record<string, string>>) =>
			broker.capture(
				{ ticketId: description.ticketId, captureCapability: randomBytes(32).toString("base64url"), fields },
				signal(),
			);
		return { capture, describeCapture, completeCapture };
	}

	it("seals only a value the relay can send on one header line", async () => {
		for (const value of [MCP_VALUE, "sk live 0123", "x", "~".repeat(4096)]) {
			const f = captureFixture();
			await f.capture({ value });
			expect(f.completeCapture).toHaveBeenCalledTimes(1);
		}
		for (const fields of [
			{ token: MCP_VALUE },
			{ value: MCP_VALUE, other: "x" },
			{ value: `${MCP_VALUE}\r\nx-injected: 1` },
			{ value: `${MCP_VALUE}\0` },
			{ value: ` ${MCP_VALUE}` },
			{ value: `${MCP_VALUE} ` },
			{ value: `${MCP_VALUE}\t` },
			{ value: `${MCP_VALUE}é` },
			{ value: "~".repeat(4097) },
		] as Record<string, string>[]) {
			const f = captureFixture();
			const error = await f.capture(fields).catch((failure: unknown) => failure);
			expect((error as Error).message).toBe("Cloud secret capture was not confirmed");
			expect(String(error)).not.toContain(MCP_VALUE);
			expect(f.describeCapture).toHaveBeenCalledTimes(1);
			expect(f.completeCapture).not.toHaveBeenCalled();
		}
	});
});
