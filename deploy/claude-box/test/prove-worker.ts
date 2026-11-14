// C4c end-to-end proof: a Claude Code worker, from its dispatch in the real SQL to its results and the completion wake,
// with Claude Code (unmodified, pinned) working on a real nested home through the coding executor's own route.
//
// Two processes, as on a real run host (prove-worker.sh runs them on a test VM, through run-on-node --sudo):
//   platform (root): a migrated database (SQL test 1268's fixture: 924's company and Alice's live run, 1246's machine
//     home-a, running for the owner, its boot the nested VM's real one); PostgREST stood in by psql (one call a request,
//     as the service role); the object gateway's folder route stood in (bytes kept in memory, confirmed with the folder
//     core as the gateway does); the shared vault's two Claude sign-in routes (the real HttpCloudSecretBrokerService and
//     CloudClaudeLoginVault, a made-up member key, its SQL through psql in the vault's own database session); the coding
//     executor's own ingress, router, machine host and LXD exec, its SQL the real one (qorpera_authorize_home_session,
//     qorpera_folder_home_session_window), the placement's LXD name and owner mapped to the proof's nested VM. It
//     dispatches, drains, materializes and starts each run (SQL test 1268's helpers), then completes its job as the
//     native host does (qorpera_complete_runner_job_v6), and reads what the run left.
//   run (nobody, a unit hardened like the company host): the runtime's own CloudNativeCompanyRuntime.execute for the
//     run's request, with HTTP clients to the platform's stand-ins, and the box's parts as C2's proof installs them. The
//     model is C2's stub (stub.py), reached through the box's own egress relay; it also answers Claude Code's renewal.
// Made-up sign-ins only: the sealed login's files hold canaries ("C2CANARY-FILE-..."), and the stub's renewals mint
// "C2CANARY-RFR-..." tokens. No real sign-in, no real model.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { authorizeHomeSession } from "../../coding-worker/home-session-authority.ts";
import { MachineCommandRouter } from "../../coding-worker/machine-command-routing.ts";
import { LxdCompanyMachineHost } from "../../../packages/runner-orchestrator/src/company-machine-host.ts";
import { LxdUnixClient } from "../../../packages/runner-orchestrator/src/lxd-client.ts";
import { CLAUDE_BOX_CONFIGURATION } from "../../../packages/runtime/src/cloud-claude-box.ts";
import { CloudClaudeLoginVault } from "../../../packages/runtime/src/cloud-claude-login-vault.ts";
import { HttpCloudCodingCommandService } from "../../../packages/runtime/src/cloud-coding-command-http.ts";
import { HttpCloudCompanyFolderBytes } from "../../../packages/runtime/src/cloud-company-folder-bytes.ts";
import { HttpCloudCompanyPathControl } from "../../../packages/runtime/src/cloud-company-path-control.ts";
import { createCloudHomeChannel } from "../../../packages/runtime/src/cloud-home-channel-client.ts";
import { CLAUDE_LOGIN_FILES_SCHEMA } from "../../../packages/runtime/src/cloud-model-login-sign-in.ts";
import { CLAUDE_LOGIN_FIELD } from "../../../packages/runtime/src/cloud-model-login-vault-sign-in.ts";
import { CloudNativeCompanyRuntime } from "../../../packages/runtime/src/cloud-native-company-runtime.ts";
import { nativeRuntimeFailureMetadata } from "../../../packages/runtime/src/cloud-native-failure.ts";
import { NativeHostDispatch } from "../../../packages/runtime/src/cloud-native-host-dispatch.ts";
import { SupabaseNativeProviderControlPlane } from "../../../packages/runtime/src/cloud-native-provider-service.ts";
import { CloudSecretBroker } from "../../../packages/runtime/src/cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService, sealClaudeLoginBack } from "../../../packages/runtime/src/cloud-secret-broker-http.ts";
import { CloudSecretKeyring } from "../../../packages/runtime/src/cloud-secret-crypto.ts";

const P = "/opt/qorpera-c2-proof";
const B = "/var/lib/c4c-proof";
const REPO = process.env.C4C_REPO ?? process.cwd();
const COMPANY = "92400000-0000-4000-8000-000000000010";
const ENVIRONMENT = "92400000-0000-4000-8000-000000000020";
const ALICE = "92400000-0000-4000-8000-000000000030";
const BROKER_AUTHORITY = "12680000-0000-4000-8000-000000000040";
const BROKER_CAPABILITY = "c".repeat(64);
const KEY_ID = "vault-root-1";
const PROOF_PLACEMENT = "c2e00000-0000-4000-8000-0000000000d2";
const PROOF_MACHINE = "qorpera-machine-c2e000000000400080000000000000d2";
const OWNER = "home-sftp-proof";
const PROVIDER = "machine-node";
const CANARY = new RegExp(`${"C2CAN"}ARY-[A-Z0-9]+-[0-9a-f]{8,}`, "g");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const say = (line: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (id: string, ok: boolean, text: string) => {
	if (!ok) failures++;
	say(`CHECK ${id} ${ok ? "PASS" : "FAIL"} ${text}`);
};

// =====================================================================================================================
// The platform (root)

/** The database through psql, as the service role (prove-company-run.mjs's Database, typed). */
class Database {
	readonly #run: (sql: string) => string;
	readonly #signatures = new Map<string, { names: string[]; nargs: number; defaults: number; set: boolean; void: boolean; types: string[] }[]>();
	calls: string[] = [];
	refusals: string[] = [];
	constructor(run: (sql: string) => string) {
		this.#run = run;
	}
	query(sql: string): string {
		return this.#run(sql).trim();
	}
	json<T = unknown>(sql: string): T {
		return JSON.parse(this.query(sql).split("\n").at(-1) ?? "null") as T;
	}
	#signature(method: string, keys: string[]) {
		if (!/^qorpera_[a-z0-9_]+$/.test(method)) throw new Error(`function name ${method}`);
		if (!this.#signatures.has(method))
			this.#signatures.set(
				method,
				JSON.parse(
					this.query(`select coalesce(json_agg(json_build_object('names', p.proargnames, 'nargs', p.pronargs,
						'defaults', p.pronargdefaults, 'set', p.proretset, 'void', p.prorettype = 'void'::regtype,
						'types', (select json_agg(format_type(t, null) order by o) from unnest(p.proargtypes) with ordinality u(t, o)))), '[]')
						from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${method}'`),
				),
			);
		const [signature] = (this.#signatures.get(method) ?? [])
			.filter((candidate) => {
				const names = (candidate.names ?? []).slice(0, candidate.nargs);
				return keys.every((key) => names.includes(key)) && names.slice(0, candidate.nargs - candidate.defaults).every((name) => keys.includes(name));
			})
			.sort((a, b) => a.nargs - b.nargs);
		return signature;
	}
	/** One function call, as PostgREST makes it; `session` runs it in another database session role (the vault's). */
	rpc(method: string, args: Record<string, unknown>, session?: string): { status: number; value: unknown } {
		this.calls.push(method);
		const keys = Object.keys(args);
		const signature = this.#signature(method, keys);
		if (!signature) return { status: 404, value: { code: "PGRST202", message: `No ${method}` } };
		const tag = `q${randomBytes(6).toString("hex")}`;
		const body = `$${tag}$${JSON.stringify(args)}$${tag}$::jsonb`;
		const parameters = keys.map((key) => {
			const type = signature.types[signature.names.indexOf(key)] ?? "jsonb";
			const value = `(${body} -> '${key}')`;
			if (type === "jsonb") return `${key} => ${value}`;
			if (type === "json") return `${key} => ${value}::json`;
			return `${key} => (${body} ->> '${key}')::${type}`;
		});
		const call = `public.${method}(${parameters.join(", ")})`;
		const select = signature.set
			? `select coalesce(jsonb_agg(to_jsonb(r)), '[]') from ${call} r;`
			: signature.void
				? `select ${call}; select 'null';`
				: `select to_jsonb(${call});`;
		// The native host's entry points are the anon role's, as PostgREST runs a call made with the publishable key.
		const role = /^qorpera_native_(host_call|host_call_long|identity_call)$/.test(method) ? "anon" : "service_role";
		try {
			const out = this.query(`\\set VERBOSITY verbose
				begin;
				${session ? `set local session authorization ${session};` : ""}
				${role === "anon" ? "set local role anon;" : ""}
				select set_config('request.jwt.claims', '{"role":"${role}"}', true) \\g /dev/null
				${select}
				commit;`);
			return { status: 200, value: out ? JSON.parse(out.split("\n").at(-1) ?? "null") : null };
		} catch (error) {
			const failed = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec((error as Error)?.message ?? "");
			if (!failed) throw error;
			this.refusals.push(`${method}: ${failed[1]} ${failed[2]}`);
			const code = failed[1] as string;
			const status = code === "42501" ? 403 : code.startsWith("55") || code.startsWith("P0") ? 500 : 400;
			return { status, value: { code, details: null, hint: null, message: failed[2] } };
		}
	}
	direct(method: string, args: Record<string, unknown>, session?: string): unknown {
		const { status, value } = this.rpc(method, args, session);
		if (status === 200) return value;
		throw Object.assign(new Error(String((value as { message?: string }).message)), { code: (value as { code?: string }).code });
	}
}

async function body(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<number> {
	const server = createServer((request, response) => {
		handler(request, response).catch((error) => {
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ message: String((error as Error)?.message ?? error) }));
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** scripts/test-hosted-db.mjs's expandTestFixture (that file runs its suite when it is the bundle's entry). */
function expandTestFixture(name: string, read: (file: string) => string, chain: string[] = []): string {
	const source = read(name);
	const directive = /^-- @fixture ([0-9a-z_.-]+\.test\.sql) until "([^"\n]+)"\n/.exec(source);
	if (!directive) return source;
	const [line, fixtureName, marker] = directive as unknown as [string, string, string];
	if (fixtureName === name || chain.includes(fixtureName)) throw new Error(`Test fixture is unavailable: ${fixtureName}`);
	const fixture = expandTestFixture(fixtureName, read, [...chain, name]);
	const end = fixture.indexOf(marker);
	if (end < 0) throw new Error(`Test fixture is unavailable: ${fixtureName}`);
	return fixture.slice(0, end) + source.slice(line.length);
}

/** SQL test 1268's helpers again, for a database session after the fixture's (each psql call is one session). */
function helpers(): string {
	const read = (name: string) => readFileSync(join(REPO, "supabase/tests", name), "utf8");
	const base = read("924_folder_runtime_base.test.sql");
	const home = read("1246_home_exec_sessions.test.sql");
	const c4 = read("1268_claude_code_worker_dispatch.test.sql");
	const between = (text: string, from: string, to: string) => {
		const start = text.indexOf(from);
		const end = text.indexOf(to, start);
		if (start < 0 || end < 0) throw new Error(`helpers moved: ${from}`);
		return text.slice(start, end);
	};
	return [
		between(base, "create function pg_temp.base_claims", "-- END BASE HELPERS"),
		between(home, "create function pg_temp.h1_binding", "-- 1241's node and executor"),
		between(c4, "-- BEGIN C4 HELPERS", "-- END C4 HELPERS"),
	].join("\n");
}

interface RunResult {
	readonly ok: boolean;
	readonly providerSessionId?: string;
	readonly error?: string;
	readonly stage?: string;
	readonly leftInRoot?: string[];
	readonly stub?: { requests: number; authTags: string[]; refreshes: number; results: { name: string; isError: boolean }[] };
	readonly outputs: string;
	readonly ms: number;
}

async function platform(): Promise<void> {
	const boot = process.argv[3];
	if (!boot || !/^[0-9a-f-]{36}$/.test(boot)) throw new Error("usage: platform <the home's boot id>");
	const name = `c4c_e2e_${randomBytes(3).toString("hex")}`;
	// Loaded from the repository as it is (bundled, its own file would no longer be its own: the warm copies hash it).
	const cluster = join(REPO, "scripts", "test-hosted-db-cluster.mjs");
	const { hostedDatabase } = (await import(cluster)) as {
		hostedDatabase: (name: string) => Promise<{ cluster: { psql(db: string, sql: string, options: string[]): string }; close(): void }>;
	};
	const database = await hostedDatabase(name);
	const db = new Database((sql) => String(database.cluster.psql(name, sql, ["-qAt"])));
	const prelude = (binding: unknown) => `begin;
${helpers()}
select set_config('qorpera_test.base_binding', '${JSON.stringify(binding)}', false) \\g /dev/null
select pg_temp.base_claims('service_role') \\g /dev/null
`;
	const sessions: { exec: number; channelBytes: number; canaryInChannels: string[] } = { exec: 0, channelBytes: 0, canaryInChannels: [] };
	try {
		// ---- The company, Alice's run, her machine home-a on the nested VM's boot, her todo (1268's fixture). ----------
		const fixture = expandTestFixture("1268_claude_code_worker_dispatch.test.sql", (file: string) =>
			readFileSync(join(REPO, "supabase/tests", file), "utf8"),
		);
		const end = fixture.indexOf("-- The checks start here");
		const randomBoot = "select pg_temp.h1_up('home-a', extensions.gen_random_uuid()) \\g /dev/null";
		if (end < 0 || fixture.slice(0, end).split(randomBoot).length !== 2) throw new Error("1268's fixture moved");
		const made = db.json<{ alice: Record<string, string>; nativeBinarySha256: string; machine: Record<string, string> }>(`${fixture
			.slice(0, end)
			.replace(randomBoot, `select pg_temp.h1_up('home-a', '${boot}') \\g /dev/null`)}
			insert into public.qorpera_claude_sign_in_members(user_id) values (pg_temp.c4_owner_id());
			-- LOCAL STAND-IN on this test VM only (the lead's word, 14 Nov): the home's two calls are not yet native host calls
			-- (20260930752000 lists none); #1761 adds them at the bottom of the stack. prove-worker.sh adds them to this
			-- run's copy of the path control and the dispatch the same way. Nothing of it is in a commit.
			insert into public.qorpera_native_host_calls(name, scope) values ('qorpera_company_home_available', 'binding'),
				('qorpera_close_home_session', 'binding') on conflict do nothing;
			select jsonb_build_object('alice', current_setting('qorpera_test.base_binding')::jsonb,
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
				'machine', to_jsonb(pg_temp.h1_machine('home-a')) - 'binding')::text;
			commit;`);
		const alice = made.alice;
		say(`company made; Alice's run ${alice.runId?.slice(0, 8)}; home-a ${made.machine.id?.slice(0, 8)} on boot ${boot.slice(0, 8)}`);
		const session = (sql: string) => db.query(`${prelude(alice)}${sql}\ncommit;`);
		const sessionJson = <T>(sql: string): T => JSON.parse(session(sql).split("\n").filter(Boolean).at(-1) || "null") as T;
		const owner = sessionJson<string>("select to_jsonb(pg_temp.c4_owner_id())::text;");
		const member = sessionJson<string>("select to_jsonb(pg_temp.c4_name())::text;");

		// ---- The vault: the member's sealed Claude sign-in (made-up canary files), and its two routes ---------------------
		const keyring = new CloudSecretKeyring({}, { [KEY_ID]: randomBytes(32) });
		const canary = (kind: string) => `sk-ant-oat01-${"C2CAN"}ARY-${kind}-${randomBytes(8).toString("hex")}`;
		const loginFiles = (token: string, expiresAt: number) => ({
			".credentials.json": Buffer.from(
				JSON.stringify({
					claudeAiOauth: {
						accessToken: token,
						refreshToken: `${token}-r`,
						expiresAt,
						scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
						subscriptionType: "max",
					},
				}),
			).toString("base64"),
			".claude.json": Buffer.from(
				JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }),
			).toString("base64"),
		});
		const insertLogin = (id: string, files: Record<string, string>) => {
			const envelope = Buffer.from(
				keyring.sealMember(
					{ [CLAUDE_LOGIN_FIELD]: JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files }) },
					{ memberId: owner, loginId: id, version: 1, keyId: KEY_ID },
				),
			);
			session(`update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
					encrypted_envelope = null, envelope_sha256 = null where owner_user_id = '${owner}' and status = 'active';
				insert into public.qorpera_claude_logins(id, owner_user_id, principal_id, client_connection_id, key_id, encrypted_envelope,
					envelope_sha256, provider_account_email)
				values ('${id}', '${owner}', '12680000-0000-4000-8000-000000000050', extensions.gen_random_uuid(), '${KEY_ID}',
					decode('${envelope.toString("base64")}', 'base64'), '${sha256(envelope)}', 'owner@example.test');`);
			envelope.fill(0);
		};
		const login = () =>
			sessionJson<{ id: string; version: number; status: string } | null>(
				`select coalesce((select jsonb_build_object('id', id, 'version', version, 'status', status) from public.qorpera_claude_logins
					where owner_user_id = '${owner}' order by created_at desc limit 1), 'null')::text;`,
			);
		const vault = new CloudClaudeLoginVault({
			keyring,
			authority: {
				openClaudeLoginForRun: async (binding) =>
					db.direct(
						"qorpera_open_claude_login_for_run",
						{ p_broker_authority_id: BROKER_AUTHORITY, p_broker_capability_sha256: BROKER_CAPABILITY, p_binding: binding },
						"qorpera_secret_broker",
					),
				openClaudeLoginForSealBack: async (binding) =>
					db.direct(
						"qorpera_open_claude_login_for_seal_back",
						{ p_broker_authority_id: BROKER_AUTHORITY, p_broker_capability_sha256: BROKER_CAPABILITY, p_binding: binding },
						"qorpera_secret_broker",
					),
				sealClaudeLoginBack: async (seal) =>
					db.direct(
						"qorpera_seal_claude_login_back",
						{
							p_broker_authority_id: BROKER_AUTHORITY,
							p_broker_capability_sha256: BROKER_CAPABILITY,
							p_binding: seal.binding,
							p_claude_login_id: seal.claudeLoginId,
							p_base_version: seal.baseVersion,
							p_base_envelope_sha256: seal.baseEnvelopeSha256,
							p_key_id: seal.keyId,
							p_encrypted_envelope_base64: Buffer.from(seal.encryptedEnvelope).toString("base64"),
							p_envelope_sha256: seal.envelopeSha256,
						},
						"qorpera_secret_broker",
					),
			},
		});
		const refuse = async () => {
			throw new Error("not in this proof");
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const vaultService = new HttpCloudSecretBrokerService(
			{
				resolve: async (id: string) =>
					id === COMPANY
						? {
								companyId: COMPANY,
								broker: new CloudSecretBroker({
									authority: {
										describeCapture: refuse,
										completeCapture: refuse,
										authorizeOperation: refuse,
										authorizeRepositoryCredential: refuse,
									},
									keyring,
									adapters: [],
								}),
								modelLogins: {} as never,
								modelLoginSignIns: undefined,
								modelLoginUsage: {} as never,
								claudeLogins: vault,
							}
						: undefined,
				signingIn: () => undefined,
			} as never,
			runtimeToken,
			// Stood in: the run's holder proof (the native host dispatch's job token). Every route checks the binding in SQL.
			{ proveBinding: async () => undefined },
		);
		const vaultPort = await vaultService.start();

		// ---- PostgREST and the run's control plane, over HTTP, for the run's process -------------------------------------
		let stopFrom = Number.POSITIVE_INFINITY;
		const stopped: { runId: string; version: number }[] = [];
		const rpcPort = await listen(async (request, response) => {
			const url = new URL(String(request.url), "http://x");
			const input = JSON.parse((await body(request)).toString("utf8") || "{}") as Record<string, unknown>;
			const rpc = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/.exec(url.pathname);
			const control = /^\/control\/([a-zA-Z]+)$/.exec(url.pathname);
			// A member's stop, as the proof makes it: once the vault holds the version Claude Code renewed at its start (the
			// early seal), the run's job is cancelled; then the run's process stops it through the run's own signal.
			if (url.pathname === "/proof/stop") {
				const runId = String(input.runId);
				for (let i = 0; i < 300 && (login()?.version ?? 0) <= stopFrom; i++) await sleep(100);
				session(`select pg_temp.c4_end_job('${runId}', 'cancelled');`);
				stopped.push({ runId, version: login()?.version ?? 0 });
				response.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			let answer: { status: number; value: unknown };
			if (rpc) answer = db.rpc(rpc[1] as string, input);
			else if (control) {
				const binding = input.binding as Record<string, unknown>;
				const op = control[1];
				const call: Record<string, () => { status: number; value: unknown }> = {
					describeToolAuthority: () => db.rpc("qorpera_describe_native_tool_authority", { p_binding: binding }),
					beginToolOperation: () =>
						db.rpc("qorpera_begin_native_tool_operation", {
							p_binding: binding,
							p_receipt_id: input.receiptId,
							p_logical_operation_key: input.logicalOperationKey,
							p_input_sha256: input.inputSha256,
							p_downstream_idempotency_sha256: sha256(String(input.downstreamIdempotencyKey)),
							p_requires_company_revision: input.requiresCompanyRevision,
						}),
					completeToolOperation: () =>
						db.rpc("qorpera_complete_native_tool_operation", {
							p_binding: binding,
							p_receipt_id: input.receiptId,
							p_input_sha256: input.inputSha256,
							p_result: input.result,
						}),
					completeFolderToolOperation: () =>
						db.rpc("qorpera_folder_complete_run_receipt", {
							p_binding: binding,
							p_receipt_id: input.receiptId,
							p_input_sha256: input.inputSha256,
							p_result: input.result,
							p_folder_commit_id: input.folderCommitId,
						}),
				};
				answer = call[op as string]?.() ?? { status: 404, value: { message: "no such control" } };
			} else answer = { status: 404, value: { message: "no route" } };
			response.writeHead(answer.status, { "content-type": "application/json" });
			response.end(JSON.stringify(answer.value));
		});

		// ---- The object gateway's folder route ---------------------------------------------------------------------------
		const objects = new Map<string, Buffer>();
		const gatewayPort = await listen(async (request, response) => {
			const url = new URL(String(request.url), "http://x");
			const route = /^\/v1\/folder-objects\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(url.pathname);
			if (!route) {
				response.writeHead(404).end("{}");
				return;
			}
			const [, environmentId, hash] = route as unknown as [string, string, string];
			if (request.method === "PUT") {
				const bytes = await body(request);
				if (sha256(bytes) !== hash) {
					response.writeHead(400).end("{}");
					return;
				}
				const binding = JSON.parse(Buffer.from(String(request.headers["x-qorpera-native-binding"]), "base64url").toString("utf8"));
				const { status } = db.rpc("qorpera_folder_confirm_object", {
					p_environment_id: environmentId,
					p_actor: { kind: "run", runId: binding.runId, jobId: binding.jobId, runnerId: binding.runnerId, assignmentId: binding.assignmentId },
					p_intent: request.headers["x-qorpera-upload-intent"],
					p_sha256: hash,
					p_bytes: bytes.length,
				});
				if (status !== 200) {
					response.writeHead(403).end("{}");
					return;
				}
				const existed = objects.has(hash);
				objects.set(hash, bytes);
				response
					.writeHead(existed ? 200 : 201, { "content-type": "application/json" })
					.end(JSON.stringify({ status: existed ? "exists" : "stored", sha256: hash, bytes: bytes.length, replication: "pending" }));
				return;
			}
			const bytes = objects.get(hash);
			if (!bytes) response.writeHead(404).end("{}");
			else response.writeHead(200).end(bytes);
		});

		// ---- The coding executor's own route: ingress, router, machine host and LXD exec; its SQL the real one -----------
		const lxd = new LxdUnixClient("/var/snap/lxd/common/lxd/unix.socket");
		const scan = (text: string, where: string) => {
			sessions.channelBytes += text.length;
			for (const hit of text.match(CANARY) ?? []) sessions.canaryInChannels.push(`${where}:${hit.slice(0, 26)}`);
		};
		const client = {
			execInstancePipe: async (project: string, instance: string, request: Record<string, unknown>, signal: AbortSignal) => {
				sessions.exec++;
				const stdout = request.stdout as ((chunk: Buffer) => void) | undefined;
				const stdin = request.stdin as AsyncIterable<Buffer> | undefined;
				return lxd.execInstancePipe(
					project,
					instance,
					{
						...request,
						...(stdout ? { stdout: (chunk: Buffer) => (scan(chunk.toString("latin1"), "out"), stdout(chunk)) } : {}),
						...(stdin
							? {
									stdin: (async function* () {
										for await (const chunk of stdin) {
											scan(Buffer.from(chunk).toString("latin1"), "in");
											yield chunk;
										}
									})(),
								}
							: {}),
					} as never,
					signal,
				);
			},
		};
		// The placement's LXD name and owner are the proof's nested VM's: the database's placement id names no LXD
		// instance on this test VM. Everything else (the session, the boot, the sharing rule) is SQL's answer as it is.
		const dbControl = {
			call: async (method: string, args: Record<string, unknown>) => {
				const value = db.direct(method, args) as Record<string, unknown>;
				if (method === "qorpera_folder_home_session_window" && value?.state === "open")
					return { ...value, placementId: PROOF_PLACEMENT };
				return value;
			},
		};
		const host = new LxdCompanyMachineHost({
			control: dbControl,
			owner: OWNER,
			machineIdSha256: "d".repeat(64),
			policy: {
				providerId: PROVIDER,
				providerPolicySha256: "a".repeat(64),
				project: "default",
				imageFingerprint: "b".repeat(64),
				bootstrapSha256: "c".repeat(64),
				storagePool: "qorpera-vm",
				network: "qagent0",
			},
			client,
			journalRoot: "/nas/coding/control",
			storagePolicy: {
				schema: "qorpera.coding-nas-policy/v1",
				mountPoint: "/nas",
				rootPath: "/nas/coding",
				source: "10.0.0.2:/coding",
				serverAddress: "10.0.0.2",
			},
			helperSha256: "e".repeat(64),
		} as never);
		const router = new MachineCommandRouter({
			owner: OWNER,
			providerId: PROVIDER,
			peers: [],
			control: dbControl,
			credential: async () => {
				throw new Error("no peers in this proof");
			},
			execServerLocal: (authority: never, signal: AbortSignal) => host.execServer(authority, signal),
		} as never);
		const executorToken = randomBytes(32).toString("base64url");
		const executor = new HttpCloudCodingCommandService({
			token: executorToken,
			host: "127.0.0.1",
			port: 0,
			proveBinding: async () => undefined,
			authorize: refuse,
			execute: refuse,
			home: {
				authorize: async (request: never, signal: AbortSignal) => {
					const answer = await authorizeHomeSession(dbControl as never, request, signal);
					return answer.state === "authorized"
						? { ...answer, placementId: PROOF_PLACEMENT, executorOwner: OWNER, providerId: PROVIDER }
						: answer;
				},
				open: (authority: never, request: never, signal: AbortSignal) => router.execServer(authority, request, signal),
			},
		} as never);
		const executorPort = await executor.start();
		say(`stand-ins up: PostgREST ${rpcPort}, gateway ${gatewayPort}, vault ${vaultPort}, executor ${executorPort}`);

		// ---- One run of a worker: dispatched, drained, materialized, started; then the run's process; then completed ----
		mkdirSync(join(B, "configs"), { recursive: true, mode: 0o700 });
		chownSync(B, 65534, 65534);
		chownSync(join(B, "configs"), 65534, 65534);
		// The stub's renewed tokens live one second, so every run renews at its start (and again before later requests):
		// each run has a renewal to seal, and a run's seal lands only on the version it opened (the vault's compare-and-swap).
		const scenario = (label: string, steps: unknown[], final: string, expiresIn = 1) => {
			const path = join(P, `scen-c4c-${label}.json`);
			writeFileSync(path, JSON.stringify({ label, nonce: randomBytes(4).toString("hex"), steps, final, expiresIn }), { mode: 0o444 });
			return path;
		};
		const out = (key: string) => `/company/QorperaOS/agents/alice/todos/onboarding/${key}`;
		const T = (tool: string, name: string, input: Record<string, unknown>) => ({ tool, name, input });
		const Bash = (command: string, name: string) => T("Bash", name, { command, description: name });
		const dispatch = (key: string, workerId: string, title: string) =>
			sessionJson<Record<string, unknown>>(`select pg_temp.c4_dispatch(pg_temp.c4_alice(), 'c4c-e2e-${key}',
				'QorperaOS/agents/alice/todos/onboarding/${key}', pg_temp.c4_brief('${workerId}', p_title => '${title}'))::text;`);
		const worker = (id: string) =>
			sessionJson<Record<string, unknown>>(`select to_jsonb(w)::text from public.qorpera_runtime_workers w where w.id = '${id}';`);
		const drain = () => sessionJson<Record<string, unknown>>("select pg_temp.c4_drain()::text;");
		const start = (workerId: string) => {
			const row = worker(workerId);
			if (!row?.occurrence_id) {
				say(`START ${workerId.slice(-2)}: no wake yet: ${JSON.stringify(row).slice(0, 400)}; lease ${session(`select to_jsonb(l)::text from public.qorpera_claude_worker_leases l`).slice(-300)}; drain ${JSON.stringify(drain())}`);
			}
			return startRun(workerId);
		};
		const startRun = (workerId: string) =>
			sessionJson<Record<string, string>>(`do $$ begin perform pg_temp.base_materialize(); end $$;
				set local session_replication_role = replica;
				update public.qorpera_execution_runs set memory_mode = 'tree' where id = (select run_id from public.qorpera_wake_occurrences
					where id = (select occurrence_id from public.qorpera_runtime_workers where id = '${workerId}'));
				set local session_replication_role = origin;
				select pg_temp.base_start((select run_id from public.qorpera_wake_occurrences
					where id = (select occurrence_id from public.qorpera_runtime_workers where id = '${workerId}')))::text;`);
		/** The job's lease token as the run's host holds it (924's fixture keeps only a made-up digest), and the job's and
		 * the native lease's time as long as a run here takes: stand-ins for the host's own lease and its renewal. */
		const leased = (binding: Record<string, string>) => {
			const token = randomBytes(32).toString("base64url");
			session(`set local session_replication_role = replica;
				update public.qorpera_runner_jobs set lease_token_sha256 = '${sha256(token)}',
					lease_expires_at = clock_timestamp() + interval '30 minutes' where id = '${binding.jobId}';
				update public.qorpera_native_provider_connection_leases set expires_at = clock_timestamp() + interval '30 minutes'
					where id = '${binding.leaseId}';
				set local session_replication_role = origin;`);
			return { ...binding, leaseToken: token };
		};
		const complete = (binding: Record<string, string>, providerSessionId: string) =>
			db.direct("qorpera_complete_runner_job_v6", {
				p_runner_id: binding.runnerId,
				p_session_token_sha256: "2".repeat(64),
				p_job_id: binding.jobId,
				p_lease_token_sha256: sha256(binding.leaseToken as string),
				p_client_artifact_index_id: randomUUID(),
				p_client_substrate_version_id: randomUUID(),
				p_output_snapshot_id: null,
				p_result: {
					schema: "qorpera.runner-result/v1",
					runtime: "company-path-v1",
					backend: "native-company-runtime",
					native_lease_id: binding.leaseId,
					substrate_version_id: sessionJson<string>(
						`select to_jsonb(substrate_version_id)::text from public.qorpera_runner_jobs where id = '${binding.jobId}';`,
					),
					output_count: 0,
					output_bytes: 0,
					publication: null,
					backend_result: {
						schema: "qorpera.native-harness-result/v2",
						run_id: binding.runId,
						message_count: 0,
						final_message_id: null,
						provider_session_id: providerSessionId,
					},
					usage: {
						schema: "qorpera.runner-usage/v1",
						execution_ms: 50,
						input_bytes: 0,
						output_bytes: 0,
						result_bytes: 300,
						limits: {
							wall_time_ms: 1000,
							memory_bytes: 67108864,
							cpu_millis: 1000,
							max_pids: 16,
							max_input_bytes: 1048576,
							max_output_bytes: 0,
							max_result_bytes: 4096,
						},
					},
				},
			});
		const results = (key: string) =>
			sessionJson<{ sha: string | null; parse: Record<string, unknown> | null } | null>(`select coalesce((select jsonb_build_object(
					'sha', v.file_sha256, 'parse', v.structured -> 'parse') from public.qorpera_folder_path_versions v
					where v.version = pg_temp.base_version('QorperaOS/agents/alice/todos/onboarding/${key}/results.md')), 'null')::text;`);
		/** The worker's results file as saved: its text (from the gateway's bytes) and the folder core's parse of it. */
		const resultsText = (key: string) => {
			const found = results(key);
			const bytes = found?.sha ? objects.get(found.sha) : undefined;
			return found ? `${bytes?.toString("utf8") ?? ""}\n${JSON.stringify(found.parse)}` : null;
		};
		let runCount = 0;
		const runWorker = async (binding: Record<string, string>, scenarioPath: string, extra: Record<string, unknown> = {}) => {
			runCount++;
			const label = `run${runCount}`;
			const config = {
				label,
				binding,
				nativeBinarySha256: made.nativeBinarySha256,
				rpc: `http://127.0.0.1:${rpcPort}`,
				gateway: `http://127.0.0.1:${gatewayPort}`,
				vault: { origin: `http://127.0.0.1:${vaultPort}`, runtimeToken, companyId: COMPANY },
				executor: { url: `http://127.0.0.1:${executorPort}`, token: executorToken },
				holder: `job.${binding.jobId}.${binding.leaseToken}`,
				scenario: scenarioPath,
				stubPort: 18443,
				...extra,
			};
			const path = join(B, "configs", `${label}.json`);
			writeFileSync(path, JSON.stringify(config), { mode: 0o400 });
			chownSync(path, 65534, 65534);
			const t0 = Date.now();
			const child = spawn(
				"systemd-run",
				[
					"--quiet",
					"--pipe",
					"--wait",
					"--collect",
					"--uid=65534",
					"--gid=65534",
					`--working-directory=${B}`,
					"-p",
					"NoNewPrivileges=yes",
					"-p",
					"PrivateDevices=yes",
					"-p",
					"DeviceAllow=/dev/fuse rw",
					"-p",
					"BindPaths=/dev/fuse",
					"-p",
					"CapabilityBoundingSet=",
					"-p",
					"AmbientCapabilities=",
					"-p",
					"RestrictNamespaces=user mnt pid net ipc uts cgroup",
					"-p",
					"ProtectSystem=strict",
					"-p",
					"ProtectHome=yes",
					"-p",
					"ProtectProc=invisible",
					"-p",
					"ProcSubset=all",
					"-p",
					"ProtectKernelTunables=no",
					"-p",
					"ProtectKernelModules=yes",
					"-p",
					"ProtectControlGroups=yes",
					"-p",
					"RestrictSUIDSGID=yes",
					"-p",
					"LockPersonality=yes",
					"-p",
					"PrivateTmp=yes",
					"-p",
					"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
					"-p",
					"TasksMax=512",
					"-p",
					`ReadWritePaths=${B}`,
					"-p",
					"UMask=0077",
					process.execPath,
					join(P, "worker.bundle.mjs"),
					"run",
					path,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let text = "";
			child.stdout.on("data", (chunk) => {
				text += chunk;
			});
			child.stderr.on("data", (chunk) => {
				text += chunk;
			});
			await new Promise((resolve) => child.once("close", resolve));
			writeFileSync(join(B, `${label}.out`), text);
			const line = text.split("\n").find((entry) => entry.startsWith("RESULT "));
			const result = line ? (JSON.parse(line.slice(7)) as RunResult) : ({ ok: false, error: "no RESULT line", outputs: text.slice(-3000), ms: 0 } as RunResult);
			say(`${label}: ${result.ok ? `ok ${result.providerSessionId}` : `failed ${result.stage ?? ""} ${result.error?.slice(0, 300)}`} in ${Date.now() - t0} ms`);
			if (!result.ok) say(`${label} output tail: ${text.slice(-2500).replaceAll("\n", " | ")}`);
			return { ...result, text };
		};

		// 1. No sign-in: the dispatch is refused in its words, and nothing is written.
		const noLogin = dispatch("nologin", "c4c00000-0000-4000-8000-0000000000b0", "Without a sign-in");
		check(
			"no-login",
			JSON.stringify(noLogin).includes(`Claude Code needs ${member}'s own Claude sign-in.`) &&
				worker("c4c00000-0000-4000-8000-0000000000b0") === null,
			`dispatch refused: ${JSON.stringify((noLogin as { units?: unknown[] }).units?.[0]).slice(0, 300)}`,
		);

		// 2. The member's sign-in, made up and expired: Claude Code renews it at its start (the stub answers).
		insertLogin("c4c00000-0000-4000-8000-0000000000c1", loginFiles(canary("FILE"), Date.now() - 3600_000));
		check("login-v1", login()?.version === 1, `the login: ${JSON.stringify(login())}`);

		// 3. The first worker: real work on the machine; a second worker of the same member waits for the lease.
		const w1 = "c4c00000-0000-4000-8000-0000000000b1";
		const d1 = dispatch("pdf", w1, "Make the onboarding notes");
		check("dispatch-1", JSON.stringify(d1).includes('"outcome": "saved"') || JSON.stringify(d1).includes('"outcome":"saved"'), `saved: ${JSON.stringify(d1).slice(0, 200)}`);
		drain();
		const b1 = leased(start(w1));
		const w2 = "c4c00000-0000-4000-8000-0000000000b2";
		dispatch("slides", w2, "Make the slides");
		const waited = drain();
		check("lease-wait", worker(w2)?.occurrence_id === null, `the second Claude Code worker waits for the member's lease: ${JSON.stringify(waited)}`);
		const work = scenario(
			"work",
			[
				Bash(`hostname; id -un; mkdir -p ${out("pdf")} && echo 'made on the machine' > ${out("pdf")}/notes.txt && cat ${out("pdf")}/notes.txt`, "shell"),
				Bash("sudo -n install -o root -g root -m 0644 /dev/null /etc/c4c-root-made && ls -l /etc/c4c-root-made", "sudo"),
				T("Write", "write", { file_path: `${out("pdf")}/onboarding.md`, content: "# Onboarding\n\nWelcome.\n" }),
				T("Read", "read-missing", { file_path: `${out("pdf")}/not-there.md` }),
				T("Grep", "grep", { pattern: "Welcome", path: out("pdf"), output_mode: "files_with_matches" }),
			],
			"I made onboarding.md and notes.txt in my folder. Nothing is left. Changed: onboarding.md, notes.txt.",
		);
		const r1 = await runWorker(b1, work);
		// A seal-back AFTER the worker's report, through the vault's own route and the real SQL, while the run's job and the
		// member's lease are still this run's (the run host does it so when a renewal comes late): the run's composition
		// wrote results.md above; the job is completed only after this.
		const reported = worker(w1);
		const head = sessionJson<{ id: string; version: number; envelopeSha256: string }>(`select jsonb_build_object('id', id,
			'version', version, 'envelopeSha256', envelope_sha256)::text from public.qorpera_claude_logins where id = 'c4c00000-0000-4000-8000-0000000000c1';`);
		const afterReport = await sealClaudeLoginBack(
			{ origin: `http://127.0.0.1:${vaultPort}`, runtimeToken, companyId: COMPANY, holder: () => `job.${b1.jobId}.${b1.leaseToken}`, allowLoopback: true },
			{
				binding: {
					leaseId: b1.leaseId as string,
					runId: b1.runId as string,
					jobId: b1.jobId as string,
					runnerId: b1.runnerId as string,
					assignmentId: b1.assignmentId as string,
					credentialCapsuleId: b1.credentialCapsuleId as string,
					computeIdentityId: b1.computeIdentityId as string,
				},
				opened: { claudeLoginId: head.id, version: head.version, envelopeSha256: head.envelopeSha256, fileSha256: {} },
				files: new Map([[".credentials.json", Buffer.from(loginFiles(canary("RFR"), Date.now() - 3600_000)[".credentials.json"], "base64")]]),
			},
			AbortSignal.timeout(20_000),
		).catch((error: Error) => ({ state: `error: ${error.message}` }));
		check("seal-after-report", reported?.reported_at != null && afterReport.state === "sealed" && login()?.version === head.version + 1,
			`the worker had reported (${String(reported?.state)}, ${String(reported?.reported_at)}); a seal-back then answered ${afterReport.state}; the login went ${head.version} -> ${login()?.version}`);
		if (r1.ok && r1.providerSessionId) complete(b1, r1.providerSessionId);
		const results1 = resultsText("pdf");
		check("run-1", r1.ok && /^claude-code\/2\.1\.325\/[^/]+\/[^/]+$/.test(r1.providerSessionId ?? ""), `the run: ${r1.providerSessionId ?? r1.error}`);
		check("results-1", results1?.includes("outcome: succeeded") === true && results1.includes("I made onboarding.md"), `results.md: ${results1?.replaceAll("\n", " | ")}`);
		const l1 = login();
		check("sealed-early", (l1?.version ?? 0) >= 2, `Claude Code renewed the expired sign-in at its start and the run sealed it back: ${JSON.stringify(l1)}`);
		check("tools-ran", (r1.stub?.results ?? []).length === 5 && (r1.stub?.results ?? []).filter((r) => r.isError).map((r) => r.name).join() === "read-missing",
			`stub saw the five results (one error): ${JSON.stringify(r1.stub?.results)}`);
		check("root-left", (r1.leftInRoot ?? ["?"]).length === 0, `nothing left in the run's root: ${JSON.stringify(r1.leftInRoot)}`);
		const steps1 = sessionJson<{ tool: string }[]>(
			`select coalesce(jsonb_agg(jsonb_build_object('tool', s.tool, 'finished', s.finished) order by s.j), '[]')::text
				from public.qorpera_memory_run_steps s where s.run_id = '${b1.runId}';`,
		);
		check("steps-1", steps1.map((s) => s.tool).join() === "claude_code,claude_code_bash,claude_code_bash,claude_code_write,claude_code_read,claude_code_grep",
			`the run's work log: ${JSON.stringify(steps1)}`);
		const w1row = (() => {
			drain();
			return worker(w1);
		})();
		check("reported", w1row?.state === "succeeded" && ["waiting", "delivered"].includes(String(w1row?.completion_state)),
			`the worker: ${w1row?.state}, its completion ${w1row?.completion_state} (delivered once Alice's own run has ended, below)`);
		const homeFiles = spawnSync("lxc", ["exec", PROOF_MACHINE, "--", "sh", "-c", `ls -ln ${out("pdf")}; ls -l /etc/c4c-root-made`], { encoding: "utf8" }).stdout;
		check("on-the-home", homeFiles.includes("onboarding.md") && homeFiles.includes("notes.txt") && homeFiles.includes("2000 2000") && homeFiles.includes("/etc/c4c-root-made"),
			`the home: ${homeFiles.replaceAll("\n", " | ")}`);

		// 4. The second worker starts once the first's run ended, and opens the version the first sealed.
		drain();
		check("lease-free", worker(w2)?.occurrence_id !== null, "the second worker started after the first's run ended");
		const b2 = leased(start(w2));
		const before2 = login()?.version ?? 0;
		const r2 = await runWorker(b2, scenario("short", [Bash("echo second run; id -un", "shell")], "Second run done."));
		if (r2.ok && r2.providerSessionId) complete(b2, r2.providerSessionId);
		check("run-2", r2.ok && resultsText("slides")?.includes("Second run done.") === true, `run 2: ${r2.providerSessionId ?? r2.error}`);
		check("opened-v2", (r2.stub?.authTags ?? []).includes("RFR") && !(r2.stub?.authTags ?? []).includes("FILE") && (login()?.version ?? 0) > before2,
			`run 2 spoke with the renewed token, not the first: ${JSON.stringify(r2.stub?.authTags)}; version ${before2} -> ${login()?.version}`);

		// 5. A run stopped in the middle, after its early seal: Claude Code renewed the expired sign-in at its start, the run
		// sealed it back at once, then the member's stop cancels the job (from then on the vault seals nothing of this run)
		// and the run's signal ends the box. The vault keeps the renewed version; nothing is left of the login folder.
		const w3 = "c4c00000-0000-4000-8000-0000000000b3";
		dispatch("stop", w3, "A long job");
		drain();
		const b3 = leased(start(w3));
		const before3 = login()?.version ?? 0;
		stopFrom = before3;
		const r3 = await runWorker(
			b3,
			scenario("stop", [Bash("echo started; sleep 20; echo should-not-print", "long"), Bash("echo after", "after")], "not reached"),
			{ stopAfterMs: 1000 },
		);
		stopFrom = Number.POSITIVE_INFINITY;
		const after3 = login()?.version ?? 0;
		check("stop", !r3.ok && stopped.length === 1 && (stopped[0]?.version ?? 0) > before3 && after3 >= (stopped[0]?.version ?? 0)
			&& (r3.leftInRoot ?? ["?"]).length === 0,
			`stopped (${r3.stage}, ${r3.error?.split("\n")[0]?.slice(0, 80)}); login ${before3} -> ${after3} (at the stop ${stopped[0]?.version}); left ${JSON.stringify(r3.leftInRoot)}`);
		const leftOnHome = spawnSync("lxc", ["exec", PROOF_MACHINE, "--", "sh", "-c", "pgrep -af 'sleep 20' | grep -v pgrep || echo none; systemctl list-units --all --plain --no-legend 'qorpera-machine-home-*' | wc -l"], { encoding: "utf8" }).stdout;
		check("stop-home", leftOnHome.startsWith("none") && leftOnHome.trim().endsWith("0"), `the home after the stop: ${leftOnHome.replaceAll("\n", " | ")}`);
		// The member's next run opens the version the stopped run sealed: it renews again from it (the stub's tokens live 30
		// s), and its seal is the next version only if its base was that one (the vault's compare-and-swap).
		drain();
		const w5 = "c4c00000-0000-4000-8000-0000000000b5";
		dispatch("next", w5, "After the stop");
		drain();
		const b5 = leased(start(w5));
		const r5 = await runWorker(b5, scenario("next", [Bash("echo next run", "shell")], "Next run done."));
		if (r5.ok && r5.providerSessionId) complete(b5, r5.providerSessionId);
		check("after-stop", r5.ok && (login()?.version ?? 0) > after3 && (r5.stub?.authTags ?? []).includes("RFR"),
			`the next run opened version ${after3} and sealed ${login()?.version}: ${r5.providerSessionId ?? r5.error}`);

		// 6. A revoked sign-in: the worker was dispatched on it; the run opens nothing and ends blocked in its words.
		drain();
		const w4 = "c4c00000-0000-4000-8000-0000000000b4";
		dispatch("revoked", w4, "After a sign-out");
		drain();
		session(`update public.qorpera_claude_logins set status = 'revoked', revoked_at = statement_timestamp(), key_id = null,
			encrypted_envelope = null, envelope_sha256 = null where owner_user_id = '${owner}' and status = 'active';`);
		const b4 = leased(start(w4));
		const r4 = await runWorker(b4, scenario("never", [Bash("echo never", "never")], "never"));
		if (r4.ok && r4.providerSessionId) complete(b4, r4.providerSessionId);
		const results4 = resultsText("revoked");
		check("revoked", r4.ok && results4?.includes("outcome: blocked") === true
			&& results4.includes(`Claude Code could not sign in as ${member}: their Claude sign-in has ended. Ask them to sign in again.`)
			&& (r4.stub?.requests ?? 1) === 0, `results.md: ${results4?.replaceAll("\n", " | ")}; model requests ${r4.stub?.requests}`);

		// 6b. The worker-completion wake: once Alice's own run has ended (its job completed here as the host would leave it),
		// the drain wakes her with her workers' reports.
		// (Her run sent nothing here, which the job's own trigger refuses for a member's turn: the triggers are set aside.)
		session(`set local session_replication_role = replica; select pg_temp.c4_end_job('${alice.runId}', 'completed');
			set local session_replication_role = origin;
			update public.qorpera_wake_occurrences set status = 'completed', finished_at = clock_timestamp()
			where run_id = '${alice.runId}' and status not in ('completed', 'failed', 'cancelled');`);
		drain();
		const delivered = [w1, w2].map((id) => worker(id));
		check("completion-wake", delivered.every((row) => row?.completion_state === "delivered" && row?.completion_occurrence_id),
			`completion: ${delivered.map((row) => `${row?.state}/${row?.completion_state}/${String(row?.completion_occurrence_id).slice(0, 8)}`).join(", ")}`);

		// 7. The canaries: in no log line, step, results file or object, on neither channel, and not on the home.
		const everything = [
			...readdirSync(B).filter((f) => f.endsWith(".out")).map((f) => readFileSync(join(B, f), "utf8")),
			...[...objects.values()].map((bytes) => bytes.toString("latin1")),
			session(`select coalesce(string_agg(s::text, E'\\n'), '') from public.qorpera_memory_run_steps s;`),
		].join("\n");
		check("canary-outputs", (everything.match(CANARY) ?? []).length === 0, `canaries in outputs, objects and steps: ${(everything.match(CANARY) ?? []).length}`);
		check("canary-channels", sessions.canaryInChannels.length === 0, `canaries on the channels: ${sessions.canaryInChannels.length} of ${sessions.channelBytes} bytes, ${sessions.exec} channels`);
		say(`refused SQL calls: ${db.refusals.slice(0, 12).join(" || ")}`);
	} finally {
		database.close();
	}
	say(failures ? `PROOF FAILED ${failures}` : "PROOF PASSED");
	process.exit(failures ? 1 : 0);
}

// =====================================================================================================================
// The run (nobody)

async function runProcess(): Promise<void> {
	const config = JSON.parse(readFileSync(String(process.argv[3]), "utf8")) as {
		label: string;
		binding: Record<string, string>;
		nativeBinarySha256: string;
		rpc: string;
		gateway: string;
		vault: { origin: string; runtimeToken: string; companyId: string };
		executor: { url: string; token: string };
		holder: string;
		scenario: string;
		stubPort: number;
		stopAfterMs?: number;
	};
	const t0 = Date.now();
	const stubLog = join(B, `stub-${config.label}.jsonl`);
	const stub = spawn("/usr/bin/python3", ["-I", `${P}/test/stub.py`, String(config.stubPort), stubLog, config.scenario, `${P}/tls/server.pem`, `${P}/tls/server.key`], {
		stdio: ["ignore", "ignore", "inherit"],
	});
	for (let i = 0; i < 100; i++) {
		const up = await new Promise<boolean>((resolve) => {
			const socket = createConnection({ host: "127.0.0.1", port: config.stubPort });
			socket.once("connect", () => (socket.destroy(), resolve(true)));
			socket.once("error", () => resolve(false));
		});
		if (up) break;
		await sleep(100);
	}
	const rewrite =
		(base: string): typeof fetch =>
		(input, init) => {
			const url = new URL(String(input instanceof Request ? input.url : input));
			return fetch(`${base}${url.pathname}${url.search}`, init);
		};
	// As the native provider service builds them (cloud-native-provider-service-main.ts): every database call of the run
	// goes through the native host's dispatch, inside the job, with its lease token; only the network below fetch is
	// the proof's (the PostgREST stand-in, which runs each call as PostgREST would: the entry point as anon).
	const origin = "https://postgrest.stand-in.invalid";
	const publishableKey = "sb_publishable_c4cproofstandin";
	const dispatch = new NativeHostDispatch({
		supabaseUrl: origin,
		identity: { computeIdentityId: config.binding.computeIdentityId as string, credential: randomBytes(32).toString("base64url"), publishableKey },
		fetch: rewrite(config.rpc),
	});
	const release = dispatch.begin(config.binding.jobId as string, { leaseToken: config.binding.leaseToken as string, publishableKey });
	const paths = new HttpCloudCompanyPathControl({ supabaseUrl: `${origin}/`, serviceRoleKey: publishableKey, fetch: dispatch.fetch });
	const control = new SupabaseNativeProviderControlPlane(origin, publishableKey, dispatch.fetch);
	const root = mkdtempSync(join(B, `root-${config.label}-`));
	const stop = new AbortController();
	if (config.stopAfterMs !== undefined) {
		void (async () => {
			// After the stub saw the first step's call, the run's own signal stops it (a member's stop).
			for (;;) {
				const text = (() => {
					try {
						return readFileSync(stubLog, "utf8");
					} catch {
						return "";
					}
				})();
				if (text.includes('"main": true') && text.split("\n").filter((l) => l.includes('"kind": "request"') && l.includes('"main": true')).length >= 1) break;
				await sleep(100);
			}
			await sleep(config.stopAfterMs ?? 0);
			await fetch(`${config.rpc}/proof/stop`, { method: "POST", body: JSON.stringify({ runId: config.binding.runId }) }).catch(() => undefined);
			stop.abort();
		})();
	}
	const runtime = new CloudNativeCompanyRuntime({
		controlPlane: control as never,
		pathControl: paths,
		command: ["/usr/bin/true"],
		binarySha256: config.nativeBinarySha256,
		folderBytes: (binding, identity) =>
			new HttpCloudCompanyFolderBytes({
				baseUrl: "http://127.0.0.1:9/",
				token: "t".repeat(43),
				binding,
				holder: () => "stand-in-holder",
				identity,
				control: paths,
				fetch: rewrite(config.gateway),
			} as never),
		homeChannel: (binding) =>
			createCloudHomeChannel({
				url: config.executor.url,
				token: config.executor.token,
				binding,
				holder: () => config.holder,
				allowLoopback: true,
			}),
		claudeWorker: {
			logins: { ...config.vault, holder: () => config.holder, allowLoopback: true },
			configuration: {
				...CLAUDE_BOX_CONFIGURATION,
				binary: `${P}/claude`,
				entryPoint: `${P}/src/cloud-native-isolation-child.ts`,
				shellClient: `${P}/src/cloud-claude-home-shell-client.ts`,
				stage: `${P}/qorpera-claude-box-stage.sh`,
				namespaceHelper: "/usr/bin/unshare",
				sshfs: `${P}/sshfs`,
				node: process.execPath,
			},
			proof: {
				transport: { resolve: async () => ["93.184.216.34"], connect: () => createConnection({ host: "127.0.0.1", port: config.stubPort }) },
				extraCa: `${P}/tls/ca.pem`,
			},
		},
	});
	const b = config.binding;
	const request = {
		runtime: "company-path-v1",
		authority: {
			leaseId: b.leaseId,
			runId: b.runId,
			credentialCapsuleId: b.credentialCapsuleId,
			encryptedCapsuleReference: "stand-in",
			attestationPolicySha256: "a".repeat(64),
			computeIdentityId: b.computeIdentityId,
			runnerId: b.runnerId,
			assignmentId: b.assignmentId,
			provider: b.provider,
			nativeHarness: b.nativeHarness,
			model: b.model,
			expiresAt: new Date(Date.now() + 120_000).toISOString(),
		},
		job: { jobId: b.jobId, jobType: "agent_turn", requiredCapability: "agent_turn", attemptCount: 1, payload: {} },
	};
	let result: Record<string, unknown>;
	try {
		const executed = await runtime.execute(request as never, root, stop.signal);
		result = { ok: true, providerSessionId: executed.providerSessionId };
	} catch (error) {
		const metadata = nativeRuntimeFailureMetadata(error) as { stage?: string } | undefined;
		result = { ok: false, error: String((error as Error)?.stack ?? error).slice(0, 3000), stage: metadata?.stage };
	}
	release();
	await sleep(500);
	stub.kill("SIGKILL");
	const lines = (() => {
		try {
			return readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch {
			return [];
		}
	})();
	const requests = lines.filter((line) => line.kind === "request" && line.main === true);
	const leftInRoot = readdirSync(root);
	console.log(
		`RESULT ${JSON.stringify({
			...result,
			leftInRoot,
			ms: Date.now() - t0,
			stub: {
				requests: requests.length,
				authTags: [...new Set(requests.flatMap((line) => line.auth_tags as string[]))].sort(),
				refreshes: lines.filter((line) => line.kind === "refresh").length,
				results: lines.filter((line) => line.kind === "result").map((line) => ({ name: line.name, isError: line.is_error })),
			},
			outputs: "",
		})}`,
	);
	process.exit(0);
}

if (process.argv[2] === "platform") await platform();
else if (process.argv[2] === "run") await runProcess();
else throw new Error("usage: prove-worker platform <boot> | run <config>");
void chmodSync;
