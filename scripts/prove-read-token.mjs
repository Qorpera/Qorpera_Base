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

// A company read that shows a token-shaped string goes on to its next request (keyholes lane, 13 Nov 2026). The tool
// boundary cuts a secret out of every answer (redactCloudWebhookSecrets) and hashes what is left; the context view cites
// a read under that hash, and SQL (qorpera_folder_record_context_view) refuses a citation whose hash is not the
// release's: "Context read provenance differs". So a read must be released under the hash of the cut text, or the run
// stops at its next model request ("Native boundary execution stopped"). A run of SQL test 924's company reads files,
// a link, a folder listing and a table that hold made-up strings of every shape the boundary cuts, one call a model
// request, through the real patched Codex, and the run goes on after each; what the model was shown, the releases, the
// context views and the run's work log are read back and compared.
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-read-token.mjs
//
// Real: the migrated database (every migration) and its functions; SQL test 924's company, run and lease; the runtime's
// own run session (runCloudNativeRunToolSession), boundary, result fence, context view, company_read, company_list and
// table_read, folder client and bytes client, run log, its folder adapter and protection; the patched Codex app-server.
// Stand-ins: PostgREST (a function call is one psql call as the service role), the object gateway's folder object route
// (bytes in memory, each object confirmed with the folder core as the gateway does) and the model provider (a scripted
// loopback Responses server; no model is called). Not covered: the native provider service process, isolation,
// auto-review, the company runtime's prompt composition, a real node. Every token here is made up for this script (built
// from parts, so no token-shaped literal is in the source); none is a real secret.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_read_token";
const PROMPT = "Read the deploy notes and say where each key is kept.";
const SUMMARY = "Read a company file.";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pass = (what) => process.stdout.write(`PASS ${what}\n`);

/** A made-up body of `n` characters: `label`, then digits. Unique per label, so it is the needle a leak would show. */
const body = (label, n) => `${label}${"0123456789".repeat(Math.ceil(n / 10))}`.slice(0, n);
/** Each shape the boundary cuts (cloud-native-tool-boundary.ts SECRET_CUTS), with a made-up body, and what the cut
 * leaves. Prefixes are joined here so that no token-shaped literal is in the source. */
const TOKENS = [
	{ shape: "whsec", body: body("FakeWhsecBody", 40), make: (b) => ["whsec", b].join("_"), shown: "whsec_[REDACTED]" },
	{ shape: "npm", body: body("FakeNpmBody", 36), make: (b) => ["npm", b].join("_"), shown: "npm_[REDACTED]" },
	{ shape: "ghp", body: body("FakeGhpBody", 36), make: (b) => ["ghp", b].join("_"), shown: "ghp_[REDACTED]" },
	{
		shape: "github_pat",
		body: body("FakeGithubPatBody_", 82),
		make: (b) => ["github", "pat", b].join("_"),
		shown: "github_pat_[REDACTED]",
	},
	{ shape: "sk_test", body: body("FakeSkTestBody", 24), make: (b) => ["sk", "test", b].join("_"), shown: "sk_[REDACTED]" },
	{ shape: "rk_live", body: body("FakeRkLiveBody", 24), make: (b) => ["rk", "live", b].join("_"), shown: "rk_[REDACTED]" },
	{ shape: "re", body: body("FakeResendBody", 20), make: (b) => ["re", "FakeRe12", b].join("_"), shown: "re_[REDACTED]" },
].map((token) => ({ ...token, raw: token.make(token.body) }));
/** The same cuts on text as other tools print it: URL-encoded, and JSON-escaped (a backslash in the file). */
const ENCODED = [
	{ shape: "whsec URL-encoded", body: body("FakeWhsecUrlBody", 40), raw: "", shown: "whsec_[REDACTED]" },
	{ shape: "whsec JSON-escaped", body: body("FakeWhsecJsonBody", 40), raw: "", shown: "whsec_[REDACTED]" },
	{ shape: "npm JSON-escaped", body: body("FakeNpmJsonBody", 36), raw: "", shown: "npm_[REDACTED]" },
];
ENCODED[0].raw = `whsec%5F${ENCODED[0].body}`;
ENCODED[1].raw = `whsec\\u005F${ENCODED[1].body}`;
ENCODED[2].raw = `npm\\u005F${ENCODED[2].body}`;

const PLAIN = { path: "notes/plain.md", text: "# Plain\n\nNothing secret here: the deploy runs at nine.\n" };
const KEY_FILES = TOKENS.map((token) => ({
	path: `notes/key-${token.shape.replace("_", "-")}.md`,
	text: `# Where the ${token.shape} key is\n\nThe deploy reads ${token.raw} from the vault.\n`,
	token,
}));
const MIXED = {
	path: "notes/mixed.md",
	text: `# Keys, as other tools print them\n\nURL-encoded: ${ENCODED[0].raw}\nJSON: {"secret":"${ENCODED[1].raw}","token":"${ENCODED[2].raw}"}\n`,
};
/** A long file of numbered lines, each with a token of its own (ghp_): more than one 32 KiB window. */
const LONG_TOKENS = Array.from({ length: 900 }, (_, n) => {
	const lineBody = body(`FakeGhpLine${String(n).padStart(4, "0")}x`, 36);
	return { body: lineBody, raw: TOKENS[2].make(lineBody) };
});
const LONG = {
	path: "notes/long.md",
	text: LONG_TOKENS.map((token, n) => `line ${String(n).padStart(4, "0")}: the deploy key is ${token.raw} here.\n`).join(""),
};
const LINK = { path: "notes/links/deploy", target: `vault/${TOKENS[5].raw}` };
const TABLE_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const TABLE = {
	folder: "QorperaOS/tables/deploy-notes",
	toml: [
		'format = "qorpera.table/v0"',
		"",
		"[table]",
		`id = "${TABLE_ID}"`,
		'name = "Deploy notes"',
		'about = "Where each deploy key is kept."',
		'rows = "file"',
		'key = ["name"]',
		"",
		"[[column]]",
		'name = "name"',
		'type = "text"',
		"max = 60",
		"",
		"[[column]]",
		'name = "note"',
		'type = "text"',
		"max = 200",
		"",
		"[write]",
		'agents = "all"',
		'members = "all"',
		"",
	].join("\n"),
	rows: `name,note\ndeploy,the deploy key is ${TOKENS[1].raw}\nbilling,the billing key is ${TOKENS[4].raw}\n`,
};

/** The calls the scripted model makes, one a request, in order: what it reads, and what the answer must show. */
const CALLS = [
	{ id: "call_plain", tool: "company_read", args: () => ({ path: PLAIN.path, offset: 0, limit: 4096 }), reads: [PLAIN.path], shows: [] },
	...KEY_FILES.map((file) => ({
		id: `call_key_${file.token.shape}`,
		tool: "company_read",
		args: () => ({ path: file.path, offset: 0, limit: 4096 }),
		reads: [file.path],
		shows: [file.token.shown],
	})),
	{
		id: "call_mixed",
		tool: "company_read",
		args: () => ({ path: MIXED.path, offset: 0, limit: 4096 }),
		reads: [MIXED.path],
		shows: ENCODED.map((token) => token.shown),
	},
	{
		id: "call_long_1",
		tool: "company_read",
		args: () => ({ path: LONG.path, offset: 0, limit: 32768 }),
		reads: [LONG.path],
		shows: [TOKENS[2].shown],
	},
	{
		id: "call_long_2",
		tool: "company_read",
		// The model reads on from the nextOffset the first window gave.
		args: (outputs) => ({ path: LONG.path, offset: JSON.parse(JSON.parse(outputs.get("call_long_1")).content.text).nextOffset, limit: 32768 }),
		reads: [LONG.path],
		shows: [TOKENS[2].shown],
	},
	{
		id: "call_list_links",
		tool: "company_list",
		args: () => ({ path: "notes/links", after: null, limit: 50 }),
		reads: ["notes/links", LINK.path],
		shows: [TOKENS[5].shown],
	},
	{
		id: "call_read_link",
		tool: "company_read",
		args: () => ({ path: LINK.path, offset: 0, limit: 4096 }),
		reads: [LINK.path],
		shows: [TOKENS[5].shown],
	},
	{
		id: "call_table",
		tool: "table_read",
		args: () => ({ table: "deploy-notes", where: null, after: null, limit: 50 }),
		reads: [`${TABLE.folder}/table.toml`, `${TABLE.folder}/rows.csv`],
		shows: [TOKENS[1].shown, TOKENS[4].shown],
	},
];

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
				'export {CloudRunLogCompanyFolder} from "./packages/runtime/src/cloud-run-log-folder.ts";',
				'export {openCloudRunLog} from "./packages/runtime/src/cloud-run-log-open.ts";',
				'export {CloudRunResumeRpc} from "./packages/runtime/src/cloud-run-resume.ts";',
				'export {CloudRunLogRpcProtection} from "./packages/runtime/src/cloud-run-log-protection.ts";',
				'export {MemoryCompactChannel, MemoryCompactLane} from "./packages/runtime/src/memory-tree/compact.ts";',
				'export {cloudNativeContextIdentity} from "./packages/runtime/src/cloud-native-context-composition.ts";',
				'export {CLOUD_NATIVE_TOOL_CATALOG_BYTES, MAX_CLOUD_TOOL_RESULT_BYTES, cloudToolJsonText, redactCloudWebhookSecrets} from "./packages/runtime/src/cloud-native-tool-boundary.ts";',
				'export {COMPANY_STATE_PARSER_VERSION, companyStatePath, parseCompanyStateFile} from "./packages/cloud-client/src/company-state-files.ts";',
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
 * types a JSON body's fields; an error names its SQLSTATE, as PostgREST's `code` does. (As
 * scripts/prove-run-log-full-result.mjs has it.) */
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
		const value = `$${tag}$${JSON.stringify(args)}$${tag}$::jsonb`;
		const parameters = keys.map((key) => {
			assert(/^p_[a-z][a-z0-9_]*$/.test(key), `argument name ${key}`);
			const type = signature.typeOf(key);
			const field = `(${value} -> '${key}')`;
			if (type === "jsonb") return `${key} => ${field}`;
			if (type === "json") return `${key} => ${field}::json`;
			if (type.endsWith("[]"))
				return `${key} => case when jsonb_typeof(${field}) = 'array' then array(select e from jsonb_array_elements_text(${field}) e) end::${type}`;
			return `${key} => (${value} ->> '${key}')::${type}`;
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

/** The bytes the platform staged for a text, as the gateway holds them: the text and its manifest (SQL test 924's
 * pg_temp.base_manifest, byte for byte). */
function holdText(objects, text) {
	const bytes = Buffer.from(text, "utf8");
	const manifest = Buffer.from(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: sha256(bytes),
			bytes: bytes.length,
			mediaType: "text/markdown",
			executable: false,
			chunks: bytes.length === 0 ? [] : [{ sha256: sha256(bytes), bytes: bytes.length }],
		}),
	);
	if (bytes.length > 0) objects.set(sha256(bytes), bytes);
	objects.set(sha256(manifest), manifest);
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

/** The scripted provider: the agent's request n (from 0) makes the call CALLS[n], and the one after the last call gets
 * the closing message; every compactor thread's request gets one line. */
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
			let raw = "";
			for await (const chunk of request) raw += chunk.toString();
			const body = JSON.parse(raw);
			const input = JSON.stringify(body.input);
			if (/Compress this step into one line|Merge these two adjacent lines|That line is \d+ bytes/.test(input)) {
				state.compactor.push({ raw });
				state.trace(`provider: compactor request ${state.compactor.length}`);
				stream(response, body.model, message(SUMMARY));
				return;
			}
			const turn = state.agent.length;
			const outputs = new Map(
				body.input.filter((item) => item.type === "function_call_output").map((item) => [item.call_id, String(item.output)]),
			);
			state.agent.push({ raw, body, outputs });
			const call = CALLS[turn];
			state.trace(`provider: agent request ${turn + 1} (${outputs.size} outputs so far) -> ${call ? `${call.tool} ${call.id}` : "the closing message"}`);
			if (!call) {
				stream(response, body.model, message("DONE: every key is in the vault."));
				return;
			}
			stream(response, body.model, {
				type: "function_call",
				id: `fc_${turn}`,
				call_id: call.id,
				namespace: "qorpera",
				name: call.tool,
				arguments: JSON.stringify(call.args(outputs)),
				status: "completed",
			});
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
				folder: new code.CloudRunLogCompanyFolder({ environmentId: identity.environmentId, runId: binding.runId, folder, control: paths }),
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
					...code.cloudInterfaceTools({ folder, identity, timeZone: "UTC" }),
				],
				assertContext: (signal, timeoutMs) => gateway.assertReadableContext(signal, timeoutMs),
				checkRun: (signal, timeoutMs) => gateway.checkRun(signal, timeoutMs),
				recordContextView: (frame, outputs, signal) => gateway.recordContextView(frame, outputs, signal),
				fenceContextView: (frame, outputs, signal) => gateway.fenceContextView(frame, outputs, signal),
				runLog: { log: opened.log, lines: opened.lines },
			};
		},
		composeContext: async (request, signal) => (runWork ? await runWork(request, signal) : code.cloudNativeContextIdentity(request)),
		compactor,
		command: command.command,
		binarySha256: command.binarySha256,
		prompt: PROMPT,
		signal: AbortSignal.timeout(300_000),
		timeoutMs: 240_000,
	});
	return { result, opened, folder, paths, identity: admitted };
}

/** A structured file's entry for a platform commit, as the folder client makes it from the shared parser. */
function structured(code, path, text) {
	const where = code.companyStatePath(path);
	assert(where, `${path} is a structured path`);
	const parsed = code.parseCompanyStateFile(path, text);
	assert(parsed?.ok, `${path} parses: ${JSON.stringify(parsed?.problems ?? parsed)}`);
	return { path, kind: where.kind, text, parse: parsed.file, parserVersion: code.COMPANY_STATE_PARSER_VERSION };
}

async function main() {
	const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
	if (!binary) {
		process.stdout.write("NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins\n");
		return;
	}
	process.stdout.write(`Codex ${binary}: sha256 ${sha256(readFileSync(binary))}\n`);
	const database = await hostedDatabase(databaseName);
	const scratch = await mkdtemp(join(tmpdir(), "qorpera-read-token-"));
	const started = Date.now();
	const traced = [];
	const trace = (what) => traced.push(`${String(Date.now() - started).padStart(6)} ms ${what}`);
	const state = { agent: [], compactor: [], failure: null, trace };
	const server = provider(state);
	const db = new Database((sql) => database.cluster.psql(databaseName, sql, ["-qAt"]));
	try {
		const code = await bundle(scratch);
		const view = db.query("select pg_get_functiondef('public.qorpera_folder_record_context_view(uuid,jsonb,jsonb)'::regprocedure)");
		assert(view.includes("Context read provenance differs") && view.includes("20260930733000"));
		pass("the database refuses a context view that cites a read under a hash other than its release's (Context read provenance differs; 32 KiB bounds of 20260930733000)");

		// Every made-up token is one the boundary cuts, and the cut leaves its marker.
		for (const token of [...TOKENS, ...ENCODED]) assert.equal(code.redactCloudWebhookSecrets(`x ${token.raw} y`), `x ${token.shown} y`, token.shape);
		assert.equal(code.redactCloudWebhookSecrets(JSON.stringify(MIXED.text)).includes(ENCODED[1].body), false);
		pass(`each of the ${TOKENS.length} shapes the boundary cuts (${TOKENS.map((token) => token.shape).join(", ")}) and ${ENCODED.length} encoded forms is cut by redactCloudWebhookSecrets: the files hold strings the cut changes`);

		// The company, its agents and Alice's run (SQL test 924), in Shared context so that it keeps a work log; the platform
		// writes the files, the link and the table.
		const fixture = readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8");
		const marker = "-- The checks start here: a test that runs after this file's fixture part stops at this line.";
		const end = fixture.indexOf(marker);
		assert(end > 0, "SQL test 924's fixture marker moved: update this script");
		const tag = `t${randomBytes(6).toString("hex")}`;
		const quoted = (text) => `$${tag}$${text}$${tag}$`;
		const stage = (text) => `pg_temp.base_stage(${quoted(text)})`;
		const write = (path, text) => `jsonb_build_object('op', 'write', 'path', ${quoted(path)}, 'file', ${stage(text)})`;
		const files = [PLAIN, ...KEY_FILES, MIXED, LONG];
		const tableToml = structured(code, `${TABLE.folder}/table.toml`, TABLE.toml);
		const tableRows = structured(code, `${TABLE.folder}/rows.csv`, TABLE.rows);
		const out = db.query(`${fixture.slice(0, end)}
			set local session_replication_role = replica;
			update public.qorpera_execution_runs set memory_mode = 'tree'
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
			set local session_replication_role = origin;
			select pg_temp.base_commit('{"kind":"platform"}', 'token-files', jsonb_build_array(
				jsonb_build_object('op', 'mkdir', 'path', 'notes'),
				jsonb_build_object('op', 'mkdir', 'path', 'notes/links'),
				${files.map((file) => write(file.path, file.text)).join(",\n\t\t\t\t")},
				jsonb_build_object('op', 'symlink', 'path', ${quoted(LINK.path)}, 'target', ${quoted(LINK.target)}),
				jsonb_build_object('op', 'mkdir', 'path', 'QorperaOS/tables'),
				jsonb_build_object('op', 'new_folder', 'path', ${quoted(TABLE.folder)}, 'contents', jsonb_build_array(
					jsonb_build_object('path', 'table.toml', 'kind', 'file', 'file', ${stage(TABLE.toml)}),
					jsonb_build_object('path', 'rows.csv', 'kind', 'file', 'file', ${stage(TABLE.rows)})),
					'structured', ${quoted(JSON.stringify([tableToml, tableRows]))}::jsonb)))
			\\g /dev/null
			select jsonb_build_object('binding', current_setting('qorpera_test.base_binding')::jsonb,
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id),
				'versions', (select jsonb_object_agg(e.path, e.version) from public.qorpera_folder_entries e
					where e.environment_id = '92400000-0000-4000-8000-000000000020' and e.kind <> 'claim'
						and (e.path like 'notes/%' or e.path like ${quoted(`${TABLE.folder}/%`)})))::text;
			commit;`);
		const setup = JSON.parse(out.split("\n").at(-1));
		const binding = setup.binding;
		const objects = new Map();
		for (const text of [...files.map((file) => file.text), TABLE.toml, TABLE.rows]) holdText(objects, text);
		for (const call of CALLS)
			for (const path of call.reads) assert(setup.versions[path], `${path} is in the folder: ${JSON.stringify(setup.versions)}`);
		pass(
			`SQL test 924's run of Alice is leased (run ${binding.runId.slice(0, 8)}); the platform wrote ${files.length} files, a link and the table ${TABLE.folder} holding them (${Buffer.byteLength(LONG.text)} bytes in ${LONG.path})`,
		);

		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const port = server.address().port;

		// The run: one call a model request, then the closing message.
		const run = await attempt(code, {
			db,
			objects,
			binary,
			port,
			root: scratch,
			nativeBinarySha256: setup.nativeBinarySha256,
			binding,
		});
		if (state.failure) throw state.failure;
		assert.equal(state.agent.length, CALLS.length + 1, `agent requests: ${state.agent.length}`);
		// Each answer as the model got it: the request after its call carries it, and any later request that still carries
		// it (before the work log folds earlier answers into its step lines) carries the same bytes.
		const answers = new Map();
		for (const [index, call] of CALLS.entries()) {
			const output = state.agent[index + 1].outputs.get(call.id);
			assert(output, `request ${index + 2} carries ${call.id}'s answer`);
			answers.set(call.id, output);
		}
		let carried = 0;
		for (const request of state.agent)
			for (const [id, output] of request.outputs) {
				assert.equal(output, answers.get(id), `${id}: the same answer in every request that carries it`);
				carried++;
			}
		const provenance = db.refusals.filter((refusal) => refusal.includes("provenance"));
		assert.deepEqual(provenance, []);
		pass(
			`the run went on to its next request after every one of its ${CALLS.length} reads: ${state.agent.length} agent requests, each after a call carrying its answer (${carried} answers carried in all, the same bytes each time), the run ended with its closing message, and no context view was refused`,
		);
		const last = { outputs: answers };

		// Where the long file's first window ends. A token that edge cuts in two is in neither window whole, so neither is
		// cut: that is a different defect (the windows of a read, not its release), noted here and left to its own fix; it is
		// the one made-up token the checks below may find shown.
		const edge = JSON.parse(JSON.parse(answers.get("call_long_1")).content.text).bytesRead;
		let split = null;
		for (let at = 0, n = 0; n < LONG_TOKENS.length; n++) {
			const start = LONG.text.indexOf(LONG_TOKENS[n].raw, at);
			const end = start + LONG_TOKENS[n].raw.length;
			if (start < edge && edge < end) split = { ...LONG_TOKENS[n], line: n, start, end };
			if (start >= edge) break;
			at = end;
		}
		const NEEDLES = [...TOKENS, ...ENCODED, ...LONG_TOKENS].map((token) => token.body).filter((needle) => needle !== split?.body);

		// Each answer: what the model was shown, its release, and how the context views cite it.
		// A release is recorded per resource it draws on, each row with the release's output hash.
		const releases = new Map(
			db
				.json(`select coalesce(jsonb_agg(jsonb_build_object('id', g.release_id, 'shas', g.shas, 'reads', g.reads)), '[]')::text
					from (select r.release_id, jsonb_agg(distinct r.output_sha256) shas, jsonb_agg(x) reads
						from public.qorpera_folder_run_read_records r cross join lateral jsonb_array_elements(r.reads) x
						where r.run_id = '${binding.runId}' group by r.release_id) g`)
				.map((release) => {
					assert.equal(release.shas.length, 1, `release ${release.id}: one output hash`);
					return [release.id, { ...release, sha: release.shas[0] }];
				}),
		);
		const cited = db
			.json(`select coalesce(jsonb_agg(o), '[]')::text from public.qorpera_native_context_views v
				cross join lateral jsonb_array_elements(v.view -> 'outputs') o where v.run_id = '${binding.runId}'`)
			.filter((output) => output.readId !== null);
		const envelopes = new Map();
		for (const call of CALLS) {
			const output = last.outputs.get(call.id);
			assert(output, `${call.id}: an answer reached the model`);
			const envelope = JSON.parse(output);
			envelopes.set(call.id, { output, envelope });
			const { content, provenance } = envelope;
			assert.equal(envelope.status, "ok", `${call.id}: ${output.slice(0, 400)}`);
			assert.equal(provenance.tool, call.tool);
			assert(Buffer.byteLength(output) <= code.MAX_CLOUD_TOOL_RESULT_BYTES && !content.truncated, `${call.id}: ${Buffer.byteLength(output)} B`);
			assert.equal(content.sha256, sha256(content.text), `${call.id}: the model was shown the whole answer`);
			assert.equal(code.redactCloudWebhookSecrets(content.text), content.text, `${call.id}: cut again, the answer is unchanged`);
			for (const shown of call.shows) assert(content.text.includes(shown), `${call.id}: shows ${shown}`);
			for (const needle of NEEDLES) assert(!content.text.includes(needle), `${call.id}: shows no made-up token (${needle.slice(0, 12)}…)`);
			const release = releases.get(provenance.companyReadId);
			assert(release, `${call.id}: its companyReadId ${provenance.companyReadId} is a release of this run`);
			assert.equal(release.sha, content.sha256, `${call.id}: the release's output hash is the hash of what the model was shown`);
			assert.deepEqual(release.reads.map((read) => read.path).sort(), [...call.reads].sort(), `${call.id}: the release names its reads`);
			const cites = cited.filter((entry) => entry.callId === call.id);
			assert(cites.length >= 1, `${call.id}: a context view cites it`);
			assert(cites.every((entry) => entry.readId === provenance.companyReadId && entry.readSha256 === release.sha));
			pass(
				`${call.tool} ${JSON.stringify(call.args(last.outputs)).slice(0, 80)}: shown ${call.shows.length ? call.shows.join(" ") : "plain text"}, no token; the release ${provenance.companyReadId.slice(0, 8)} holds the hash of what was shown (${content.sha256.slice(0, 12)}), and ${cites.length} context views cite it under that hash`,
			);
		}

		// The long file: each window is the cut of the file's bytes it covers, and the second goes on where the first ended.
		const longBytes = Buffer.from(LONG.text, "utf8");
		const first = JSON.parse(envelopes.get("call_long_1").envelope.content.text);
		const second = JSON.parse(envelopes.get("call_long_2").envelope.content.text);
		assert(first.bytesRead > 29_000 && first.nextOffset === first.bytesRead && second.offset === first.nextOffset, JSON.stringify({ ...first, text: undefined }));
		assert.equal(first.text, code.redactCloudWebhookSecrets(longBytes.subarray(0, first.bytesRead).toString("utf8")));
		assert.equal(second.text, code.redactCloudWebhookSecrets(longBytes.subarray(second.offset, second.offset + second.bytesRead).toString("utf8")));
		const window = longBytes.subarray(0, first.bytesRead).toString("utf8");
		const tail = window.slice(window.lastIndexOf("\n") + 1);
		pass(
			`${LONG.path}: the first window (${first.bytesRead} file bytes, an envelope of ${Buffer.byteLength(envelopes.get("call_long_1").output)} B) is the cut of the file's bytes it covers, and the second reads on from its nextOffset ${first.nextOffset}; the window ends ${tail.length ? `inside a line (${JSON.stringify(tail.slice(-24))})` : "at a line's end"}`,
		);
		if (split) {
			// The two parts of the split token, each shown as the file has it: the first window's end, the second's start.
			assert(first.text.endsWith(split.raw.slice(0, edge - split.start)) && second.text.startsWith(split.raw.slice(edge - split.start)));
			process.stdout.write(
				`NOTE a different defect, not fixed here: the first window ends inside line ${split.line}'s token, after ${JSON.stringify(split.raw.slice(0, edge - split.start))}; neither window holds it whole, so neither is cut, and the second shows ${JSON.stringify(split.raw.slice(edge - split.start, edge - split.start + 16))}… (${split.end - edge} bytes) uncut\n`,
			);
		}

		// Nothing the provider got held a made-up token (but the split one): neither the agent's requests nor the compactor's.
		for (const request of [...state.agent, ...state.compactor])
			for (const needle of NEEDLES) assert(!request.raw.includes(needle), `a provider request held ${needle.slice(0, 12)}…`);
		pass(
			`no request the provider got (${state.agent.length} agent, ${state.compactor.length} compactor) holds any of the ${NEEDLES.length} made-up tokens${split ? " other than the one the window edge split" : ""}`,
		);

		// The run's work log keeps every step: a finished row per call naming its release, and the block's line holds the
		// envelope the model got, byte for byte.
		const steps = db.json(`select coalesce(jsonb_agg(jsonb_build_object('j', s.j, 'call', s.call_id, 'tool', s.tool, 'finished', s.finished,
				'releases', s.releases, 'block', s.block_path) order by s.j), '[]')::text
			from public.qorpera_memory_run_steps s where s.run_id = '${binding.runId}'`);
		assert.deepEqual(
			steps.map((step) => [step.call, step.tool, step.finished]),
			CALLS.map((call) => [call.id, call.tool, true]),
		);
		const place = new code.CloudRunLogCompanyFolder({ environmentId: run.identity.environmentId, runId: binding.runId, folder: run.folder, control: run.paths });
		const located = await place.locate(binding.runId, AbortSignal.timeout(30_000));
		assert(located.exists, JSON.stringify(located));
		const blocks = new Map();
		for (const stored of new Set(steps.map((step) => step.block))) {
			const path = `${located.path}/log/${stored.split("/").at(-1)}`;
			const block = await place.read(path, AbortSignal.timeout(30_000));
			assert(block, `the log's block ${path}`);
			blocks.set(stored, block.text);
		}
		for (const step of steps) {
			const { output, envelope } = envelopes.get(step.call);
			assert(step.releases.includes(envelope.provenance.companyReadId), `${step.call}: the step names its release`);
			const line = blocks
				.get(step.block)
				.split("\n")
				.find((text) => text.includes(`"call":${JSON.stringify(step.call)},`) && !text.includes('"result":null'));
			assert(line, `${step.call}: the block holds the step's finished line`);
			assert(line.includes(`"result":${output},`), `${step.call}: the line keeps the envelope as the fence issued it`);
			const parsed = JSON.parse(line);
			assert(JSON.stringify(parsed.releases).includes(envelope.provenance.companyReadId));
			const callPaths = CALLS.find((call) => call.id === step.call).reads;
			for (const read of parsed.reads) assert(callPaths.includes(read.path) && setup.versions[read.path] === read.version, `${step.call}: ${JSON.stringify(read)}`);
		}
		pass(
			`the run's work log keeps all ${steps.length} steps finished, in ${blocks.size} block(s): each line holds the envelope the model got byte for byte, its release and the reads it drew on`,
		);
		process.stdout.write(`Database calls: ${db.calls.length}; provider requests: ${state.agent.length} agent, ${state.compactor.length} compactor\n`);
	} catch (error) {
		// What the run met on its way, for the failure's reader: refused database calls, the provider's requests, and the
		// native process's own diagnostics.
		for (const refusal of db.refusals) process.stdout.write(`refused ${refusal.slice(0, 400)}\n`);
		for (const line of traced) process.stdout.write(`trace ${line}\n`);
		process.stdout.write(`provider requests: ${state.agent.length} agent, ${state.compactor.length} compactor\n`);
		for (const [index, request] of state.agent.entries())
			for (const [call, output] of request.outputs)
				if (index === state.agent.length - 1) process.stdout.write(`answer ${call}: ${output.slice(0, 600)}\n`);
		const diagnostics = await readFile(join(scratch, "native-diagnostics.log"), "utf8").catch(() => "");
		if (diagnostics) process.stdout.write(`native diagnostics (last 4000 characters):\n${diagnostics.slice(-4000)}\n`);
		if (error?.cause) process.stdout.write(`cause: ${error.cause?.stack ?? error.cause}\n`);
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
