import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// One tool result of 32 KiB, from the read to the resume (PR #1530): a run reads a full 32 KiB window of a long company
// file through the real patched Codex, the run's work log keeps that step through the folder's structured-file path
// (the shared parser on the staged bytes, then the database's own checks), the attempt is cut off, and the next attempt
// resumes from the log. What the model receives after the resume is checked at the provider.
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-run-log-full-result.mjs
//
// Real: the migrated database (every migration, with 20260930733000) and its functions; SQL test 924's company, run and
// lease, made through the real orchestrator and native lease contracts; the runtime's own run session
// (runCloudNativeRunToolSession), boundary, result fence, company_read, folder client and bytes client, run log, its
// folder adapter and protection, resume, step lines and work composer; the patched Codex app-server. Stand-ins: PostgREST
// (a function call is one psql call as the service role, its arguments typed as the function declares them), the object
// gateway's folder object route (bytes kept in memory; each object confirmed with the folder core as the gateway does),
// and the model provider (a scripted loopback Responses server; no model is called). Not covered: the native provider
// service process, isolation, auto-review, the company runtime's prompt composition, a real node.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_run_log_full_result";
const ORCHESTRATOR = "92400000-0000-4000-8000-000000000092";
const LONG_PATH = "notes/long.md";
/** A long file of numbered lines: several 32 KiB windows. */
const LONG_TEXT = Array.from({ length: 3000 }, (_, n) => `line ${String(n).padStart(5, "0")} of a long file, in words.\n`).join("");
const SUMMARY = "Read notes/long.md from its start: numbered lines of a long file, in words; more follows.";
const PROMPT = `Read ${LONG_PATH} from its start.`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pass = (what) => process.stdout.write(`PASS ${what}\n`);

async function bundle(scratch) {
	const modulePath = join(scratch, "prove.mjs");
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents: [
				'export {runCloudNativeRunToolSession} from "./packages/runtime/src/cloud-native-run-tool-session.ts";',
				'export {HttpCloudCompanyPathControl} from "./packages/runtime/src/cloud-company-path-control.ts";',
				'export {CloudCompanyPathGateway} from "./packages/runtime/src/cloud-company-path-gateway.ts";',
				'export {CloudCompanyFolderClient, cloudCompanyFolderRunActor} from "./packages/runtime/src/cloud-company-folder-client.ts";',
				'export {HttpCloudCompanyFolderBytes} from "./packages/runtime/src/cloud-company-folder-bytes.ts";',
				'export {cloudFolderFileTools} from "./packages/runtime/src/cloud-folder-file-tools.ts";',
				'export {CloudRunLogCompanyFolder} from "./packages/runtime/src/cloud-run-log-folder.ts";',
				'export {openCloudRunLog} from "./packages/runtime/src/cloud-run-log-open.ts";',
				'export {CloudRunResumeRpc} from "./packages/runtime/src/cloud-run-resume.ts";',
				'export {CloudRunLogRpcProtection} from "./packages/runtime/src/cloud-run-log-protection.ts";',
				'export {MemoryCompactChannel, MemoryCompactLane} from "./packages/runtime/src/memory-tree/compact.ts";',
				'export {cloudNativeContextIdentity} from "./packages/runtime/src/cloud-native-context-composition.ts";',
				'export {CLOUD_NATIVE_TOOL_CATALOG_BYTES, MAX_CLOUD_TOOL_RESULT_BYTES, cloudToolJsonText} from "./packages/runtime/src/cloud-native-tool-boundary.ts";',
				'export {MEMORY_RUN_STEP_RESULT_BYTES} from "./packages/cloud-client/src/memory-run-files.ts";',
				'export {nativeCodexFixtureCommand} from "./packages/runtime/test/fixtures/native-codex-fixture-command.ts";',
			].join("\n"),
		},
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: modulePath,
		logLevel: "silent",
	});
	return import(pathToFileURL(modulePath).href);
}

/** The database through psql, as the service role. A function's arguments are typed as it declares them, as PostgREST
 * types a JSON body's fields; an error names its SQLSTATE, as PostgREST's `code` does. */
class Database {
	#run;
	#signatures = new Map();
	calls = [];
	/** Each refused call, by its function, SQLSTATE and message: shown when the proof fails. */
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
		// As PostgREST picks an overload: the one these named arguments call, the fewest arguments first.
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
			const value = `(${body} -> '${key}')`;
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

	/** A call the runtime makes through its control plane, not over HTTP: an answer, or the error PostgREST would give. */
	direct(method, args) {
		const { status, value } = this.rpc(method, args);
		if (status === 200) return value;
		throw Object.assign(new Error(value.message), { code: value.code, status });
	}
}

/** PostgREST's HTTP status for an error's SQLSTATE (its error table). */
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

/** PostgREST in front of the database, for the runtime's HttpCloudCompanyPathControl. */
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

/** The object gateway's folder object route, for the runtime's HttpCloudCompanyFolderBytes: a put stores the object and
 * confirms it with the folder core under the run's upload intent, as the gateway does; a get answers the bytes. */
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
			const actor = {
				kind: "run",
				runId: binding.runId,
				jobId: binding.jobId,
				runnerId: binding.runnerId,
				assignmentId: binding.assignmentId,
			};
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

/** The run's control plane as the native provider service makes its calls (cloud-native-provider-service.ts). */
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

/** The scripted provider: the agent's turns by phase, and every compactor thread's request (§7.2). */
function provider(state) {
	const event = (response, value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
	const stream = (response, model, item) => {
		const base = { id: `resp_${randomBytes(8).toString("hex")}`, object: "response", model, created_at: 1 };
		response.writeHead(200, { "content-type": "text/event-stream" });
		event(response, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
		// An assistant message's text arrives as a delta, as a provider streams it: a compactor thread's reply is read
		// from it.
		const text = item.type === "message" ? item.content[0].text : undefined;
		const started = { ...item, status: "in_progress", ...(text === undefined ? {} : { content: [] }) };
		event(response, { type: "response.output_item.added", output_index: 0, item: started });
		if (text)
			event(response, { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text });
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
			let raw = "";
			for await (const chunk of request) raw += chunk.toString();
			const body = JSON.parse(raw);
			const input = JSON.stringify(body.input);
			if (/Compress this step into one line|Merge these two adjacent lines|That line is \d+ bytes/.test(input)) {
				state.compactor.push({ phase: state.phase, input });
				state.trace(`provider: compactor request (${state.phase})`);
				// The first attempt's compactor is refused, so its step's line stays missing and the resumed attempt builds it
				// from the log (§7.2: a refusal leaves the node missing for the rest of the run).
				stream(response, body.model, message(state.phase === "first" ? "" : SUMMARY));
				return;
			}
			const turn = state.agent.filter((entry) => entry.phase === state.phase).length;
			state.agent.push({ phase: state.phase, input, body });
			state.trace(`provider: agent request ${turn + 1} (${state.phase})`);
			if (state.phase === "first" && turn === 0)
				stream(response, body.model, {
					type: "function_call",
					id: "fc_read",
					call_id: "call_read_long",
					namespace: "qorpera",
					name: "company_read",
					arguments: JSON.stringify({ path: LONG_PATH, offset: 0, limit: 32768 }),
					status: "completed",
				});
			else stream(response, body.model, message(`${state.phase.toUpperCase()}_DONE`));
		})().catch((error) => {
			state.failure ??= error;
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
}

/** One attempt of the run, as the company runtime composes it: its folder, log and tools on the real session. */
async function attempt(code, context) {
	const { db, binding, objects, binary, port, root, nativeBinarySha256 } = context;
	const paths = new code.HttpCloudCompanyPathControl({
		supabaseUrl: "https://postgrest.stand-in.invalid/",
		serviceRoleKey: "stand-in",
		fetch: postgrestFetch(db),
	});
	const compactor = new code.MemoryCompactChannel();
	const lane = new code.MemoryCompactLane();
	let runWork;
	let opened = null;
	let folder;
	let admitted;
	const command = await code.nativeCodexFixtureCommand(root, [binary], port);
	const result = await code.runCloudNativeRunToolSession({
		binding,
		controlPlane: controlPlane(db),
		beginExecution: async (specification, signal) => {
			const identity = db.direct("qorpera_describe_native_tool_authority", { p_binding: binding }).identity;
			signal.throwIfAborted();
			await paths.call(
				"qorpera_begin_native_company_execution_v3",
				{
					p_binding: binding,
					p_binary_sha256: nativeBinarySha256,
					p_runtime_bundle_sha256: identity.runtimeBundleSha256,
					p_reasoning_policy_sha256: identity.reasoningPolicySha256,
					p_tool_catalog_text: code.cloudToolJsonText(specification, code.CLOUD_NATIVE_TOOL_CATALOG_BYTES),
				},
				signal,
			);
			// The run's opening binds its composed context once (M1b-4b-3); here the context is the prompt alone.
			await paths.call(
				"qorpera_bind_native_company_context",
				{ p_binding: binding, p_context_sha256: sha256(PROMPT), p_context_bytes: Buffer.byteLength(PROMPT) },
				signal,
			);
		},
		tools: async (identity, operations, run) => {
			admitted = identity;
			const bytes = new code.HttpCloudCompanyFolderBytes({
				baseUrl: "http://127.0.0.1:9/",
				token: "t".repeat(43),
				binding,
				holder: () => "stand-in-holder",
				identity,
				control: paths,
				fetch: gatewayFetch(db, objects),
			});
			folder = new code.CloudCompanyFolderClient({ binding, identity, control: paths, bytes });
			const gateway = new code.CloudCompanyPathGateway({ binding, identity, control: paths });
			opened = await code.openCloudRunLog({
				resume: new code.CloudRunResumeRpc({ run, control: paths }),
				folder: new code.CloudRunLogCompanyFolder({
					environmentId: identity.environmentId,
					runId: binding.runId,
					folder,
					control: paths,
				}),
				log: {
					runId: binding.runId,
					protection: new code.CloudRunLogRpcProtection({
						environmentId: identity.environmentId,
						jobId: binding.jobId,
						runId: binding.runId,
						call: (method, args, signal) => paths.call(method, args, signal),
					}),
					signal: run.signal,
				},
				lines: {
					call: async (system, signal) => {
						context.trace(`compactor thread asked (${context.phase})`);
						try {
							const thread = await compactor.call(system, signal);
							context.trace("compactor thread open");
							return thread;
						} catch (error) {
							context.trace(`compactor thread refused: ${error?.message ?? error}`);
							throw error;
						}
					},
					lane,
					observe: (stats) => context.trace(`step lines pass: ${JSON.stringify(stats)}`),
				},
			});
			assert(opened?.log, "the run keeps a log (Shared context: its recorded memory mode is tree)");
			runWork = opened.composeContext;
			return {
				tools: code.cloudFolderFileTools({ folder, operations, identity }),
				assertContext: (signal, timeoutMs) => gateway.assertReadableContext(signal, timeoutMs),
				checkRun: (signal, timeoutMs) => gateway.checkRun(signal, timeoutMs),
				recordContextView: (frame, outputs, signal) => gateway.recordContextView(frame, outputs, signal),
				fenceContextView: (frame, outputs, signal) => gateway.fenceContextView(frame, outputs, signal),
				runLog: { log: opened.log, lines: opened.lines },
			};
		},
		composeContext: async (request, signal) => {
			context.trace(`compose ${request.purpose} (${request.items.length} items)`);
			const composed = runWork ? await runWork(request, signal) : code.cloudNativeContextIdentity(request);
			context.trace(`composed ${request.purpose}`);
			return composed;
		},
		compactor,
		command: command.command,
		binarySha256: command.binarySha256,
		prompt: PROMPT,
		signal: AbortSignal.timeout(120_000),
		timeoutMs: 90_000,
	});
	return { result, opened, folder, paths, identity: admitted };
}

/** SQL test 924's helpers (`base_*`), for a session after the fixture's. */
function baseHelpers(fixture) {
	const start = fixture.indexOf("create function pg_temp.base_claims");
	const end = fixture.indexOf("-- END BASE HELPERS");
	assert(start > 0 && end > start, "SQL test 924's helpers moved: update this script");
	return fixture.slice(start, end);
}

async function main() {
	const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
	if (!binary) {
		process.stdout.write("NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins\n");
		return;
	}
	process.stdout.write(`Codex ${binary}: sha256 ${sha256(readFileSync(binary))}\n`);
	const database = await hostedDatabase(databaseName);
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-run-log-full-result-"));
	const started = Date.now();
	const traced = [];
	const trace = (what) => traced.push(`${String(Date.now() - started).padStart(6)} ms ${what}`);
	const state = { phase: "first", agent: [], compactor: [], failure: null, trace };
	const server = provider(state);
	const db = new Database((sql) => database.cluster.psql(databaseName, sql, ["-qAt"]));
	try {
		const code = await bundle(scratch);
		assert.equal(code.MAX_CLOUD_TOOL_RESULT_BYTES, 32 * 1024);
		assert.equal(code.MEMORY_RUN_STEP_RESULT_BYTES, code.MAX_CLOUD_TOOL_RESULT_BYTES);
		pass("one tool result is 32 KiB, and the run log's parser keeps that bound (one shared constant)");
		assert.equal(
			db.query(
				"select (strpos(pg_get_functiondef('public.qorpera_memory_run_step_line(text)'::regprocedure), '20260930733000') > 0)::text",
			),
			"true",
		);
		pass("the database carries 20260930733000 (a step's result up to 32 KiB)");

		// The company, its agents and Alice's run, claimed and leased through the real contracts (SQL test 924). The run is
		// recorded in Shared context (its memory mode tree), as a beta company's run is, so it keeps a work log; the
		// platform writes the long file.
		const fixture = readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8");
		const marker = "-- The checks start here: a test that runs after this file's fixture part stops at this line.";
		const end = fixture.indexOf(marker);
		assert(end > 0, "SQL test 924's fixture marker moved: update this script");
		const tag = `t${randomBytes(6).toString("hex")}`;
		const out = db.query(`${fixture.slice(0, end)}
			set local session_replication_role = replica;
			update public.qorpera_execution_runs set memory_mode = 'tree'
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
			set local session_replication_role = origin;
			select pg_temp.base_commit('{"kind":"platform"}', 'long-file', jsonb_build_array(
				jsonb_build_object('op', 'mkdir', 'path', 'notes'),
				jsonb_build_object('op', 'write', 'path', '${LONG_PATH}', 'file', pg_temp.base_stage($${tag}$${LONG_TEXT}$${tag}$))))
			\\g /dev/null
			select jsonb_build_object('binding', current_setting('qorpera_test.base_binding')::jsonb,
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id))::text;
			commit;`);
		const setup = JSON.parse(out.split("\n").at(-1));
		const first = setup.binding;
		// The long file's bytes, as the gateway holds what the platform staged (pg_temp.base_manifest's manifest).
		const objects = new Map();
		const text = Buffer.from(LONG_TEXT, "utf8");
		const manifest = Buffer.from(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v2",
				fileSha256: sha256(text),
				bytes: text.length,
				mediaType: "text/markdown",
				executable: false,
				chunks: [{ sha256: sha256(text), bytes: text.length }],
			}),
		);
		objects.set(sha256(text), text);
		objects.set(sha256(manifest), manifest);
		pass(`SQL test 924's run of Alice is leased (run ${first.runId.slice(0, 8)}), and ${LONG_PATH} holds ${text.length} bytes`);

		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = server.address().port;
		const context = {
			db,
			objects,
			binary,
			port,
			root: scratch,
			nativeBinarySha256: setup.nativeBinarySha256,
			trace,
			get phase() {
				return state.phase;
			},
		};

		// 1. The first attempt reads a full 32 KiB window of the long file.
		const one = await attempt(code, { ...context, binding: first });
		if (state.failure) throw state.failure;
		const firstTurns = state.agent.filter((entry) => entry.phase === "first");
		assert.equal(firstTurns.length, 2, "the first attempt makes two agent requests");
		const outputs = firstTurns[1].body.input.filter((item) => item.type === "function_call_output");
		assert.equal(outputs.length, 1);
		const envelope = String(outputs[0].output);
		const parsed = JSON.parse(envelope);
		const bytes = Buffer.byteLength(envelope);
		assert(bytes > code.MAX_CLOUD_TOOL_RESULT_BYTES - 1024 && bytes <= code.MAX_CLOUD_TOOL_RESULT_BYTES, `envelope ${bytes} B`);
		assert.equal(parsed.status, "ok");
		const shown = JSON.parse(parsed.content.text);
		assert(LONG_TEXT.startsWith(shown.text) && shown.text.length > 29_000 && shown.nextOffset === Buffer.byteLength(shown.text));
		const lastLine = shown.text.trimEnd().split("\n").at(-1);
		pass(
			`company_read's window reached the model whole through the patched Codex: a ${bytes}-byte envelope, ${shown.text.length} bytes of the file, nextOffset ${shown.nextOffset}`,
		);
		const views = JSON.parse(
			db.query(`select coalesce(jsonb_agg(v.view -> 'outputs'), '[]')::text from public.qorpera_native_context_views v
				where v.run_id = '${first.runId}'`),
		)
			.flat()
			.filter((output) => output.callId === "call_read_long");
		assert(views.length >= 1 && views.every((output) => output.bytes === bytes), JSON.stringify(views));
		pass(`the run's context view recorded that output at ${bytes} bytes (past the old 8,192)`);

		// 2. The step is in the run's log, through the folder's structured-file path.
		const steps = JSON.parse(
			db.query(`select coalesce(jsonb_agg(jsonb_build_object('j', s.j, 'tool', s.tool, 'finished', s.finished) order by s.j), '[]')::text
				from public.qorpera_memory_run_steps s where s.run_id = '${first.runId}'`),
		);
		assert.deepEqual(steps, [{ j: 0, tool: "company_read", finished: true }]);
		const place = new code.CloudRunLogCompanyFolder({
			environmentId: one.identity.environmentId,
			runId: first.runId,
			folder: one.folder,
			control: one.paths,
		});
		const located = await place.locate(first.runId, AbortSignal.timeout(30_000));
		assert(located.exists && located.last === 0, JSON.stringify(located));
		const block = await place.read(`${located.path}/log/00000000.jsonl`, AbortSignal.timeout(30_000));
		assert(block, "the log's first block");
		assert(block.text.includes(`"result":${envelope},`), "the block keeps the envelope as the fence issued it, byte for byte");
		pass(
			`the log's block ${located.path.split("/").slice(-3).join("/")}/log/00000000.jsonl (${Buffer.byteLength(block.text)} B) keeps step 0 with the whole ${bytes}-byte envelope: staged with the shared parser's parse, accepted by qorpera_folder_memory_commit, read back through the parser`,
		);
		assert(state.compactor.some((entry) => entry.phase === "first"), "the first attempt's step lines asked for step 0's line");
		pass("the first attempt's compactor was refused, so step 0's line is missing and the next attempt builds it from the log");

		// 3. The attempt is cut off (its runner's lease runs out and the orchestrator's reconcile ends it), and the next
		//    attempt is claimed, provisioned, assigned and leased on the same login (SQL test 991's path).
		const cut = db.query(`begin;
			${baseHelpers(fixture)}
			select pg_temp.base_claims('service_role');
			update public.qorpera_runner_jobs set lease_expires_at = statement_timestamp() - interval '1 second' where id = '${first.jobId}';
			select public.qorpera_reconcile_runner_orchestrator('${ORCHESTRATOR}') \\g /dev/null
			select jsonb_build_object('cutOff', (select count(*) from public.qorpera_execution_run_events
				where run_id = '${first.runId}' and event_type = 'run_cut_off'), 'next', pg_temp.base_start('${first.runId}'))::text;
			commit;`);
		const cutOff = JSON.parse(cut.split("\n").at(-1));
		assert.equal(cutOff.cutOff, 1, "one run_cut_off event: the run resumes from its log");
		const next = cutOff.next;
		assert.equal(next.runId, first.runId);
		assert.notEqual(next.assignmentId, first.assignmentId);
		pass("the first attempt was cut off with its log, and the next attempt is leased");

		// 4. The next attempt resumes from the log.
		state.phase = "resumed";
		const two = await attempt(code, { ...context, binding: next });
		if (state.failure) throw state.failure;
		const earlier = await two.opened.log.earlier(AbortSignal.timeout(30_000));
		assert.equal(earlier.length, 1);
		assert.equal(earlier[0].tool, "company_read");
		assert.deepEqual(JSON.parse(earlier[0].result), parsed, "the resumed attempt read the whole envelope from the log");
		pass(`the resumed attempt read step 0 from the log with its whole result (${Buffer.byteLength(earlier[0].result)} B as it re-serializes)`);
		const resumes = JSON.parse(
			db.query(`select coalesce(jsonb_agg(jsonb_build_object('stepsRead', r.steps_read)), '[]')::text
				from public.qorpera_memory_run_resumes r where r.run_id = '${first.runId}'`),
		);
		assert.deepEqual(resumes, [{ stepsRead: 1 }], JSON.stringify(resumes));
		pass("qorpera_memory_run_resume_record recorded the resume: 1 step read, no unknown outcome");
		const compacted = state.compactor.filter((entry) => entry.phase === "resumed");
		assert(compacted.length >= 1, "the resumed attempt built step 0's line");
		assert(
			compacted.some((entry) => entry.input.includes(lastLine) && entry.input.includes("company_read(")),
			"the compactor saw the whole step, to the window's last line",
		);
		pass(`what the model got to summarize step 0 after the resume holds the whole window, to its last line ("${lastLine}")`);
		const resumedTurns = state.agent.filter((entry) => entry.phase === "resumed");
		assert(resumedTurns.length >= 1, "the resumed attempt made an agent request");
		const work = resumedTurns[0].input;
		assert(work.includes("qorpera.run-work/v1"), "the resumed attempt's first request carries the run's work message");
		const shownWork = resumedTurns[0].body.input.find((item) => JSON.stringify(item).includes("qorpera.run-work/v1"));
		process.stdout.write(`the resumed attempt's work message item: ${JSON.stringify(shownWork).slice(0, 1500)}\n`);
		assert(work.includes(`0+1|${SUMMARY}`), "the work message holds step 0's line");
		assert(!work.includes(lastLine), "the agent's request holds the step's line, not the raw window again");
		pass(`the resumed attempt's first model request carries the work message with step 0's line ("0+1|${SUMMARY.slice(0, 40)}…")`);
		process.stdout.write(
			`Database calls: ${db.calls.length}; provider requests: ${state.agent.length} agent, ${state.compactor.length} compactor\n`,
		);
	} catch (error) {
		// What the run met on its way, for the failure's reader: refused database calls, the provider's requests, and
		// the native process's own diagnostics.
		for (const refusal of db.refusals) process.stdout.write(`refused ${refusal.slice(0, 400)}\n`);
		for (const line of traced) process.stdout.write(`trace ${line}\n`);
		process.stdout.write(`provider requests: ${state.agent.length} agent, ${state.compactor.length} compactor\n`);
		const diagnostics = await readFile(join(scratch, "native-diagnostics.log"), "utf8").catch(() => "");
		if (diagnostics) process.stdout.write(`native diagnostics (last 4000 characters):\n${diagnostics.slice(-4000)}\n`);
		if (error?.cause) process.stdout.write(`cause: ${error.cause?.stack ?? error.cause}\n`);
		process.stdout.write(`failure fields: ${JSON.stringify({ ...error })}\n`);
		throw error;
	} finally {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(() => resolve()));
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
