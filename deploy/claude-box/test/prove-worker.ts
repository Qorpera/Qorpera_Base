import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { authorizeHomeSession } from "../../coding-worker/home-session-authority.ts";
import { MachineCommandRouter } from "../../coding-worker/machine-command-routing.ts";
import { LxdCompanyMachineHost } from "../../../packages/runner-orchestrator/src/company-machine-host.ts";
import { LxdUnixClient } from "../../../packages/runner-orchestrator/src/lxd-client.ts";
import { CLAUDE_BOX_CONFIGURATION } from "../../../packages/runtime/src/cloud-claude-box.ts";
import {
	CloudClaudeLoginRenewer,
	checkClaudeLogin,
	claudeStatusLoggedIn,
} from "../../../packages/runtime/src/cloud-claude-login-renewal.ts";
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
import { nativeRunRootPrefix } from "../../../packages/runtime/src/cloud-native-provider-host.ts";
import { SupabaseNativeProviderControlPlane } from "../../../packages/runtime/src/cloud-native-provider-service.ts";
import { CloudSecretBroker } from "../../../packages/runtime/src/cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService } from "../../../packages/runtime/src/cloud-secret-broker-http.ts";
import { CloudSecretKeyring } from "../../../packages/runtime/src/cloud-secret-crypto.ts";

const P = "/opt/qorpera-c2-proof";
const B = "/var/lib/c4c-proof";
const SLOT_HOST = "/var/lib/qorpera-shared-execution/slots/11/host";
const RUN_ROOT = /^\/var\/lib\/qorpera-shared-execution\/slots\/11\/host\/qorpera-native-run-[0-9a-f-]{36}-[A-Za-z0-9]{6}$/;
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
	readonly #runAsync: (sql: string) => Promise<string>;
	calls: string[] = [];
	refusals: string[] = [];
	readonly slowest = new Map<string, number>();
	constructor(run: (sql: string) => string, runAsync: (sql: string) => Promise<string>) {
		this.#run = run;
		this.#runAsync = runAsync;
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
	#prepare(method: string, args: Record<string, unknown>, session?: string): string | undefined {
		this.calls.push(method);
		const keys = Object.keys(args);
		const signature = this.#signature(method, keys);
		if (!signature) return undefined;
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
		return `\\set VERBOSITY verbose
				begin;
				${session ? `set local session authorization ${session};` : ""}
				${role === "anon" ? "set local role anon;" : ""}
				select set_config('request.jwt.claims', '{"role":"${role}"}', true) \\g /dev/null
				${select}
				commit;`;
	}
	#answer(out: string): { status: number; value: unknown } {
		const text = out.trim();
		return { status: 200, value: text ? JSON.parse(text.split("\n").at(-1) ?? "null") : null };
	}
	#refused(method: string, error: unknown): { status: number; value: unknown } {
		const failed = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec((error as Error)?.message ?? "");
		if (!failed) throw error;
		this.refusals.push(`${method}: ${failed[1]} ${failed[2]}`);
		const code = failed[1] as string;
		const status = code === "42501" ? 403 : code.startsWith("55") || code.startsWith("P0") ? 500 : 400;
		return { status, value: { code, details: null, hint: null, message: failed[2] } };
	}
	rpc(method: string, args: Record<string, unknown>, session?: string): { status: number; value: unknown } {
		const sql = this.#prepare(method, args, session);
		if (sql === undefined) return { status: 404, value: { code: "PGRST202", message: `No ${method}` } };
		try {
			return this.#answer(this.#run(sql));
		} catch (error) {
			return this.#refused(method, error);
		}
	}
	async rpcAsync(method: string, args: Record<string, unknown>, session?: string): Promise<{ status: number; value: unknown }> {
		const sql = this.#prepare(method, args, session);
		if (sql === undefined) return { status: 404, value: { code: "PGRST202", message: `No ${method}` } };
		const started = Date.now();
		try {
			return this.#answer(await this.#runAsync(sql));
		} catch (error) {
			return this.#refused(method, error);
		} finally {
			const ms = Date.now() - started;
			if (ms > (this.slowest.get(method) ?? 0)) this.slowest.set(method, ms);
		}
	}
	async directAsync(method: string, args: Record<string, unknown>, session?: string): Promise<unknown> {
		const { status, value } = await this.rpcAsync(method, args, session);
		if (status === 200) return value;
		throw Object.assign(new Error(String((value as { message?: string }).message)), { code: (value as { code?: string }).code });
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
	readonly root?: string;
	readonly leftInSlot?: string[];
	readonly stub?: {
		requests: number;
		authTags: string[];
		attribution: string[];
		refreshes: number;
		results: { name: string; isError: boolean; text?: string }[];
		reviews?: { decision: string; tool: string; model: string; ntools: number; arguments: string }[];
	};
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
		hostedDatabase: (name: string) => Promise<{
			cluster: { psql(db: string, sql: string, options: string[]): string; psqlArgs(db: string, options: string[]): string[] };
			close(): void;
		}>;
	};
	const database = await hostedDatabase(name);
	const db = new Database(
		(sql) => String(database.cluster.psql(name, sql, ["-qAt"])),
		(sql) =>
			new Promise<string>((resolve, reject) => {
				const child = spawn("docker", database.cluster.psqlArgs(name, ["-qAt"]), { stdio: ["pipe", "pipe", "pipe"] });
				let out = "";
				let err = "";
				child.stdout.on("data", (chunk) => {
					out += chunk;
				});
				child.stderr.on("data", (chunk) => {
					err += chunk;
				});
				child.once("error", reject);
				child.once("close", (code) =>
					code === 0 ? resolve(out) : reject(new Error(`psql failed (exit ${code}):\n${(out + err).slice(-8000)}`)),
				);
				child.stdin.end(sql);
			}),
	);
	const prelude = (binding: unknown) => `begin;
${helpers()}
select set_config('qorpera_test.base_binding', '${JSON.stringify(binding)}', false) \\g /dev/null
select pg_temp.base_claims('service_role') \\g /dev/null
`;
	const sessions: { exec: number; channelBytes: number; canaryInChannels: string[] } = { exec: 0, channelBytes: 0, canaryInChannels: [] };
	const children: ReturnType<typeof spawn>[] = [];
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
			select jsonb_build_object('alice', current_setting('qorpera_test.base_binding')::jsonb,
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
				'machine', to_jsonb(pg_temp.h1_machine('home-a')) - 'binding')::text;
			commit;`);
		const alice = made.alice;
		say(`company made; Alice's run ${alice.runId?.slice(0, 8)}; home-a ${made.machine.id?.slice(0, 8)} on boot ${boot.slice(0, 8)}`);
		const session = (sql: string) => db.query(`${prelude(alice)}${sql}\ncommit;`);
		const sessionJson = <T>(sql: string): T => JSON.parse(session(sql).split("\n").filter(Boolean).at(-1) || "null") as T;
		/** A run's authority held for the whole proof (its job, run deadline, native lease, assignment and runner session):
		 * a stand-in for its host's renewals (924's fixture grants two minutes). */
		const hold = (binding: Record<string, string>, tokenSha?: string) =>
			session(`set local session_replication_role = replica;
				update public.qorpera_runner_jobs set lease_expires_at = clock_timestamp() + interval '2 hours'
					${tokenSha ? `, lease_token_sha256 = '${tokenSha}'` : ""} where id = '${binding.jobId}';
				update public.qorpera_execution_runs set deadline_at = greatest(deadline_at, clock_timestamp() + interval '2 hours')
					where id = '${binding.runId}';
				update public.qorpera_native_provider_connection_leases set expires_at = clock_timestamp() + interval '2 hours'
					where id = '${binding.leaseId}';
				update public.qorpera_runner_assignments set expires_at = clock_timestamp() + interval '2 hours'
					where id = '${binding.assignmentId}';
				update public.qorpera_runners set session_expires_at = clock_timestamp() + interval '2 hours'
					where id = '${binding.runnerId}';
				set local session_replication_role = origin;`);
		// Alice's own run is the dispatching one for the whole proof.
		hold(alice);
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
		const renewalDir = join(B, "renewal");
		mkdirSync(join(renewalDir, "checks"), { recursive: true, mode: 0o711 });
		chmodSync(renewalDir, 0o711);
		const renewalState = join(renewalDir, "state.json");
		const renewalLog = join(renewalDir, "stub.jsonl");
		const proxyLog = join(renewalDir, "proxy.jsonl");
		writeFileSync(renewalState, JSON.stringify({ valid: "FILE", n: 0, validS: "SECOND", nS: 0, refuse: false, steps: [], revoked: [], expiresIn: 320, exp: {} }));
		writeFileSync(join(renewalDir, "allow"), "platform.claude.com\napi.anthropic.com\n");
		const renewalStubPort = 20000 + Math.floor(Math.random() * 9000);
		const renewalProxyPort = renewalStubPort + 1;
		const startPython = async (script: string, args: string[]) => {
			const child = spawn("/usr/bin/python3", ["-I", join(REPO, "deploy/claude-box/test", script), ...args], { stdio: ["ignore", "pipe", "inherit"] });
			children.push(child);
			const ready = await new Promise<boolean>((resolve) => {
				let text = "";
				child.stdout.on("data", (chunk) => {
					text += chunk;
					if (text.includes("READY")) resolve(true);
				});
				child.once("exit", () => resolve(false));
				setTimeout(() => resolve(false), 15_000).unref();
			});
			if (!ready) throw new Error(`${script} did not start`);
			return child;
		};
		await startPython("renewal-stub.py", [String(renewalStubPort), renewalState, renewalLog, `${P}/tls/server.pem`, `${P}/tls/server.key`]);
		await startPython("renewal-proxy.py", [String(renewalProxyPort), String(renewalStubPort), join(renewalDir, "allow"), proxyLog]);
		const renewals = () => {
			try {
				return readFileSync(renewalLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { kind: string; sent?: string; answer?: string; bearer?: string; wall?: number })
					.filter((line) => line.kind === "refresh");
			} catch {
				return [];
			}
		};
		const statusAsNobody = {
			claudeLoginStatus: async (root: string, signal: AbortSignal) => {
				mkdirSync(join(root, "home"), { mode: 0o700 });
				spawnSync("chown", ["-R", "65534:65534", root]);
				const child = spawn("setpriv", ["--reuid=65534", "--regid=65534", "--clear-groups", `${P}/claude`, "auth", "status", "--json"], {
					cwd: root,
					env: {
						HOME: join(root, "home"),
						PATH: "/usr/bin:/bin",
						CLAUDE_CONFIG_DIR: join(root, "claude"),
						HTTPS_PROXY: `http://127.0.0.1:${renewalProxyPort}`,
						NODE_EXTRA_CA_CERTS: `${P}/tls/ca.pem`,
						DISABLE_AUTOUPDATER: "1",
						CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
						DISABLE_TELEMETRY: "1",
						DISABLE_ERROR_REPORTING: "1",
						NO_COLOR: "1",
					},
					stdio: ["ignore", "pipe", "pipe"],
					signal,
				});
				let text = "";
				child.stdout.on("data", (chunk) => {
					text += chunk;
				});
				child.stderr.on("data", (chunk) => {
					text += chunk;
				});
				const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
				return { exitedOk: code === 0, loggedIn: claudeStatusLoggedIn(text) };
			},
		};
		const PRINCIPAL = "12680000-0000-4000-8000-000000000050";
		const PRINCIPAL_CAPABILITY = "a".repeat(64);
		const renewer = new CloudClaudeLoginRenewer({
			keyring,
			checker: {
				checkClaudeLogin: (files, signal) =>
					checkClaudeLogin({ driver: statusAsNobody, temporaryRoot: join(renewalDir, "checks") }, files, signal),
			},
			authority: {
				takeClaudeLoginRenewal: async (request) =>
					db.directAsync("qorpera_take_claude_login_renewal", { p_principal_id: PRINCIPAL, p_capability_sha256: PRINCIPAL_CAPABILITY,
						p_claude_login_id: request.claudeLoginId, p_purpose: request.purpose }, "qorpera_secret_broker"),
				takeIdleClaudeLoginRenewal: async () =>
					db.directAsync("qorpera_take_idle_claude_login_renewal", { p_principal_id: PRINCIPAL, p_capability_sha256: PRINCIPAL_CAPABILITY },
						"qorpera_secret_broker"),
				commitClaudeLoginRenewal: async (commit) =>
					db.directAsync("qorpera_commit_claude_login_renewal", { p_principal_id: PRINCIPAL, p_capability_sha256: PRINCIPAL_CAPABILITY,
						p_claude_login_id: commit.claudeLoginId, p_token: commit.token, p_base_version: commit.baseVersion,
						p_base_envelope_sha256: commit.baseEnvelopeSha256, p_key_id: commit.keyId,
						p_encrypted_envelope_base64: Buffer.from(commit.encryptedEnvelope).toString("base64"),
						p_envelope_sha256: commit.envelopeSha256 }, "qorpera_secret_broker"),
				releaseClaudeLoginRenewal: async (release) =>
					db.directAsync("qorpera_release_claude_login_renewal", { p_principal_id: PRINCIPAL, p_capability_sha256: PRINCIPAL_CAPABILITY,
						p_claude_login_id: release.claudeLoginId, p_token: release.token, p_outcome: release.outcome }, "qorpera_secret_broker"),
			},
		});
		const vault = new CloudClaudeLoginVault({
			keyring,
			renewer,
			authority: {
				openClaudeLoginForRun: async (binding, _signal, knownVersion) =>
					db.directAsync(
						"qorpera_open_claude_login_for_run",
						{
							p_broker_authority_id: BROKER_AUTHORITY,
							p_broker_capability_sha256: BROKER_CAPABILITY,
							p_binding: binding,
							...(knownVersion === undefined ? {} : { p_known_version: knownVersion }),
						},
						"qorpera_secret_broker",
					),
				openClaudeLoginForSealBack: async (binding) =>
					db.directAsync(
						"qorpera_open_claude_login_for_seal_back",
						{ p_broker_authority_id: BROKER_AUTHORITY, p_broker_capability_sha256: BROKER_CAPABILITY, p_binding: binding },
						"qorpera_secret_broker",
					),
				sealClaudeLoginBack: async (seal) =>
					db.directAsync(
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
		const stopped: { runId: string; version: number }[] = [];
		const rpcPort = await listen(async (request, response) => {
			const url = new URL(String(request.url), "http://x");
			const input = JSON.parse((await body(request)).toString("utf8") || "{}") as Record<string, unknown>;
			const rpc = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/.exec(url.pathname);
			const control = /^\/control\/([a-zA-Z]+)$/.exec(url.pathname);
			if (url.pathname === "/proof/stop") {
				const runId = String(input.runId);
				session(`select pg_temp.c4_end_job('${runId}', 'cancelled');`);
				stopped.push({ runId, version: login()?.version ?? 0 });
				response.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			let answer: { status: number; value: unknown };
			if (rpc) answer = await db.rpcAsync(rpc[1] as string, input);
			else if (control) {
				const binding = input.binding as Record<string, unknown>;
				const op = control[1];
				const call: Record<string, () => Promise<{ status: number; value: unknown }>> = {
					describeToolAuthority: () => db.rpcAsync("qorpera_describe_native_tool_authority", { p_binding: binding }),
					beginToolOperation: () =>
						db.rpcAsync("qorpera_begin_native_tool_operation", {
							p_binding: binding,
							p_receipt_id: input.receiptId,
							p_logical_operation_key: input.logicalOperationKey,
							p_input_sha256: input.inputSha256,
							p_downstream_idempotency_sha256: sha256(String(input.downstreamIdempotencyKey)),
							p_requires_company_revision: input.requiresCompanyRevision,
						}),
					completeToolOperation: () =>
						db.rpcAsync("qorpera_complete_native_tool_operation", {
							p_binding: binding,
							p_receipt_id: input.receiptId,
							p_input_sha256: input.inputSha256,
							p_result: input.result,
						}),
					completeFolderToolOperation: () =>
						db.rpcAsync("qorpera_folder_complete_run_receipt", {
							p_binding: binding,
							p_receipt_id: input.receiptId,
							p_input_sha256: input.inputSha256,
							p_result: input.result,
							p_folder_commit_id: input.folderCommitId,
						}),
				};
				answer = (await call[op as string]?.()) ?? { status: 404, value: { message: "no such control" } };
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
				const { status } = await db.rpcAsync("qorpera_folder_confirm_object", {
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
				const value = (await db.directAsync(method, args)) as Record<string, unknown>;
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
			hold(binding, sha256(token));
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
		const slotRuns: { label: string; root?: string; left?: string[] }[] = [];
		const slotUnit = spawnSync(
			"python3",
			[
				"-I",
				join(REPO, "deploy/claude-box/test/unit-props.py"),
				join(REPO, "deploy/shared-execution/qorpera-shared-run-host@.service"),
				"11",
			],
			{ encoding: "utf8" },
		)
			.stdout.split("\n")
			.filter(Boolean)
			.flatMap((property) => ["-p", property]);
		check("slot-unit", slotUnit.includes("PrivateTmp=yes") && slotUnit.includes("ProtectSystem=strict"), `the runs have qorpera-shared-run-host@11's hardening: ${slotUnit.filter((_, i) => i % 2).join(" ")}`);
		const runWorker = async (binding: Record<string, string>, scenarioPath: string, extra: Record<string, unknown> = {}) => {
			runCount++;
			const stubPort = 18443 + runCount;
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
				stubPort,
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
					...slotUnit,
					"-p",
					`ReadWritePaths=${SLOT_HOST}`,
					"-p",
					`ReadWritePaths=${B}`,
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
			const reviewNotes = text.split("\n").filter((entry) => /^(LONE|REVIEWER) /.test(entry));
			if (reviewNotes.length) say(`${label} review notes: ${reviewNotes.join(" || ").slice(0, 3000)}`);
			say(`${label} results: ${JSON.stringify((result.stub?.results ?? []).map((r) => [r.name, r.isError, (r.text ?? "").slice(0, 120)]))}`);
			if (!extra.parallel) slotRuns.push({ label, root: result.root, left: result.leftInSlot });
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
		// The folder service's last boundary, stood in by SQL (the nested home's /company is a plain folder): one second after
		// the run's home session closed, a commit of the machine's view lands as the run, as the view's last boundary commits
		// what its quiet period still held. The report's file list must hold it.
		const lastBoundary = (async () => {
			for (let i = 0; i < 1200; i++) {
				const closed = sessionJson<boolean>(`select to_jsonb(exists (select 1 from public.qorpera_company_home_sessions
					where run_id = '${b1.runId}' and closed_at is not null))::text;`);
				if (closed) break;
				await sleep(150);
			}
			await sleep(1000);
			session(`set local session_replication_role = replica;
				insert into public.qorpera_folder_commits(id, environment_id, operation_key, actor_kind, actor_id, session_kind, run_id,
					view_id, view_kind, units)
				values ('c4c00000-0000-4000-8000-0000000000f1', '${ENVIRONMENT}', 'c4c-last-boundary', 'staff_agent', '${ALICE}', 'in_house',
					'${b1.runId}', extensions.gen_random_uuid(), 'test_machine', '[]'::jsonb);
				insert into public.qorpera_folder_path_versions(version, environment_id, path, key_sha256, op, kind, commit_id, unit_no)
				values (extensions.gen_random_uuid(), '${ENVIRONMENT}', 'QorperaOS/agents/alice/todos/onboarding/pdf/onboarding.md',
					extensions.digest(public.qorpera_folder_key('QorperaOS/agents/alice/todos/onboarding/pdf/onboarding.md'), 'sha256'),
					'write', 'file', 'c4c00000-0000-4000-8000-0000000000f1', 1);
				set local session_replication_role = origin;`);
			return Date.now();
		})();
		const r1 = await runWorker(b1, work);
		say(`run 1 reviews: ${session(`select coalesce(string_agg(r.tool_name || ' ' || r.decision || ' ' || left(r.action ->> 'arguments', 300), ' || '), 'none')
			from public.qorpera_action_reviews r where r.run_id = '${b1.runId}';`)}`);
		const boundaryAt = await lastBoundary;
		if (r1.ok && r1.providerSessionId) complete(b1, r1.providerSessionId);
		const results1 = resultsText("pdf");
		check("run-1", r1.ok && /^claude-code\/2\.1\.325\/[^/]+\/[^/]+$/.test(r1.providerSessionId ?? ""), `the run: ${r1.providerSessionId ?? r1.error}`);
		check("results-1", results1?.includes("outcome: succeeded") === true && results1.includes("I made onboarding.md"), `results.md: ${results1?.replaceAll("\n", " | ")}`);
		check("files-1", (results("pdf")?.parse as { files?: unknown } | null)?.files !== undefined
			&& JSON.stringify((results("pdf")?.parse as { files?: unknown }).files) === JSON.stringify(["QorperaOS/agents/alice/todos/onboarding/pdf/onboarding.md"]),
			`the report's file list holds what the view's last boundary committed ${boundaryAt ? "after the session closed" : ""}: ${JSON.stringify((results("pdf")?.parse as { files?: unknown } | null)?.files)}`);
		const l1 = login();
		const issued = () => new Set(["FILE", ...renewals().filter((r) => r.answer?.startsWith("R")).map((r) => r.answer as string)]);
		check("vault-renewed", (l1?.version ?? 0) === 2 && renewals().length === 1 && renewals()[0]?.sent === "FILE" && renewals()[0]?.answer === "R1",
			`the vault renewed the expired sign-in at the run's open, with Claude Code's own renewal: login ${JSON.stringify(l1)}; renewals ${JSON.stringify(renewals())}`);
		check("run-cannot-renew", r1.stub?.refreshes === 0 && JSON.stringify(r1.stub?.authTags) === JSON.stringify(["R1"]),
			`run 1 renewed nothing (its egress has no renewal host) and spoke with the vault's version only: ${JSON.stringify(r1.stub?.authTags)}, ${r1.stub?.refreshes} renewals`);
		check("tools-ran", (r1.stub?.results ?? []).length === 5 && (r1.stub?.results ?? []).filter((r) => r.isError).map((r) => r.name).join() === "read-missing",
			`stub saw the five results (one error): ${JSON.stringify(r1.stub?.results)}`);
		check("root-left", (r1.leftInRoot ?? ["?"]).length === 0, `nothing left in the run's root: ${JSON.stringify(r1.leftInRoot)}`);
		check("real-root", RUN_ROOT.test(r1.root ?? "") && Buffer.byteLength(r1.root ?? "") === 110,
			`the run's root is the provider host's own, in slot 11's host folder (${Buffer.byteLength(r1.root ?? "")} bytes): ${r1.root}`);
		check("slot-left", (r1.leftInSlot ?? ["?"]).length === 0, `nothing of the box left beside the run's root in the slot: ${JSON.stringify(r1.leftInSlot)}`);
		const homeSession1 = sessionJson<{ opened: number; closed: number }>(`select jsonb_build_object('opened', count(*), 'closed', count(*) filter (where closed_at is not null))::text
			from public.qorpera_company_home_sessions where run_id = '${b1.runId}';`);
		check("home-session", homeSession1.opened === 1 && homeSession1.closed === 1, `the run's home session opened and closed: ${JSON.stringify(homeSession1)}`);
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
		check("opened-renewed", (r2.stub?.authTags ?? []).length > 0 && (r2.stub?.authTags ?? []).every((tag) => tag !== "FILE" && issued().has(tag))
			&& r2.stub?.refreshes === 0 && (login()?.version ?? 0) >= before2,
			`run 2 spoke with a version the vault renewed, never the first: ${JSON.stringify(r2.stub?.authTags)}; version ${before2} -> ${login()?.version}`);

		// 4b. A follow-up of the first worker: a fresh Claude Code session told where its earlier work is and what it reported.
		drain();
		const fu = sessionJson<Record<string, unknown>>(`select pg_temp.c4_followup(pg_temp.c4_alice(), 'c4c-e2e-followup',
			'QorperaOS/agents/alice/todos/onboarding/pdf', 'Use the new logo.')::text;`);
		check("followup-saved", JSON.stringify(fu).includes('"outcome": "saved"') || JSON.stringify(fu).includes('"outcome":"saved"'), `follow-up: ${JSON.stringify(fu).slice(0, 200)}`);
		drain();
		const bf = leased(start(w1));
		const rf = await runWorker(bf, scenario("followup", [Bash("echo following up", "shell")], "Used the new logo."));
		if (rf.ok && rf.providerSessionId) complete(bf, rf.providerSessionId);
		const asked = (() => {
			try {
				return readFileSync(join(B, `stub-run${runCount}.jsonl`), "utf8").split("\n").filter(Boolean)
					.map((line) => JSON.parse(line) as { kind: string; text?: string }).find((line) => line.kind === "prompt")?.text ?? "";
			} catch {
				return "";
			}
		})();
		check("followup-prompt", rf.ok && asked.includes("This follows up your earlier work on this, which is in /company/QorperaOS/agents/alice/todos/onboarding/pdf")
			&& asked.includes("Your earlier report said: I made onboarding.md and notes.txt in my folder.")
			&& asked.includes("The agent's follow-up on your earlier report: Use the new logo."),
			`Claude Code was asked: ${asked.replaceAll("\n", " | ").slice(0, 900)}`);
		check("no-attribution", (r1.stub?.requests ?? 0) > 0 && (rf.stub?.requests ?? 0) > 0
			&& r1.stub?.attribution.length === 0 && rf.stub?.attribution.length === 0,
			`what Claude Code sent holds no "Co-Authored-By" and no "Generated with": run 1 ${JSON.stringify(r1.stub?.attribution)} in ${r1.stub?.requests} requests, follow-up ${JSON.stringify(rf.stub?.attribution)} in ${rf.stub?.requests}`);

		// 4c. The plan's limit and an ended sign-in, as Anthropic answers them (429 with its unified limit headers; 401), in
		// Claude Code's own words on its own stream.
		const failRun = async (key: string, workerId: string, fail: Record<string, unknown>, steps: unknown[]) => {
			drain();
			dispatch(key, workerId, key);
			drain();
			const binding = leased(start(workerId));
			const path = join(P, `scen-c4c-${key}.json`);
			writeFileSync(path, JSON.stringify({ label: key, nonce: randomBytes(4).toString("hex"), steps, final: "never", expiresIn: 1, fail }), { mode: 0o444 });
			const run = await runWorker(binding, path);
			if (run.ok && run.providerSessionId) complete(binding, run.providerSessionId);
			return { run, text: resultsText(key) ?? "" };
		};
		const limited = await failRun("limit", "c4c00000-0000-4000-8000-0000000000b6", {
			status: 429,
			after: 1,
			headers: {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": "{reset}",
				"anthropic-ratelimit-unified-representative-claim": "five_hour",
				"retry-after": "3600",
			},
			body: { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } },
		}, [Bash("echo before the limit", "shell")]);
		check("limit-429", limited.run.ok && limited.text.includes("outcome: blocked")
			&& /Member's Claude plan has reached its limit\. Claude Code said: "You've hit your [^"]*limit[^"]*resets [^"]+"\. Nothing was changed after that point\./.test(limited.text),
			`results.md: ${limited.text.replaceAll("\n", " | ").slice(0, 600)}`);
		const ended = await failRun("signedout", "c4c00000-0000-4000-8000-0000000000b7", {
			status: 401,
			after: 0,
			body: { type: "error", error: { type: "authentication_error", message: "OAuth token has expired. Please obtain a new token or refresh your existing token." } },
		}, []);
		check("signed-out-401", ended.run.ok && ended.text.includes("outcome: blocked")
			&& ended.text.includes("Claude Code could not sign in as Member: their Claude sign-in has ended. Ask them to sign in again."),
			`results.md: ${ended.text.replaceAll("\n", " | ").slice(0, 600)}`);
		for (const label of [`run${runCount - 1}`, `run${runCount}`]) {
			const lines = readFileSync(join(B, `stub-${label}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; status?: number });
			say(`${label} stub: ${lines.filter((l) => l.kind === "failed").map((l) => l.status).join(",")} failed answers, ${lines.filter((l) => l.kind === "refresh").length} renewals`);
		}

		const w3 = "c4c00000-0000-4000-8000-0000000000b3";
		dispatch("stop", w3, "A long job");
		drain();
		const b3 = leased(start(w3));
		const before3 = login()?.version ?? 0;
		const r3 = await runWorker(
			b3,
			scenario("stop", [Bash("echo started; sleep 20; echo should-not-print", "long"), Bash("echo after", "after")], "not reached"),
			{ stopAfterMs: 1000 },
		);
		const after3 = login()?.version ?? 0;
		check("stop", !r3.ok && stopped.length === 1 && after3 >= before3 && login()?.status === "active"
			&& (r3.leftInRoot ?? ["?"]).length === 0,
			`stopped (${r3.stage}, ${r3.error?.split("\n")[0]?.slice(0, 80)}); login ${before3} -> ${after3} (at the stop ${stopped[0]?.version}); left ${JSON.stringify(r3.leftInRoot)}`);
		const leftOnHome = spawnSync("lxc", ["exec", PROOF_MACHINE, "--", "sh", "-c", "pgrep -af 'sleep 20' | grep -v pgrep || echo none; systemctl list-units --all --plain --no-legend 'qorpera-machine-home-*' | wc -l"], { encoding: "utf8" }).stdout;
		check("stop-home", leftOnHome.startsWith("none") && leftOnHome.trim().endsWith("0"), `the home after the stop: ${leftOnHome.replaceAll("\n", " | ")}`);
		drain();
		const w5 = "c4c00000-0000-4000-8000-0000000000b5";
		dispatch("next", w5, "After the stop");
		drain();
		const b5 = leased(start(w5));
		const r5 = await runWorker(b5, scenario("next", [Bash("echo next run", "shell")], "Next run done."));
		if (r5.ok && r5.providerSessionId) complete(b5, r5.providerSessionId);
		check("after-stop", r5.ok && (login()?.version ?? 0) >= after3 && (r5.stub?.authTags ?? []).every((tag) => tag !== "FILE" && issued().has(tag))
			&& r5.stub?.refreshes === 0,
			`the next run opened version ${login()?.version} (${JSON.stringify(r5.stub?.authTags)}): ${r5.providerSessionId ?? r5.error}`);

		session("update public.qorpera_claude_parallel_runs set cap = 4;");
		const parallel = async (label: string, keys: string[], steps: unknown[], final: string) => {
			drain();
			const ids = keys.map((key, i) => `c4c00000-0000-4000-8000-0000000001${label === "two" ? "a" : "b"}${i}`);
			keys.forEach((key, i) => dispatch(key, ids[i] as string, `${label} ${key}`));
			const drained = drain();
			const startedIds = ids.filter((id) => worker(id)?.occurrence_id !== null);
			const runOf = new Map(
				startedIds.map((id) => [
					sessionJson<string>(`do $$ begin perform pg_temp.base_materialize(); end $$;
						select to_jsonb((select run_id from public.qorpera_wake_occurrences
							where id = (select occurrence_id from public.qorpera_runtime_workers where id = '${id}')))::text;`),
					id,
				]),
			);
			session(`set local session_replication_role = replica;
				update public.qorpera_execution_runs set memory_mode = 'tree' where id in (${[...runOf.keys()].map((run) => `'${run}'`).join(", ")});
				set local session_replication_role = origin;`);
			const byWorker = new Map<string, Record<string, string>>();
			for (let i = 0; i < startedIds.length; i++) {
				const binding = sessionJson<Record<string, string>>("select pg_temp.base_start(null)::text;");
				const id = runOf.get(binding.runId as string);
				if (!id) throw new Error(`a started run is no worker's here: ${binding.runId}`);
				byWorker.set(id, binding);
			}
			const bindings = startedIds.map((id) => leased(byWorker.get(id) as Record<string, string>));
			const versions = login()?.version ?? 0;
			const t0 = Date.now();
			const runs = await Promise.all(
				bindings.map((binding, i) =>
					runWorker(binding, scenario(`${label}-${i}`, steps, `${final} ${i}.`, 1), { parallel: true }),
				),
			);
			for (const [i, run] of runs.entries()) if (run.ok && run.providerSessionId) complete(bindings[i] as Record<string, string>, run.providerSessionId);
			return { ids, startedIds, drained, runs, ms: Date.now() - t0, versionBefore: versions };
		};
		const two = await parallel("two", ["two-a", "two-b"], [Bash("echo two at once; id -un", "shell"), Bash("sleep 5; echo done", "wait")], "Two at once");
		check("two-at-once", two.startedIds.length === 2 && two.runs.every((run) => run.ok)
			&& two.runs.every((run, i) => resultsText(`two-${i ? "b" : "a"}`)?.includes("outcome: succeeded") === true),
			`both started by one drain and both succeeded: ${JSON.stringify(two.runs.map((run) => [run.ok, run.providerSessionId ?? run.error?.slice(0, 120), run.ms]))}`);
		check("two-overlapped", two.ms < two.runs.reduce((sum, run) => sum + (run.ms ?? 0), 0),
			`the two ran side by side: ${two.ms} ms for ${two.runs.map((run) => run.ms).join(" + ")} ms of runs`);
		check("two-no-renewal", two.runs.every((run) => run.stub?.refreshes === 0 && (run.stub?.authTags ?? []).every((tag) => tag !== "FILE" && issued().has(tag))),
			`neither run renewed; both spoke with the vault's versions: ${JSON.stringify(two.runs.map((run) => run.stub?.authTags))}`);
		const long = Array.from({ length: 11 }, (_, i) => Bash(`sleep 15; echo step ${i}`, `wait-${i}`));
		const four = await parallel("four", ["four-a", "four-b", "four-c", "four-d", "four-e"], long, "Four at once");
		const fifth = four.ids[4] as string;
		check("four-at-once", four.startedIds.length === 4 && !four.startedIds.includes(fifth) && four.runs.every((run) => run.ok),
			`four started, the fifth waited (cap 4): started ${four.startedIds.map((id) => id.slice(-2)).join(",")}; ${JSON.stringify(four.runs.map((run) => [run.ok, run.ms, run.error?.slice(0, 120)]))}`);
		check("four-in-place", four.runs.every((run) => (run.stub?.authTags ?? []).length >= 2 && run.stub?.refreshes === 0
			&& (run.stub?.authTags ?? []).every((tag) => tag !== "FILE" && issued().has(tag))) && (login()?.version ?? 0) > four.versionBefore,
			`each run spoke with two versions or more, the newer put in place while Claude Code worked, and renewed nothing itself: ${JSON.stringify(four.runs.map((run) => run.stub?.authTags))}; login ${four.versionBefore} -> ${login()?.version}`);
		const slotAfter = readdirSync(SLOT_HOST);
		check("four-slot-left", slotAfter.length === 0 && four.runs.every((run) => RUN_ROOT.test(run.root ?? "") && (run.leftInRoot ?? ["?"]).length === 0),
			`after the parallel runs nothing is left in slot 11's host folder: ${JSON.stringify(slotAfter)}`);
		drain();
		check("fifth-starts", worker(fifth)?.occurrence_id !== null, "the fifth started once the four had ended");
		const b5th = leased(start(fifth));
		const r5th = await runWorker(b5th, scenario("fifth", [Bash("echo fifth", "shell")], "Fifth done."));
		if (r5th.ok && r5th.providerSessionId) complete(b5th, r5th.providerSessionId);
		check("fifth-run", r5th.ok && r5th.stub?.refreshes === 0, `the fifth ran: ${r5th.providerSessionId ?? r5th.error}`);
		const refused = renewals().filter((r) => r.answer === "invalid_grant");
		check("rotation-clean", refused.length === 0 && renewals().every((r, i, all) => i === 0 || r.sent === all[i - 1]?.answer),
			`every renewal used the newest refresh token, none was refused: ${JSON.stringify(renewals().map((r) => `${r.sent}->${r.answer}`))}`);
		const beforeIdle = login()?.version ?? 0;
		session(`update public.qorpera_claude_logins set checked_at = clock_timestamp() - interval '21 hours' where owner_user_id = '${owner}' and status = 'active';`);
		const lastRenewal = renewals().at(-1)?.wall ?? 0;
		while (Date.now() / 1000 < lastRenewal + 25) await sleep(1000);
		const idleChecked = await renewer.idle();
		check("stays-signed-in", idleChecked === 1 && login()?.status === "active" && (login()?.version ?? 0) === beforeIdle + 1
			&& renewals().at(-1)?.answer?.startsWith("R") === true,
			`after all runs: the idle check renewed ${beforeIdle} -> ${login()?.version} (${renewals().at(-1)?.sent} -> ${renewals().at(-1)?.answer}); status ${login()?.status}`);
		const firstLogin = login()?.id as string;
		const secondLogin = "c4c00000-0000-4000-8000-0000000000c2";
		const secondFiles = loginFiles(canary("SECOND"), Date.now() - 3600_000);
		const secondEnvelope = Buffer.from(
			keyring.sealMember(
				{ [CLAUDE_LOGIN_FIELD]: JSON.stringify({ schema: CLAUDE_LOGIN_FILES_SCHEMA, files: secondFiles }) },
				{ memberId: owner, loginId: secondLogin, version: 1, keyId: KEY_ID },
			),
		);
		session(`insert into public.qorpera_claude_logins(id, owner_user_id, principal_id, client_connection_id, key_id, encrypted_envelope,
				envelope_sha256, provider_account_email)
			values ('${secondLogin}', '${owner}', '12680000-0000-4000-8000-000000000050', extensions.gen_random_uuid(), '${KEY_ID}',
				decode('${secondEnvelope.toString("base64")}', 'base64'), '${sha256(secondEnvelope)}', 'second@example.test');`);
		secondEnvelope.fill(0);
		const logins = () =>
			sessionJson<{ id: string; version: number; status: string; in_use: boolean }[]>(
				`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'version', version, 'status', status, 'in_use', in_use) order by created_at),
					'[]')::text from public.qorpera_claude_logins where owner_user_id = '${owner}' and id in ('${firstLogin}', '${secondLogin}');`,
			);
		const ofLogin = (id: string) => logins().find((row) => row.id === id);
		const leaseLogin = (workerId: string) =>
			sessionJson<string | null>(`select to_jsonb((select claude_login_id from public.qorpera_claude_worker_leases
				where worker_id = '${workerId}' order by taken_at desc limit 1))::text;`);
		const wA = "c4c00000-0000-4000-8000-0000000001c0";
		const wB = "c4c00000-0000-4000-8000-0000000001c1";
		drain();
		dispatch("login-a", wA, "On the first login");
		drain();
		const bA = leased(start(wA));
		session(`update public.qorpera_claude_logins set in_use = false where id = '${firstLogin}';
			update public.qorpera_claude_logins set in_use = true where id = '${secondLogin}';
			update public.qorpera_runtime_workers set claude_login_id = '${secondLogin}' where id = '${wA}';`);
		dispatch("login-b", wB, "On the second login");
		drain();
		const bB = leased(start(wB));
		const firstBefore = ofLogin(firstLogin)?.version ?? 0;
		const [rA, rB] = await Promise.all([
			runWorker(bA, scenario("login-a", long, "First login done.", 1), { parallel: true }),
			runWorker(bB, scenario("login-b", long, "Second login done.", 1), { parallel: true }),
		]);
		if (rA.ok && rA.providerSessionId) complete(bA, rA.providerSessionId);
		if (rB.ok && rB.providerSessionId) complete(bB, rB.providerSessionId);
		const first = renewals().filter((r) => r.answer?.startsWith("R"));
		const second = renewals().filter((r) => r.sent?.startsWith("S"));
		const fromFirst = new Set(first.map((r) => r.answer as string));
		const fromSecond = new Set(second.map((r) => r.answer as string));
		check("second-login-leases", leaseLogin(wA) === firstLogin && leaseLogin(wB) === secondLogin
			&& (worker(wB) as { claude_login_id?: string } | null)?.claude_login_id === secondLogin,
			`a run's lease keeps the login it started on, after the member's switch and its worker's follow-up: A ${leaseLogin(wA)?.slice(-2)}, B ${leaseLogin(wB)?.slice(-2)}`);
		check("second-login-own-runs", rA.ok && rB.ok && (rA.stub?.authTags ?? []).length >= 2 && (rB.stub?.authTags ?? []).length >= 2
			&& (rA.stub?.authTags ?? []).every((tag) => fromFirst.has(tag)) && (rB.stub?.authTags ?? []).every((tag) => fromSecond.has(tag))
			&& rA.stub?.refreshes === 0 && rB.stub?.refreshes === 0,
			`each run spoke only with its own login's versions, the newer put in place while it worked, and renewed nothing itself: A ${JSON.stringify(rA.stub?.authTags)}, B ${JSON.stringify(rB.stub?.authTags)}; ${rA.error?.slice(0, 120) ?? ""} ${rB.error?.slice(0, 120) ?? ""}`);
		check("second-login-renewed", second.length >= 2 && second[0]?.sent === "SECOND" && second.every((r) => r.answer !== "invalid_grant")
			&& second.every((r, i, all) => i === 0 || r.sent === all[i - 1]?.answer)
			&& renewals().filter((r) => r.answer === "invalid_grant").length === 0
			&& (ofLogin(secondLogin)?.version ?? 0) === second.length + 1 && (ofLogin(firstLogin)?.version ?? 0) > firstBefore,
			`the vault renewed each login on its own chain, from its newest refresh token, none refused: second ${JSON.stringify(second.map((r) => `${r.sent}->${r.answer}`))} (version ${ofLogin(secondLogin)?.version}), first ${firstBefore} -> ${ofLogin(firstLogin)?.version}`);
		check("second-login-in-use", JSON.stringify(logins().map((row) => [row.status, row.in_use])) === JSON.stringify([["active", false], ["active", true]]),
			`both logins active, the second In use: ${JSON.stringify(logins())}`);
		session(`update public.qorpera_claude_logins set in_use = false where id = '${secondLogin}';
			update public.qorpera_claude_logins set in_use = true where id = '${firstLogin}';`);
		session("update public.qorpera_claude_parallel_runs set cap = 1;");

		drain();
		const w8 = "c4c00000-0000-4000-8000-0000000000b8";
		dispatch("checked", w8, "Checked work");
		drain();
		const b8 = leased(start(w8));
		const r8 = await runWorker(
			b8,
			scenario(
				"checked",
				[
					Bash("echo C4C-REFUSE > /company/c4c-refused.txt", "refused-shell"),
					Bash("echo allowed-on-the-home > /company/c4c-allowed.txt && cat /company/c4c-allowed.txt", "allowed-shell"),
					T("Write", "refused-write", { file_path: `${out("checked")}/refused.md`, content: "C4C-REFUSE\n" }),
					T("Write", "allowed-write", { file_path: `${out("checked")}/allowed.md`, content: "fine\n" }),
					Bash("echo C4C-ASK > /company/c4c-asked.txt", "asked-shell"),
					T("Read", "read", { file_path: `${out("checked")}/allowed.md` }),
					T("Write", "proc-write", { file_path: "/proc/self/root/company/c4c-proc.md", content: "C4C-REFUSE\n" }),
				],
				"Checked work done.",
			),
		);
		if (r8.ok && r8.providerSessionId) complete(b8, r8.providerSessionId);
		const told = (name: string) => (r8.stub?.results ?? []).find((result) => result.name === name);
		const onHome = spawnSync("lxc", ["exec", PROOF_MACHINE, "--", "sh", "-c",
			`for f in /company/c4c-refused.txt /company/c4c-allowed.txt /company/c4c-asked.txt /company/c4c-proc.md ${out("checked")}/refused.md ${out("checked")}/allowed.md; do [ -e "$f" ] && echo "there $f" || echo "absent $f"; done`],
			{ encoding: "utf8" }).stdout;
		const reviews8 = sessionJson<{ tool: string; decision: string; model: string; arguments: string }[]>(
			`select coalesce(jsonb_agg(jsonb_build_object('tool', r.tool_name, 'decision', r.decision, 'model', r.reviewer_model,
				'arguments', left(r.action ->> 'arguments', 400)) order by r.created_at), '[]')::text
				from public.qorpera_action_reviews r where r.run_id = '${b8.runId}';`,
		);
		say(`checked run: reviews ${JSON.stringify(reviews8)}; stub reviews ${JSON.stringify(r8.stub?.reviews)}; results ${JSON.stringify(r8.stub?.results)}; home ${onHome.replaceAll("\n", " | ")}`);
		check("review-run", r8.ok && resultsText("checked")?.includes("Checked work done.") === true, `the checked run: ${r8.providerSessionId ?? r8.error}`);
		check("review-refused-shell", told("refused-shell")?.isError === true && (told("refused-shell")?.text ?? "").includes("REVIEW_DENIED: The proof refuses this action.")
			&& onHome.includes("absent /company/c4c-refused.txt"),
			`a refused command never ran on the home, and Claude Code read why: ${JSON.stringify(told("refused-shell"))}`);
		check("review-allowed-shell", told("allowed-shell")?.isError === false && (told("allowed-shell")?.text ?? "").includes("allowed-on-the-home")
			&& onHome.includes("there /company/c4c-allowed.txt"),
			`an allowed command ran on the home: ${JSON.stringify(told("allowed-shell"))}`);
		check("review-refused-write", told("refused-write")?.isError === true && (told("refused-write")?.text ?? "").includes("REVIEW_DENIED")
			&& onHome.includes(`absent ${out("checked")}/refused.md`),
			`a refused file change never reached the home, and Claude Code read why: ${JSON.stringify(told("refused-write"))}`);
		check("review-allowed-write", told("allowed-write")?.isError === false && onHome.includes(`there ${out("checked")}/allowed.md`)
			&& told("read")?.isError === false,
			`an allowed file change reached the home: ${JSON.stringify(told("allowed-write"))}`);
		check("review-asked", told("asked-shell")?.isError === true && /APPROVAL_(PENDING|UNAVAILABLE_HERE)/.test(told("asked-shell")?.text ?? "")
			&& onHome.includes("absent /company/c4c-asked.txt"),
			`a command that asks a member first waits, in words, and the run goes on: ${JSON.stringify(told("asked-shell"))}`);
		check("review-records", reviews8.filter((r) => r.tool === "home_command").map((r) => r.decision).join() === "deny,allow,ask"
			&& reviews8.filter((r) => r.tool === "home_change").map((r) => r.decision).join() === "deny,allow,deny"
			&& reviews8.every((r) => r.model === "haiku"),
			`the run's reviews as members see Codex's: ${JSON.stringify(reviews8.map((r) => [r.tool, r.decision, r.model]))}`);
		check("review-proc-path", told("proc-write")?.isError === true && (told("proc-write")?.text ?? "").includes("REVIEW_DENIED")
			&& onHome.includes("absent /company/c4c-proc.md"),
			`a file tool aimed at the home through /proc/self/root is reviewed with its content like any other: ${JSON.stringify(told("proc-write"))}`);
		check("review-no-renewal", (r8.stub?.refreshes ?? 1) === 0 && (r8.stub?.reviews ?? []).length > 0,
			`neither the run nor its reviewers renewed the sign-in (the vault is the only renewer): ${r8.stub?.refreshes} renewals at the run's stub`);
		check("review-reviewer", (r8.stub?.reviews ?? []).length === reviews8.length && (r8.stub?.reviews ?? []).every((r) => r.ntools === 0),
			`each review was one tool-less request of Claude Code's: ${JSON.stringify(r8.stub?.reviews?.map((r) => [r.decision, r.model, r.ntools]))}`);

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
		const delivered = [w1, w2, "c4c00000-0000-4000-8000-0000000000b6"].map((id) => worker(id));
		check("completion-wake", delivered.every((row) => row?.completion_state === "delivered" && row?.completion_occurrence_id),
			`completion: ${delivered.map((row) => `${row?.state}/${row?.completion_state}/${String(row?.completion_occurrence_id).slice(0, 8)}`).join(", ")}`);

		// 7. The canaries: in no log line, step, results file or object, on neither channel, and not on the home.
		const everything = [
			...readdirSync(B).filter((f) => f.endsWith(".out")).map((f) => readFileSync(join(B, f), "utf8")),
			...[...objects.values()].map((bytes) => bytes.toString("latin1")),
			session(`select coalesce(string_agg(s::text, E'\\n'), '') from public.qorpera_memory_run_steps s;`),
		].join("\n");
		check("slot-left-all", slotRuns.length > 0 && slotRuns.every((run) => RUN_ROOT.test(run.root ?? "") && run.left?.length === 0),
			`every run's root was the provider host's own in slot 11, and nothing of its box was left beside it: ${JSON.stringify(slotRuns.map((run) => [run.label, run.left]))}`);
		check("canary-outputs", (everything.match(CANARY) ?? []).length === 0, `canaries in outputs, objects and steps: ${(everything.match(CANARY) ?? []).length}`);
		check("canary-channels", sessions.canaryInChannels.length === 0, `canaries on the channels: ${sessions.canaryInChannels.length} of ${sessions.channelBytes} bytes, ${sessions.exec} channels`);
		say(`refused SQL calls: ${db.refusals.slice(0, 12).join(" || ")}`);
		say(`slowest stand-in calls (ms): ${JSON.stringify([...db.slowest].sort((a, b) => b[1] - a[1]).slice(0, 12))}`);
		say(`renewals at the vault's stub: ${JSON.stringify(renewals().map((r) => `${r.sent}->${r.answer}`))}`);
	} finally {
		for (const child of children) child.kill();
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
	const root = await mkdtemp(nativeRunRootPrefix(SLOT_HOST, config.binding.runId as string));
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
				onLone: (change: { method: string; paths: readonly string[] }) => console.error(`LONE ${change.method} ${change.paths.join(" ")}`),
				onReviewerFailure: (text: string) => console.error(`REVIEWER ${text.replaceAll("\n", " | ").slice(0, 3000)}`),
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
	const leftInSlot = readdirSync(SLOT_HOST).filter((name) => name !== basename(root));
	rmSync(root, { recursive: true, force: true });
	console.log(
		`RESULT ${JSON.stringify({
			...result,
			leftInRoot,
			root,
			leftInSlot,
			ms: Date.now() - t0,
			stub: {
				requests: requests.length,
				authTags: [...new Set(requests.flatMap((line) => line.auth_tags as string[]))].sort(),
				attribution: [
					...new Set(lines.filter((line) => line.kind === "request").flatMap((line) => (line.attribution as string[]) ?? [])),
				].sort(),
				refreshes: lines.filter((line) => line.kind === "refresh").length,
				results: lines
					.filter((line) => line.kind === "result")
					.map((line) => ({ name: line.name, isError: line.is_error, text: String(line.text ?? "").slice(0, 600) })),
				reviews: lines
					.filter((line) => line.kind === "review")
					.map((line) => ({ decision: line.decision, tool: line.tool, model: line.model, ntools: line.ntools, arguments: line.arguments })),
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
