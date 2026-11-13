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

// One company run through the real patched Codex, for the end-to-end proofs of what a folder tool gives the model
// (keyholes S2 and S3, after #1530's scripts/prove-run-log-full-result.mjs, whose harness this is): a migrated database,
// SQL test 924's company and Alice's run, claimed, assigned and leased through the real orchestrator and native lease
// contracts, its memory mode tree (Shared context, as a beta company's run is), so it keeps a work log; then the runtime's
// own run session (runCloudNativeRunToolSession), boundary, result fence, the folder file tools, folder client and bytes
// client, run log, its folder adapter and protection, and the patched Codex app-server, with a scripted model that makes
// the calls a proof names, one a response, each from the answers before it.
//
// Stand-ins, as in #1530's proof: PostgREST (a function call is one psql call as the service role, its arguments typed as
// the function declares them), the object gateway's folder object route (bytes kept in memory; each object confirmed with
// the folder core as the gateway does; a get holds one of its two NAS lanes for a moment, and finds them busy, or its
// object in flight, as it does), and the model provider (a scripted loopback Responses server; no model is
// called). Not covered: the native provider service process, isolation, auto-review, the company runtime's prompt
// composition, a real node, a real model.

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ENVIRONMENT = "92400000-0000-4000-8000-000000000020";
export const OWNER = '{"kind":"member","userId":"92400000-0000-4000-8000-000000000001"}';

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const pass = (what) => process.stdout.write(`PASS ${what}\n`);

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
				'export {CloudCompanyFolderClient} from "./packages/runtime/src/cloud-company-folder-client.ts";',
				'export {HttpCloudCompanyFolderBytes} from "./packages/runtime/src/cloud-company-folder-bytes.ts";',
				'export {cloudFolderFileTools} from "./packages/runtime/src/cloud-folder-file-tools.ts";',
				'export {cloudInterfaceTools} from "./packages/runtime/src/cloud-folder-interface-tools.ts";',
				'export {cloudMachineTools} from "./packages/runtime/src/cloud-machine-tools.ts";',
				'export {CloudRunLogCompanyFolder} from "./packages/runtime/src/cloud-run-log-folder.ts";',
				'export {openHomeFolderWindow, homeCallHead} from "./packages/runtime/src/cloud-home-folder-window.ts";',
				'export {openCloudRunLog} from "./packages/runtime/src/cloud-run-log-open.ts";',
				'export {CloudRunResumeRpc} from "./packages/runtime/src/cloud-run-resume.ts";',
				'export {CloudRunLogRpcProtection} from "./packages/runtime/src/cloud-run-log-protection.ts";',
				'export {MemoryCompactChannel, MemoryCompactLane} from "./packages/runtime/src/memory-tree/compact.ts";',
				'export {cloudNativeContextIdentity} from "./packages/runtime/src/cloud-native-context-composition.ts";',
				'export {CLOUD_NATIVE_TOOL_CATALOG_BYTES, MAX_CLOUD_TOOL_RESULT_BYTES, cloudToolJsonText, redactCloudWebhookSecrets} from "./packages/runtime/src/cloud-native-tool-boundary.ts";',
				'export {COMPANY_STATE_PARSER_VERSION, companyStatePath, parseCompanyStateFile} from "./packages/cloud-client/src/company-state-files.ts";',
				'export {MEMORY_RUN_STEP_FIELD_BYTES, MEMORY_RUN_STEP_READS_BYTES, MEMORY_RUN_STEP_RESULT_BYTES, parseMemoryRunFile} from "./packages/cloud-client/src/memory-run-files.ts";',
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
	/** Called with each function call's name and arguments before it runs (a proof's change while the run goes on). */
	before;

	constructor(run) {
		this.#run = run;
	}

	query(sql) {
		return this.#run(sql).trim();
	}

	/** One JSON value a query selects as text (its last line). */
	json(sql) {
		return JSON.parse(this.query(sql).split("\n").at(-1));
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
		this.before?.(method, args);
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
 * confirms it with the folder core under the run's upload intent, as the gateway does; a get answers the bytes. A get
 * takes one of the gateway's two NAS lanes for `lane.ms` (object-store.ts: at most two operations in flight, and one
 * on any one object); with both busy, or its object already in flight, it answers 503, as the gateway does for an
 * object with no Storage copy yet (one just written). `lane` counts the gets, the most in flight at once, and those
 * answered busy. */
function gatewayFetch(db, objects, lane) {
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
		lane.gets++;
		if (lane.inFlight >= 2 || lane.objects.has(hash)) {
			lane.busy++;
			return new Response("{}", { status: 503 });
		}
		lane.most = Math.max(lane.most, ++lane.inFlight);
		lane.objects.add(hash);
		try {
			await new Promise((done) => setTimeout(done, lane.ms));
			const bytes = objects.get(hash);
			return bytes ? new Response(bytes, { status: 200 }) : new Response("{}", { status: 404 });
		} finally {
			lane.inFlight--;
			lane.objects.delete(hash);
		}
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

/** The scripted provider. Agent request n (from 0) is answered with `calls[n]`, a function of the outputs the model
 * has had so far (each `{callId, output}`, in order), which returns the call's `{name, arguments}` (and its call `id`,
 * if it names one); past the last, a final message. Every compactor thread's request (§7.2) is answered with one short
 * line. */
function provider(state, calls) {
	const event = (response, value) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
	const stream = (response, model, item) => {
		const base = { id: `resp_${randomBytes(8).toString("hex")}`, object: "response", model, created_at: 1 };
		response.writeHead(200, { "content-type": "text/event-stream" });
		event(response, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
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
				state.compactor.push(input);
				stream(response, body.model, message("Listed and read company files."));
				return;
			}
			const turn = state.agent.length;
			state.agent.push({ input, body });
			state.trace(`provider: agent request ${turn + 1}`);
			const outputs = body.input
				.filter((item) => item.type === "function_call_output")
				.map((item) => ({ callId: item.call_id, output: String(item.output) }));
			const call = turn < calls.length ? calls[turn](outputs) : null;
			if (!call) {
				stream(response, body.model, message("DONE"));
				return;
			}
			const callId = call.id ?? `call_${String(turn).padStart(2, "0")}_${call.name}`;
			state.calls.push({ callId, ...call });
			stream(response, body.model, {
				type: "function_call",
				id: `fc_${turn}`,
				call_id: callId,
				namespace: "qorpera",
				name: call.name,
				arguments: JSON.stringify(call.arguments),
				status: "completed",
			});
		})().catch((error) => {
			state.failure ??= error;
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
}

/** The run's one attempt, as the company runtime composes it: its folder, log and tools on the real session. */
async function attempt(code, context) {
	const { db, binding, objects, binary, port, root, nativeBinarySha256, prompt, interfaceTools, moreTools } = context;
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
				{ p_binding: binding, p_context_sha256: sha256(prompt), p_context_bytes: Buffer.byteLength(prompt) },
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
				fetch: gatewayFetch(db, objects, context.lane),
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
				lines: { call: (system, signal) => compactor.call(system, signal), lane },
			});
			assert(opened?.log, "the run keeps a log (Shared context: its recorded memory mode is tree)");
			runWork = opened.composeContext;
			return {
				tools: [
					...code.cloudFolderFileTools({ folder, operations, identity }),
					...(interfaceTools ? code.cloudInterfaceTools({ folder, identity, timeZone: "UTC" }) : []),
					...(moreTools ? moreTools(code, { db, binding, identity, operations, paths }) : []),
				],
				assertContext: (signal, timeoutMs) => gateway.assertReadableContext(signal, timeoutMs),
				checkRun: (signal, timeoutMs) => gateway.checkRun(signal, timeoutMs),
				recordContextView: (frame, outputs, signal) => gateway.recordContextView(frame, outputs, signal),
				fenceContextView: (frame, outputs, signal) => gateway.fenceContextView(frame, outputs, signal),
				runLog: { log: opened.log, lines: opened.lines },
			};
		},
		composeContext: async (request, signal) =>
			runWork ? await runWork(request, signal) : code.cloudNativeContextIdentity(request),
		compactor,
		command: command.command,
		binarySha256: command.binarySha256,
		prompt,
		signal: AbortSignal.timeout(240_000),
		timeoutMs: 200_000,
	});
	return { result, opened, folder, paths, identity: admitted };
}

/** The folder objects of texts the platform staged with SQL test 924's `base_stage`: each text's chunk and its version-2
 * manifest, byte for byte as `pg_temp.base_manifest` writes it, so the gateway stand-in answers the reads of them. */
export function textObjects(texts) {
	const objects = new Map();
	for (const text of texts) {
		const bytes = Buffer.from(text, "utf8");
		assert(bytes.length > 0, "a staged text is not empty");
		const manifest = Buffer.from(
			`{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha256(bytes)}","bytes":${bytes.length},"mediaType":"text/markdown","executable":false,"chunks":[{"sha256":"${sha256(bytes)}","bytes":${bytes.length}}]}`,
		);
		objects.set(sha256(bytes), bytes);
		objects.set(sha256(manifest), manifest);
	}
	return objects;
}

/** A SQL string literal of any text, dollar-quoted under a tag the text cannot hold. */
export function sqlText(text) {
	const tag = `t${randomBytes(6).toString("hex")}`;
	assert(!text.includes(`$${tag}$`));
	return `$${tag}$${text}$${tag}$`;
}

/** The answer an output envelope carries, with the envelope's own bytes and fields. */
export function answerOf(output) {
	const envelope = JSON.parse(output);
	return { envelope, bytes: Buffer.byteLength(output), text: envelope.content.text };
}

/** Runs one proof: the company of SQL test 924 with `setup` (SQL run in the fixture's transaction after its part, as
 * the platform; `pg_temp.base_*` helpers are there; or a function of the bundled code that gives it) and the objects of
 * its texts, Alice's run in Shared context through the real patched Codex making `calls` with the folder file tools
 * (and the interface tools, `interfaceTools`, and the tools `moreTools(code, {db, binding, identity, operations, paths})`
 * gives), then `check(run)` on what was stored. `beforeRpc(method, args, db)`, if given, is called before each function
 * call of the run's (a change the proof makes while the run goes on, with `platformChange`). Without the binary it
 * prints NOT RUN. */
export async function proveCompanyRun({
	name,
	prompt,
	setup,
	objects,
	calls,
	check,
	interfaceTools = false,
	moreTools,
	beforeRpc,
}) {
	const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
	if (!binary) {
		process.stdout.write("NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins\n");
		return;
	}
	process.stdout.write(`Codex ${binary}: sha256 ${sha256(readFileSync(binary))}\n`);
	const database = await hostedDatabase(name);
	const scratch = await mkdtemp(join(tmpdir(), `${name}-`));
	const started = Date.now();
	const traced = [];
	const trace = (what) => traced.push(`${String(Date.now() - started).padStart(6)} ms ${what}`);
	const state = { agent: [], calls: [], compactor: [], failure: null, trace, lane: { ms: 15, gets: 0, inFlight: 0, most: 0, busy: 0, objects: new Set() } };
	const server = provider(state, calls);
	const db = new Database((sql) => database.cluster.psql(name, sql, ["-qAt"]));
	try {
		const code = await bundle(scratch);
		assert.equal(code.MAX_CLOUD_TOOL_RESULT_BYTES, 32 * 1024);
		assert.equal(code.MEMORY_RUN_STEP_RESULT_BYTES, code.MAX_CLOUD_TOOL_RESULT_BYTES);
		pass("one tool result is 32 KiB, and the run log's parser keeps that bound (one shared constant)");
		// The company, its agents and Alice's run, claimed and leased through the real contracts (SQL test 924), recorded
		// in Shared context (its memory mode tree), so it keeps a work log; then the proof's own setup.
		const fixture = readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8");
		const marker = "-- The checks start here: a test that runs after this file's fixture part stops at this line.";
		const end = fixture.indexOf(marker);
		assert(end > 0, "SQL test 924's fixture marker moved: update this script");
		const madeAt = Date.now();
		const made = db.json(`${fixture.slice(0, end)}
			set local session_replication_role = replica;
			update public.qorpera_execution_runs set memory_mode = 'tree'
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
			set local session_replication_role = origin;
			select pg_temp.base_claims('service_role') \\g /dev/null
			${typeof setup === "function" ? setup(code) : setup}
			select jsonb_build_object('binding', current_setting('qorpera_test.base_binding')::jsonb,
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id))::text;
			commit;`);
		const binding = made.binding;
		process.stdout.write(`The company was made in ${Date.now() - madeAt} ms; Alice's run ${binding.runId.slice(0, 8)} is leased\n`);
		await new Promise((done, failed) => {
			server.once("error", failed);
			server.listen(0, "127.0.0.1", done);
		});
		if (beforeRpc) db.before = (method, args) => beforeRpc(method, args, db);
		const run = await attempt(code, {
			db,
			binding,
			objects,
			binary,
			port: server.address().port,
			root: scratch,
			nativeBinarySha256: made.nativeBinarySha256,
			prompt,
			lane: state.lane,
			interfaceTools,
			moreTools,
		});
		db.before = undefined;
		if (state.failure) throw state.failure;
		assert.equal(state.agent.length, calls.length + 1, "the model made every call, then answered");
		// What the model got for each call, from the request right after it, as the provider received it. (A Shared
		// context run's later requests carry its earlier steps as the work message's lines, not as raw outputs.)
		const outputs = state.calls.map((call, turn) => {
			const found = state.agent[turn + 1].body.input.find(
				(item) => item.type === "function_call_output" && item.call_id === call.callId,
			);
			assert(found, `the model got an output for ${call.callId} in the request after it`);
			return { ...call, output: String(found.output), ...answerOf(String(found.output)) };
		});
		await check({ code, db, binding, run, outputs, state, log: await runLog(code, db, run, binding.runId) });
		process.stdout.write(
			`Database calls: ${db.calls.length}; provider requests: ${state.agent.length} agent, ${state.compactor.length} compactor\n`,
		);
	} catch (error) {
		for (const refusal of db.refusals) process.stdout.write(`refused ${refusal.slice(0, 400)}\n`);
		for (const line of traced) process.stdout.write(`trace ${line}\n`);
		process.stdout.write(`provider requests: ${state.agent.length} agent, ${state.compactor.length} compactor\n`);
		const diagnostics = await readFile(join(scratch, "native-diagnostics.log"), "utf8").catch(() => "");
		if (diagnostics) process.stdout.write(`native diagnostics (last 4000 characters):\n${diagnostics.slice(-4000)}\n`);
		if (error?.cause) process.stdout.write(`cause: ${error.cause?.stack ?? error.cause}\n`);
		throw error;
	} finally {
		server.closeAllConnections?.();
		await new Promise((done) => server.close(() => done()));
		await rm(scratch, { recursive: true, force: true });
		database.close();
	}
}

/** The run's log as stored: every step's index row, and every block read back through the folder's own read (the shared
 * parser on its bytes, memory-run-files.ts), its lines parsed. */
async function runLog(code, db, run, runId) {
	const index = db.json(`select coalesce(jsonb_agg(jsonb_build_object('j', s.j, 'tool', s.tool, 'call', s.call_id,
			'finished', s.finished, 'narrow', s.narrow, 'releases', s.releases) order by s.j), '[]')::text
		from public.qorpera_memory_run_steps s where s.run_id = '${runId}'`);
	const place = new code.CloudRunLogCompanyFolder({
		environmentId: run.identity.environmentId,
		runId,
		folder: run.folder,
		control: run.paths,
	});
	const located = await place.locate(runId, AbortSignal.timeout(30_000));
	assert(located.exists, "the run's log exists");
	const blocks = [];
	let first = 0;
	while (first < index.length) {
		const path = `${located.path}/log/${String(first).padStart(8, "0")}.jsonl`;
		const block = await place.read(path, AbortSignal.timeout(30_000));
		assert(block, `the log's block ${path}`);
		// The run log's folder adapter ran the shared parser on these bytes as it read them (a block that does not parse is
		// folder_response_invalid); run it here too, for the record.
		const parsed = code.parseMemoryRunFile("memory-steps", path, block.text);
		assert(parsed.ok, `${path} parses: ${JSON.stringify(parsed)}`);
		const lines = block.text
			.split("\n")
			.filter(Boolean)
			.map((line) => ({ line, value: JSON.parse(line) }));
		assert(lines.length > 0 && lines[0].value.j === first, `${path} starts at step ${first}`);
		blocks.push({ path, text: block.text, lines });
		first += lines.length;
	}
	const steps = blocks.flatMap((block) => block.lines.map((line) => ({ ...line, block: block.path })));
	return { index, blocks, steps, path: located.path };
}

/** Ends a proof's process: exit 0 when it passed (or did not run), else one FAIL line and exit 1. */
export function finish(proof) {
	return proof.then(
		() => process.exit(0),
		(error) => {
			process.stdout.write(`FAIL ${error?.stack ?? error}\n`);
			process.exit(1);
		},
	);
}

/** One commit of the platform's, through SQL test 924's `base_commit`: units `{op: "mkdir", path}`,
 * `{op: "write", path, text}` (each text staged with `base_stage`) or `{op: "move", from, to}` (a file, at the version it
 * has), in order. */
export function platformCommit(key, units) {
	assert(/^[a-z0-9-]{8,64}$/.test(key) && units.length >= 1 && units.length <= 1000);
	return `select pg_temp.base_commit('{"kind":"platform"}', '${key}', (select jsonb_agg(case when u ->> 'op' = 'mkdir' then u
		when u ->> 'op' = 'move' then jsonb_build_object('op', 'move', 'from', u ->> 'from', 'to', u ->> 'to',
			'expectedVersion', pg_temp.base_version(u ->> 'from'))
		else jsonb_build_object('op', 'write', 'path', u ->> 'path', 'file', pg_temp.base_stage(u ->> 'text')) end order by n)
		from jsonb_array_elements(${sqlText(JSON.stringify(units))}::jsonb) with ordinality t(u, n))) \\g /dev/null`;
}

/** A commit of the platform's while the run goes on, in a database session of its own (SQL test 924's helpers made
 * there again): units as `platformCommit` takes them. Returns the folder's clock after it. */
export function platformChange(db, key, units) {
	const fixture = readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8");
	const start = fixture.indexOf("create function pg_temp.base_claims");
	const end = fixture.indexOf("-- END BASE HELPERS");
	assert(start > 0 && end > start, "SQL test 924's helpers moved: update this script");
	const out = db.query(`begin;
		${fixture.slice(start, end)}
		select pg_temp.base_claims('service_role') \\g /dev/null
		${platformCommit(key, units)}
		select last_seq::text from public.qorpera_folder_clocks where environment_id = '${ENVIRONMENT}';
		commit;`);
	return Number(out.split("\n").at(-1));
}
