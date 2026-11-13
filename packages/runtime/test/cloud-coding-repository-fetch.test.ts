import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BrokerRepositoryFetch, publicGitHubTransport } from "../../../deploy/coding-worker/repository-fetch.ts";
import {
	type CodeImportAnswer,
	type CodeImportSink,
	CodeImportStop,
	type CodeImportTransport,
	codeImportPktLine,
	codeImportRelayRefusals,
} from "../../runner-orchestrator/src/code-import.ts";
import { fetchGitHubImport } from "../../runner-orchestrator/src/code-import-fetch.ts";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CodingRepositoryFetchRequest,
} from "../src/cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService } from "../src/cloud-secret-broker-http.ts";
import type { CloudSecretRelayTarget, CloudSecretRelayTransport } from "../src/cloud-secret-broker-relay.ts";
import type { CloudSecretBrokerCompanies } from "../src/cloud-secret-broker-shared.ts";
import { CloudSecretKeyring } from "../src/cloud-secret-crypto.ts";
import { markCloudVaultDatabaseFailure } from "../src/cloud-vault-database-failure.ts";

// Step 6, part C2: the import's two transports. Through the company's GitHub connection the executor asks the shared
// vault's relay (the real broker HTTP service, in its shared-vault form, with real envelope sealing and opening; the
// kernel is a fake authority), whose upstream is a loopback server the relay believes is GitHub's public address;
// a public project goes straight to github.com through the relay's own connection rules, here pointed at the same
// loopback server. Real git (`upload-pack --stateless-rpc`, protocol v2) answers where a whole import is fetched.

const GIT = "/usr/bin/git";
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const KEY = "company-kek-1";
const PUBLIC_ADDRESS = "93.184.215.14";
const ORIGIN = "https://secrets.qorpera.test";
const REPOSITORY = { owner: "Acme", name: "Shop" };
// Values the tests seal or the sources say. None may reach an error, a log or an answer.
const GITHUB_TOKEN = "gho_fetchCANARY0123456789abcdef";
const BASIC = `Basic ${Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64")}`;
const CANARY = "remote-words-CANARY-91c2";
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const keyring of keyrings.splice(0)) keyring.close();
});
afterAll(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

let home = "",
	small = "";
const gitEnv = () => ({
	PATH: "/usr/local/bin:/usr/bin:/bin",
	HOME: home,
	LC_ALL: "C",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
});
async function git(dir: string, args: string[]) {
	const child = spawn(GIT, args, { cwd: dir, env: gitEnv() });
	const out: Buffer[] = [],
		err: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
	const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${Buffer.concat(err)}`);
	return Buffer.concat(out).toString().trim();
}
beforeAll(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "repository-fetch-")));
	roots.push(home);
	const work = join(home, "work");
	await mkdir(work);
	await git(work, ["init", "--quiet", "--initial-branch=main"]);
	await writeFile(join(work, "a.txt"), "one\n");
	await git(work, ["add", "."]);
	await git(work, ["commit", "--quiet", "-m", "one"]);
	await git(work, ["tag", "-a", "v1", "-m", "release one"]);
	await writeFile(join(work, "b.txt"), "two\n");
	await git(work, ["add", "."]);
	await git(work, ["commit", "--quiet", "-m", "two"]);
	small = join(home, "small.git");
	await git(home, ["clone", "--quiet", "--bare", work, small]);
}, 60_000);

/** Real git's answer to one smart HTTP request of protocol v2: the advertisement (GitHub's form, with its service line)
 * or upload-pack's for the request's body. */
function gitAnswer(incoming: IncomingMessage, body: Buffer, reply: ServerResponse) {
	const refs = incoming.method === "GET";
	const env = { ...gitEnv(), GIT_PROTOCOL: "version=2" };
	const child = refs
		? spawn(GIT, ["upload-pack", "--http-backend-info-refs", small], { env })
		: spawn(GIT, ["upload-pack", "--stateless-rpc", small], { env });
	child.stdin.on("error", () => {});
	child.stdin.end(refs ? undefined : body);
	reply.on("close", () => child.kill());
	reply.writeHead(200, { "content-type": `application/x-git-upload-pack-${refs ? "advertisement" : "result"}` });
	if (refs) reply.write("001e# service=git-upload-pack\n0000");
	child.stdout.pipe(reply);
}

interface Seen {
	readonly method: string;
	readonly url: string;
	readonly headers: IncomingMessage["headers"];
	readonly body: Buffer;
}
type Handler = (incoming: IncomingMessage, body: Buffer, reply: ServerResponse) => void;

/** A loopback HTTP server that records each request and answers it with `handler` (real git by default). */
async function upstream(handler: { answer: Handler } = { answer: gitAnswer }) {
	const seen: Seen[] = [];
	const server = createServer((incoming, reply) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const body = Buffer.concat(chunks);
			seen.push({ method: incoming.method ?? "", url: incoming.url ?? "", headers: incoming.headers, body });
			handler.answer(incoming, body, reply);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	return { port: (server.address() as AddressInfo).port, seen, handler };
}

/** The relay's connection, believing the loopback server is the public address it resolved. */
function relayTo(port: number, addresses = [PUBLIC_ADDRESS]) {
	const targets: CloudSecretRelayTarget[] = [];
	const relay: CloudSecretRelayTransport = {
		resolve: vi.fn(async () => [...addresses]),
		request: (target) => {
			targets.push(target);
			return httpRequest({
				host: "127.0.0.1",
				port,
				method: target.method,
				path: target.path,
				headers: target.headers,
				agent: false,
			});
		},
	};
	return { relay, targets };
}

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

/** The shared vault serving one company, its relay to `source`, and the executor's transports to it. */
async function vault(source: { port: number }, options: { proxyPort?: (brokerPort: number) => Promise<number> } = {}) {
	const companyId = randomUUID(),
		environmentId = randomUUID();
	const keyring = new CloudSecretKeyring({ [KEY]: randomBytes(32) });
	keyrings.push(keyring);
	const identity = { companyId, environmentId, secretId: randomUUID(), version: 2, keyId: KEY };
	const envelope = Buffer.from(keyring.seal({ access_token: GITHUB_TOKEN }, identity));
	const state = { refuse: false, busy: false };
	const authorizeCodingRepositoryFetch = vi.fn(async (request: CodingRepositoryFetchRequest) => {
		if (state.refuse) throw new Error(`no grant ${CANARY}`);
		return {
			schema: "qorpera.coding-repository-fetch-authorization/v1",
			companyId,
			environmentId,
			secretId: identity.secretId,
			secretVersion: identity.version,
			keyId: KEY,
			connectorId: "github",
			credentialName: "access_token",
			encryptedEnvelopeBase64: envelope.toString("base64"),
			envelopeSha256: hashOf(envelope),
			workerId: request.workerId,
			repository: { host: "github.com", owner: "Acme", name: "Shop", baseBranch: "main" },
		};
	});
	const broker = new CloudSecretBroker({
		authority: { ...unusedAuthority(), authorizeCodingRepositoryFetch },
		keyring,
		adapters: [],
	});
	const companies: CloudSecretBrokerCompanies = {
		resolve: async (id) => {
			if (state.busy) throw markCloudVaultDatabaseFailure(new Error("Connection terminated unexpectedly"));
			if (id !== companyId) return undefined;
			return {
				companyId,
				broker,
				modelLogins: {} as never,
				modelLoginSignIns: undefined,
				modelLoginUsage: {} as never,
			};
		},
		signingIn: () => undefined,
	};
	const { relay, targets } = relayTo(source.port);
	const runtimeToken = randomBytes(32).toString("base64url");
	const executorToken = randomBytes(32).toString("base64url");
	const service = new HttpCloudSecretBrokerService(companies, runtimeToken, {
		codingExecutorToken: executorToken,
		relayTransport: relay,
	});
	services.push(service);
	const brokerPort = await service.start();
	const port = options.proxyPort ? await options.proxyPort(brokerPort) : brokerPort;
	const calls: { url: string; init: RequestInit }[] = [];
	// The shared public origin, rewritten to the loopback listener.
	const rewrite: typeof fetch = (input, init) => {
		const url = new URL(String(input));
		calls.push({ url: url.href, init: init ?? {} });
		return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
	};
	const transports = (token = executorToken) =>
		new BrokerRepositoryFetch({
			origin: ORIGIN,
			executorToken: token,
			executorOwner: "coding-node-02",
			fetch: rewrite,
		});
	const scope = {
		companyId: companyId.toUpperCase(),
		requestId: randomUUID().toUpperCase(),
		leaseToken: randomUUID(),
	};
	return { companyId, state, authorizeCodingRepositoryFetch, targets, calls, transports, scope, executorToken };
}

function memory(): CodeImportSink & { bytes: () => Buffer } {
	const pieces: Buffer[] = [];
	return {
		bytes: () => Buffer.concat(pieces),
		write: async (chunk: Uint8Array) => {
			pieces.push(Buffer.from(chunk));
		},
	};
}

const fetchOf = (
	transport: CodeImportTransport,
	writer: CodeImportSink = memory(),
	bounds: { idleMs?: number; fetchMs?: number } = {},
) =>
	fetchGitHubImport(
		{
			transport,
			repository: { owner: "Acme", name: "Shop" },
			branch: null,
			maximumBytes: GiB,
			signal: new AbortController().signal,
		},
		writer,
		bounds,
	);

/** Nothing of a secret, of the executor's token or of a source's words in an error. */
function clean(error: unknown, ...secrets: string[]) {
	const text = `${String(error)} ${(error as Error)?.stack} ${JSON.stringify(error)} ${String((error as Error)?.cause)}`;
	for (const secret of [GITHUB_TOKEN, BASIC, CANARY, ...secrets]) expect(text).not.toContain(secret);
}
async function stopped(work: Promise<unknown>, ...secrets: string[]) {
	const error = await work.then(
		() => null,
		(caught: unknown) => caught,
	);
	if (!(error instanceof CodeImportStop)) throw new Error(`not a stop: ${String(error)}`);
	clean(error, ...secrets);
	return `${error.end} ${error.code}`;
}

/** The first bundle proven by git: it verifies, and every ref fetches strictly into a new repository. */
async function proveBundle(bytes: Buffer) {
	const top = await realpath(await mkdtemp(join(tmpdir(), "repository-fetch-proof-")));
	roots.push(top);
	const file = join(top, "first.bundle");
	await writeFile(file, bytes);
	await git(top, ["init", "--quiet", "--bare", "proof.git"]);
	const proof = join(top, "proof.git");
	await git(top, [`--git-dir=${proof}`, "bundle", "verify", "--quiet", file]);
	await git(top, [
		`--git-dir=${proof}`,
		"-c",
		"transfer.fsckObjects=true",
		"fetch",
		"--quiet",
		"--no-tags",
		"--no-write-fetch-head",
		file,
		"+refs/*:refs/*",
	]);
	await git(top, [`--git-dir=${proof}`, "fsck", "--full", "--strict", "--no-progress"]);
	const refs = (dir: string) => git(dir, ["for-each-ref", "--format=%(objectname) %(refname)"]);
	expect(await refs(proof)).toBe(await refs(small));
}

describe("an import through the company's GitHub connection (BrokerRepositoryFetch)", { timeout: 60_000 }, () => {
	it("asks the relay exactly, the token never leaves the broker, and git takes the bundle", async () => {
		const source = await upstream();
		const f = await vault(source);
		const transport = f.transports().connection(f.scope, { owner: "Acme", name: "Shop" });
		const sink = memory();
		const fetched = await fetchOf(transport, sink);
		await proveBundle(sink.bytes());
		expect(hashOf(sink.bytes())).toBe(fetched.sha256);

		const company = f.companyId.toLowerCase();
		const headers = {
			authorization: `Bearer ${f.executorToken}`,
			"x-qorpera-coding-worker": f.scope.requestId.toLowerCase(),
			"x-qorpera-coding-lease": f.scope.leaseToken,
			"x-qorpera-coding-executor": "coding-node-02",
			"x-qorpera-coding-repository": "Acme/Shop",
			"git-protocol": "version=2",
		};
		const post = {
			...headers,
			"content-type": "application/x-git-upload-pack-request",
			accept: "application/x-git-upload-pack-result",
		};
		expect(f.calls.map(({ url, init }) => [url, init.method, init.redirect, init.headers])).toEqual([
			[`${ORIGIN}/v1/coding-repository-fetch/refs?company=${company}`, "GET", "error", headers],
			[`${ORIGIN}/v1/coding-repository-fetch/upload-pack?company=${company}`, "POST", "error", post],
			[`${ORIGIN}/v1/coding-repository-fetch/upload-pack?company=${company}`, "POST", "error", post],
		]);
		expect(f.calls[0]?.init.body).toBeUndefined();
		expect(Buffer.from(f.calls[1]?.init.body as Uint8Array)).toEqual(source.seen[1]?.body);
		// The kernel was asked for each request, as for the import's own lease.
		expect(f.authorizeCodingRepositoryFetch).toHaveBeenCalledTimes(3);
		expect(f.authorizeCodingRepositoryFetch).toHaveBeenNthCalledWith(
			1,
			{
				workerId: f.scope.requestId.toLowerCase(),
				leaseToken: f.scope.leaseToken,
				executorOwner: "coding-node-02",
				repository: "Acme/Shop",
			},
			expect.any(AbortSignal),
		);
		// GitHub got the connection's token from the broker, and never the executor's.
		expect(source.seen.map(({ method, url }) => [method, url])).toEqual([
			["GET", "/Acme/Shop.git/info/refs?service=git-upload-pack"],
			["POST", "/Acme/Shop.git/git-upload-pack"],
			["POST", "/Acme/Shop.git/git-upload-pack"],
		]);
		for (const seen of source.seen) {
			expect(seen.headers.authorization).toBe(BASIC);
			expect(seen.headers["git-protocol"]).toBe("version=2");
			expect(JSON.stringify(seen.headers)).not.toContain(f.executorToken);
		}
		expect(f.targets.every((target) => target.host === "github.com" && target.address === PUBLIC_ADDRESS)).toBe(true);
	});

	it("maps GitHub's answers and the relay's own: refused, busy, refused at the third 403 in a row, not routed", async () => {
		const source = await upstream();
		const f = await vault(source);
		const transport = f.transports().connection(f.scope, { owner: "Acme", name: "Shop" });
		const answering = (status: number, extra: Record<string, string> = {}) => {
			source.handler.answer = (_incoming, _body, reply) => {
				reply.writeHead(status, { "content-type": "text/plain", ...extra });
				reply.end(`Repository not found. ${CANARY}\n`);
			};
		};
		for (const status of [401, 403, 404]) {
			answering(status);
			expect(await stopped(fetchOf(transport), f.executorToken), `${status}`).toBe("refused IMPORT_SOURCE_REFUSED");
		}
		answering(503);
		expect(await stopped(fetchOf(transport), f.executorToken)).toBe("busy IMPORT_SOURCE_BUSY");
		// A renamed project through the connection: the relay refuses the redirect with its own 403.
		answering(301, { location: "https://github.com/acme/elsewhere.git" });
		expect(await stopped(fetchOf(transport), f.executorToken)).toBe("busy IMPORT_RELAY_REFUSED");
		expect(source.seen.at(-1)?.url).toBe("/Acme/Shop.git/info/refs?service=git-upload-pack");

		// The kernel's refusal is the relay's opaque 403: busy twice, refused the third time in a row, as the run counts.
		source.handler.answer = gitAnswer;
		f.state.refuse = true;
		let relayRefused = 0;
		const ends: string[] = [];
		for (let claim = 0; claim < 3; claim++) {
			const ended = (await fetchOf(transport).catch((error: unknown) => error)) as CodeImportStop;
			clean(ended, f.executorToken);
			const counted = codeImportRelayRefusals(relayRefused, ended);
			relayRefused = counted.relayRefused;
			ends.push(`${counted.stop?.end} ${counted.stop?.code}`);
		}
		expect(ends).toEqual(["busy IMPORT_RELAY_REFUSED", "busy IMPORT_RELAY_REFUSED", "refused IMPORT_SOURCE_REFUSED"]);
		// The kernel lets it through again: the import is in.
		f.state.refuse = false;
		await expect(fetchOf(transport)).resolves.toMatchObject({ defaultBranch: "main" });

		// The vault's database busy: its 503.
		f.state.busy = true;
		expect(await stopped(fetchOf(transport), f.executorToken)).toBe("busy IMPORT_RELAY_BUSY");
		f.state.busy = false;
		// A company the vault does not serve, and a bearer that is not the executor's: the relay's own 404.
		const elsewhere = f
			.transports()
			.connection({ ...f.scope, companyId: randomUUID() }, { owner: "Acme", name: "Shop" });
		expect(await stopped(fetchOf(elsewhere), f.executorToken)).toBe("failed IMPORT_RELAY_NOT_ROUTED");
		const stranger = randomBytes(32).toString("base64url");
		const wrong = f.transports(stranger).connection(f.scope, { owner: "Acme", name: "Shop" });
		expect(await stopped(fetchOf(wrong), f.executorToken, stranger)).toBe("failed IMPORT_RELAY_NOT_ROUTED");
		const raw = await wrong.refs(new AbortController().signal);
		expect(raw).toEqual({ by: "relay", status: 404, error: "not_found" });
	});

	it("tells the relay's own answer by its exact JSON, never follows a redirect, and says nothing of a failure", async () => {
		// A stand-in for the broker's origin, answering what the tests ask.
		let answer: Handler = () => undefined;
		const broker = await upstream({ answer: (incoming, body, reply) => answer(incoming, body, reply) });
		const elsewhere = await upstream({
			answer: (_incoming, _body, reply) => {
				reply.end();
			},
		});
		const token = randomBytes(32).toString("base64url");
		const transports = new BrokerRepositoryFetch({
			origin: ORIGIN,
			executorToken: token,
			executorOwner: "coding-node-02",
			fetch: (input, init) => {
				const url = new URL(String(input));
				return fetch(`http://127.0.0.1:${broker.port}${url.pathname}${url.search}`, init);
			},
		});
		const scope = { companyId: randomUUID(), requestId: randomUUID(), leaseToken: randomUUID() };
		const transport = transports.connection(scope, { owner: "Acme", name: "Shop" });
		const signal = new AbortController().signal;
		const json = (status: number, value: unknown) => {
			answer = (_incoming, _body, reply) => {
				reply.writeHead(status, { "content-type": "application/json; charset=utf-8" });
				reply.end(JSON.stringify(value));
			};
		};
		const error = (word: unknown) => ({ schema: "qorpera.cloud-secret-error/v1", error: word });
		json(400, error("invalid"));
		await expect(transport.refs(signal)).resolves.toEqual({ by: "relay", status: 400, error: "invalid" });
		expect(await stopped(fetchOf(transport), token)).toBe("failed IMPORT_RELAY_FAILED");
		json(503, error("busy"));
		await expect(transport.uploadPack(Buffer.from("0000"), signal)).resolves.toEqual({
			by: "relay",
			status: 503,
			error: "busy",
		});
		// The word only when it is one; never a body's other text.
		json(403, error(`unavailable ${CANARY}`));
		const odd = await transport.refs(signal);
		expect(odd).toEqual({ by: "relay", status: 403, error: null });
		// JSON that is not the relay's is the source's answer, its body not read on.
		json(403, { message: CANARY });
		const theirs = (await transport.refs(signal)) as Extract<CodeImportAnswer, { by: "source" }>;
		expect([theirs.by, theirs.status, theirs.contentType]).toEqual(["source", 403, "application/json"]);
		const unread: Uint8Array[] = [];
		for await (const piece of theirs.body) unread.push(piece);
		expect(unread).toEqual([]);
		expect(await stopped(fetchOf(transport), token)).toBe("refused IMPORT_SOURCE_REFUSED");
		json(403, { ...error("unavailable"), more: true });
		await expect(transport.refs(signal)).resolves.toMatchObject({ by: "source", status: 403 });
		// A redirect is an error: the place it names is never asked.
		answer = (_incoming, _body, reply) => {
			reply.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/v1/coding-repository-fetch/refs` });
			reply.end();
		};
		const redirected = await transport.refs(signal).catch((caught: unknown) => caught);
		expect((redirected as Error).message).toBe("CODE_IMPORT_RELAY_UNREACHED");
		clean(redirected, token);
		expect(elsewhere.seen).toEqual([]);
		expect(await stopped(fetchOf(transport), token)).toBe("busy IMPORT_TRANSFER_CUT");
		// A broker that cannot be reached.
		const gone = new BrokerRepositoryFetch({
			origin: ORIGIN,
			executorToken: token,
			executorOwner: "coding-node-02",
			fetch: (_input, init) => fetch("http://127.0.0.1:1/v1/coding-repository-fetch/refs", init),
		});
		const unreached = await gone
			.connection(scope, { owner: "Acme", name: "Shop" })
			.refs(signal)
			.catch((caught: unknown) => caught);
		expect((unreached as Error).message).toBe("CODE_IMPORT_RELAY_UNREACHED");
		expect((unreached as Error).cause).toBeUndefined();
		clean(unreached, token);
	});

	it("waits a bounded time for the broker's headers, never for its body, and reads a broken body as a cut", async () => {
		let answer: Handler = () => undefined;
		const broker = await upstream({ answer: (incoming, body, reply) => answer(incoming, body, reply) });
		const token = randomBytes(32).toString("base64url");
		const transport = new BrokerRepositoryFetch({
			origin: ORIGIN,
			executorToken: token,
			executorOwner: "coding-node-02",
			answerMs: 300,
			fetch: (input, init) => {
				const url = new URL(String(input));
				return fetch(`http://127.0.0.1:${broker.port}${url.pathname}${url.search}`, init);
			},
		}).connection({ companyId: randomUUID(), requestId: randomUUID(), leaseToken: randomUUID() }, REPOSITORY);
		const signal = new AbortController().signal;
		// No headers: given up at the bound, with a fixed code.
		const started = Date.now();
		const late = await transport.refs(signal).catch((caught: unknown) => caught);
		expect((late as Error).message).toBe("CODE_IMPORT_RELAY_UNREACHED");
		expect(Date.now() - started).toBeGreaterThanOrEqual(290);
		// Headers in time, then a body slower than the bound: it all comes.
		answer = (_incoming, _body, reply) => {
			reply.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
			reply.write("first ");
			setTimeout(() => reply.end("and last"), 700);
		};
		const slow = (await transport.refs(signal)) as Extract<CodeImportAnswer, { by: "source" }>;
		const pieces: Buffer[] = [];
		for await (const piece of slow.body) pieces.push(Buffer.from(piece));
		expect(Buffer.concat(pieces).toString()).toBe("first and last");
		// A body whose connection breaks: a cut, in no words of the answer's.
		answer = (_incoming, _body, reply) => {
			reply.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" });
			reply.write(`${CANARY} `, () => reply.socket?.destroy());
		};
		const broken = (await transport.refs(signal)) as Extract<CodeImportAnswer, { by: "source" }>;
		const cut = await (async () => {
			for await (const _piece of broken.body);
		})().catch((caught: unknown) => caught);
		expect((cut as Error).message).toBe("CODE_IMPORT_TRANSFER_CUT");
		expect((cut as Error).cause).toBeUndefined();
		clean(cut, token);
		for (const answerMs of [0, 60_001, 1.5])
			expect(
				() => new BrokerRepositoryFetch({ origin: ORIGIN, executorToken: token, executorOwner: "x", answerMs }),
			).toThrow("CODING_REPOSITORY_BROKER_CONFIG_INVALID");
	});

	it("refuses a configuration, a scope and a repository that are none", () => {
		const token = randomBytes(32).toString("base64url");
		const good = { origin: ORIGIN, executorToken: token, executorOwner: "coding-node-02" };
		for (const options of [
			{ ...good, origin: "http://secrets.qorpera.test" },
			{ ...good, origin: `${ORIGIN}/path` },
			{ ...good, origin: "https://user:pass@secrets.qorpera.test" },
			{ ...good, executorToken: "short" },
			{ ...good, executorOwner: "coding node" },
		])
			expect(() => new BrokerRepositoryFetch(options)).toThrow("CODING_REPOSITORY_BROKER_CONFIG_INVALID");
		const transports = new BrokerRepositoryFetch(good);
		const scope = { companyId: randomUUID(), requestId: randomUUID(), leaseToken: randomUUID() };
		for (const bad of [
			{ ...scope, companyId: "company" },
			{ ...scope, requestId: "" },
			{ ...scope, leaseToken: 7 },
		])
			expect(() => transports.connection(bad as typeof scope, { owner: "Acme", name: "Shop" })).toThrow(
				"CODE_IMPORT_FETCH_SCOPE_INVALID",
			);
		for (const repository of [
			{ owner: "Acme", name: "Shop/x" },
			{ owner: "-acme", name: "shop" },
			{ owner: "Acme", name: "" },
		])
			expect(() => transports.connection(scope, repository)).toThrow("INVALID_CODE_IMPORT_INPUT");
	});
});

describe("a slow writer through the node's proxy", { timeout: 150_000 }, () => {
	/** A stand-in for node 1's nginx in front of the broker: answers stream through as they come, and a reader that
	 * takes nothing for `sendMs` has its connection cut (nginx's `send_timeout`, 40 s at the http level today). */
	async function proxy(target: number, sendMs: number) {
		const record = { pushed: 0, cut: 0 };
		const server = createServer((incoming, reply) => {
			const outgoing = httpRequest({
				host: "127.0.0.1",
				port: target,
				method: incoming.method,
				path: incoming.url,
				headers: incoming.headers,
				agent: false,
			});
			incoming.pipe(outgoing);
			outgoing.on("error", () => reply.destroy());
			outgoing.on("response", (answer) => {
				const { connection: _connection, ...headers } = answer.headers;
				reply.writeHead(answer.statusCode ?? 502, headers);
				answer.on("data", (chunk: Buffer) => {
					record.pushed += chunk.length;
					if (reply.write(chunk)) return;
					answer.pause();
					const timer = setTimeout(() => {
						record.cut = Date.now();
						reply.destroy();
						outgoing.destroy();
					}, sendMs);
					reply.once("drain", () => {
						clearTimeout(timer);
						answer.resume();
					});
				});
				answer.on("end", () => reply.end());
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		return { port: (server.address() as AddressInfo).port, record };
	}

	it("ends busy, never refused, when a write is held 60 s mid-pack behind a 40 s send bound", async () => {
		const MAIN = "a".repeat(40);
		const pkt = codeImportPktLine;
		const line = pkt(Buffer.concat([Buffer.from([1]), randomBytes(65_515)]));
		const head = pkt(Buffer.concat([Buffer.from([1]), Buffer.from("PACK\0\0\0\x02\0\0\0\x01"), randomBytes(65_503)]));
		const sent = { bytes: 0 };
		// A source with 256 MiB to send, as fast as it is taken.
		const source = await upstream({
			answer: (incoming, body, reply) => {
				const type = `application/x-git-upload-pack-${incoming.method === "GET" ? "advertisement" : "result"}`;
				reply.writeHead(200, { "content-type": type });
				if (incoming.method === "GET")
					return void reply.end(
						Buffer.concat([
							Buffer.from("001e# service=git-upload-pack\n0000"),
							pkt("version 2\n"),
							pkt("ls-refs\n"),
							pkt("fetch\n"),
							Buffer.from("0000"),
						]),
					);
				if (body.includes("command=ls-refs"))
					return void reply.end(
						Buffer.concat([
							pkt(`${MAIN} HEAD symref-target:refs/heads/main\n`),
							pkt(`${MAIN} refs/heads/main\n`),
							Buffer.from("0000"),
						]),
					);
				reply.write(pkt("packfile\n"));
				let n = 0;
				const more = () => {
					while (n < 4_096) {
						const next = n === 0 ? head : line;
						n += 1;
						sent.bytes += next.length;
						if (!reply.write(next)) return void reply.once("drain", more);
					}
					reply.end("0000");
				};
				more();
			},
		});
		let edge: Awaited<ReturnType<typeof proxy>> | undefined;
		const f = await vault(source, {
			proxyPort: async (brokerPort) => {
				edge = await proxy(brokerPort, 40_000);
				return edge.port;
			},
		});
		const pulled = { bytes: 0 };
		const inner = f.transports().connection(f.scope, { owner: "Acme", name: "Shop" });
		// The transport's body, counted as the fetch takes it.
		const counted: CodeImportTransport = {
			refs: (signal) => inner.refs(signal),
			uploadPack: async (body, signal) => {
				const answer = await inner.uploadPack(body, signal);
				if (answer.by !== "source") return answer;
				return {
					...answer,
					body: (async function* () {
						for await (const piece of answer.body) {
							pulled.bytes += piece.byteLength;
							yield piece;
						}
					})(),
				};
			},
		};
		let written = 0,
			heldAt = 0,
			atHold = { pulled: 0, pushed: 0 };
		const sink: CodeImportSink = {
			write: async (chunk) => {
				written += chunk.byteLength;
				if (written >= 2 * MiB && heldAt === 0) {
					heldAt = Date.now();
					await new Promise((resolve) => setTimeout(resolve, 2_000));
					atHold = { pulled: pulled.bytes, pushed: edge?.record.pushed ?? 0 };
					await new Promise((resolve) => setTimeout(resolve, 58_000));
				}
			},
		};
		const ended = await stopped(fetchOf(counted, sink), f.executorToken);
		expect(ended).toBe("busy IMPORT_TRANSFER_CUT");
		// The proxy cut the reader that took nothing for 40 s; until the write was let go, the executor read nothing
		// more than what it already held, and the source was held back far short of its 256 MiB.
		expect(edge?.record.cut).toBeGreaterThanOrEqual(heldAt + 39_000);
		expect(Date.now() - heldAt).toBeGreaterThanOrEqual(60_000);
		expect(atHold.pulled - 2 * MiB).toBeLessThanOrEqual(MiB + 4 * 65_520);
		expect(edge?.record.pushed).toBe(atHold.pushed);
		expect(atHold.pushed).toBeLessThan(128 * MiB);
		expect(sent.bytes).toBeLessThan(160 * MiB);
	});
});

describe("a public project straight from github.com (publicGitHubTransport)", { timeout: 60_000 }, () => {
	it("asks github.com as git does, over the relay's checked connection, with no credential", async () => {
		const source = await upstream();
		const { relay, targets } = relayTo(source.port);
		const sink = memory();
		await fetchOf(publicGitHubTransport({ owner: "Acme", name: "Shop" }, { relay }), sink);
		await proveBundle(sink.bytes());
		expect(targets.map(({ address, host, port, method, path }) => [address, host, port, method, path])).toEqual([
			[PUBLIC_ADDRESS, "github.com", 443, "GET", "/Acme/Shop.git/info/refs?service=git-upload-pack"],
			[PUBLIC_ADDRESS, "github.com", 443, "POST", "/Acme/Shop.git/git-upload-pack"],
			[PUBLIC_ADDRESS, "github.com", 443, "POST", "/Acme/Shop.git/git-upload-pack"],
		]);
		expect(targets[0]?.headers).toEqual({
			"git-protocol": "version=2",
			"user-agent": "qorpera-coding-executor",
			host: "github.com",
		});
		expect(targets[1]?.headers).toEqual({
			"content-type": "application/x-git-upload-pack-request",
			accept: "application/x-git-upload-pack-result",
			"content-length": String(source.seen[1]?.body.length),
			"git-protocol": "version=2",
			"user-agent": "qorpera-coding-executor",
			host: "github.com",
		});
		expect(source.seen.every((seen) => seen.headers.authorization === undefined)).toBe(true);
		expect(relay.resolve).toHaveBeenCalledWith("github.com", expect.any(AbortSignal));
		// The broker's transports hand a public project to the same.
		const token = randomBytes(32).toString("base64url");
		const transports = new BrokerRepositoryFetch({
			origin: ORIGIN,
			executorToken: token,
			executorOwner: "coding-node-02",
			relay,
		});
		await expect(fetchOf(transports.public({ owner: "Acme", name: "Shop" }))).resolves.toMatchObject({
			defaultBranch: "main",
		});
		expect(targets).toHaveLength(6);
		expect(source.seen.every((seen) => !JSON.stringify(seen.headers).includes(token))).toBe(true);
	});

	it("follows no redirect, takes no private address, no encoded answer, and ends a quiet connection", async () => {
		const source = await upstream();
		const { relay, targets } = relayTo(source.port);
		const transport = publicGitHubTransport({ owner: "Acme", name: "Shop" }, { relay });
		source.handler.answer = (_incoming, _body, reply) => {
			reply.writeHead(301, { location: "https://github.com/acme/renamed.git/info/refs?service=git-upload-pack" });
			reply.end(CANARY);
		};
		expect(await stopped(fetchOf(transport))).toBe("refused IMPORT_SOURCE_MOVED");
		expect(source.seen).toHaveLength(1);

		source.handler.answer = (_incoming, _body, reply) => {
			reply.writeHead(200, {
				"content-type": "application/x-git-upload-pack-advertisement",
				"content-encoding": "gzip",
			});
			reply.end(CANARY);
		};
		expect(await stopped(fetchOf(transport))).toBe("failed IMPORT_SOURCE_PROTOCOL");
		// The transport refuses it itself: no encoded body is handed on to be read.
		expect(await stopped(transport.refs(new AbortController().signal))).toBe("failed IMPORT_SOURCE_PROTOCOL");

		// An answer that stops in its body: the relay's own idle bound ends the connection, a cut transfer.
		source.handler.answer = (incoming, body, reply) => {
			if (incoming.method === "GET") return gitAnswer(incoming, body, reply);
			reply.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
			reply.write(codeImportPktLine(`${"a".repeat(40)} refs/heads/main\n`));
		};
		const quiet = publicGitHubTransport({ owner: "Acme", name: "Shop" }, { relay, idleMs: 300 });
		const started = Date.now();
		expect(await stopped(fetchOf(quiet, memory(), { idleMs: 60_000 }))).toBe("busy IMPORT_TRANSFER_CUT");
		expect(Date.now() - started).toBeLessThan(10_000);

		// github.com at an address that is not public: no connection is made.
		const before = targets.length;
		const inside = relayTo(source.port, ["10.0.0.7"]);
		const fenced = publicGitHubTransport({ owner: "Acme", name: "Shop" }, { relay: inside.relay });
		const refused = await fenced.refs(new AbortController().signal).catch((caught: unknown) => caught);
		expect((refused as Error).message).toBe("CODE_IMPORT_SOURCE_UNREACHED");
		expect((refused as Error).cause).toBeUndefined();
		expect(await stopped(fetchOf(fenced))).toBe("busy IMPORT_TRANSFER_CUT");
		expect(inside.targets).toEqual([]);
		expect(targets.length).toBe(before);

		for (const repository of [
			{ owner: "Acme", name: "Shop.git/x" },
			{ owner: "", name: "Shop" },
		])
			expect(() => publicGitHubTransport(repository, { relay })).toThrow("INVALID_CODE_IMPORT_INPUT");
		for (const idleMs of [0, 1.5, 2 * 60_000 + 1])
			expect(() => publicGitHubTransport({ owner: "Acme", name: "Shop" }, { relay, idleMs })).toThrow(
				"CODE_IMPORT_FETCH_IDLE_INVALID",
			);
	});
});
