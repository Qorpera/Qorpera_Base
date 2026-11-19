import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type ClaudeLoginRunAuthority,
	CloudClaudeLoginVault,
	claudeLoginSealFiles,
} from "@qorpera/runtime/cloud-claude-login-vault";
import { CLAUDE_LOGIN_FILES_SCHEMA } from "@qorpera/runtime/cloud-model-login-sign-in";
import type { ModelLoginRunBinding } from "@qorpera/runtime/cloud-model-login-vault";
import { CLAUDE_LOGIN_FIELD } from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { CloudSecretBroker } from "@qorpera/runtime/cloud-secret-broker";
import {
	HttpCloudSecretBrokerService,
	openClaudeLoginForRun,
	sealClaudeLoginBack,
} from "@qorpera/runtime/cloud-secret-broker-http";
import type { CloudSecretBrokerCompanies } from "@qorpera/runtime/cloud-secret-broker-shared";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { CloudSecretBrokerBusyError } from "@qorpera/runtime/cloud-vault-database-failure";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Slice C4b (migration 20260930771000): the shared vault opens a member's sealed Claude login for one Claude Code
 * worker's run and seals back what Claude Code changed; the run host's two client calls. The login files here are
 * made-up canaries, never a real sign-in, and no line of output may carry them.
 */

const CANARY_CREDENTIALS = `{"claudeAiOauth":{"accessToken":"CANARY-C4B-ACCESS-${randomUUID()}","refreshToken":"CANARY-C4B-REFRESH"}}`;
const CANARY_SETTINGS = `{"oauthAccount":{"emailAddress":"canary-c4b@example.test"}}`;
const RENEWED_CREDENTIALS = `{"claudeAiOauth":{"accessToken":"CANARY-C4B-RENEWED-${randomUUID()}","refreshToken":"CANARY-C4B-REFRESH-2"}}`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

function binding(): ModelLoginRunBinding {
	return {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
	};
}

/** A stand-in for the database: one Claude login, sealed under the member's key, with SQL's compare-and-swap, and the
 * worker's state ruled on as 20260930771000 rules on it: the open route's call refuses a worker no longer at work (the
 * database's 42501), the seal-back's re-open and the seal itself do not. */
function standIn() {
	const keyring = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
	const login = {
		id: randomUUID(),
		owner: randomUUID(),
		keyId: "vault-root-1",
		version: 1,
		refusal: null as string | null,
		workerState: "active" as "active" | "succeeded" | "cancelled",
	};
	const files = {
		schema: CLAUDE_LOGIN_FILES_SCHEMA,
		files: { ".credentials.json": b64(CANARY_CREDENTIALS), ".claude.json": b64(CANARY_SETTINGS) },
	};
	let envelope = Buffer.from(
		keyring.sealMember(
			{ [CLAUDE_LOGIN_FIELD]: JSON.stringify(files) },
			{ memberId: login.owner, loginId: login.id, version: 1, keyId: login.keyId },
		),
	);
	const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const refusal = () => ({ schema: "qorpera.claude-login-for-run/v1", state: "refused", reason: login.refusal });
	const loginHead = () => ({
		schema: "qorpera.claude-login-for-run/v1",
		claudeLoginId: login.id,
		ownerUserId: login.owner,
		keyId: login.keyId,
		version: login.version,
		envelopeSha256: sha(envelope),
	});
	const openAnswer = () =>
		login.refusal
			? refusal()
			: { ...loginHead(), state: "open", encryptedEnvelopeBase64: envelope.toString("base64") };
	const authority: ClaudeLoginRunAuthority = {
		openClaudeLoginForRun: vi.fn(async () => {
			if (login.workerState !== "active")
				throw Object.assign(new Error("Claude login is unavailable to this run"), { code: "42501" });
			return openAnswer();
		}),
		openClaudeLoginForSealBack: vi.fn(async () => openAnswer()),
		sealClaudeLoginBack: vi.fn(async (seal) => {
			if (login.refusal) return { schema: "qorpera.claude-login-seal/v1", state: "refused", reason: login.refusal };
			if (seal.baseVersion !== login.version || seal.baseEnvelopeSha256 !== sha(envelope))
				return {
					schema: "qorpera.claude-login-seal/v1",
					state: "stale",
					claudeLoginId: login.id,
					version: login.version,
				};
			expect(seal.envelopeSha256).toBe(sha(seal.encryptedEnvelope));
			envelope = Buffer.from(seal.encryptedEnvelope);
			login.version += 1;
			return {
				schema: "qorpera.claude-login-seal/v1",
				state: "sealed",
				claudeLoginId: login.id,
				version: login.version,
				envelopeSha256: sha(envelope),
			};
		}),
	};
	/** The login's files as sealed now, opened with the member's key and the version in the identity. */
	const sealed = () =>
		keyring.useMember(
			envelope,
			{ memberId: login.owner, loginId: login.id, version: login.version, keyId: login.keyId },
			async (fields) => JSON.parse(fields[CLAUDE_LOGIN_FIELD] as string) as typeof files,
		);
	return {
		keyring,
		login,
		authority,
		sealed,
		sha: () => sha(envelope),
		vault: new CloudClaudeLoginVault({ authority, keyring }),
	};
}

const output: string[] = [];
function captureOutput(): void {
	for (const method of ["log", "info", "warn", "error", "debug"] as const)
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			output.push(args.map(String).join(" "));
		});
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output.push(String(chunk));
		return true;
	});
}
afterEach(() => {
	vi.restoreAllMocks();
	// No canary reached any line of output.
	expect(output.join("\n")).not.toMatch(/CANARY-C4B|canary-c4b/);
	output.length = 0;
});

describe("the vault opens a run's Claude login", () => {
	it("hands the run its files as sealed, with the version and digest it opened", async () => {
		captureOutput();
		const f = standIn();
		const opened = await f.vault.open({ binding: binding() }, AbortSignal.timeout(5000));
		expect(opened).toEqual({
			schema: "qorpera.claude-login-files-for-run/v1",
			state: "open",
			claudeLoginId: f.login.id,
			version: 1,
			envelopeSha256: f.sha(),
			files: { ".credentials.json": b64(CANARY_CREDENTIALS), ".claude.json": b64(CANARY_SETTINGS) },
		});
	});

	it("answers the database's refusal and opens nothing", async () => {
		captureOutput();
		for (const reason of ["SIGNED_OUT", "NOT_OPEN"]) {
			const f = standIn();
			f.login.refusal = reason;
			expect(await f.vault.open({ binding: binding() }, AbortSignal.timeout(5000))).toEqual({
				schema: "qorpera.claude-login-files-for-run/v1",
				state: "refused",
				reason,
			});
		}
	});

	it("refuses an envelope that is not its digest, another member's, another version's, or a binding out of shape", async () => {
		captureOutput();
		const f = standIn();
		const answer = await f.authority.openClaudeLoginForRun(binding(), AbortSignal.timeout(5000));
		for (const changed of [
			{ envelopeSha256: "0".repeat(64) },
			{ ownerUserId: randomUUID() },
			{ version: 2 },
			{ extra: true },
		]) {
			vi.mocked(f.authority.openClaudeLoginForRun).mockResolvedValueOnce({ ...(answer as object), ...changed });
			await expect(f.vault.open({ binding: binding() }, AbortSignal.timeout(5000))).rejects.toThrow();
		}
		await expect(
			f.vault.open({ binding: { ...binding(), runId: "nope" } }, AbortSignal.timeout(5000)),
		).rejects.toThrow("Model login run is invalid");
	});
});

describe("the vault seals back what Claude Code changed", () => {
	it("seals the files as the next version under the member's key, and a stale base leaves the newer one", async () => {
		captureOutput();
		const f = standIn();
		const base = { claudeLoginId: f.login.id, baseVersion: 1, baseEnvelopeSha256: f.sha() };
		const files = { ".credentials.json": b64(RENEWED_CREDENTIALS), ".claude.json": b64(CANARY_SETTINGS) };
		const sealed = await f.vault.sealBack({ binding: binding(), ...base, files }, AbortSignal.timeout(5000));
		// The answer names the new version's envelope digest: the base a later seal of the same run starts from.
		expect(sealed).toEqual({
			schema: "qorpera.claude-login-seal/v1",
			state: "sealed",
			claudeLoginId: f.login.id,
			version: 2,
			envelopeSha256: f.sha(),
		});
		// Version 2's identity opens it, with the renewed file.
		expect((await f.sealed()).files).toEqual(files);
		// A second run that opened version 1: stale, nothing sealed, version 2 stays.
		const before = f.sha();
		const stale = await f.vault.sealBack(
			{ binding: binding(), ...base, files: { ".credentials.json": b64(CANARY_CREDENTIALS) } },
			AbortSignal.timeout(5000),
		);
		expect(stale).toEqual({
			schema: "qorpera.claude-login-seal/v1",
			state: "stale",
			claudeLoginId: f.login.id,
			version: 2,
		});
		expect(f.sha()).toBe(before);
		expect(f.authority.sealClaudeLoginBack).toHaveBeenCalledTimes(1);
		// The database's own stale answer (another seal between the description and the swap) is passed on as it is.
		vi.mocked(f.authority.sealClaudeLoginBack).mockResolvedValueOnce({
			schema: "qorpera.claude-login-seal/v1",
			state: "stale",
			claudeLoginId: f.login.id,
			version: 3,
		});
		expect(
			await f.vault.sealBack(
				{ binding: binding(), claudeLoginId: f.login.id, baseVersion: 2, baseEnvelopeSha256: f.sha(), files },
				AbortSignal.timeout(5000),
			),
		).toMatchObject({ state: "stale", version: 3 });
	});

	it("keeps a login file the run host did not send as the run opened it", async () => {
		captureOutput();
		const f = standIn();
		const sealed = await f.vault.sealBack(
			{
				binding: binding(),
				claudeLoginId: f.login.id,
				baseVersion: 1,
				baseEnvelopeSha256: f.sha(),
				files: { ".credentials.json": b64(RENEWED_CREDENTIALS) },
			},
			AbortSignal.timeout(5000),
		);
		expect(sealed).toMatchObject({ state: "sealed", version: 2 });
		expect((await f.sealed()).files).toEqual({
			".credentials.json": b64(RENEWED_CREDENTIALS),
			".claude.json": b64(CANARY_SETTINGS),
		});
		// The vault opened the version the run opened once more for it, through the seal-back's own re-open, and sealed
		// nothing else.
		expect(f.authority.openClaudeLoginForSealBack).toHaveBeenCalledTimes(1);
		expect(f.authority.openClaudeLoginForRun).not.toHaveBeenCalled();
		expect(f.authority.sealClaudeLoginBack).toHaveBeenCalledTimes(1);
	});

	it("seals back for a worker that has reported or was cancelled, through its own re-open, and opens nothing for it", async () => {
		captureOutput();
		for (const state of ["succeeded", "cancelled"] as const) {
			const f = standIn();
			const opened = await f.vault.open({ binding: binding() }, AbortSignal.timeout(5000));
			if (opened.state !== "open") throw new Error(opened.state);
			// The model's report_work (or a cancel) moves the worker's state while Claude Code still runs.
			f.login.workerState = state;
			await expect(f.vault.open({ binding: binding() }, AbortSignal.timeout(5000))).rejects.toThrow(
				"Claude login is unavailable to this run",
			);
			const sealed = await f.vault.sealBack(
				{
					binding: binding(),
					claudeLoginId: f.login.id,
					baseVersion: opened.version,
					baseEnvelopeSha256: opened.envelopeSha256,
					files: { ".credentials.json": b64(RENEWED_CREDENTIALS) },
				},
				AbortSignal.timeout(5000),
			);
			expect(sealed).toMatchObject({ state: "sealed", version: 2 });
			expect((await f.sealed()).files[".credentials.json"]).toBe(b64(RENEWED_CREDENTIALS));
			// The open route's call was asked once while at work and once after; the seal-back asked only its own.
			expect(f.authority.openClaudeLoginForRun).toHaveBeenCalledTimes(2);
			expect(f.authority.openClaudeLoginForSealBack).toHaveBeenCalledTimes(1);
		}
	});

	it("seals only Claude Code's login files, the credentials among them", async () => {
		captureOutput();
		const f = standIn();
		const base = { binding: binding(), claudeLoginId: f.login.id, baseVersion: 1, baseEnvelopeSha256: f.sha() };
		const refusedFiles: Record<string, string>[] = [
			{ ".credentials.json": b64(RENEWED_CREDENTIALS), "settings.json": b64("{}") },
			{ ".claude.json": b64(CANARY_SETTINGS) },
			{ ".credentials.json": "not base64!" },
			{ ".credentials.json": b64("x") },
			{ ".credentials.json": b64("x".repeat(16 * 1024 + 1)) },
		];
		for (const files of refusedFiles)
			await expect(f.vault.sealBack({ ...base, files }, AbortSignal.timeout(5000))).rejects.toThrow();
		await expect(
			f.vault.sealBack(
				{ ...base, claudeLoginId: randomUUID(), files: { ".credentials.json": b64(RENEWED_CREDENTIALS) } },
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow("Claude login seal-back names another login");
		expect(f.authority.sealClaudeLoginBack).not.toHaveBeenCalled();
		expect(f.login.version).toBe(1);
	});

	it("answers a refusal of the login now and seals nothing", async () => {
		captureOutput();
		const f = standIn();
		f.login.refusal = "SIGNED_OUT";
		expect(
			await f.vault.sealBack(
				{
					binding: binding(),
					claudeLoginId: f.login.id,
					baseVersion: 1,
					baseEnvelopeSha256: f.sha(),
					files: { ".credentials.json": b64(RENEWED_CREDENTIALS) },
				},
				AbortSignal.timeout(5000),
			),
		).toEqual({ schema: "qorpera.claude-login-seal/v1", state: "refused", reason: "SIGNED_OUT" });
		expect(f.authority.sealClaudeLoginBack).not.toHaveBeenCalled();
	});

	it("checks the shape of what it seals, never its contents", () => {
		expect(claudeLoginSealFiles({ ".credentials.json": b64("{not json at all}") })).toEqual({
			".credentials.json": b64("{not json at all}"),
		});
	});
});

describe("the run host's two calls (C4c's), against a stand-in vault route", () => {
	let server: Server | undefined;
	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
		server = undefined;
	});

	async function route(f: ReturnType<typeof standIn>) {
		const requests: { path: string; body: Record<string, unknown>; headers: IncomingMessage["headers"] }[] = [];
		// The vault saves the next seal, and its answer is lost on the way back (the route answers busy).
		const lose = { nextSealAnswer: false };
		server = createServer(async (request, reply) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			requests.push({ path: `${url.pathname}${url.search}`, body, headers: request.headers });
			const answer =
				url.pathname === "/v1/claude-logins/open"
					? await f.vault.open({ binding: body.binding as ModelLoginRunBinding }, AbortSignal.timeout(5000))
					: await f.vault.sealBack(
							{
								binding: body.binding as ModelLoginRunBinding,
								claudeLoginId: body.claudeLoginId as string,
								baseVersion: body.baseVersion as number,
								baseEnvelopeSha256: body.baseEnvelopeSha256 as string,
								files: body.files as Record<string, string>,
							},
							AbortSignal.timeout(5000),
						);
			if (url.pathname === "/v1/claude-logins/seal" && lose.nextSealAnswer) {
				lose.nextSealAnswer = false;
				reply.writeHead(503, { "content-type": "application/json" });
				reply.end('{"error":"busy"}');
				return;
			}
			reply.writeHead(200, { "content-type": "application/json" });
			reply.end(JSON.stringify(answer));
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
		const client = {
			origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			runtimeToken: "a".repeat(43),
			companyId: randomUUID(),
			holder: () => "holder-c4b",
			allowLoopback: true,
		};
		return { client, requests, lose };
	}

	it("opens the files for the box, sends back only changed login files, and none when nothing changed", async () => {
		captureOutput();
		const f = standIn();
		const { client, requests } = await route(f);
		const run = binding();
		const opened = await openClaudeLoginForRun(client, run, AbortSignal.timeout(5000));
		if ("refused" in opened) throw new Error("refused");
		expect(opened).toMatchObject({ claudeLoginId: f.login.id, version: 1, envelopeSha256: f.sha() });
		expect(opened.files.get(".credentials.json")?.toString("utf8")).toBe(CANARY_CREDENTIALS);
		expect(opened.files.get(".claude.json")?.toString("utf8")).toBe(CANARY_SETTINGS);
		expect(requests[0]).toMatchObject({
			path: `/v1/claude-logins/open?company=${client.companyId}`,
			body: { schema: "qorpera.claude-login-open-request/v1", binding: run },
		});
		expect(requests[0]?.headers.authorization).toBe(`Bearer ${client.runtimeToken}`);
		expect(requests[0]?.headers["x-qorpera-identity"]).toBe("holder-c4b");
		// Nothing changed in the box: nothing is sent, also when only the credentials file is read back (as C4c does).
		const unchanged = await sealClaudeLoginBack(
			client,
			{ binding: run, opened, files: opened.files },
			AbortSignal.timeout(5000),
		);
		expect(unchanged).toEqual({ state: "unchanged", opened });
		expect(
			await sealClaudeLoginBack(
				client,
				{
					binding: run,
					opened,
					files: new Map([[".credentials.json", opened.files.get(".credentials.json") ?? Buffer.alloc(0)]]),
				},
				AbortSignal.timeout(5000),
			),
		).toEqual({ state: "unchanged", opened });
		expect(requests).toHaveLength(1);
		// Without the credentials file nothing is sent either: it is refused.
		await expect(
			sealClaudeLoginBack(
				client,
				{
					binding: run,
					opened,
					files: new Map([[".claude.json", Buffer.from(CANARY_SETTINGS)]]),
				},
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow("Only Claude Code's login files are sealed back");
		expect(requests).toHaveLength(1);
		// A file other than Claude Code's login files is never sent.
		await expect(
			sealClaudeLoginBack(
				client,
				{ binding: run, opened, files: new Map([...opened.files, ["history.jsonl", Buffer.from("x")]]) },
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow("Only Claude Code's login files are sealed back");
		expect(requests).toHaveLength(1);
		// Claude Code renewed its token: the files go back and are sealed as version 2.
		const renewed = new Map(opened.files);
		renewed.set(".credentials.json", Buffer.from(RENEWED_CREDENTIALS));
		const sealed = await sealClaudeLoginBack(
			client,
			{ binding: run, opened, files: renewed },
			AbortSignal.timeout(5000),
		);
		const next = {
			claudeLoginId: f.login.id,
			version: 2,
			envelopeSha256: f.sha(),
			fileSha256: {
				".credentials.json": createHash("sha256").update(RENEWED_CREDENTIALS).digest("hex"),
				".claude.json": createHash("sha256").update(CANARY_SETTINGS).digest("hex"),
			},
		};
		expect(sealed).toEqual({
			schema: "qorpera.claude-login-seal/v1",
			state: "sealed",
			claudeLoginId: f.login.id,
			version: 2,
			envelopeSha256: f.sha(),
			opened: next,
		});
		expect(requests[1]?.body).toMatchObject({
			schema: "qorpera.claude-login-seal-request/v1",
			claudeLoginId: f.login.id,
			baseVersion: 1,
			baseEnvelopeSha256: opened.envelopeSha256,
		});
		expect(Object.keys(requests[1]?.body.files as object).sort()).toEqual([".claude.json", ".credentials.json"]);
		expect((await f.sealed()).files[".credentials.json"]).toBe(b64(RENEWED_CREDENTIALS));
		// The same run's seal again from version 1 is stale now: the newer one stays.
		expect(
			await sealClaudeLoginBack(client, { binding: run, opened, files: renewed }, AbortSignal.timeout(5000)),
		).toMatchObject({ state: "stale", version: 2 });
	});

	it("seals twice in one run, each from the base the last answer gave, and a retry after a lost answer is stale", async () => {
		captureOutput();
		const f = standIn();
		const { client, requests, lose } = await route(f);
		const run = binding();
		const opened = await openClaudeLoginForRun(client, run, AbortSignal.timeout(5000));
		if ("refused" in opened) throw new Error("refused");
		// Right after Claude Code's start: it renewed, and only the credentials file is read back.
		const first = await sealClaudeLoginBack(
			client,
			{ binding: run, opened, files: new Map([[".credentials.json", Buffer.from(RENEWED_CREDENTIALS)]]) },
			AbortSignal.timeout(5000),
		);
		if (first.state !== "sealed") throw new Error(first.state);
		expect(first.opened).toMatchObject({ version: 2, envelopeSha256: f.sha() });
		// The same file at the end: nothing to send.
		expect(
			await sealClaudeLoginBack(
				client,
				{
					binding: run,
					opened: first.opened,
					files: new Map([[".credentials.json", Buffer.from(RENEWED_CREDENTIALS)]]),
				},
				AbortSignal.timeout(5000),
			),
		).toEqual({ state: "unchanged", opened: first.opened });
		// Renewed again during the run: the second seal starts from the first's answer.
		const again = `{"claudeAiOauth":{"accessToken":"CANARY-C4B-AGAIN-${randomUUID()}"}}`;
		const second = await sealClaudeLoginBack(
			client,
			{ binding: run, opened: first.opened, files: new Map([[".credentials.json", Buffer.from(again)]]) },
			AbortSignal.timeout(5000),
		);
		expect(second).toMatchObject({ state: "sealed", version: 3, envelopeSha256: f.sha() });
		expect((await f.sealed()).files).toEqual({
			".credentials.json": b64(again),
			".claude.json": b64(CANARY_SETTINGS),
		});
		if (second.state !== "sealed") throw new Error(second.state);
		// A third seal whose answer is lost: the vault saved version 4, the client heard busy.
		const last = `{"claudeAiOauth":{"accessToken":"CANARY-C4B-LAST-${randomUUID()}"}}`;
		lose.nextSealAnswer = true;
		await expect(
			sealClaudeLoginBack(
				client,
				{ binding: run, opened: second.opened, files: new Map([[".credentials.json", Buffer.from(last)]]) },
				AbortSignal.timeout(5000),
			),
		).rejects.toBeInstanceOf(CloudSecretBrokerBusyError);
		expect(f.login.version).toBe(4);
		// Its retry answers stale with the version it named plus one: possibly its own seal, and the saved one stays.
		const sealedBefore = f.sha();
		expect(
			await sealClaudeLoginBack(
				client,
				{ binding: run, opened: second.opened, files: new Map([[".credentials.json", Buffer.from(last)]]) },
				AbortSignal.timeout(5000),
			),
		).toEqual({ schema: "qorpera.claude-login-seal/v1", state: "stale", claudeLoginId: f.login.id, version: 4 });
		expect(f.sha()).toBe(sealedBefore);
		expect((await f.sealed()).files[".credentials.json"]).toBe(b64(last));
		expect(requests.filter((request) => request.path.startsWith("/v1/claude-logins/seal"))).toHaveLength(4);
	});

	it("tells a refused login apart from a refused run", async () => {
		captureOutput();
		const f = standIn();
		f.login.refusal = "NOT_OPEN";
		const { client } = await route(f);
		expect(await openClaudeLoginForRun(client, binding(), AbortSignal.timeout(5000))).toEqual({
			refused: "NOT_OPEN",
		});
		server?.removeAllListeners("request");
		server?.on("request", (_request, reply) => {
			reply.writeHead(403, { "content-type": "application/json" });
			reply.end("{}");
		});
		await expect(openClaudeLoginForRun(client, binding(), AbortSignal.timeout(5000))).rejects.toThrow(
			"Cloud secret broker refused the Claude login",
		);
	});
});

describe("the vault's two routes on the broker service", () => {
	it("serve a run only under the runtime token and the run's lease proof, and never cache", async () => {
		captureOutput();
		const f = standIn();
		const refuse = vi.fn(async () => {
			throw new Error("not in this test");
		});
		const broker = new CloudSecretBroker({
			authority: {
				describeCapture: refuse,
				completeCapture: refuse,
				authorizeOperation: refuse,
				authorizeRepositoryCredential: refuse,
			},
			keyring: f.keyring,
			adapters: [],
		});
		const runtimeToken = randomBytes(32).toString("base64url");
		const run = binding();
		const holder = `job.${run.jobId}.${randomBytes(32).toString("base64url")}`;
		const proveBinding = vi.fn(async (_binding: object, _holder: string) => undefined);
		// Only the shared vault keeps Claude logins: the company's scope carries them.
		const companyId = randomUUID();
		const companies: CloudSecretBrokerCompanies = {
			resolve: async (id) =>
				id === companyId
					? {
							companyId,
							broker,
							modelLogins: {} as never,
							modelLoginSignIns: undefined,
							modelLoginUsage: {} as never,
							claudeLogins: f.vault,
						}
					: undefined,
			signingIn: () => undefined,
		};
		const service = new HttpCloudSecretBrokerService(companies, runtimeToken, { proveBinding });
		const port = await service.start();
		try {
			const client = {
				origin: `http://127.0.0.1:${port}`,
				runtimeToken,
				companyId,
				holder: () => holder,
				allowLoopback: true,
			};
			const opened = await openClaudeLoginForRun(client, run, AbortSignal.timeout(5000));
			if ("refused" in opened) throw new Error("refused");
			expect(opened.version).toBe(1);
			expect(proveBinding).toHaveBeenCalledWith(run, holder);
			const renewed = new Map(opened.files);
			renewed.set(".credentials.json", Buffer.from(RENEWED_CREDENTIALS));
			expect(
				await sealClaudeLoginBack(client, { binding: run, opened, files: renewed }, AbortSignal.timeout(5000)),
			).toMatchObject({
				state: "sealed",
				version: 2,
			});
			expect(proveBinding).toHaveBeenCalledTimes(2);
			const post = (headers: Record<string, string>, path = "open") =>
				fetch(`http://127.0.0.1:${port}/v1/claude-logins/${path}?company=${client.companyId}`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify({ schema: "qorpera.claude-login-open-request/v1", binding: run }),
				});
			// Another token never reaches the vault; a request without the run's holder is refused before it.
			const opens = vi.mocked(f.authority.openClaudeLoginForRun).mock.calls.length;
			expect(
				(await post({ authorization: `Bearer ${"b".repeat(43)}`, "x-qorpera-identity": holder })).status,
			).not.toBe(200);
			expect((await post({ authorization: `Bearer ${runtimeToken}` })).status).toBe(403);
			proveBinding.mockRejectedValueOnce(new Error("not this run's lease"));
			expect((await post({ authorization: `Bearer ${runtimeToken}`, "x-qorpera-identity": holder })).status).toBe(
				403,
			);
			expect(vi.mocked(f.authority.openClaudeLoginForRun).mock.calls.length).toBe(opens);
			// A company this vault does not serve gets nothing.
			await expect(
				openClaudeLoginForRun({ ...client, companyId: randomUUID() }, run, AbortSignal.timeout(5000)),
			).rejects.toThrow("Cloud secret broker refused the Claude login");
			expect(vi.mocked(f.authority.openClaudeLoginForRun).mock.calls.length).toBe(opens);
			const fine = await post({ authorization: `Bearer ${runtimeToken}`, "x-qorpera-identity": holder });
			expect(fine.status).toBe(200);
			expect(fine.headers.get("cache-control")).toBe("no-store");
			await fine.arrayBuffer();
			// The worker reports (report_work) while Claude Code still runs: the open route gives the run nothing more, and
			// its seal-back through the vault's own routes still seals what Claude Code renewed since.
			f.login.workerState = "succeeded";
			await expect(openClaudeLoginForRun(client, run, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker refused the Claude login",
			);
			const renewedAgain = `{"claudeAiOauth":{"accessToken":"CANARY-C4B-AFTER-REPORT-${randomUUID()}"}}`;
			const afterReport = await sealClaudeLoginBack(
				client,
				{
					binding: run,
					opened: { claudeLoginId: f.login.id, version: 2, envelopeSha256: f.sha(), fileSha256: {} },
					files: new Map([[".credentials.json", Buffer.from(renewedAgain)]]),
				},
				AbortSignal.timeout(5000),
			);
			expect(afterReport).toMatchObject({ state: "sealed", version: 3 });
			expect((await f.sealed()).files[".credentials.json"]).toBe(b64(renewedAgain));
		} finally {
			await service.close();
		}
	});
});
