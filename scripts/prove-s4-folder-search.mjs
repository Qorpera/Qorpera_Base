import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// Folder search for every run, and wider (keyholes S4, PR #1698), end to end: a run searches its company folder through
// the real patched Codex, the runtime's search tool, a relay to the node's folder service (the real service code, run
// as the node runs it: its own process, the unit's node flags), the folder core's own listing of the run's view (the
// run's read rights per path) and the run's releases; then the stored forms are read back: the context views, the
// releases with their reads, and the run's work log.
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> [QORPERA_S4_OLD_TREE=<dir>] node scripts/prove-s4-folder-search.mjs
//
// QORPERA_S4_OLD_TREE names a directory holding the release before this one (tsconfig.json, tsconfig.base.json,
// deploy/folder-service and packages/{contracts,cloud-client,object-gateway,runtime}/src, e.g. from `git archive`): its
// folder service and its runtime search tool are the old parts for the two orders of a roll. Without it those checks are
// NOT RUN (and said so).
//
// What it proves, as checks counted from its PASS lines:
// - the largest answer: a search with more hits than one tool result holds fills one result (32 KiB, never cut by the
//   fence), says it is part of the answer and where to go on, and the calls that follow its cursors show every hit
//   exactly once, in order; with context lines, files only, a find by glob, names and patterns too;
// - read rights: a folder shared with another agent only is never searched, shown, counted or released;
// - patterns: with the unit's flag a hostile pattern runs in linear time; without it (the switch off) a pattern is
//   refused in plain words, by the runtime and by the node, and everything else works;
// - both orders of a roll: a new runtime over the old folder service (version 1: text and names, the rest refused in
//   plain words) and back; an old runtime over the new folder service, answered exactly as the old one answers it;
// - what is stored: each answer's context view, its release (under the hash of exactly the text shown, also when the
//   boundary cut a secret out of it) and its step in the run's work log, byte for byte.
//
// Real: the migrated database and its functions; SQL test 924's company, run and lease; a resource shared with Bob only;
// the runtime's run session, boundary, fence, search tool, folder client, run log; the patched Codex app-server; the
// folder service (FolderService, its server, its core client, its object reader) in child processes under the unit's
// node flags. Stand-ins: PostgREST (one psql call per function, as the service role), the vsock bridge and the slot's
// relay (one socket that writes the bridge's first frame naming the execution host, then carries bytes both ways, as
// they do), the object gateway's byte route for the run log's blocks (bytes in memory, confirmed with the core), and the
// model provider (a scripted loopback Responses server). Not covered: systemd, vsock, a node, a real model.
// Prints one PASS line per check and exits 1 on the first failure; without the binary it prints NOT RUN and exits 0.

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = "qorpera_s4_folder_search";
const ENV = "92400000-0000-4000-8000-000000000020";
const BOB = "92400000-0000-4000-8000-000000000031";
const PROMPT = "Search the company folder.";
/** The execution host as the node's bridge names it, and the machine the folder service admits run views from. */
const EXEC_HOST = { project: "qn25b2", name: "qorpera-exec-node02", physicalId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
const REGEX_FLAG = "--enable-experimental-regexp-engine";
const KIND = { bridge: 0x42, hello: 0x48, helloOk: 0x68, search: 0x53, found: 0x73, error: 0x65 };
const MAX_RESULT = 32 * 1024;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let checks = 0;
const pass = (what) => {
	checks++;
	process.stdout.write(`PASS ${what}\n`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- The company folder's files ---------------------------------------------------------------------------------

/** A note of 40 lines, one in four an invoice line; some end with a line of more than 200 characters with an invoice
 * near its end (a hit shown around its match). */
function noteText(f, n) {
	const lines = [];
	for (let i = 1; i <= 40; i++)
		lines.push(
			i % 4 === 0
				? `Line ${i}: the invoice ${f}-${n}-${i} for customer ${n} was sent and paid on time.`
				: `Line ${i} of note ${f}-${n}: the usual words about the work at hand.`,
		);
	if (n % 7 === 3)
		lines.push(
			`${"A long line of plain words that goes on and on. ".repeat(6)}and then the invoice ${f}-${n}-long shows up near its end.`,
		);
	return `${lines.join("\n")}\n`;
}

/** Every file, with its bytes, its media type and whether Alice's run may read it (docs/restricted is Bob's only). */
function corpus() {
	const files = [];
	const add = (path, content, mediaType = "text/markdown") =>
		files.push({ path, bytes: Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"), mediaType });
	for (let f = 0; f < 8; f++)
		for (let n = 0; n < 15; n++)
			add(`docs/f${String(f).padStart(2, "0")}/note-${String(n).padStart(3, "0")}.md`, noteText(f, n));
	// Pages of a web export: every line a hit, and full of what the fence escapes (< > & as six bytes each, " as two), so
	// the node's page of 26 KiB of hits is more than one tool result once escaped: the runtime must cut it.
	for (let p = 0; p < 4; p++)
		add(
			`docs/web/page-${p}.html`,
			`${Array.from({ length: 100 }, (_, i) => `<tr><td class="n">${i}</td><td>invoice ${p}-${i}</td><td>&lt;paid&gt; &amp; "sent"</td></tr>`).join("\n")}\n`,
			"text/html",
		);
	add("docs/roadmap/plan.md", "The plan for next year.\nOnly plans here.\n");
	add("docs/data/a.csv", "id,amount\n1,100\n", "text/csv");
	add("docs/data/b.csv", "id,amount\n2,200\n", "text/csv");
	add("docs/zebra.md", "A zebra crossing.\n");
	add("docs/bin/blob.dat", Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(" an invoice in a binary file\n")]), "application/octet-stream");
	add("docs/long/big.txt", `short first line\n${"x".repeat(600_000)} needle ${"y".repeat(600_000)}\nlast line\n`, "text/plain");
	add("docs/restricted/plan.md", "Restricted plan: the invoice for the zebra account.\n");
	add("docs/restricted/hidden.csv", "id,amount\n9,900\n", "text/csv");
	add("finance/2026/q1.csv", "id,amount\n3,300\n", "text/csv");
	add("hostile/aaaa.txt", `${"a".repeat(200_000)}\n${"a".repeat(5_000)}!\n`, "text/plain");
	add("notes/deploy.md", "Runbook.\nThe deploy token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123 for the runner.\n");
	for (const file of files) file.readable = !file.path.startsWith("docs/restricted/");
	return files;
}

/** The folders the files are in, parents first. */
function foldersOf(files) {
	const all = new Set();
	for (const { path } of files) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join("/"));
	}
	return [...all].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** A v2 manifest of one chunk, as the gateway writes it (and as SQL test 924's base_manifest spells it). */
function manifestOf(file) {
	const hash = sha256(file.bytes);
	return `{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${hash}","bytes":${file.bytes.length},"mediaType":"${file.mediaType}","executable":false,"chunks":[{"sha256":"${hash}","bytes":${file.bytes.length}}]}`;
}

/** The node's walk order: name by name in byte order, a folder before what it holds. */
function treeOrder(a, b) {
	const x = a.split("/");
	const y = b.split("/");
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		const order = Buffer.compare(Buffer.from(x[i]), Buffer.from(y[i]));
		if (order !== 0) return order;
	}
	return x.length - y.length;
}

/** A hit's text as the search shows it (ASCII lines): the line, or 200 characters around its match. */
function around(line, found) {
	const chars = Array.from(line.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, " "));
	if (chars.length <= 200) return chars.join("");
	const start = Math.max(0, Math.min(found - 50, chars.length - 200));
	return `${start > 0 ? "…" : ""}${chars.slice(start, start + 200).join("")}${start + 200 < chars.length ? "…" : ""}`;
}

/** The text files under `under` the run may read, in walk order (binary ones left out). */
function readableText(files, under) {
	return files
		.filter((f) => f.readable && f.path.startsWith(`${under}/`) && !f.bytes.subarray(0, 8192).includes(0))
		.sort((a, b) => treeOrder(a.path, b.path));
}

/** Every hit line a search for `find` must show under `under`, in order. */
function expectedHits(files, under, find) {
	const out = [];
	for (const file of readableText(files, under)) {
		const lines = file.bytes.toString("utf8").split("\n");
		if (lines.at(-1) === "") lines.pop();
		lines.forEach((line, i) => {
			const found = find(line);
			if (found >= 0) out.push(`${file.path}:${i + 1}: ${around(line, found)}`);
		});
	}
	return out;
}

// ---- The run's view of what the model got ------------------------------------------------------------------------

function envelopeOf(call) {
	const envelope = JSON.parse(call.envelope);
	return { envelope, text: envelope.content.text };
}

function cursorIn(envelopeText) {
	const text = JSON.parse(envelopeText).content.text;
	return /More: call again with cursor ([A-Za-z0-9_-]{16})$/.exec(text)?.[1];
}

/** An answer's lines (before its closing line), each read against the paths it may name. */
function answerLines(text, paths) {
	const cut = text.lastIndexOf("\n\n");
	const body = text.slice(0, cut);
	const closing = text.slice(cut + 2);
	const known = [...paths].sort((a, b) => b.length - a.length);
	const lines = body === "No matches here." ? [] : body.split("\n");
	return {
		closing,
		lines: lines.map((line) => {
			if (line === "--") return { kind: "separator", line };
			for (const path of known) {
				if (line === path || line === `${path}/`) return { kind: "name", path, line };
				if (line.startsWith(`${path}:`)) {
					const hit = /^:(\d+): (.*)$/s.exec(line.slice(path.length));
					if (hit) return { kind: "hit", path, n: Number(hit[1]), text: hit[2], line };
					const count = /^: (\d+)( so far.*)?$/.exec(line.slice(path.length));
					if (count) return { kind: "file", path, count: Number(count[1]), partial: Boolean(count[2]), line };
				}
				if (line.startsWith(`${path}-`)) {
					const context = /^-(\d+)- (.*)$/s.exec(line.slice(path.length));
					if (context) return { kind: "context", path, n: Number(context[1]), text: context[2], line };
				}
			}
			return { kind: "other", line };
		}),
	};
}

// ---- The database, PostgREST and the gateway's byte route (stand-ins, as in prove-run-log-full-result.mjs) ----------

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

/** PostgREST for the runtime's HttpCloudCompanyPathControl. */
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

/** PostgREST over loopback HTTP for the folder services' core client: functions, and the folder clocks it polls. */
function postgrestServer(db) {
	return createHttpServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk.toString();
		});
		request.on("end", () => {
			const url = new URL(request.url, "http://stand-in");
			const rpc = /^\/rest\/v1\/rpc\/(qorpera_[a-z0-9_]+)$/.exec(url.pathname);
			let answer;
			if (request.method === "POST" && rpc) answer = db.rpc(rpc[1], JSON.parse(raw || "{}"));
			else if (request.method === "GET" && url.pathname === "/rest/v1/qorpera_folder_clocks") {
				const ids = /^in\.\(([0-9a-f,-]+)\)$/.exec(url.searchParams.get("environment_id") ?? "")?.[1].split(",") ?? [];
				assert(ids.every((id) => /^[0-9a-f-]{36}$/.test(id)));
				answer = {
					status: 200,
					value: JSON.parse(
						db.query(`select coalesce(json_agg(json_build_object('environment_id', environment_id, 'last_seq', last_seq)), '[]')
							from public.qorpera_folder_clocks where environment_id in (${ids.map((id) => `'${id}'`).join(",") || "null"})`),
					),
				};
			} else answer = { status: 404, value: { code: "PGRST202", message: `No ${url.pathname}` } };
			response.writeHead(answer.status, { "content-type": "application/json" });
			response.end(JSON.stringify(answer.value));
		});
	});
}

/** The object gateway's folder object route, for the run log's blocks (as prove-run-log-full-result.mjs keeps them). */
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

// ---- The node: folder services, the bridge and the relay ----------------------------------------------------------

/** A folder service host as the unit runs it: the service, its server on a socket, its core client, its object reader. */
const HOST = `
import { SupabaseFolderCore } from "./packages/object-gateway/src/folder-service/core.ts";
import { nodeRequest } from "./packages/object-gateway/src/folder-service/https-request.ts";
import { MountGrants } from "./packages/object-gateway/src/folder-service/mounts.ts";
import { NasObjects } from "./packages/object-gateway/src/folder-service/objects.ts";
import { createFolderServer } from "./packages/object-gateway/src/folder-service/server.ts";
import { FolderService } from "./packages/object-gateway/src/folder-service/service.ts";
const [socket, objects, port, machine] = process.argv.slice(2);
const log = (line) => process.stderr.write(line + "\\n");
const core = new SupabaseFolderCore({
	projectUrl: "https://postgrest.stand-in.invalid/",
	secretKey: "stand-in",
	transport: (url, request, max, signal) =>
		nodeRequest(new URL(url.pathname + url.search, "http://127.0.0.1:" + port), request, max, signal),
});
const service = new FolderService({
	core,
	objects: new NasObjects({ root: objects, cacheBytes: 256 * 1024 * 1024 }),
	grants: new MountGrants([], [JSON.parse(machine)]),
	log,
});
createFolderServer(service, log).listen(socket, () => process.stdout.write("LISTENING\\n"));
service.start();
`;

/** Bundles a tree's folder service host; checks that everything in it comes from that tree. */
async function bundleHost(tree, outfile) {
	const result = await build({
		absWorkingDir: tree,
		stdin: { contents: HOST, resolveDir: tree, sourcefile: "s4-folder-service-host.ts", loader: "ts" },
		bundle: true,
		platform: "node",
		// CommonJS, as the package builds it: under --jitless node:http's ESM facade needs WebAssembly.
		format: "cjs",
		target: "node22",
		outfile,
		logLevel: "silent",
		metafile: true,
		nodePaths: [join(repositoryRoot, "node_modules")],
	});
	const outside = Object.keys(result.metafile.inputs).filter((input) => input.startsWith("..") && !input.includes("node_modules"));
	assert.deepEqual(outside, [], `the folder service of ${tree} is bundled from that tree only`);
}

/** The node flags of a tree's folder service unit (its ExecStart). */
function unitFlags(tree) {
	const unit = readFileSync(join(tree, "deploy/folder-service/qorpera-folder-service.service"), "utf8");
	const exec = /^ExecStart=\S+\s+(.*?)\s*\S+\.cjs\s*$/m.exec(unit);
	assert(exec, `the folder service unit of ${tree} starts node`);
	return exec[1].split(/\s+/).filter((flag) => flag.startsWith("--"));
}

/** Starts a folder service in its own process; resolves once it serves its socket. */
function startService(name, bundle, flags, socket, objects, port, logs) {
	const child = spawn(process.execPath, [...flags, bundle, socket, objects, String(port), JSON.stringify(EXEC_HOST)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	logs[name] = [];
	child.stderr.on("data", (bytes) => logs[name].push(...bytes.toString().split("\n").filter(Boolean)));
	return new Promise((resolveStart, rejectStart) => {
		const timer = setTimeout(() => rejectStart(new Error(`folder service ${name} did not start`)), 60_000);
		child.stdout.on("data", (bytes) => {
			if (bytes.toString().includes("LISTENING")) {
				clearTimeout(timer);
				resolveStart(child);
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectStart(new Error(`folder service ${name} exited ${code}: ${logs[name].slice(-5).join(" | ")}`));
		});
	});
}

/** The slot's relay and the node's vsock bridge in one: a connection to `path` reaches the folder service `target`
 * names, after the bridge's first frame naming the execution host; bytes then go both ways. `switch` moves later
 * connections to another service and ends the open ones, as a restart of the node's folder service does. */
class Bridge {
	#sockets;
	#open = new Set();
	#server;
	target;

	constructor(sockets, target) {
		this.#sockets = sockets;
		this.target = target;
	}

	listen(path) {
		this.#server = createNetServer((local) => {
			const upstream = connect(this.#sockets[this.target]);
			const payload = Buffer.from(JSON.stringify({ cid: 77, lookup: "found", machine: EXEC_HOST }));
			const head = Buffer.alloc(5);
			head.writeUInt32BE(payload.length + 1, 0);
			head[4] = KIND.bridge;
			upstream.write(Buffer.concat([head, payload]));
			local.pipe(upstream);
			upstream.pipe(local);
			const pair = [local, upstream];
			this.#open.add(pair);
			const end = () => {
				local.destroy();
				upstream.destroy();
				this.#open.delete(pair);
			};
			for (const socket of pair) {
				socket.on("close", end);
				socket.on("error", end);
			}
		});
		return new Promise((done) => this.#server.listen(path, done));
	}

	switch(target) {
		this.target = target;
		for (const [local, upstream] of this.#open) {
			local.destroy();
			upstream.destroy();
		}
		this.#open.clear();
	}

	close() {
		this.switch(this.target);
		this.#server?.close();
	}
}

/** A machine's side of the folder protocol, for a hello and one search frame (what the runtime sends, by hand). */
class RawClient {
	#socket;
	#buffer = Buffer.alloc(0);
	#frames = [];
	#waiting;

	static open(path) {
		const client = new RawClient();
		client.#socket = connect(path);
		client.#socket.on("data", (data) => {
			client.#buffer = Buffer.concat([client.#buffer, data]);
			while (client.#buffer.length >= 5 && client.#buffer.length >= 4 + client.#buffer.readUInt32BE(0)) {
				const length = client.#buffer.readUInt32BE(0);
				const frame = { kind: client.#buffer[4], body: JSON.parse(client.#buffer.subarray(5, 4 + length).toString("utf8")) };
				client.#buffer = client.#buffer.subarray(4 + length);
				if (client.#waiting) {
					const waiting = client.#waiting;
					client.#waiting = undefined;
					waiting(frame);
				} else client.#frames.push(frame);
			}
		});
		return new Promise((done, fail) => {
			client.#socket.once("connect", () => done(client));
			client.#socket.once("error", fail);
		});
	}

	send(kind, value) {
		const payload = Buffer.from(JSON.stringify(value));
		const head = Buffer.alloc(5);
		head.writeUInt32BE(payload.length + 1, 0);
		head[4] = kind;
		this.#socket.write(Buffer.concat([head, payload]));
	}

	next() {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve(frame);
		return new Promise((done, fail) => {
			const timer = setTimeout(() => fail(new Error("no frame")), 120_000);
			this.#waiting = (value) => {
				clearTimeout(timer);
				done(value);
			};
		});
	}

	close() {
		this.#socket.destroy();
	}
}

// ---- The runtime ---------------------------------------------------------------------------------------------------

const RUNTIME = [
	'export {runCloudNativeRunToolSession} from "./packages/runtime/src/cloud-native-run-tool-session.ts";',
	'export {HttpCloudCompanyPathControl} from "./packages/runtime/src/cloud-company-path-control.ts";',
	'export {CloudCompanyPathGateway} from "./packages/runtime/src/cloud-company-path-gateway.ts";',
	'export {CloudCompanyFolderClient} from "./packages/runtime/src/cloud-company-folder-client.ts";',
	'export {HttpCloudCompanyFolderBytes} from "./packages/runtime/src/cloud-company-folder-bytes.ts";',
	'export {cloudFolderFileTools} from "./packages/runtime/src/cloud-folder-file-tools.ts";',
	'export {CloudFolderSearch, cloudFolderSearchTool} from "./packages/runtime/src/cloud-folder-search-tool.ts";',
	'export {CloudRunLogCompanyFolder} from "./packages/runtime/src/cloud-run-log-folder.ts";',
	'export {openCloudRunLog} from "./packages/runtime/src/cloud-run-log-open.ts";',
	'export {CloudRunResumeRpc} from "./packages/runtime/src/cloud-run-resume.ts";',
	'export {CloudRunLogRpcProtection} from "./packages/runtime/src/cloud-run-log-protection.ts";',
	'export {MemoryCompactChannel, MemoryCompactLane} from "./packages/runtime/src/memory-tree/compact.ts";',
	'export {cloudNativeContextIdentity} from "./packages/runtime/src/cloud-native-context-composition.ts";',
	'export {CLOUD_NATIVE_TOOL_CATALOG_BYTES, MAX_CLOUD_TOOL_RESULT_BYTES, cloudToolJsonText} from "./packages/runtime/src/cloud-native-tool-boundary.ts";',
	'export {nativeCodexFixtureCommand} from "./packages/runtime/test/fixtures/native-codex-fixture-command.ts";',
].join("\n");

/** An old release's search tool and the folder client it releases with: the old runtime's side of a roll. */
const OLD_RUNTIME = [
	'export {CloudFolderSearch, cloudFolderSearchTool} from "./packages/runtime/src/cloud-folder-search-tool.ts";',
	'export {CloudCompanyFolderClient} from "./packages/runtime/src/cloud-company-folder-client.ts";',
	'export {HttpCloudCompanyFolderBytes} from "./packages/runtime/src/cloud-company-folder-bytes.ts";',
	'export {HttpCloudCompanyPathControl} from "./packages/runtime/src/cloud-company-path-control.ts";',
].join("\n");

async function bundleRuntime(tree, contents, outfile) {
	const result = await build({
		absWorkingDir: tree,
		stdin: { resolveDir: tree, contents },
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile,
		logLevel: "silent",
		metafile: true,
		nodePaths: [join(repositoryRoot, "node_modules")],
	});
	const outside = Object.keys(result.metafile.inputs).filter((input) => input.startsWith("..") && !input.includes("node_modules"));
	assert.deepEqual(outside, [], `the runtime of ${tree} is bundled from that tree only`);
	return import(pathToFileURL(outfile).href);
}

/** A folder client for the run, as the company runtime makes one (its bytes through the gateway stand-in). */
function folderClient(code, db, binding, identity, objects) {
	const control = new code.HttpCloudCompanyPathControl({
		supabaseUrl: "https://postgrest.stand-in.invalid/",
		serviceRoleKey: "stand-in",
		fetch: postgrestFetch(db),
	});
	const bytes = new code.HttpCloudCompanyFolderBytes({
		baseUrl: "http://127.0.0.1:9/",
		token: "t".repeat(43),
		binding,
		holder: () => "stand-in-holder",
		identity,
		control,
		fetch: gatewayFetch(db, objects),
	});
	return { control, folder: new code.CloudCompanyFolderClient({ binding, identity, control, bytes }) };
}

/** A search tool call outside a model turn: its arguments parsed as the boundary parses them, then run. */
async function searchCall(tool, binding, callId, args) {
	const parsed = tool.parseArguments(args);
	try {
		const content = await tool.execute(parsed, {
			companyId: "stand-in",
			runId: binding.runId,
			callId,
			argumentSha256: sha256(JSON.stringify(args)),
			signal: AbortSignal.timeout(120_000),
		});
		return { ok: true, text: content.value, companyReadId: content.companyReadId };
	} catch (error) {
		if (error?.name === "CloudToolRefusal") return { ok: false, text: `REFUSED: ${error.message}` };
		throw error;
	}
}

// ---- The scripted provider -------------------------------------------------------------------------------------------

/** The run's searches, in order. Each `yield` is a call (its answer comes back as the envelope the model got) or a
 * restart of the node's folder service into another version. */
function* searches(old) {
	const paged = function* (label, args) {
		let envelope = yield { label, args };
		for (let turns = 1; cursorIn(envelope); turns++) {
			assert(turns < 40, `${label}: too many calls`);
			envelope = yield { label, args: { ...args, cursor: cursorIn(envelope) } };
		}
	};
	// The new folder service with its unit's flags (patterns on).
	yield* paged("invoice", { query: "invoice", path: "docs" });
	yield* paged("web", { query: "invoice", path: "docs/web" });
	yield* paged("context", { query: "invoice", path: "docs/f00", context: 2 });
	yield* paged("files", { query: "invoice", path: "docs", files_only: true });
	yield { label: "find", args: { glob: "**/*.csv", path: "docs" } };
	yield { label: "names", args: { query: "plan", names_only: true, path: "docs" } };
	yield { label: "zebra", args: { query: "zebra", path: "docs" } };
	yield* paged("pattern", { query: "invoice 1-\\d+-(4|8) ", regex: true, path: "docs/f01" });
	yield { label: "hostile-1", args: { query: "(a|aa)*(a*)*b", regex: true, path: "hostile" } };
	yield { label: "hostile-2", args: { query: "^(a+)+$", regex: true, path: "hostile" } };
	yield { label: "long-pattern", args: { query: "needle", regex: true, path: "docs/long" } };
	yield { label: "long-text", args: { query: "needle", path: "docs/long" } };
	yield { label: "backreference", args: { query: "(in)voice \\1", regex: true, path: "docs/f00" } };
	// The same service started without the pattern engine's flag: the switch off.
	yield { restart: "off" };
	yield { label: "off-pattern", args: { query: "invoice \\d", regex: true, path: "docs/f00" } };
	yield { label: "off-text", args: { query: "zebra", path: "docs" } };
	if (old) {
		// The old folder service (a roll back, or a node not rolled yet).
		yield { restart: "old" };
		yield* paged("old-invoice", { query: "invoice", path: "docs/f00" });
		yield { label: "old-context", args: { query: "invoice", path: "docs/f00", context: 2 } };
		yield { label: "old-find", args: { glob: "**/*.csv", path: "docs" } };
		yield { label: "old-pattern", args: { query: "invoice", regex: true, path: "docs/f00" } };
	}
	// The new one again (the roll forward).
	yield { restart: "on" };
	yield { label: "again", args: { query: "invoice", path: "docs/f00/note-000.md", context: 1 } };
	// Last: an answer the boundary cuts a secret out of, cited by the next request's context view.
	yield { label: "token", args: { query: "deploy token", path: "notes" } };
}

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
	return createHttpServer((request, response) => {
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
			// The run's step lines (Shared context): one plain line for any step, and for any two lines.
			if (/Compress this step into one line|Merge these two adjacent lines|That line is \d+ bytes/.test(input)) {
				state.compactor++;
				stream(response, body.model, message("Searched the company folder."));
				return;
			}
			state.agent++;
			state.firstRaw ??= raw;
			const last = state.calls.at(-1);
			let answer;
			if (last && last.envelope === undefined) {
				const output = body.input.find((item) => item.type === "function_call_output" && item.call_id === last.callId);
				assert(output, `the request after ${last.callId} carries its output`);
				last.envelope = String(output.output);
				last.ms = Date.now() - last.sentAt;
				answer = last.envelope;
			}
			let step = state.started ? state.plan.next(answer) : state.plan.next();
			state.started = true;
			while (!step.done && step.value.restart) {
				state.trace(`node: folder service ${step.value.restart}`);
				state.bridge.switch(step.value.restart);
				state.phase = step.value.restart;
				await sleep(300);
				step = state.plan.next();
			}
			if (step.done) {
				state.finished = true;
				stream(response, body.model, message("SEARCHED"));
				return;
			}
			const callId = `call_s4_${String(state.calls.length).padStart(3, "0")}`;
			state.calls.push({ ...step.value, callId, phase: state.phase, sentAt: Date.now() });
			state.trace(`provider: ${callId} ${step.value.label} ${JSON.stringify(step.value.args)}`);
			stream(response, body.model, {
				type: "function_call",
				id: `fc_${callId}`,
				call_id: callId,
				namespace: "qorpera",
				name: "company_search",
				arguments: JSON.stringify(step.value.args),
				status: "completed",
			});
		})().catch((error) => {
			state.failure ??= error;
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
}

// ---- The run ---------------------------------------------------------------------------------------------------------

async function session(code, context) {
	const { db, binding, objects, binary, port, root, nativeBinarySha256, bridgePath } = context;
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
	let search;
	const command = await code.nativeCodexFixtureCommand(root, [binary], port);
	try {
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
				({ folder } = folderClient(code, db, binding, identity, objects));
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
				// As the company runtime gives a run on a host with the node's folder search (cloud-native-company-runtime.ts).
				search = new code.CloudFolderSearch({ socketPath: bridgePath, folder, environmentId: identity.environmentId });
				return {
					tools: [
						...code.cloudFolderFileTools({ folder, operations, identity }),
						code.cloudFolderSearchTool({ search, folder, runId: identity.runId }),
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
			prompt: PROMPT,
			signal: AbortSignal.timeout(600_000),
			timeoutMs: 540_000,
		});
		return { result, opened, folder, paths, identity: admitted };
	} finally {
		search?.close();
	}
}

async function main() {
	const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
	if (!binary) {
		process.stdout.write("NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins\n");
		return;
	}
	process.stdout.write(`Codex ${binary}: sha256 ${sha256(readFileSync(binary))}\n`);
	const oldTree = process.env.QORPERA_S4_OLD_TREE ? resolve(repositoryRoot, process.env.QORPERA_S4_OLD_TREE) : undefined;
	if (oldTree) {
		assert(existsSync(join(oldTree, "packages/object-gateway/src/folder-service/service.ts")), `${oldTree} holds an old release`);
		const ref = existsSync(join(oldTree, "REF")) ? readFileSync(join(oldTree, "REF"), "utf8").trim() : "unknown";
		process.stdout.write(`Old release: ${oldTree} (${ref})\n`);
	} else process.stdout.write("NOT RUN: the old-and-new orders of a roll; set QORPERA_S4_OLD_TREE to an old release's tree\n");

	const database = await hostedDatabase(databaseName);
	const scratch = await mkdtemp(join(tmpdir(), "s4-"));
	const started = Date.now();
	const traced = [];
	const trace = (what) => traced.push(`${String(Date.now() - started).padStart(7)} ms ${what}`);
	const db = new Database((sql) => database.cluster.psql(databaseName, sql, ["-qAt"]));
	const logs = {};
	const children = [];
	const bridges = [];
	const state = { plan: searches(Boolean(oldTree)), started: false, calls: [], agent: 0, compactor: 0, phase: "on", trace };
	const server = provider(state);
	const rest = postgrestServer(db);
	try {
		// 1. The company folder: SQL test 924's company and Alice's run (in Shared context, so it keeps a work log), a
		//    resource docs/restricted shared with Bob only, and the files, staged by the platform; their bytes on the
		//    object store's share as the folder service reads them.
		const files = corpus();
		const fixture = readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8");
		const end = fixture.indexOf("-- The checks start here: a test that runs after this file's fixture part stops at this line.");
		assert(end > 0, "SQL test 924's fixture marker moved: update this script");
		const tag = `t${randomBytes(6).toString("hex")}`;
		const units = [
			...foldersOf(files).map((path) => `jsonb_build_object('op','mkdir','path','${path}')`),
			...files.map(
				(file) =>
					`jsonb_build_object('op','write','path','${file.path}','file',(pg_temp.base_seal('{"kind":"platform"}', $${tag}$${manifestOf(file)}$${tag}$) -> 'file'))`,
			),
		];
		const commits = [];
		for (let i = 0; i < units.length; i += 40)
			commits.push(
				`select pg_temp.base_commit('{"kind":"platform"}', 's4-corpus-${i}', jsonb_build_array(${units.slice(i, i + 40).join(",")})) \\g /dev/null`,
			);
		const out = db.query(`${fixture.slice(0, end)}
			set local session_replication_role = replica;
			update public.qorpera_execution_runs set memory_mode = 'tree'
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
			set local session_replication_role = origin;
			select set_config('qorpera_test.s4_resource', public.qorpera_folder_set_resource('${ENV}', pg_temp.base_owner(),
				'docs/restricted', 'subtree', 'company_shared', 'normal') ->> 'resourceId', true) \\g /dev/null
			select public.qorpera_folder_grant('${ENV}', pg_temp.base_owner(), current_setting('qorpera_test.s4_resource')::uuid,
				'staff_agent', '${BOB}', array['read']) \\g /dev/null
			${commits.join("\n")}
			select jsonb_build_object('binding', current_setting('qorpera_test.base_binding')::jsonb,
				'profileId', (select profile_id from public.qorpera_company_files where environment_id = '${ENV}'),
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id))::text;
			commit;`);
		const setup = JSON.parse(out.split("\n").at(-1));
		const binding = setup.binding;
		const share = join(scratch, "objects");
		await mkdir(join(share, setup.profileId), { recursive: true });
		for (const file of files) {
			await writeFile(join(share, setup.profileId, sha256(file.bytes)), file.bytes);
			const manifest = manifestOf(file);
			await writeFile(join(share, setup.profileId, sha256(manifest)), manifest);
		}
		const docs = files.filter((f) => f.path.startsWith("docs/"));
		pass(
			`SQL test 924's run of Alice is leased (run ${binding.runId.slice(0, 8)}); the folder holds ${files.length} files, ${docs.length} under docs, of which docs/restricted is shared with Bob only`,
		);

		// 2. The node: the folder services as their units run them, behind one relay.
		await new Promise((done) => rest.listen(0, "127.0.0.1", done));
		const restPort = rest.address().port;
		const newFlags = unitFlags(repositoryRoot);
		assert(newFlags.includes(REGEX_FLAG), `the unit starts node with ${REGEX_FLAG}: ${newFlags.join(" ")}`);
		const services = {
			on: { tree: repositoryRoot, flags: newFlags },
			off: { tree: repositoryRoot, flags: newFlags.filter((flag) => flag !== REGEX_FLAG) },
			...(oldTree ? { old: { tree: oldTree, flags: unitFlags(oldTree) } } : {}),
		};
		await bundleHost(repositoryRoot, join(scratch, "fs-new.cjs"));
		if (oldTree) await bundleHost(oldTree, join(scratch, "fs-old.cjs"));
		const sockets = {};
		for (const [name, service] of Object.entries(services)) {
			sockets[name] = join(scratch, `${name}.sock`);
			children.push(
				await startService(
					name,
					join(scratch, service.tree === repositoryRoot ? "fs-new.cjs" : "fs-old.cjs"),
					service.flags,
					sockets[name],
					share,
					restPort,
					logs,
				),
			);
		}
		const relay = (target) => {
			const bridge = new Bridge(sockets, target);
			bridges.push(bridge);
			return bridge;
		};
		state.bridge = relay("on");
		await state.bridge.listen(join(scratch, "relay.sock"));
		process.stdout.write(
			`Folder services: ${Object.entries(services).map(([name, s]) => `${name} (${s.tree === repositoryRoot ? "this tree" : "old tree"}, node ${s.flags.join(" ")})`).join("; ")}\n`,
		);

		// 3. The run searches through the patched Codex.
		const code = await bundleRuntime(repositoryRoot, RUNTIME, join(scratch, "runtime.mjs"));
		assert.equal(code.MAX_CLOUD_TOOL_RESULT_BYTES, MAX_RESULT);
		await new Promise((done, fail) => {
			server.once("error", fail);
			server.listen(0, "127.0.0.1", done);
		});
		const logObjects = new Map();
		const run = await session(code, {
			db,
			binding,
			objects: logObjects,
			binary,
			port: server.address().port,
			root: scratch,
			nativeBinarySha256: setup.nativeBinarySha256,
			bridgePath: join(scratch, "relay.sock"),
		});
		if (state.failure) throw state.failure;
		trace(`session: ${JSON.stringify(run.result).slice(0, 300)}`);
		assert(state.finished, "the run asked every search and its last request went to the provider");
		const calls = state.calls;
		assert(calls.every((call) => call.envelope !== undefined));
		pass(
			`the run made ${calls.length} company_search calls through the patched Codex and finished (${state.agent} agent requests, ${state.compactor} for its step lines)`,
		);

		// What OpenAI sees: company_search's definition as Codex sent it (in the first request's additional_tools item, under
		// the qorpera namespace). Codex sends a schema's types and descriptions, not its bounds: context's 0 to 5 reaches
		// the model in the description's words, and the runtime refuses any other in words.
		const definitions = [];
		const walk = (value) => {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value === "object") {
				if (value.type === "function" && value.name === "company_search") definitions.push(value);
				Object.values(value).forEach(walk);
			}
		};
		walk(JSON.parse(state.firstRaw ?? "{}"));
		const [definition] = definitions;
		assert(definition, "the provider's first request carries company_search's definition");
		const schema = definition.parameters;
		assert(schema.properties.regex?.type === "boolean" && schema.properties.files_only?.type === "boolean");
		assert(schema.properties.context?.type === "integer");
		assert(!(schema.required ?? []).includes("query"), "query is no longer required");
		assert(definition.description.includes("context adds up to 5 lines") && definition.description.includes("about 30 KiB"));
		process.stdout.write(`company_search as Codex sent it: ${JSON.stringify(definition)}\n`);
		pass("the provider's first request carries company_search's new definition (regex, context, files_only; query optional; the limits in its words)");

		// Every answer reached the model whole: one envelope of at most 32 KiB, never cut by the fence.
		for (const call of calls) {
			const { envelope } = envelopeOf(call);
			assert(Buffer.byteLength(call.envelope) <= MAX_RESULT, `${call.callId} ${Buffer.byteLength(call.envelope)} B`);
			assert.equal(envelope.content.truncated, false, call.callId);
			assert.equal(envelope.content.includedBytes, envelope.content.originalBytes, call.callId);
			assert.equal(envelope.provenance.tool, "company_search");
		}
		pass(`all ${calls.length} answers reached the model whole (each envelope at most 32 KiB, none cut by the fence)`);

		const label = (name) => calls.filter((call) => call.label === name);
		const docPaths = docs.map((f) => f.path);
		const allPaths = [...files.map((f) => f.path), ...foldersOf(files)];
		const ok = (call) => {
			const { envelope, text } = envelopeOf(call);
			assert.equal(envelope.status, "ok", `${call.callId} ${text.slice(0, 300)}`);
			return text;
		};
		const refused = (call, start) => {
			const { envelope, text } = envelopeOf(call);
			assert.equal(envelope.status, "denied", `${call.callId}: ${text.slice(0, 300)}`);
			assert(text.startsWith(`REFUSED: ${start}`), `${call.callId}: ${text}`);
			return text;
		};
		const hitsOf = (group) => group.flatMap((call) => answerLines(ok(call), allPaths).lines.filter((l) => l.kind === "hit").map((l) => l.line));

		// 4. The largest answer, one that does not fit, and every hit exactly once.
		const findInvoice = (line) => line.toLowerCase().indexOf("invoice");
		const goesOn = (group, truth) => {
			for (let i = 1; i < group.length; i++) {
				const before = answerLines(ok(group[i - 1]), allPaths).lines.filter((l) => l.kind === "hit").at(-1).line;
				const next = answerLines(ok(group[i]), allPaths).lines.filter((l) => l.kind === "hit")[0].line;
				assert.equal(truth.indexOf(next), truth.indexOf(before) + 1, `${group[i].callId} goes on right after the last hit shown`);
			}
		};
		const invoice = label("invoice");
		const truth = expectedHits(files, "docs", findInvoice);
		const first = envelopeOf(invoice[0]);
		const firstBytes = Buffer.byteLength(invoice[0].envelope);
		assert(invoice.length >= 3, `the docs search takes several calls (${invoice.length})`);
		assert(firstBytes > 25_000, `the first answer is a page of about 26 KiB (${firstBytes} B)`);
		assert.deepEqual(hitsOf(invoice), truth);
		assert(invoice.slice(0, -1).every((call) => cursorIn(call.envelope)));
		assert(answerLines(ok(invoice.at(-1)), allPaths).closing.endsWith("Nothing more."));
		assert(!invoice.some((call) => ok(call).includes("restricted")));
		goesOn(invoice, truth);
		pass(
			`the largest answer that fits: "invoice" under docs has ${truth.length} hit lines; the first answer shows ${Buffer.byteLength(first.text)} bytes (a ${firstBytes}-byte envelope); ${invoice.length} calls show every hit exactly once, in order, each going on at its cursor, and nothing of docs/restricted`,
		);
		const web = label("web");
		const webTruth = expectedHits(files, "docs/web", findInvoice);
		const webFirst = envelopeOf(web[0]);
		const webBytes = Buffer.byteLength(web[0].envelope);
		const webShown = answerLines(webFirst.text, allPaths).lines.length;
		assert(/\n\nPart of the answer\. More: call again with cursor [A-Za-z0-9_-]{16}$/.test(webFirst.text), webFirst.text.slice(-200));
		assert(webBytes > 31_000 && webBytes <= MAX_RESULT, `${webBytes} B`);
		assert.deepEqual(hitsOf(web), webTruth);
		goesOn(web, webTruth);
		pass(
			`an answer that does not fit: the node's page of web lines (< > & " escaped) is more than one result, so the runtime shows ${webShown} of its hits in a ${webBytes}-byte envelope, says "Part of the answer. More: call again with cursor …", and ${web.length} calls show all ${webTruth.length} hits exactly once, each going on at the first hit left out`,
		);

		// Context lines: every hit with the lines around it, no line shown twice.
		const context = label("context");
		const contextLines = context.flatMap((call) => answerLines(ok(call), docPaths).lines);
		assert(contextLines.every((l) => ["hit", "context", "separator"].includes(l.kind)), JSON.stringify(contextLines.find((l) => !["hit", "context", "separator"].includes(l.kind))));
		const f00 = expectedHits(files, "docs/f00", (line) => line.toLowerCase().indexOf("invoice"));
		assert.deepEqual(contextLines.filter((l) => l.kind === "hit").map((l) => l.line), f00);
		const shownLines = new Set();
		const textOf = new Map(files.map((f) => [f.path, f.bytes.toString("utf8").split("\n")]));
		for (const l of contextLines.filter((x) => x.kind === "hit" || x.kind === "context")) {
			const key = `${l.path}:${l.n}`;
			assert(!shownLines.has(key), `${key} shown twice`);
			shownLines.add(key);
			if (l.kind === "context") assert.equal(l.text, textOf.get(l.path)[l.n - 1], key);
		}
		for (const l of contextLines.filter((x) => x.kind === "hit")) {
			const count = textOf.get(l.path).length - 1;
			for (const n of [l.n - 2, l.n - 1, l.n + 1, l.n + 2])
				if (n >= 1 && n <= count) assert(shownLines.has(`${l.path}:${n}`), `${l.path}:${n} around ${l.n}`);
		}
		pass(
			`context 2 under docs/f00: ${context.length} calls show its ${f00.length} hits each with the two lines before and after it, every line once (${shownLines.size} lines), in rg's form`,
		);

		// Files only: every readable file with its count, and the count of files searched leaves the restricted one out.
		const filesCalls = label("files");
		assert.equal(filesCalls.length, 1, "files only under docs is one call");
		const counted = answerLines(ok(filesCalls[0]), docPaths);
		const expectedCounts = readableText(files, "docs")
			.map((f) => [f.path, f.bytes.toString("utf8").split("\n").filter((line) => line.toLowerCase().includes("invoice")).length])
			.filter(([, n]) => n > 0)
			.map(([path, n]) => `${path}: ${n}`);
		assert.deepEqual(counted.lines.map((l) => l.line), expectedCounts);
		const searchable = readableText(files, "docs").length;
		assert.equal(counted.closing, `${searchable} files searched, 1 binary passed over. Nothing more.`);
		pass(
			`files only: ${expectedCounts.length} files with their counts, and "${counted.closing}" counts exactly the ${searchable} text files the run may read (docs/restricted/plan.md, which mentions an invoice, is in neither)`,
		);

		// A find by glob, and names.
		const found = answerLines(ok(label("find")[0]), allPaths).lines.map((l) => l.line);
		assert.deepEqual(found, ["docs/data/a.csv", "docs/data/b.csv"]);
		const names = answerLines(ok(label("names")[0]), allPaths).lines.map((l) => l.line);
		assert.deepEqual(names, ["docs/roadmap/plan.md"]);
		const zebra = hitsOf(label("zebra"));
		assert.deepEqual(zebra, ["docs/zebra.md:1: A zebra crossing."]);
		pass("a find by glob alone lists docs/data's two CSV files; names and text find only what the run may read (no docs/restricted/hidden.csv, plan.md or zebra line)");

		// Patterns, the unit's flag on.
		const pattern = label("pattern");
		const patternTruth = expectedHits(files, "docs/f01", (line) => line.toLowerCase().search(/invoice 1-\d+-(4|8) /));
		assert.deepEqual(hitsOf(pattern), patternTruth);
		pass(`a pattern (invoice 1-\\d+-(4|8) under docs/f01) shows exactly its ${patternTruth.length} lines`);
		const [hostile1] = label("hostile-1");
		const [hostile2] = label("hostile-2");
		assert.equal(ok(hostile1), "No matches here.\n\n1 file searched. Nothing more.");
		assert.deepEqual(hitsOf([hostile2]), [`hostile/aaaa.txt:1: ${around("a".repeat(200_000), 0)}`]);
		assert(hostile1.ms < 15_000 && hostile2.ms < 15_000, `${hostile1.ms} ms, ${hostile2.ms} ms`);
		pass(
			`hostile patterns run in linear time: (a|aa)*(a*)*b over a line of 200,000 a's (${hostile1.ms} ms for the whole call) and ^(a+)+$ (${hostile2.ms} ms), each with the right answer`,
		);
		const longPattern = ok(label("long-pattern")[0]);
		assert.equal(
			longPattern,
			"No matches here.\n\n1 file searched; 1 line over 1 MiB not searched by the pattern (search them as text, or read them). Nothing more.",
		);
		const big = files.find((f) => f.path === "docs/long/big.txt").bytes.toString("utf8").split("\n")[1];
		assert.deepEqual(hitsOf(label("long-text")), [`docs/long/big.txt:2: ${around(big, big.indexOf("needle"))}`]);
		pass("a line over 1 MiB: the pattern's answer says it left 1 such line and how to find it; the text search shows it");
		const backreference = refused(label("backreference")[0], "REGEX_BACKREFERENCE");
		pass(`a pattern RE2 does not take is refused in words: "${backreference}"`);

		// The switch off: the same service without the flag.
		const offPattern = refused(label("off-pattern")[0], "REGEX_OFF");
		assert.deepEqual(hitsOf(label("off-text")), ["docs/zebra.md:1: A zebra crossing."]);
		pass(`switch off (no ${REGEX_FLAG}): the run, reconnected to the restarted service, is refused a pattern in words ("${offPattern}"), and text search works`);

		// The old folder service, and back.
		if (oldTree) {
			const oldInvoice = label("old-invoice");
			assert(oldInvoice.every((call) => call.phase === "old"));
			assert.deepEqual(hitsOf(oldInvoice), f00);
			const notYet = ["old-context", "old-find", "old-pattern"].map((name) => refused(label(name)[0], "SEARCH_NOT_HERE_YET"));
			pass(
				`new runtime, old folder service: text search shows every hit under docs/f00 (${f00.length}, ${oldInvoice.length} calls of version 1 pages); context, a find by glob and a pattern are refused in words ("${notYet[0]}")`,
			);
		}
		const again = label("again");
		assert.equal(again[0].phase, "on");
		assert(answerLines(ok(again[0]), docPaths).lines.some((l) => l.kind === "context"));
		pass("the new folder service again (roll forward): the run reconnects and context lines are back");

		// The token: cut out by the boundary, and still cited.
		const token = envelopeOf(label("token")[0]);
		assert.equal(token.envelope.status, "ok");
		assert(token.text.includes("ghp_[REDACTED]") && !token.text.includes("ghp_ABCDEF"), token.text);
		pass("an answer with a token in it reaches the model with the token cut out (ghp_[REDACTED]), and the run's next request still went out");

		// 5. What is stored: context views, releases and their reads, the run's log.
		const outputs = JSON.parse(
			db.query(`select coalesce(jsonb_agg(o), '[]')::text from public.qorpera_native_context_views v,
				jsonb_array_elements(v.view -> 'outputs') o where v.run_id = '${binding.runId}'`),
		);
		const releases = JSON.parse(
			db.query(`select coalesce(jsonb_agg(jsonb_build_object('releaseId', release_id, 'output', output_sha256, 'reads', reads)), '[]')::text
				from public.qorpera_folder_run_read_records where run_id = '${binding.runId}'`),
		);
		let cited = 0;
		for (const call of calls) {
			const { envelope, text } = envelopeOf(call);
			const views = outputs.filter((o) => o.callId === call.callId);
			assert(views.length >= 1, `${call.callId} is in a context view`);
			for (const view of views) {
				assert.equal(view.bytes, Buffer.byteLength(call.envelope), call.callId);
				assert.equal(view.sha256, sha256(call.envelope), call.callId);
				assert.equal(view.readId, envelope.provenance.companyReadId ?? null, call.callId);
			}
			if (envelope.provenance.companyReadId) {
				cited++;
				const release = releases.filter((r) => r.releaseId === envelope.provenance.companyReadId);
				assert(release.length >= 1, `${call.callId}'s release`);
				assert(release.every((r) => r.output === sha256(text)), `${call.callId}'s release is under the hash of the text shown`);
			}
		}
		const releasedPaths = releases.flatMap((r) => r.reads.map((read) => read.path));
		assert(!releasedPaths.some((path) => path.startsWith("docs/restricted")), "nothing of docs/restricted was released");
		const firstReads = releases.filter((r) => r.releaseId === first.envelope.provenance.companyReadId).flatMap((r) => r.reads.map((read) => read.path));
		const firstShown = new Set(answerLines(first.text, allPaths).lines.filter((l) => l.kind === "hit").map((l) => l.path));
		assert([...firstShown].every((path) => firstReads.includes(path)), "the first answer's release names every file it showed");
		pass(
			`stored: each of the ${calls.length} answers is in the run's context view at its exact bytes; ${cited} cite a release under the hash of the text shown (the token's too); the releases hold ${releasedPaths.length} reads, every file an answer showed, none under docs/restricted`,
		);
		const steps = JSON.parse(
			db.query(`select coalesce(jsonb_agg(jsonb_build_object('j', s.j, 'tool', s.tool, 'finished', s.finished) order by s.j), '[]')::text
				from public.qorpera_memory_run_steps s where s.run_id = '${binding.runId}'`),
		);
		assert.equal(steps.length, calls.length);
		assert(steps.every((step) => step.tool === "company_search" && step.finished));
		const place = new code.CloudRunLogCompanyFolder({ environmentId: run.identity.environmentId, runId: binding.runId, folder: run.folder, control: run.paths });
		const located = await place.locate(binding.runId, AbortSignal.timeout(30_000));
		assert(located.exists, JSON.stringify(located));
		// Each block is named by its first step, the step after the block before it's last (a block holds 64 KiB: one or
		// two steps of a full result).
		const blocks = [];
		for (let first = 0; first < calls.length; ) {
			const block = await place.read(`${located.path}/log/${String(first).padStart(8, "0")}.jsonl`, AbortSignal.timeout(30_000));
			assert(block, `the log's block ${first}`);
			blocks.push(block.text);
			const steps = block.text.split("\n").filter(Boolean).map((line) => JSON.parse(line).j);
			assert(steps[0] === first && steps.every((j, i) => j === first + i), `block ${first}: ${steps}`);
			first = steps.at(-1) + 1;
		}
		assert.equal(located.last, JSON.parse(blocks.at(-1).split("\n")[0]).j, "the log's last block is the one read last");
		const logText = blocks.join("\n");
		for (const call of calls) assert(logText.includes(`"result":${call.envelope},`), `${call.callId}'s step keeps its envelope byte for byte`);
		pass(
			`the run's work log keeps all ${calls.length} search steps (${blocks.length} blocks of at most 64 KiB), each with the envelope the model got, byte for byte, read back through the parser`,
		);

		// 6. The node, by hand: what each service says in its hello, and the node's own refusal with the switch off.
		const helloOf = async (bridgePath, view) => {
			const client = await RawClient.open(bridgePath);
			client.send(KIND.hello, { protocol: 4, environmentId: ENV, viewId: view.viewId, pass: view.pass, role: "io" });
			return { client, hello: await client.next() };
		};
		const direct = {};
		for (const name of Object.keys(services)) {
			direct[name] = relay(name);
			await direct[name].listen(join(scratch, `relay-${name}.sock`));
		}
		const viewed = {};
		for (const name of Object.keys(services)) {
			const view = await run.folder.openRunView(AbortSignal.timeout(60_000));
			const { client, hello } = await helloOf(join(scratch, `relay-${name}.sock`), view);
			assert.equal(hello.kind, KIND.helloOk, `${name}: ${JSON.stringify(hello.body)}`);
			viewed[name] = hello.body.search ?? null;
			if (name === "off") {
				client.send(KIND.search, {
					version: 2,
					query: "invoice \\d",
					regex: true,
					path: "docs/f00",
					glob: null,
					namesOnly: false,
					filesOnly: false,
					caseSensitive: false,
					context: 0,
					after: null,
				});
				const answer = await client.next();
				assert.equal(answer.kind, KIND.error);
				assert.equal(answer.body.code, "BAD_REQUEST");
				assert(answer.body.message.startsWith("REGEX_OFF:"), answer.body.message);
				viewed.offRefusal = answer.body.message;
			}
			client.close();
		}
		assert.deepEqual(viewed.on, { version: 2, regex: true });
		assert.deepEqual(viewed.off, { version: 2, regex: false });
		if (oldTree) assert.equal(viewed.old, null);
		pass(
			`hellos: the new service says ${JSON.stringify(viewed.on)} with its unit's flag and ${JSON.stringify(viewed.off)} without it${oldTree ? ", the old one says nothing (version 1)" : ""}; asked a pattern anyway with the switch off, the node itself refuses ("${viewed.offRefusal}")`,
		);

		// 7. An old runtime over the new folder service: exactly what the old one answers it, call for call.
		if (oldTree) {
			const old = await bundleRuntime(oldTree, OLD_RUNTIME, join(scratch, "runtime-old.mjs"));
			const asks = [
				{ query: "invoice", path: "docs/f00" },
				{ query: "zebra", path: "docs" },
				{ query: "plan", names_only: true, path: "docs" },
				{ query: "invoice", glob: "note-00*.md", path: "docs/f01" },
			];
			const cursorOfText = (text) => /More: call again with cursor ([A-Za-z0-9_-]{16})$/.exec(text)?.[1];
			const answers = {};
			for (const name of ["old", "on"]) {
				const { folder } = folderClient(old, db, binding, run.identity, logObjects);
				const search = new old.CloudFolderSearch({ socketPath: join(scratch, `relay-${name}.sock`), folder, environmentId: ENV });
				const tool = old.cloudFolderSearchTool({ search, folder, runId: binding.runId });
				answers[name] = [];
				let n = 0;
				for (const ask of asks) {
					const pages = [await searchCall(tool, binding, `call_old_${name}_${n++}`, ask)];
					for (let cursor = cursorOfText(pages[0].text); cursor; cursor = cursorOfText(pages.at(-1).text)) {
						assert(pages.length < 60, "the old runtime's paging ends");
						pages.push(await searchCall(tool, binding, `call_old_${name}_${n++}`, { ...ask, cursor }));
					}
					answers[name].push(pages);
				}
				search.close();
			}
			const same = (list) => list.map((pages) => pages.map((a) => `${a.ok}|${a.text.replace(/cursor [A-Za-z0-9_-]{16}$/, "cursor <token>")}`));
			assert(answers.old.flat().every((a) => a.ok && a.companyReadId), "the old runtime's answers from the old service are released and cited");
			assert.deepEqual(same(answers.on), same(answers.old));
			assert.deepEqual(
				answers.old[0].flatMap((a) => answerLines(a.text, allPaths).lines.filter((l) => l.kind === "hit").map((l) => l.line)),
				f00,
			);
			pass(
				`old runtime (the old release's search tool), new folder service: all ${answers.on.flat().length} answers (${answers.old[0].length} pages of version 1 for docs/f00) equal the old service's, text for text (cursors aside), and are released and cited`,
			);
		}

		// 8. A hostile pattern's time on the node, without the model in between.
		{
			const { folder } = folderClient(code, db, binding, run.identity, logObjects);
			const search = new code.CloudFolderSearch({ socketPath: join(scratch, "relay-on.sock"), folder, environmentId: ENV });
			const tool = code.cloudFolderSearchTool({ search, folder, runId: binding.runId });
			await searchCall(tool, binding, "call_warm", { query: "a", path: "hostile" });
			const timed = [];
			for (const [n, query] of ["(a|aa)*(a*)*b", "^(a+)+$", "(x+x+)+y"].entries()) {
				const at = performance.now();
				const answer = await searchCall(tool, binding, `call_hostile_${n}`, { query, regex: true, path: "hostile" });
				const ms = Math.round(performance.now() - at);
				assert(answer.ok, answer.text);
				assert(ms < 3_000, `${query}: ${ms} ms`);
				timed.push(`${query} ${ms} ms`);
			}
			search.close();
			pass(`hostile patterns over 205,000 characters, one call each with its release: ${timed.join(", ")}`);
		}

		process.stdout.write(
			`Database calls: ${db.calls.length}; provider requests: ${state.agent} agent, ${state.compactor} step lines; ${Math.round((Date.now() - started) / 1000)} s\n`,
		);
		process.stdout.write(`S4 PROOF: ${checks} checks passed${oldTree ? "" : " (the old-and-new orders NOT RUN)"}\n`);
	} catch (error) {
		for (const refusal of db.refusals) process.stdout.write(`refused ${refusal.slice(0, 400)}\n`);
		for (const line of traced) process.stdout.write(`trace ${line}\n`);
		for (const call of state.calls)
			process.stdout.write(`call ${call.callId} ${call.label} ${call.phase}: ${(call.envelope ?? "(no answer)").slice(0, 600)}\n`);
		for (const [name, lines] of Object.entries(logs)) for (const line of lines.slice(-20)) process.stdout.write(`folder-service ${name}: ${line}\n`);
		const diagnostics = await readFile(join(scratch, "native-diagnostics.log"), "utf8").catch(() => "");
		if (diagnostics) process.stdout.write(`native diagnostics (last 4000 characters):\n${diagnostics.slice(-4000)}\n`);
		if (error?.cause) process.stdout.write(`cause: ${error.cause?.stack ?? error.cause}\n`);
		throw error;
	} finally {
		for (const bridge of bridges) bridge.close();
		for (const child of children) child.kill("SIGKILL");
		server.closeAllConnections?.();
		await new Promise((done) => server.close(() => done()));
		rest.closeAllConnections?.();
		await new Promise((done) => rest.close(() => done()));
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
