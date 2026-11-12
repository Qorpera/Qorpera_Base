import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// A command's output fills one tool result (keyholes S1, PR #1707), from the machine to the model and back: an agent's
// run starts commands on company machines and reads their logs through the real patched Codex, and each page that comes
// back is checked against the bytes the command printed, at every hop, with old and new parts in both orders.
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> QORPERA_S1_OLD_TREE=<old tree> node scripts/prove-s1-command-output.mjs
//
// The old tree is the PR's base without the slice: `packages/{contracts,runtime,cloud-client,runner-orchestrator}/src`,
// `deploy/coding-worker`, `tsconfig.json`, `tsconfig.base.json` and a `REF` file naming its commit (git archive of the
// base). Old parts are bundled from it, new parts from this tree.
//
// Real: the migrated database and its functions; SQL test 924's company and Alice's run (claimed and leased through the
// real contracts, in Shared context so it keeps a work log) and SQL test 628's machine helpers, which place three
// machines on two nodes of two machine executors; the runtime's own run session, boundary, result fence, context view
// and run log; machine_run and machine_read with their HTTP gateway; each executor's command service (its guest-facing
// listener and its peer listener), its router, the SQL authority it asks for every call, and its machine host
// (LxdCompanyMachineHost), whose pass claims each machine's boot and marks it running in SQL; each machine's guest helper
// (runMachineGuestCli), which runs the command in a real bash and pages its real log; coding_run_command and
// coding_read_command with their gateway and the command service's coding route; the patched Codex app-server.
// Stand-ins: PostgREST (one psql call as the service role), LXD (instances in memory; an exec runs the guest helper in
// this process on the machine's own folders, and a file read is bounded as LXD's 64 KiB is), systemd and the kernel's
// files on each machine (a transient unit runs the helper's own `execute` step at once, and the helper reads its log as
// this process's user, not root), the NAS journal storage, the guest listener's lease proof (G2-6b), the coding route's
// authority and its executor (pages of a real log, read by the guests' reader), the object gateway (bytes in memory) and
// the model provider (scripted; no model is called). Not covered: a node, a real VM, nginx in front of the executors,
// the company folder's release of a command's output (heldBack), the coding image's helper (the NAS model) and the
// folder model's own pages, a real coding session and its own context view call, a real model.
// Prints one PASS line per check and exits 1 on the first failure; without the binary or the old tree it prints NOT RUN
// and exits 0.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_s1_command_output";
const RESULT = 32 * 1024;
const LEGACY = 16_384;
const PAGE = 65_536;
const MAC = "0e:51:0a:d2:01:01";
const PROMPT = "Run the build on the company's machines and read its whole log.";
const LINE = "Ran a command on a machine and read its output.";
const NODE_A = "92400000-0000-4000-8000-000000000a01";
const NODE_B = "92400000-0000-4000-8000-000000000b01";
const POLICY_A = {
	providerId: "machine-fixture",
	providerPolicySha256: "f".repeat(64),
	project: "machines",
	imageFingerprint: "a".repeat(64),
	bootstrapSha256: "b".repeat(64),
	storagePool: "machines",
	network: "qagent0",
};
const POLICY_B = { ...POLICY_A, providerId: "machine-fixture-b", providerPolicySha256: "e".repeat(64) };
const NAS = {
	schema: "qorpera.coding-nas-policy/v1",
	mountPoint: "/nas",
	rootPath: "/nas/coding",
	source: "10.0.0.2:/coding",
	serverAddress: "10.0.0.2",
};
/** What the commands print: one long plain run, escape-heavy bytes, bytes that are not UTF-8 among characters of two to
 * four bytes, and a short line. */
const COMMANDS = {
	big: "head -c 100000 /dev/zero | tr '\\0' a",
	escaped: "python3 -c 'import sys;sys.stdout.buffer.write(bytes([60,34,38,92,10,1])*5000)'",
	mixed: `python3 -c 'import sys;sys.stdout.buffer.write((b"ab\\xffc"+"æ€\u{1f600}".encode())*4000)'`,
	short: "printf 'hello\\n'",
};
const CODING_BIG = Buffer.alloc(90_000, "c");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let passed = 0;
const pass = (what) => {
	passed++;
	process.stdout.write(`PASS ${what}\n`);
};
const notRun = (what) => process.stdout.write(`NOT RUN ${what}\n`);
const token = () => randomBytes(32).toString("base64url");

/** One bundle of `exports` from the tree at `root`, resolved by that tree's own tsconfig paths (its packages' sources),
 * with this checkout's node_modules for anything else. The machine host's NAS journal storage is a stand-in. */
async function bundle(root, scratch, name, exports) {
	const outfile = join(scratch, `${name}.mjs`);
	await build({
		absWorkingDir: root,
		stdin: { resolveDir: root, contents: exports.join("\n") },
		tsconfig: join(root, "tsconfig.json"),
		nodePaths: [join(repositoryRoot, "node_modules")],
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile,
		logLevel: "silent",
		plugins: [
			{
				name: "nas-journal-stand-in",
				setup(b) {
					b.onResolve({ filter: /\/coding-storage\.ts$/ }, (args) =>
						args.importer.endsWith("company-machine-host.ts") ? { path: "nas", namespace: "s1-stand-in" } : undefined,
					);
					b.onLoad({ filter: /.*/, namespace: "s1-stand-in" }, () => ({
						loader: "js",
						contents: `export function createCodingNasStorage() {
							const controlPath = globalThis.__s1JournalRoot;
							return { controlPath, assertControl: async () => {}, prepareControl: async () => controlPath,
								prepare: async () => {}, assert: async () => {} };
						}`,
					}));
				},
			},
		],
	});
	return { module: await import(pathToFileURL(outfile).href), bytes: readFileSync(outfile) };
}

const RUNTIME = [
	'export {runCloudNativeRunToolSession} from "./packages/runtime/src/cloud-native-run-tool-session.ts";',
	'export {HttpCloudCompanyPathControl} from "./packages/runtime/src/cloud-company-path-control.ts";',
	'export {CloudCompanyPathGateway} from "./packages/runtime/src/cloud-company-path-gateway.ts";',
	'export {CloudCompanyFolderClient} from "./packages/runtime/src/cloud-company-folder-client.ts";',
	'export {HttpCloudCompanyFolderBytes} from "./packages/runtime/src/cloud-company-folder-bytes.ts";',
	'export {CloudRunLogCompanyFolder} from "./packages/runtime/src/cloud-run-log-folder.ts";',
	'export {openCloudRunLog} from "./packages/runtime/src/cloud-run-log-open.ts";',
	'export {CloudRunResumeRpc} from "./packages/runtime/src/cloud-run-resume.ts";',
	'export {CloudRunLogRpcProtection} from "./packages/runtime/src/cloud-run-log-protection.ts";',
	'export {MemoryCompactChannel, MemoryCompactLane} from "./packages/runtime/src/memory-tree/compact.ts";',
	'export {cloudNativeContextIdentity} from "./packages/runtime/src/cloud-native-context-composition.ts";',
	'export {CLOUD_NATIVE_TOOL_CATALOG_BYTES, CLOUD_TOOL_RESULT_RESERVE_BYTES, MAX_CLOUD_TOOL_RESULT_BYTES, cloudToolJsonText} from "./packages/runtime/src/cloud-native-tool-boundary.ts";',
	'export {nativeCodexFixtureCommand} from "./packages/runtime/test/fixtures/native-codex-fixture-command.ts";',
];
const TOOLS = [
	'export {cloudMachineTools} from "./packages/runtime/src/cloud-machine-tools.ts";',
	'export {createHttpCloudMachineCommandGateway} from "./packages/runtime/src/cloud-machine-command-http.ts";',
	'export {cloudCodingCommandTools} from "./packages/runtime/src/cloud-coding-command-tools.ts";',
	'export {createHttpCloudCodingCommandGateway} from "./packages/runtime/src/cloud-coding-command-http.ts";',
	'export {parseCloudCodingCommandRead} from "@qorpera/contracts";',
];
const NEW_TOOLS = [
	'export {CloudCommandPages} from "./packages/runtime/src/cloud-command-pages.ts";',
	'export {CLOUD_COMMAND_PAGE_ASK} from "./packages/runtime/src/cloud-command-page-fit.ts";',
	'export {CLOUD_CODING_COMMAND_PAGE_BYTES, CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES} from "@qorpera/contracts";',
];
const EXECUTOR = [
	'export {HttpCloudCodingCommandService} from "./packages/runtime/src/cloud-coding-command-http.ts";',
	'export {MachineCommandRouter, machineCommandRoutes} from "./deploy/coding-worker/machine-command-routing.ts";',
	'export {LxdCompanyMachineHost} from "./packages/runner-orchestrator/src/company-machine-host.ts";',
	'export {readCodingCommandLog} from "./packages/runtime/src/cloud-coding-command-log.ts";',
	'export {parseCloudCodingCommandRead} from "@qorpera/contracts";',
];
const GUEST = [
	'export {runMachineGuestCli} from "./packages/runtime/src/cloud-machine-guest.ts";',
	'export {readCodingCommandLog} from "./packages/runtime/src/cloud-coding-command-log.ts";',
];

/** The database through psql, as the service role. A function's arguments are typed as it declares them, as PostgREST
 * types a JSON body's fields; an error names its SQLSTATE, as PostgREST's `code` does. */
class Database {
	#run;
	#signatures = new Map();
	calls = [];
	refusals = [];
	constructor(run) {
		this.#run = run;
	}
	query(sql) {
		return this.#run(sql).trim();
	}
	#signature(method, keys) {
		assert(/^qorpera_[a-z0-9_]+$/.test(method), `function name ${method}`);
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
		const [signature] = this.#signatures
			.get(method)
			.filter((candidate) => {
				const names = (candidate.names ?? []).slice(0, candidate.nargs);
				return (
					keys.every((key) => names.includes(key)) &&
					names.slice(0, candidate.nargs - candidate.defaults).every((name) => keys.includes(name))
				);
			})
			.sort((a, b) => a.nargs - b.nargs);
		if (!signature) return null;
		return { ...signature, typeOf: (key) => signature.types[signature.names.indexOf(key)] };
	}
	rpc(method, args) {
		this.calls.push(method);
		const keys = Object.keys(args);
		const signature = this.#signature(method, keys);
		if (!signature) return { status: 404, value: { code: "PGRST202", details: null, hint: null, message: `No ${method}` } };
		const tag = `q${randomBytes(6).toString("hex")}`;
		const body = `$${tag}$${JSON.stringify(args)}$${tag}$::jsonb`;
		const parameters = keys.map((key) => {
			assert(/^p_[a-z][a-z0-9_]*$/.test(key), `argument name ${key}`);
			const type = signature.typeOf(key);
			// A JSON null is SQL's NULL, as PostgREST reads a body's fields (jsonb_populate_record).
			const value = `nullif(${body} -> '${key}', 'null'::jsonb)`;
			if (type === "jsonb") return `${key} => ${value}`;
			if (type === "json") return `${key} => ${value}::json`;
			if (type.endsWith("[]"))
				return `${key} => case when jsonb_typeof(${value}) = 'array' then array(select e from jsonb_array_elements_text(${value}) e) end::${type}`;
			return `${key} => (${body} ->> '${key}')::${type}`;
		});
		const call = `public.${method}(${parameters.join(", ")})`;
		const select = signature.set
			? `select coalesce(jsonb_agg(to_jsonb(r)), '[]') from ${call} r;`
			: signature.void
				? `select ${call}; select 'null';`
				: `select to_jsonb(${call});`;
		try {
			const out = this.query(`\\set VERBOSITY verbose
				begin;
				select set_config('request.jwt.claims', '{"role":"service_role"}', true) \\g /dev/null
				${select}
				commit;`);
			return { status: 200, value: out ? JSON.parse(out.split("\n").at(-1)) : null };
		} catch (error) {
			const failed = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(error?.message ?? "");
			if (!failed) throw error;
			this.refusals.push(`${method}: ${failed[1]} ${failed[2]}`);
			return { status: postgrestStatus(failed[1]), value: { code: failed[1], details: null, hint: null, message: failed[2] } };
		}
	}
	direct(method, args) {
		const { status, value } = this.rpc(method, args);
		if (status === 200) return value;
		throw Object.assign(new Error(value.message), { code: value.code, status });
	}
}

function postgrestStatus(code) {
	if (code === "42501") return 403;
	if (code === "23503" || code === "23505") return 409;
	if (code === "P0001") return 400;
	if (code === "42883" || code === "42P01") return 404;
	const group = code.slice(0, 2);
	if (group === "08" || group === "53") return 503;
	if (["0L", "0P", "28"].includes(group)) return 403;
	if (["09", "25", "2D", "38", "39", "3B", "40", "54", "55", "57", "58", "F0", "HV", "P0", "XX"].includes(group)) return 500;
	return 400;
}

function postgrestFetch(db) {
	return async (input, init = {}) => {
		const url = new URL(String(input));
		const rpc = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/.exec(url.pathname);
		const { status, value } =
			init.method === "POST" && rpc
				? db.rpc(rpc[1], JSON.parse(init.body ?? "{}"))
				: { status: 404, value: { code: "PGRST202", details: null, hint: null, message: `No ${url.pathname}` } };
		return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
	};
}

/** The object gateway's folder object route, for the run log's bytes: a put is confirmed with the folder core under the
 * run's upload intent, as the gateway does; a get answers the bytes. */
function gatewayFetch(db, objects) {
	return async (input, init = {}) => {
		const url = new URL(String(input));
		const route = /^\/v1\/folder-objects\/([0-9a-f-]{36})\/([0-9a-f]{64})$/.exec(url.pathname);
		if (!route) return new Response("{}", { status: 404 });
		const [, environmentId, hash] = route;
		if (init.method === "PUT") {
			const bytes = Buffer.from(init.body);
			if (sha256(bytes) !== hash) return new Response("{}", { status: 400 });
			const binding = JSON.parse(Buffer.from(init.headers["x-qorpera-native-binding"], "base64url").toString("utf8"));
			const actor = { kind: "run", runId: binding.runId, jobId: binding.jobId, runnerId: binding.runnerId, assignmentId: binding.assignmentId };
			const existed = objects.has(hash);
			const { status } = db.rpc("qorpera_folder_confirm_object", {
				p_environment_id: environmentId,
				p_actor: actor,
				p_intent: init.headers["x-qorpera-upload-intent"],
				p_sha256: hash,
				p_bytes: bytes.length,
			});
			if (status !== 200) return new Response("{}", { status: 403 });
			objects.set(hash, bytes);
			return new Response(
				JSON.stringify({ status: existed ? "exists" : "stored", sha256: hash, bytes: bytes.length, replication: "pending" }),
				{ status: existed ? 200 : 201 },
			);
		}
		const bytes = objects.get(hash);
		return bytes ? new Response(bytes, { status: 200 }) : new Response("{}", { status: 404 });
	};
}

function controlPlane(db) {
	return {
		describeToolAuthority: async (binding) => db.direct("qorpera_describe_native_tool_authority", { p_binding: binding }),
		beginToolOperation: async (binding, input) =>
			db.direct("qorpera_begin_native_tool_operation", {
				p_binding: binding,
				p_receipt_id: input.receiptId,
				p_logical_operation_key: input.logicalOperationKey,
				p_input_sha256: input.inputSha256,
				p_downstream_idempotency_sha256: sha256(input.downstreamIdempotencyKey),
				p_requires_company_revision: input.requiresCompanyRevision,
			}),
		completeToolOperation: async (binding, input) =>
			db.direct("qorpera_complete_native_tool_operation", {
				p_binding: binding,
				p_receipt_id: input.receiptId,
				p_input_sha256: input.inputSha256,
				p_result: input.result,
			}),
		completeFolderToolOperation: async (binding, input) =>
			db.direct("qorpera_folder_complete_run_receipt", {
				p_binding: binding,
				p_receipt_id: input.receiptId,
				p_input_sha256: input.inputSha256,
				p_result: input.result,
				p_folder_commit_id: input.folderCommitId,
			}),
	};
}

/** HTTPS origins as the nodes' proxies serve them, each answered by one of this process's listeners; every request on
 * the way is recorded with the page it asked for and the page size the answer said. */
function network(record) {
	const routes = new Map();
	const via = (from) => async (input, init = {}) => {
		const url = new URL(String(input));
		const port = routes.get(url.origin);
		if (port === undefined) throw new Error(`no route to ${url.origin}`);
		const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
		const response = await fetch(`http://127.0.0.1:${port}${url.pathname}`, init);
		record.push({
			from,
			to: url.origin,
			path: url.pathname,
			action: body.action,
			commandId: body.input?.commandId,
			offset: body.input?.offset,
			tail: body.input?.tail,
			limit: body.input?.limit,
			status: response.status,
			said: response.headers.get("x-qorpera-command-page-bytes"),
		});
		return response;
	};
	return { routes, via };
}

/** A machine's disk and /run in temporary folders, with systemd and the kernel's files simulated as the guest helper's
 * own tests do; a transient unit runs the helper's `execute` step at once, in a real bash, and ends with its exit. */
async function machineGuest(guest, name, uid) {
	const root = await realpath(await mkdtemp(join(tmpdir(), `qorpera-s1-${name}-`)));
	const home = join(root, "home");
	await mkdir(home);
	const units = new Map([
		["qorpera-control.slice", "ControlGroup=/qorpera.slice/qorpera-control.slice\n"],
		["lxd-agent.service", "ControlGroup=/system.slice/lxd-agent.service\n"],
	]);
	const files = new Map([
		["/sys/fs/cgroup/qorpera.slice/qorpera-control.slice/cpu.stat", "usage_usec 200000\nuser_usec 100000\n"],
		["/sys/fs/cgroup/system.slice/lxd-agent.service/cpu.stat", "usage_usec 300000\n"],
	]);
	const bootId = randomUUID();
	const execs = [];
	const ports = {
		stateRoot: join(root, "var"),
		runtimeRoot: join(root, "run"),
		helper: "/opt/qorpera-machine/cloud-machine-guest.mjs",
		nowMs: async () => 1_000_000 + Math.round(performance.now()),
		bootId: async () => bootId,
		system: async (executable, args) => {
			if (executable === "/usr/bin/systemd-run") {
				const unit = String(args.find((arg) => arg.startsWith("--unit="))).slice("--unit=".length);
				units.set(unit, "LoadState=loaded\nActiveState=active\nSubState=running\nResult=success\n");
				const code = await guest.module.runMachineGuestCli(["execute", args.at(-1)], ports);
				units.set(
					unit,
					`LoadState=loaded\nActiveState=active\nSubState=exited\nResult=${code ? "exit-code" : "success"}\nExecMainCode=1\nExecMainStatus=${code}\n`,
				);
			} else if (executable === "/usr/bin/systemctl" && args[0] === "show")
				return units.get(args[1]) ?? "LoadState=not-found\nActiveState=inactive\nSubState=dead\nResult=success\n";
			else if (executable === "/usr/bin/systemctl" && args[0] === "stop" && args[1] === "qorpera-machine.slice") {
				for (const unit of [...units.keys()]) if (unit.startsWith("qorpera-machine-command-")) units.delete(unit);
			} else if (executable === "/usr/bin/systemctl" && args[0] === "stop") units.delete(args[1]);
			return "";
		},
		readCpu: async () => "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3\n",
		readSystemFile: async (path) => {
			const contents = files.get(path);
			if (contents === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return contents;
		},
		listSystemDirectory: async (path) => [
			...new Set([...files.keys()].flatMap((file) => (file.startsWith(`${path}/`) ? [file.slice(path.length + 1).split("/")[0]] : []))),
		],
		// The helper's own log reader, which expects root's files on the machine; here the machine's folders are this
		// process's user's.
		readLog: (options) => guest.module.readCodingCommandLog({ ...options, owner: uid, protectedOwner: uid }),
		home,
		requireRoot: false,
	};
	/** A path on the machine, in its folders here. */
	const local = (path) => {
		for (const [from, to] of [
			["/var/lib/qorpera-machine", ports.stateRoot],
			["/run/qorpera-machine", ports.runtimeRoot],
		])
			if (path === from || path.startsWith(`${from}/`)) return to + path.slice(from.length);
		throw new Error(`no such path on the machine: ${path}`);
	};
	return { name, guest, root, ports, bootId, execs, local, log: (commandId) => join(ports.stateRoot, "commands", commandId, "output.log") };
}

/** LXD on one node, as the machine host uses it: instances in memory, each exec on a machine run by its guest helper in
 * this process, and each file read bounded as LXD's (64 KiB). */
function fakeLxd(machines) {
	const instances = new Map();
	const pending = new Map();
	const of = (name) => {
		const machine = machines.get(name);
		if (!machine) throw new Error("LXD instance unavailable");
		return machine;
	};
	return {
		getInstance: async (_project, name) => instances.get(name),
		submitInstanceOperation: async (project, action) => {
			const name = action.action === "create" ? action.request.name : action.name;
			pending.set(name, action);
			return { project, instanceName: name, operationId: randomUUID() };
		},
		inspectInstanceOperation: async (reference) => {
			const action = pending.get(reference.instanceName);
			pending.delete(reference.instanceName);
			const instance = instances.get(reference.instanceName);
			if (action?.action === "create")
				instances.set(reference.instanceName, {
					name: action.request.name,
					type: "virtual-machine",
					status: "Stopped",
					statusCode: 102,
					profiles: [],
					devices: structuredClone(action.request.devices),
					expandedDevices: structuredClone(action.request.devices),
					config: { ...action.request.config, "volatile.base_image": POLICY_A.imageFingerprint },
					expandedConfig: { ...action.request.config, "volatile.base_image": POLICY_A.imageFingerprint },
				});
			else if (action?.action === "delete") instances.delete(reference.instanceName);
			else if (instance && action) {
				instance.status = action.action === "start" ? "Running" : "Stopped";
				instance.statusCode = action.action === "start" ? 103 : 102;
			}
			return "succeeded";
		},
		execInstance: async (_project, name, command) => {
			const machine = of(name);
			if (command[0] !== "/usr/bin/node") return;
			machine.execs.push(command.slice(3));
			await machine.guest.module.runMachineGuestCli(command.slice(2), machine.ports);
		},
		readInstanceFile: async (_project, name, path, maximumBytes) => {
			const machine = of(name);
			if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 65536)
				throw new Error("LXD_INSTANCE_FILE_UNCONFIRMED");
			const content =
				path === "/opt/qorpera-machine/cloud-machine-guest.mjs" ? machine.guest.helper : await readFile(machine.local(path));
			if (content.length > maximumBytes) throw new Error("LXD_INSTANCE_FILE_TOO_LARGE");
			return { content, uid: 0, gid: 0, mode: path.endsWith(".mjs") ? 0o444 : 0o600 };
		},
		pushInstanceFile: async (_project, name, path, content, mode) => {
			const machine = of(name);
			await writeFile(machine.local(path), content, { mode });
		},
	};
}

/** One node's coding executor, from one tree: its command service's guest-facing listener and its peer listener, its
 * router, and its machine host over LXD with these machines. SQL answers every authority question. */
async function executor(code, options) {
	const { db, owner, providerId, policy, machineIdSha256, machines, peers, tokens, net, coding, helpers } = options;
	const via = net.via(owner);
	const control = { call: async (method, args) => db.direct(method, args) };
	const journalRoot = await realpath(await mkdtemp(join(tmpdir(), `qorpera-s1-journal-${owner}-`)));
	await chmod(journalRoot, 0o700);
	globalThis.__s1JournalRoot = journalRoot;
	const host = new code.module.LxdCompanyMachineHost({
		control,
		owner,
		machineIdSha256,
		policy,
		client: fakeLxd(machines),
		journalRoot,
		storagePolicy: NAS,
		helperSha256: helpers.current,
		previousHelperSha256s: [helpers.previous],
		agentPlug: async () => MAC,
		passHoldMs: Number.POSITIVE_INFINITY,
	});
	const router = new code.module.MachineCommandRouter({
		owner,
		providerId,
		peers,
		control,
		credential: async (name) => tokens[name],
		executeLocal: (request, authority, signal) =>
			host.command(
				{
					machineId: authority.machineId,
					placementId: authority.placementId,
					commandId: request.input.commandId,
					inputSha256: authority.inputSha256,
					bootId: authority.bootId,
					runId: authority.runId,
					staffAgentId: authority.staffAgentId,
					requestedByUserId: authority.requestedByUserId,
					folderLost: authority.folderLost,
				},
				request.action === "start"
					? {
							action: "start",
							commandId: request.input.commandId,
							inputSha256: request.input.inputSha256,
							command: request.input.command,
							timeoutMs: request.input.timeoutMs,
						}
					: request.action === "read"
						? { action: "read", read: request.input }
						: { action: "cancel", commandId: request.input.commandId },
				signal,
			),
		fetch: via,
	});
	const codingRoutes = {
		authorize: async (request) => ({
			inputSha256: request.action === "start" ? request.input.inputSha256 : coding.inputs.get(request.input.commandId),
		}),
		execute: async (request) => ({ receipt: await coding.serve(code, request), hidden: async () => undefined }),
	};
	const listener = new code.module.HttpCloudCodingCommandService({
		token: tokens[`guest-${owner}`],
		proveBinding: async (_binding, holder) => assert.equal(holder, options.holder),
		...codingRoutes,
		machines: code.module.machineCommandRoutes(router, control, false),
	});
	const peerListener = new code.module.HttpCloudCodingCommandService({
		token: tokens[`peer-${owner}`],
		proveBinding: null,
		...codingRoutes,
		machines: code.module.machineCommandRoutes(router, control, true),
	});
	return {
		owner,
		host,
		origin: `https://${owner}.s1.test`,
		listener: await listener.start(),
		peer: await peerListener.start(),
		close: async () => {
			await listener.close();
			await peerListener.close();
			await rm(journalRoot, { recursive: true, force: true });
		},
	};
}

/** The coding route's executor stand-in: a command's log is kept in a folder of this process's user, and each call is
 * answered with a page of it read by the executor tree's own reader (the guests' readCodingCommandLog). */
async function codingExecutor(scratch, uid) {
	const root = join(scratch, "coding");
	await mkdir(root, { mode: 0o700 });
	const inputs = new Map();
	const logs = new Map();
	return {
		inputs,
		logs,
		serve: async (code, request) => {
			const { commandId } = request.input;
			if (request.action === "start") {
				inputs.set(commandId, request.input.inputSha256);
				const folder = join(root, commandId);
				await mkdir(folder, { mode: 0o700 });
				await writeFile(join(folder, "output.log"), CODING_BIG, { mode: 0o600 });
				logs.set(commandId, join(folder, "output.log"));
			}
			const page = await code.module.readCodingCommandLog({
				path: logs.get(commandId),
				owner: uid,
				protectedOwner: uid,
				mountRoot: root,
				boundary: root,
				maxBytes: 1_048_576,
				read: request.action === "read" ? request.input : { commandId, offset: 0, limit: 4096 },
				terminal: true,
			});
			return {
				schema: "qorpera.coding-command-result/v2",
				workerId: request.scope.workerId,
				commandId,
				inputSha256: inputs.get(commandId),
				state: "succeeded",
				exitCode: 0,
				...page,
			};
		},
	};
}

/** The scripted provider: the agent's calls, each from the answers before it, and a line for every compactor request. */
function provider(state) {
	const event = (response, value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
	const stream = (response, model, item) => {
		const base = { id: `resp_${randomBytes(8).toString("hex")}`, object: "response", model, created_at: 1 };
		response.writeHead(200, { "content-type": "text/event-stream" });
		event(response, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
		const text = item.type === "message" ? item.content[0].text : undefined;
		const started = { ...item, status: "in_progress", ...(text === undefined ? {} : { content: [] }) };
		event(response, { type: "response.output_item.added", output_index: 0, item: started });
		if (text) event(response, { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text });
		event(response, { type: "response.output_item.done", output_index: 0, item });
		const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 11 };
		event(response, { type: "response.completed", response: { ...base, status: "completed", output: [item], usage } });
		response.end();
	};
	const message = (text) => ({
		type: "message",
		id: `msg_${randomBytes(6).toString("hex")}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	});
	return createServer((request, response) => {
		void (async () => {
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				response.writeHead(404);
				response.end();
				return;
			}
			// Decoded once, whole: a character may straddle two chunks.
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const input = JSON.stringify(body.input);
			if (/Compress this step into one line|Merge these two adjacent lines|That line is \d+ bytes/.test(input)) {
				state.compactor++;
				stream(response, body.model, message(LINE));
				return;
			}
			const last = state.calls.at(-1);
			let answer;
			if (last) {
				const output = body.input.find((item) => item.type === "function_call_output" && item.call_id === last.callId);
				assert(output, `the request carries the output of ${last.callId}`);
				last.envelope = String(output.output);
				last.parsed = JSON.parse(last.envelope);
				answer = last.parsed.status === "ok" ? JSON.parse(last.parsed.content.text) : { error: last.parsed };
			}
			const next = state.script.next(answer);
			if (next.done) {
				stream(response, body.model, message("S1_DONE"));
				return;
			}
			const call = { callId: `call_${state.calls.length + 1}`, name: next.value.name, args: next.value.args };
			state.calls.push(call);
			stream(response, body.model, {
				type: "function_call",
				id: `fc_${state.calls.length}`,
				call_id: call.callId,
				namespace: "qorpera",
				name: call.name,
				arguments: JSON.stringify(call.args),
				status: "completed",
			});
		})().catch((error) => {
			state.failure ??= error;
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
}

/** What the agent does: each long command read to its end, a tail, a smaller and a too large limit, a short command,
 * the machines behind an old guest and an old executor, and a coding command when the run offers coding tools. */
function* agent(state) {
	const read = (machine, commandId, more) => ({ name: "machine_read", args: { machine, commandId, ...more } });
	const toEnd = function* (machine, first, key) {
		const pages = [first];
		for (const page of pages) assert(page?.log, `${key}: ${JSON.stringify(page).slice(0, 400)}`);
		while (pages.at(-1).log.nextOffset < pages.at(-1).log.totalBytes) {
			assert(pages.length < 40, `${key} ends`);
			const page = yield read(machine, first.commandId, { offset: pages.at(-1).log.nextOffset });
			assert(page?.log, `${key}: ${JSON.stringify(page).slice(0, 400)}`);
			pages.push(page);
		}
		state.pages[key] = pages;
	};
	const big = yield { name: "machine_run", args: { machine: "m-new", command: COMMANDS.big, operationKey: "s1-big" } };
	state.answers.big = big;
	state.answers.second = yield read("m-new", big.commandId, { offset: big.log.nextOffset });
	state.answers.tail = yield read("m-new", big.commandId, { tail: true });
	state.answers.small = yield read("m-new", big.commandId, { offset: 0, limit: 100 });
	state.answers.tooLarge = yield read("m-new", big.commandId, { offset: 0, limit: 40000 });
	yield* toEnd("m-new", yield { name: "machine_run", args: { machine: "m-new", command: COMMANDS.escaped, operationKey: "s1-escaped" } }, "escaped");
	yield* toEnd("m-new", yield { name: "machine_run", args: { machine: "m-new", command: COMMANDS.mixed, operationKey: "s1-mixed" } }, "mixed");
	state.answers.short = yield { name: "machine_run", args: { machine: "m-new", command: COMMANDS.short, operationKey: "s1-short" } };
	state.answers.oldGuest = yield { name: "machine_run", args: { machine: "m-oldguest", command: COMMANDS.big, operationKey: "s1-old-guest" } };
	state.answers.peer = yield { name: "machine_run", args: { machine: "m-peer", command: COMMANDS.big, operationKey: "s1-peer" } };
	if (state.codingOffered) {
		const coding = yield { name: "coding_run_command", args: { command: "npm test", operationKey: "s1-coding" } };
		state.answers.coding = coding;
		state.answers.codingNext = yield { name: "coding_read_command", args: { commandId: coding.commandId, offset: coding.log.nextOffset } };
	}
}

/** SQL test 924's helpers (`base_*`), and SQL test 628's machine helpers (`mc_*`), for a session after the fixture's. */
function helperText(file, from, to) {
	const text = readFileSync(join(repositoryRoot, "supabase/tests", file), "utf8");
	const start = text.indexOf(from);
	const end = text.indexOf(to);
	assert(start > 0 && end > start, `SQL test ${file}'s helpers moved: update this script`);
	return text.slice(start, end);
}

async function main() {
	const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
	if (!binary) {
		process.stdout.write("NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins\n");
		return;
	}
	if (!process.env.QORPERA_S1_OLD_TREE) {
		process.stdout.write("NOT RUN: set QORPERA_S1_OLD_TREE to the base's tree without the slice (old parts)\n");
		return;
	}
	process.stdout.write(`Codex ${binary}: sha256 ${sha256(readFileSync(binary))}\n`);
	const oldTree = resolve(process.env.QORPERA_S1_OLD_TREE);
	const oldRef = readFileSync(join(oldTree, "REF"), "utf8").trim();
	assert(/^[0-9a-f]{40}$/.test(oldRef), "the old tree names its commit");
	process.stdout.write(`Old parts: ${oldTree} at ${oldRef}\n`);
	const database = await hostedDatabase(databaseName);
	const scratch = await realpath(await mkdtemp(join(tmpdir(), "qorpera-s1-command-output-")));
	const uid = process.getuid();
	const started = Date.now();
	const traced = [];
	const trace = (what) => traced.push(`${String(Date.now() - started).padStart(6)} ms ${what}`);
	const state = { calls: [], answers: {}, pages: {}, compactor: 0, failure: null };
	state.script = agent(state);
	const server = provider(state);
	const db = new Database((sql) => database.cluster.psql(databaseName, sql, ["-qAt"]));
	const record = [];
	const net = network(record);
	const closing = [];
	try {
		// 1. The parts: new from this tree, old from the base without the slice.
		const runtime = (await bundle(repositoryRoot, scratch, "runtime", [...RUNTIME, ...TOOLS, ...NEW_TOOLS])).module;
		const newExecutor = await bundle(repositoryRoot, scratch, "executor-new", EXECUTOR);
		const newGuest = await bundle(repositoryRoot, scratch, "guest-new", GUEST);
		newGuest.helper = Buffer.from("cloud-machine-guest.mjs of this tree");
		const old = {
			tools: (await bundle(oldTree, scratch, "tools-old", TOOLS)).module,
			executor: await bundle(oldTree, scratch, "executor-old", EXECUTOR),
			guest: Object.assign(await bundle(oldTree, scratch, "guest-old", GUEST), {
				helper: Buffer.from("cloud-machine-guest.mjs of the base"),
			}),
		};
		const helpers = { current: sha256(newGuest.helper), previous: sha256(old.guest.helper) };
		assert.equal(runtime.MAX_CLOUD_TOOL_RESULT_BYTES, RESULT);
		assert.equal(runtime.CLOUD_COMMAND_PAGE_ASK, RESULT - runtime.CLOUD_TOOL_RESULT_RESERVE_BYTES);
		assert.equal(runtime.CLOUD_CODING_COMMAND_PAGE_BYTES, PAGE);
		assert.equal(runtime.CLOUD_CODING_COMMAND_LEGACY_PAGE_BYTES, LEGACY);
		const id = randomUUID();
		assert.equal(newExecutor.module.parseCloudCodingCommandRead({ commandId: id, limit: PAGE }).limit, PAGE);
		assert.throws(() => newExecutor.module.parseCloudCodingCommandRead({ commandId: id, limit: PAGE + 1 }));
		pass(
			`one result is ${RESULT} bytes; a read asks for ${runtime.CLOUD_COMMAND_PAGE_ASK} when it names no limit; a page holds up to ${PAGE} bytes on the wire (new parse), ${PAGE + 1} refused`,
		);
		assert.equal(old.executor.module.parseCloudCodingCommandRead({ commandId: id, limit: LEGACY }).limit, LEGACY);
		assert.throws(() => old.executor.module.parseCloudCodingCommandRead({ commandId: id, limit: LEGACY + 1 }));
		pass(`the old parts are the base without the slice (${oldRef.slice(0, 9)}): their parse refuses a page past ${LEGACY}`);

		// 2. The company, Alice's run (Shared context: it keeps a work log), and three machines: m-new and m-oldguest on
		//    node a (executor mx-s1a), m-peer on node b (executor mx-s1b), placed through the run's own machine_start
		//    receipts.
		const fixture = readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8");
		const marker = "-- The checks start here: a test that runs after this file's fixture part stops at this line.";
		const end = fixture.indexOf(marker);
		assert(end > 0, "SQL test 924's fixture marker moved: update this script");
		const start = (name, key) =>
			`pg_temp.mc_start('${key}', '{"name":"${name}","purpose":"S1 proof","cpus":1,"memoryGiB":1,"diskGiB":10,"lifetime":"task"}')`;
		const out = db.query(`${fixture.slice(0, end)}
			set local session_replication_role = replica;
			update public.qorpera_execution_runs set memory_mode = 'tree'
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
			set local session_replication_role = origin;
			select pg_temp.base_claims('service_role') \\g /dev/null
			${helperText("628_runtime_company_machines.test.sql", "create function pg_temp.mc_binding()", "-- 1. Without a machine executor")}
			do $s1$
			declare v jsonb; v_a jsonb := '${JSON.stringify(POLICY_A)}'; v_b jsonb := '${JSON.stringify(POLICY_B)}';
			begin
				perform pg_temp.mc_node('${NODE_A}', repeat('c', 64), 'node-a', 16000, 68719476736);
				perform public.qorpera_enroll_runtime_node_provider('${NODE_A}', repeat('c', 64), 'machine', 'machine-fixture', repeat('f', 64), 8000, 34359738368);
				perform public.qorpera_configure_machine_executor('mx-s1a', repeat('c', 64), true, v_a, 322122547200);
				perform pg_temp.mc_observe('${NODE_A}', repeat('c', 64), 16000, 68719476736);
				v := ${start("m-new", "s1-new")};
				perform pg_temp.base_assert(v #>> '{machine,node}' = 'node-a', 'm-new on node a: ' || v::text);
				perform pg_temp.mc_observe('${NODE_A}', repeat('c', 64), 16000, 68719476736);
				v := ${start("m-oldguest", "s1-oldguest")};
				perform pg_temp.base_assert(v #>> '{machine,node}' = 'node-a', 'm-oldguest on node a: ' || v::text);
				perform pg_temp.mc_node('${NODE_B}', repeat('d', 64), 'node-b', 16000, 68719476736);
				perform public.qorpera_enroll_runtime_node_provider('${NODE_B}', repeat('d', 64), 'machine', 'machine-fixture-b', repeat('e', 64), 8000, 34359738368);
				perform public.qorpera_configure_machine_executor('mx-s1b', repeat('d', 64), true, v_b, 322122547200);
				-- Node a looked away for a moment: the next machine goes to node b.
				update public.qorpera_runtime_node_observations set observed_at = clock_timestamp() - interval '2 minutes' where node_id = '${NODE_A}';
				perform pg_temp.mc_observe('${NODE_B}', repeat('d', 64), 16000, 68719476736);
				v := ${start("m-peer", "s1-peer")};
				perform pg_temp.base_assert(v #>> '{machine,node}' = 'node-b', 'm-peer on node b: ' || v::text);
				perform pg_temp.mc_observe('${NODE_A}', repeat('c', 64), 16000, 68719476736);
			end $s1$;
			select jsonb_build_object('binding', current_setting('qorpera_test.base_binding')::jsonb,
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
				'machines', (select jsonb_object_agg(m.name, jsonb_build_object('machineId', m.id, 'placementId', p.id, 'owner', p.owner))
					from public.qorpera_company_machines m join public.qorpera_company_machine_placements p on p.machine_id = m.id
					where p.retired_at is null and p.removed_at is null))::text;
			commit;`);
		const setup = JSON.parse(out.split("\n").at(-1));
		const binding = setup.binding;
		const placements = setup.machines;
		assert.deepEqual(
			Object.fromEntries(Object.entries(placements).map(([name, machine]) => [name, machine.owner])),
			{ "m-new": "mx-s1a", "m-oldguest": "mx-s1a", "m-peer": "mx-s1b" },
		);
		pass(`SQL test 924's run of Alice is leased (run ${binding.runId.slice(0, 8)}), and her machine_start receipts placed m-new and m-oldguest on node a, m-peer on node b`);

		// 3. The executors: a (this tree's) with m-new (this tree's guest) and m-oldguest (the base's guest); b (the base's)
		//    with m-peer (this tree's guest). Each machine host's pass makes its machines, claims each guest's boot and
		//    marks it running in SQL.
		const instance = (placementId) => `qorpera-machine-${placementId.replaceAll("-", "")}`;
		const machineNew = await machineGuest(newGuest, "m-new", uid);
		const machineOldGuest = await machineGuest(old.guest, "m-oldguest", uid);
		const machinePeer = await machineGuest(newGuest, "m-peer", uid);
		const machines = { "m-new": machineNew, "m-oldguest": machineOldGuest, "m-peer": machinePeer };
		for (const machine of Object.values(machines)) closing.push(() => rm(machine.root, { recursive: true, force: true }));
		const tokens = {
			"guest-mx-s1a": token(),
			"peer-mx-s1a": token(),
			"guest-mx-s1b": token(),
			"peer-mx-s1b": token(),
		};
		const holder = `job.${binding.jobId}.${randomBytes(32).toString("base64url").slice(0, 43)}`;
		const coding = await codingExecutor(scratch, uid);
		const nodeA = {
			db,
			owner: "mx-s1a",
			providerId: POLICY_A.providerId,
			policy: POLICY_A,
			machineIdSha256: "c".repeat(64),
			machines: new Map([
				[instance(placements["m-new"].placementId), machineNew],
				[instance(placements["m-oldguest"].placementId), machineOldGuest],
			]),
			peers: [{ owner: "mx-s1b", providerId: POLICY_B.providerId, origin: "https://mx-s1b-peer.s1.test", tokenCredential: "peer-mx-s1b" }],
			tokens,
			net,
			coding,
			helpers,
			holder,
		};
		const a = await executor(newExecutor, nodeA);
		closing.push(a.close);
		const b = await executor(old.executor, {
			...nodeA,
			owner: "mx-s1b",
			providerId: POLICY_B.providerId,
			policy: POLICY_B,
			machineIdSha256: "d".repeat(64),
			machines: new Map([[instance(placements["m-peer"].placementId), machinePeer]]),
			peers: [{ owner: "mx-s1a", providerId: POLICY_A.providerId, origin: "https://mx-s1a-peer.s1.test", tokenCredential: "peer-mx-s1a" }],
		});
		closing.push(b.close);
		// Node a's executor as the base's, with a's own credentials and machines: what a rolls back to (step 9).
		const aBefore = await executor(old.executor, nodeA);
		closing.push(aBefore.close);
		for (const node of [a, b]) {
			net.routes.set(node.origin, node.listener);
			net.routes.set(`https://${node.owner}-peer.s1.test`, node.peer);
		}
		for (const host of [a.host, b.host]) {
			await host.pass(AbortSignal.timeout(60_000));
			await host.settled();
		}
		const listed = db.direct("qorpera_native_machine_manage", { p_binding: binding, p_request: { action: "list" } });
		const states = Object.fromEntries(listed.machines.map((machine) => [machine.name, machine.state]));
		assert.deepEqual(states, { "m-new": "running", "m-oldguest": "running", "m-peer": "running" }, JSON.stringify(listed));
		const prepared = (machine) => {
			const reply = machine.execs.find((args) => args[0] === "prepare");
			assert(reply, `${machine.name}'s guest was claimed`);
			return reply;
		};
		for (const machine of Object.values(machines)) prepared(machine);
		pass(
			"each executor's pass made its machines, claimed their guests' boots and marked them running in SQL (executor a this tree's, b the base's; m-oldguest's guest the base's)",
		);

		// 4. The run, through the real patched Codex: its session, boundary, fence, context view and log, with the machine
		//    tools on executor a's guest-facing listener and the coding tools.
		await new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const port = server.address().port;
		const pages = new runtime.CloudCommandPages();
		const paths = new runtime.HttpCloudCompanyPathControl({
			supabaseUrl: "https://postgrest.stand-in.invalid/",
			serviceRoleKey: "stand-in",
			fetch: postgrestFetch(db),
		});
		const machineGateway = (code, url, sharedPages, from = "runtime") =>
			code.createHttpCloudMachineCommandGateway({
				url,
				token: tokens[`guest-${new URL(url).hostname.split(".")[0]}`],
				binding,
				holder: () => holder,
				...(sharedPages ? { pages: sharedPages } : {}),
				fetch: net.via(from),
			});
		const codingGateway = (code, url, sharedPages, from = "runtime") =>
			code.createHttpCloudCodingCommandGateway({
				url,
				token: tokens[`guest-${new URL(url).hostname.split(".")[0]}`],
				binding,
				holder: () => holder,
				authorize: async () => {},
				...(sharedPages ? { pages: sharedPages } : {}),
				fetch: net.via(from),
			});
		const codingScope = { workerId: randomUUID(), vmId: randomUUID(), requestId: randomUUID(), turn: 1 };
		const objects = new Map();
		const compactor = new runtime.MemoryCompactChannel();
		const lane = new runtime.MemoryCompactLane();
		let identity;
		let opened;
		let folder;
		let codingOffered = false;
		const command = await runtime.nativeCodexFixtureCommand(scratch, [binary], port);
		await runtime.runCloudNativeRunToolSession({
			binding,
			controlPlane: controlPlane(db),
			beginExecution: async (specification, signal) => {
				const described = db.direct("qorpera_describe_native_tool_authority", { p_binding: binding }).identity;
				signal.throwIfAborted();
				await paths.call(
					"qorpera_begin_native_company_execution_v3",
					{
						p_binding: binding,
						p_binary_sha256: setup.nativeBinarySha256,
						p_runtime_bundle_sha256: described.runtimeBundleSha256,
						p_reasoning_policy_sha256: described.reasoningPolicySha256,
						p_tool_catalog_text: runtime.cloudToolJsonText(specification, runtime.CLOUD_NATIVE_TOOL_CATALOG_BYTES),
					},
					signal,
				);
				await paths.call(
					"qorpera_bind_native_company_context",
					{ p_binding: binding, p_context_sha256: sha256(PROMPT), p_context_bytes: Buffer.byteLength(PROMPT) },
					signal,
				);
			},
			tools: async (admitted, operations, run) => {
				identity = admitted;
				const bytes = new runtime.HttpCloudCompanyFolderBytes({
					baseUrl: "http://127.0.0.1:9/",
					token: "t".repeat(43),
					binding,
					holder: () => "stand-in-holder",
					identity,
					control: paths,
					fetch: gatewayFetch(db, objects),
				});
				folder = new runtime.CloudCompanyFolderClient({ binding, identity, control: paths, bytes });
				const gateway = new runtime.CloudCompanyPathGateway({ binding, identity, control: paths });
				opened = await runtime.openCloudRunLog({
					resume: new runtime.CloudRunResumeRpc({ run, control: paths }),
					folder: new runtime.CloudRunLogCompanyFolder({ environmentId: identity.environmentId, runId: binding.runId, folder, control: paths }),
					log: {
						runId: binding.runId,
						protection: new runtime.CloudRunLogRpcProtection({
							environmentId: identity.environmentId,
							jobId: binding.jobId,
							runId: binding.runId,
							call: (method, args, signal) => paths.call(method, args, signal),
						}),
						signal: run.signal,
					},
					lines: { call: (system, signal) => compactor.call(system, signal), lane, observe: () => {} },
				});
				assert(opened?.log, "the run keeps a log (Shared context: its recorded memory mode is tree)");
				let codingTools = [];
				try {
					codingTools = runtime.cloudCodingCommandTools({
						scope: codingScope,
						identity,
						operations,
						gateway: codingGateway(runtime, a.origin, pages),
					});
					codingOffered = true;
					state.codingOffered = true;
				} catch (error) {
					trace(`coding tools not offered to this run: ${error.message}`);
				}
				return {
					tools: [
						...runtime.cloudMachineTools({ binding, identity, control: paths, operations, gateway: machineGateway(runtime, a.origin, pages) }),
						...codingTools,
					],
					assertContext: (signal, timeoutMs) => gateway.assertReadableContext(signal, timeoutMs),
					checkRun: (signal, timeoutMs) => gateway.checkRun(signal, timeoutMs),
					recordContextView: (frame, outputs, signal) => gateway.recordContextView(frame, outputs, signal),
					fenceContextView: (frame, outputs, signal) => gateway.fenceContextView(frame, outputs, signal),
					runLog: { log: opened.log, lines: opened.lines },
				};
			},
			composeContext: async (request, signal) =>
				opened?.composeContext ? opened.composeContext(request, signal) : runtime.cloudNativeContextIdentity(request),
			compactor,
			command: command.command,
			binarySha256: command.binarySha256,
			prompt: PROMPT,
			signal: AbortSignal.timeout(300_000),
			timeoutMs: 240_000,
		});
		if (state.failure) throw state.failure;
		assert(state.calls.every((call) => call.envelope), "every call's output reached the provider");
		const log = (machine, commandId) => readFileSync(machine.log(commandId));
		const reads = (commandId, from = "runtime") =>
			record.filter((entry) => entry.from === from && entry.action === "read" && entry.commandId === commandId);
		const guestReads = (machine, commandId) =>
			machine.execs.filter((args) => args[0] === "read" && args[1] === commandId).map((args) => args.slice(2));
		const textOf = (bytes) => new TextDecoder("utf-8").decode(bytes);
		const byteLengths = state.calls.map((call) => Buffer.byteLength(call.envelope));
		assert(byteLengths.every((bytes) => bytes <= RESULT), JSON.stringify(byteLengths));

		// 5. A long command in one call: machine_run's own answer shows how it ended and a full result of its output.
		const big = state.answers.big;
		const bigLog = log(machineNew, big.commandId);
		const bigEnvelope = Buffer.byteLength(state.calls[0].envelope);
		assert.equal(bigLog.length, 100_000);
		assert(big.state === "succeeded" && big.exitCode === 0 && big.log.offset === 0 && big.truncated === true);
		assert.equal(big.output, textOf(bigLog.subarray(0, big.log.nextOffset)));
		assert(big.log.nextOffset > 30_000 && bigEnvelope > RESULT - 300 && bigEnvelope <= RESULT, `${big.log.nextOffset} / ${bigEnvelope}`);
		assert.deepEqual(
			reads(big.commandId).slice(0, 1).map((entry) => [entry.offset, entry.limit, entry.status, entry.said]),
			[[0, runtime.CLOUD_COMMAND_PAGE_ASK, 200, String(PAGE)]],
		);
		assert.deepEqual(guestReads(machineNew, big.commandId)[0], ["0", String(runtime.CLOUD_COMMAND_PAGE_ASK)]);
		pass(
			`machine_run on m-new answered in one call: succeeded, exit 0, the first ${big.log.nextOffset} of ${bigLog.length} bytes in a ${bigEnvelope}-byte envelope through the patched Codex; the runtime asked executor a for ${runtime.CLOUD_COMMAND_PAGE_ASK} and the guest was asked the same`,
		);
		const second = state.answers.second;
		// The same room a page, give or take the cursor's digits and the answer's own fields.
		assert(
			second.log.offset === big.log.nextOffset && Math.abs(second.log.nextOffset - second.log.offset - big.log.nextOffset) <= 64,
			JSON.stringify(second.log),
		);
		assert.equal(second.output, textOf(bigLog.subarray(second.log.offset, second.log.nextOffset)));
		const tail = state.answers.tail;
		assert(tail.log.nextOffset === 100_000 && tail.log.offset === 100_000 - Buffer.byteLength(tail.output) && tail.output.length > 30_000);
		assert.equal(tail.output, textOf(bigLog.subarray(tail.log.offset)));
		pass(
			`machine_read went on at nextOffset ${big.log.nextOffset} for exactly the next ${second.log.nextOffset - second.log.offset} bytes, and a tail read showed the last ${tail.output.length} bytes from offset ${tail.log.offset}`,
		);
		assert(state.answers.small.output === "a".repeat(100) && state.answers.small.log.nextOffset === 100);
		assert(state.answers.tooLarge.error && state.answers.tooLarge.error.status !== "ok");
		assert.equal(reads(big.commandId).filter((entry) => entry.limit === 40000).length, 0);
		pass(
			`limit 100 asked for less and got 100 bytes; limit 40000 was refused by the tool (${state.answers.tooLarge.error.status}) before any request left the runtime`,
		);

		// 6. Output that escapes to several bytes a byte, and bytes that are not UTF-8: every page fits one result at an
		//    exact cursor, and the pages give back the whole log.
		for (const key of ["escaped", "mixed"]) {
			const pagesOf = state.pages[key];
			const bytes = log(machineNew, pagesOf[0].commandId);
			let at = 0;
			for (const page of pagesOf) {
				assert.equal(page.log.offset, at, `${key}: the pages follow each other`);
				const expected = textOf(bytes.subarray(page.log.offset, page.log.nextOffset));
				if (page.output !== expected) {
					let at = 0;
					while (page.output[at] === expected[at]) at++;
					assert.fail(
						`${key}: a page is its log's bytes: ${JSON.stringify({ ...page, output: undefined })}, ${page.output.length} and ${expected.length} characters, first apart at ${at}: ${JSON.stringify(page.output.slice(at - 8, at + 8))} / ${JSON.stringify(expected.slice(at - 8, at + 8))}`,
					);
				}
				at = page.log.nextOffset;
			}
			assert.equal(at, bytes.length);
			const asked = reads(pagesOf[0].commandId);
			process.stdout.write(
				`${key}: ${bytes.length} bytes in ${pagesOf.length} pages of ${pagesOf.map((page) => page.log.nextOffset - page.log.offset).join(", ")} bytes; ${asked.length} reads asked ${asked.map((entry) => entry.limit).join(", ")}\n`,
			);
			if (key === "escaped") assert.equal(asked.length, pagesOf.length, "a page whose cut holds no U+FFFD is asked once");
			else assert(asked.length > pagesOf.length, "a cut with U+FFFD on both sides was asked again for exactly the bytes that fit");
		}
		pass(
			`escape-heavy output (${state.pages.escaped.length} pages) and output with bytes that are not UTF-8 (${state.pages.mixed.length} pages) came back whole and exact, page after page, each in one result; only cuts that could not tell their cursor were asked again`,
		);
		const short = state.answers.short;
		assert(short.state === "succeeded" && short.exitCode === 0 && short.output === "hello\n" && short.truncated === false);
		assert.equal(reads(short.commandId).length, 0);
		pass("a short command came back whole in machine_run's own answer, with no read at all");

		// 7. The old guest, and the old executor behind a peer: each asked only for what it takes.
		const oldGuest = state.answers.oldGuest;
		const oldGuestReads = guestReads(machineOldGuest, oldGuest.commandId);
		assert.equal(oldGuest.log.nextOffset, LEGACY);
		assert.equal(oldGuest.output, textOf(log(machineOldGuest, oldGuest.commandId).subarray(0, LEGACY)));
		assert.deepEqual(oldGuestReads, [["0", String(LEGACY)]]);
		assert.deepEqual(reads(oldGuest.commandId).map((entry) => entry.limit), [runtime.CLOUD_COMMAND_PAGE_ASK]);
		pass(
			`m-oldguest (the base's guest, which says nothing of its pages): the runtime asked for ${runtime.CLOUD_COMMAND_PAGE_ASK}, executor a asked the guest for ${LEGACY}, and machine_run showed ${LEGACY} bytes`,
		);
		const peer = state.answers.peer;
		const peerReads = reads(peer.commandId, "mx-s1a");
		assert.deepEqual(reads(peer.commandId).map((entry) => entry.limit), [runtime.CLOUD_COMMAND_PAGE_ASK]);
		assert.deepEqual(peerReads.map((entry) => [entry.to, entry.limit, entry.said]), [["https://mx-s1b-peer.s1.test", LEGACY, null]]);
		assert.deepEqual(guestReads(machinePeer, peer.commandId), [["0", String(LEGACY)]]);
		assert(peer.log.nextOffset === LEGACY && peer.output === textOf(log(machinePeer, peer.commandId).subarray(0, LEGACY)));
		pass(
			`m-peer on executor b (the base's): executor a forwarded the read asking ${LEGACY} (b never says what it takes), b asked its guest for ${LEGACY}, and machine_run showed ${LEGACY} bytes`,
		);

		// 8. What was kept of each answer: the context view (SQL), the run's log, and machine_run's receipt.
		const views = JSON.parse(
			db.query(`select coalesce(jsonb_agg(o), '[]')::text from public.qorpera_native_context_views v,
				jsonb_array_elements(v.view -> 'outputs') o where v.run_id = '${binding.runId}'`),
		);
		for (const call of state.calls) {
			const seen = views.filter((output) => output.callId === call.callId);
			assert(
				seen.length >= 1 &&
					seen.every((output) => output.bytes === Buffer.byteLength(call.envelope) && output.sha256 === sha256(call.envelope)),
				`${call.callId}: ${JSON.stringify(seen)}`,
			);
		}
		pass(
			`the run's context views recorded all ${state.calls.length} outputs at their envelopes' bytes and digests (the largest ${Math.max(...byteLengths)} bytes)`,
		);
		const steps = JSON.parse(
			db.query(`select coalesce(jsonb_agg(jsonb_build_object('j', s.j, 'tool', s.tool, 'finished', s.finished) order by s.j), '[]')::text
				from public.qorpera_memory_run_steps s where s.run_id = '${binding.runId}'`),
		);
		assert.deepEqual(
			steps.map((step) => [step.j, step.tool]),
			state.calls.map((call, j) => [j, call.name]),
			JSON.stringify(steps),
		);
		const place = new runtime.CloudRunLogCompanyFolder({ environmentId: identity.environmentId, runId: binding.runId, folder, control: paths });
		const located = await place.locate(binding.runId, AbortSignal.timeout(30_000));
		let kept = 0;
		for (let block = 0; block <= located.last; block++) {
			const text = (await place.read(`${located.path}/log/${String(block).padStart(8, "0")}.jsonl`, AbortSignal.timeout(30_000)))?.text ?? "";
			kept += state.calls.filter((call) => text.includes(`"result":${call.envelope},`)).length;
		}
		assert.equal(kept, state.calls.length);
		pass(
			`the run's log kept all ${state.calls.length} steps, each with its whole envelope byte for byte (blocks 0 to ${located.last}, staged with the shared parser's parse and accepted by SQL)`,
		);
		const receipt = JSON.parse(
			db.query(`select r.result::text from public.qorpera_run_operation_receipts r where r.run_id = '${binding.runId}'
				and r.logical_operation_key = 'machine_run:s1-big'`),
		);
		const stored = JSON.parse(receipt.content.value);
		assert(stored.commandId === big.commandId && stored.log.nextOffset <= 4096 && Buffer.byteLength(receipt.content.value) < 48 * 1024);
		pass(
			`machine_run's receipt keeps the start's own answer (its first ${stored.log.nextOffset} bytes): a replay answers the start and reads again; the read's page is the answer, never stored in the receipt`,
		);

		// 9. The run's tools called directly (no model) for what the run above did not do: the base's runtime on this tree's
		//    executor, this tree's runtime entering at the base's executor, the first read of a fresh runtime process, an
		//    executor rolled back to the base under a running runtime, and a read outside the run's company.
		const context = (args, as = identity) => ({
			companyId: identity.companyId,
			runId: identity.runId,
			callId: `direct-${randomUUID()}`,
			argumentSha256: sha256(JSON.stringify(args)),
			signal: AbortSignal.timeout(60_000),
			identity: as,
		});
		const noOperations = { execute: async () => assert.fail("no operation in a read") };
		const readWith = async (code, gateway, args) => {
			const tool = code
				.cloudMachineTools({ binding, identity, control: paths, operations: noOperations, gateway })
				.find((entry) => entry.name === "machine_read");
			const content = await tool.execute(tool.parseArguments(args), context(args));
			return JSON.parse(content.value);
		};
		const since = () => {
			const mark = record.length;
			return () => record.slice(mark).map((entry) => [entry.from, entry.to, entry.limit, entry.status, entry.said]);
		};
		const bigRead = (more) => ({ machine: "m-new", commandId: big.commandId, offset: 0, ...more });
		let seen = since();
		const plain = await readWith(old.tools, machineGateway(old.tools, a.origin, undefined, "old-runtime"), bigRead({}));
		const asked = await readWith(old.tools, machineGateway(old.tools, a.origin, undefined, "old-runtime"), bigRead({ limit: LEGACY }));
		assert(plain.output === "a".repeat(4096) && asked.output === "a".repeat(LEGACY));
		assert.deepEqual(seen(), [
			["old-runtime", a.origin, 4096, 200, String(PAGE)],
			["old-runtime", a.origin, LEGACY, 200, String(PAGE)],
		]);
		pass(`the base's machine_read on this tree's executor a: it asked for 4096 by default and ${LEGACY} at most, and got exactly that (the page header it does not read)`);
		seen = since();
		const enteringB = new runtime.CloudCommandPages();
		const viaB = await readWith(runtime, machineGateway(runtime, b.origin, enteringB), bigRead({}));
		const viaBAgain = await readWith(runtime, machineGateway(runtime, b.origin, enteringB), bigRead({ offset: LEGACY }));
		assert(viaB.output === "a".repeat(LEGACY) && viaB.log.nextOffset === LEGACY && viaBAgain.log.nextOffset === 2 * LEGACY);
		// Each hop is recorded as its answer comes: the peer's before the entry's.
		assert.deepEqual(seen(), [
			["mx-s1b", "https://mx-s1a-peer.s1.test", LEGACY, 200, String(PAGE)],
			["runtime", b.origin, LEGACY, 200, null],
			["mx-s1b", "https://mx-s1a-peer.s1.test", LEGACY, 200, String(PAGE)],
			["runtime", b.origin, LEGACY, 200, null],
		]);
		pass(`this tree's machine_read entering at the base's executor b: it asked b for ${LEGACY} (b says nothing), b forwarded ${LEGACY} to this tree's executor a, and each page was ${LEGACY} bytes`);
		seen = since();
		const fresh = new runtime.CloudCommandPages();
		const first = await readWith(runtime, machineGateway(runtime, a.origin, fresh), bigRead({}));
		const again = await readWith(runtime, machineGateway(runtime, a.origin, fresh), bigRead({}));
		assert.deepEqual(seen(), [
			["runtime", a.origin, LEGACY, 200, String(PAGE)],
			["runtime", a.origin, runtime.CLOUD_COMMAND_PAGE_ASK, 200, String(PAGE)],
		]);
		assert(first.log.nextOffset === LEGACY && again.log.nextOffset === big.log.nextOffset);
		pass(`a runtime process that has heard nothing from executor a yet asks it for ${LEGACY}, and for one result's room once a said it takes ${PAGE}`);
		seen = since();
		const rolled = new runtime.CloudCommandPages();
		await readWith(runtime, machineGateway(runtime, a.origin, rolled), bigRead({}));
		await readWith(runtime, machineGateway(runtime, a.origin, rolled), bigRead({}));
		// Executor a rolls back to the base's, with a's own credentials and machines, under the same origin.
		net.routes.set(a.origin, aBefore.listener);
		let refused;
		const swapped = await readWith(runtime, machineGateway(runtime, a.origin, rolled), bigRead({})).catch((error) => {
			refused = error;
		});
		const after = await readWith(runtime, machineGateway(runtime, a.origin, rolled), bigRead({}));
		net.routes.set(a.origin, a.listener);
		const rollback = seen();
		assert(!refused, `the read after the rollback is answered: ${refused?.message}`);
		assert(swapped.output === "a".repeat(LEGACY) && after.output === "a".repeat(LEGACY));
		assert.deepEqual(rollback, [
			["runtime", a.origin, LEGACY, 200, String(PAGE)],
			["runtime", a.origin, runtime.CLOUD_COMMAND_PAGE_ASK, 200, String(PAGE)],
			["runtime", a.origin, runtime.CLOUD_COMMAND_PAGE_ASK, 403, null],
			["runtime", a.origin, LEGACY, 200, null],
			["runtime", a.origin, LEGACY, 200, null],
		]);
		pass(
			`executor a rolled back to the base under a running runtime that had learned ${PAGE}: the base refused the read's ${runtime.CLOUD_COMMAND_PAGE_ASK}-byte page without saying what it takes, the gateway asked once more for ${LEGACY} in the same call and the agent got ${LEGACY} bytes; later reads ask ${LEGACY}`,
		);
		seen = since();
		const execs = machineNew.execs.length;
		await assert.rejects(
			machineGateway(runtime, a.origin, pages).read({ machineId: randomUUID() }, { commandId: big.commandId, offset: 0, limit: PAGE }, AbortSignal.timeout(30_000)),
		);
		const stranger = seen();
		assert(stranger.length === 1 && stranger[0][3] === 403 && machineNew.execs.length === execs, JSON.stringify(stranger));
		assert(db.refusals.some((refusal) => refusal.startsWith("qorpera_authorize_machine_command: 42501")));
		pass(`a read naming a machine outside the run's company, asking ${stranger[0][2]} bytes, was refused by SQL's authority at executor a (403) and never reached a guest`);

		// 10. Coding commands: this tree's coding_run_command answers an ended command's output in one call, and the
		//     gateways and command services take pages in both orders. The run's identity is a company agent's; a coding
		//     session's run is a worker's, which these tools check, so they are called directly here with that audience.
		const worker = { ...identity, audienceKind: "company", audienceUserId: null };
		const codingTool = (code, gateway, name, operations = noOperations) =>
			code.cloudCodingCommandTools({ scope: codingScope, identity: worker, operations, gateway }).find((entry) => entry.name === name);
		const codingCall = async (code, gateway, name, args, operations) => {
			const tool = codingTool(code, gateway, name, operations);
			return JSON.parse((await tool.execute(tool.parseArguments(args), context(args, worker))).value);
		};
		const operationsOnce = {
			execute: async ({ operation, perform }) =>
				(
					await perform(operation, {
						receiptId: randomUUID(),
						inputSha256: sha256(JSON.stringify(operation)),
						signal: AbortSignal.timeout(30_000),
					})
				).content,
		};
		seen = since();
		const codingPages = new runtime.CloudCommandPages();
		const codingStart = await codingCall(runtime, codingGateway(runtime, a.origin, codingPages), "coding_run_command", { command: "npm test", operationKey: "s1-coding" }, operationsOnce);
		const codingNext = await codingCall(runtime, codingGateway(runtime, a.origin, codingPages), "coding_read_command", { commandId: codingStart.commandId, offset: codingStart.log.nextOffset });
		assert(codingStart.state === "succeeded" && codingStart.log.offset === 0 && codingStart.log.nextOffset > 30_000);
		assert.equal(codingStart.output, CODING_BIG.subarray(0, codingStart.log.nextOffset).toString());
		assert(
			codingNext.log.offset === codingStart.log.nextOffset &&
				Math.abs(codingNext.log.nextOffset - codingNext.log.offset - codingStart.log.nextOffset) <= 64,
			JSON.stringify(codingNext.log),
		);
		assert.deepEqual(seen(), [
			["runtime", a.origin, undefined, 200, String(PAGE)],
			["runtime", a.origin, runtime.CLOUD_COMMAND_PAGE_ASK, 200, String(PAGE)],
			["runtime", a.origin, runtime.CLOUD_COMMAND_PAGE_ASK, 200, String(PAGE)],
		]);
		pass(
			`coding_run_command answered an ended command with its first ${codingStart.log.nextOffset} of ${CODING_BIG.length} bytes in one call (its start, then one read asking ${runtime.CLOUD_COMMAND_PAGE_ASK}), and coding_read_command went on for the next ${codingNext.log.nextOffset - codingNext.log.offset}`,
		);
		seen = since();
		const toOld = await codingCall(runtime, codingGateway(runtime, b.origin, new runtime.CloudCommandPages()), "coding_read_command", { commandId: codingStart.commandId, offset: 0 });
		const fromOld = await codingCall(old.tools, codingGateway(old.tools, a.origin, undefined, "old-runtime"), "coding_read_command", { commandId: codingStart.commandId, offset: 0, limit: LEGACY });
		assert(toOld.log.nextOffset === LEGACY && fromOld.log.nextOffset === LEGACY);
		assert.deepEqual(seen(), [
			["runtime", b.origin, LEGACY, 200, null],
			["old-runtime", a.origin, LEGACY, 200, String(PAGE)],
		]);
		pass(`coding reads in both orders: this tree's gateway asked the base's command service for ${LEGACY} (it says nothing), and the base's coding_read_command asked this tree's service for ${LEGACY} at most`);
		if (state.answers.coding) {
			const viaCodex = state.answers.coding;
			assert(viaCodex.state === "succeeded" && viaCodex.log.nextOffset === codingStart.log.nextOffset);
			assert(state.answers.codingNext.log.offset === viaCodex.log.nextOffset);
			pass(`the run's own coding_run_command and coding_read_command, through the patched Codex, showed the same ${viaCodex.log.nextOffset}-byte pages`);
		} else notRun(`coding tools through the patched Codex: ${codingOffered ? "offered, not called" : "this run's identity takes none (a coding session's run does)"}`);

		// 11. The coding sessions' own context view: on a folder-v2 company it is the run's folder view, whose bound on an
		//     output is one result's (20260930733000).
		const definition = (signature) => db.query(`select pg_get_functiondef('public.${signature}'::regprocedure)`);
		const codingView = definition("qorpera_record_coding_context_view(jsonb,jsonb)");
		const legacyView = definition("qorpera_record_native_context_view(uuid,jsonb,jsonb)");
		const folderView = definition("qorpera_folder_record_context_view(uuid,jsonb,jsonb)");
		assert(codingView.includes("public.qorpera_record_native_context_view("));
		const guard = legacyView.indexOf("return public.qorpera_folder_record_context_view(p_environment_id, p_binding, p_view)");
		assert(guard > 0 && guard < legacyView.indexOf("> 8192"), "the legacy view hands folder-v2 to the folder view before its own 8 KiB bound");
		assert(folderView.includes("20260930733000") && folderView.includes("> 32768") && !folderView.includes("> 8192 then"));
		pass("a coding session's context view call hands a folder-v2 company to the folder view first, which takes an output up to 32,768 bytes (read from the migrated database's functions)");
		process.stdout.write(
			`Database calls: ${db.calls.length}; provider requests: ${state.calls.length + 1} agent, ${state.compactor} compactor; HTTP requests between the parts: ${record.length}\n`,
		);
		process.stdout.write(`S1 proof: ${passed} checks passed\n`);
	} catch (error) {
		for (const refusal of db.refusals) process.stdout.write(`refused ${refusal.slice(0, 400)}\n`);
		for (const line of traced) process.stdout.write(`trace ${line}\n`);
		for (const entry of record.slice(-30)) process.stdout.write(`http ${JSON.stringify(entry)}\n`);
		process.stdout.write(`calls: ${state.calls.map((call) => `${call.name} ${JSON.stringify(call.args).slice(0, 120)} -> ${call.envelope ? Buffer.byteLength(call.envelope) : "none"}`).join("\n  ")}\n`);
		const diagnostics = await readFile(join(scratch, "native-diagnostics.log"), "utf8").catch(() => "");
		if (diagnostics) process.stdout.write(`native diagnostics (last 4000 characters):\n${diagnostics.slice(-4000)}\n`);
		if (error?.cause) process.stdout.write(`cause: ${error.cause?.stack ?? error.cause}\n`);
		throw error;
	} finally {
		for (const close of closing.reverse()) await close().catch(() => {});
		server.closeAllConnections?.();
		await new Promise((resolveClose) => server.close(() => resolveClose()));
		await rm(scratch, { recursive: true, force: true });
		database.close();
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		process.stdout.write(`FAIL ${error?.stack ?? error}\n`);
		process.exit(1);
	},
);
