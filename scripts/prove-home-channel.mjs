import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { build, transformSync } from "esbuild";
import {
	controlPlane,
	Database,
	ENVIRONMENT,
	finish,
	gatewayFetch,
	OWNER,
	platformCommit,
	postgrestFetch,
	repositoryRoot,
	runLog,
	sha256,
	textObjects,
} from "./prove-company-run.mjs";
import { hostedDatabase } from "./test-hosted-db-cluster.mjs";

// The agent's home, end to end (lanes/agent-box-20261113, slices 1, 2 and 4):
//
//   QORPERA_CODEX_FENCE_BINARY=/opt/qorpera-codex-fence/codex node scripts/prove-home-channel.mjs
//
// Real, and all of it ours: the pinned patched Codex in the slot's own bubblewrap namespace (the arguments
// `nativeIsolationInvocation` gives, now with the home's socket bound), the runtime's run session, tool boundary,
// result fence, context composition, folder tools, run log and context views in a migrated database (SQL test 924's
// company and Alice's run, in Shared context), the host of the home (`CloudCodexHome`: its socket, its review of every
// action, its native steps), the channel client, the coding executor's ingress route with its transport token, the
// run's holder proven, and the session's authority in SQL (20260930752000).
//
// Stood in: the model (the scripted provider); the egress relay (a Unix socket that forwards only to it); the machine
// (`codex exec-server` in a second bubblewrap namespace on the same test VM, where production runs it inside the run's
// own company machine over LXD, as the agent's user); `/usr/bin/node` in the namespace; and the sign-in (a made-up
// auth.json and a made-up bearer, as a plan run's fallback passes its token).
//
// The four things it proves, counted from its own log:
// 1. With the switch off a run is EXACTLY as it is on master: the same tools, the same instructions, the same first
//    request to the provider, byte for byte once its own ids are taken out, and no environment at all.
// 2. With the switch on, Codex's own tools reach the machine through the whole channel and work there.
// 3. The run's work log holds a step for each of Codex's own calls, with the envelope the model was shown.
// 4. A command the review declines never reaches the machine, and the model is told in words it can act on.
// 5. The two identities on a machine (only in a run that is root, `run-on-node --sudo`): Codex's own shell is the
//    agent's account, it reaches root through the image's own sudo rule, and it can change a file root wrote.

const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
const ONLY = process.env.P1_ONLY ? new Set(process.env.P1_ONLY.split(",")) : null;
const pass = (what) => process.stdout.write(`PASS ${what}\n`);
const note = (what) => process.stdout.write(`NOTE ${what}\n`);
const evidence = { scenarios: {} };
/** The current scenario's list of fenced batches (the boundary's fenceNativeResults, wrapped in main). */
let fenceTrace = null;

const CANARY_AUTH = `HOMECANARY-auth-${randomBytes(16).toString("hex")}`;
const CANARY_ENV = `HOMECANARY-env-${randomBytes(16).toString("hex")}`;
const CANARIES = { auth: CANARY_AUTH, env: CANARY_ENV };
const PROVIDER_BASE = "http://scripted-provider.invalid/v1";
/** The account Codex's own tools run as on a machine, and its uid, as the image makes them (CLOUD_MACHINE_HOME). */
const CLOUD_AGENT_ACCOUNT = "qorpera-agent";
const CLOUD_AGENT_UID = 2000;
/** Whether this run may make that account and give it the image's sudo rule: only `run-on-node --sudo` can. */
const AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const README = "# Readme\n\nThe company's readme, in the folder (read with company_read).\n";
const SEED = "# Seed\n\nThe first line of the seed.\nA line apply_patch will change.\nThe last line.\n";

/** A small valid PNG (RGB, `size` x `size`), for view_image. */
function png(size = 8) {
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8;
	header[9] = 2;
	const rows = Buffer.concat(
		Array.from({ length: size }, (_, y) =>
			Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size * 3 }, (_, x) => (x * 31 + y * 17) % 256))]),
		),
	);
	return Buffer.concat([
		Buffer.from("\x89PNG\r\n\x1a\n", "binary"),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(rows)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// The slot's host side, as one process between the run session and the namespace: it starts the namespace with the
// isolation's own arguments, serves the namespace's egress relay (to the scripted provider only) and relays the
// namespace's exec socket to the machine's exec-server, logging every JSON-RPC line it carries (and whether a canary
// was in it). Built with esbuild so it uses nativeIsolationInvocation itself.
const SLOT_SOURCE = String.raw`
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { nativeIsolationInvocation } from "./packages/runtime/src/cloud-native-isolation.ts";

// The slot's own process, as the provider service is in production: it makes the namespace with the runtime's own
// isolation arguments and serves the egress relay. The home's socket is the RUNTIME's (cloud-codex-home.ts): it is in
// this same scratch root, and bound in by nativeIsolationInvocation's homeSocket.
const cfg = JSON.parse(readFileSync(new URL("./slot.json", import.meta.url), "utf8"));
const log = (file, value) => appendFileSync(join(cfg.logDir, file), JSON.stringify({ t: Date.now(), ...value }) + "\n");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const fenceSocket = process.env.QORPERA_NATIVE_RESULT_FENCE_SOCKET;
const root = dirname(fenceSocket);
const codexHome = process.env.CODEX_HOME;
const args = process.argv.slice(2);
const provider = 'model_providers.qorpera_fixture={name="Offline boundary fixture",base_url="' + cfg.providerBaseUrl +
	'",env_key="QORPERA_OFFLINE_PROBE_KEY",wire_api="responses",requires_openai_auth=false}';
let catalogArgs = [];
if (cfg.modelCatalog) {
	const target = join(root, "config", "model-catalog.json");
	writeFileSync(target, readFileSync(cfg.modelCatalog), { mode: 0o400, flag: "wx" });
	catalogArgs = ["-c", "model_catalog_json=" + JSON.stringify(target)];
}
const codexArgs = [args[0], "-c", 'model_provider="qorpera_fixture"', "-c", provider, ...catalogArgs, ...args.slice(1)];

// The egress relay's stand-in: the entry's proxy reaches this socket; it forwards only to the scripted provider.
const relayPath = join(root, "relay.sock");
const relay = createHttpServer((request, response) => {
	const url = new URL(request.url, "http://relay.invalid");
	log("relay.jsonl", { method: request.method, host: url.host, path: url.pathname, bearerSha256: request.headers.authorization ? hash(request.headers.authorization) : null });
	const upstream = httpRequest(
		{ host: "127.0.0.1", port: cfg.providerPort, method: request.method, path: url.pathname + url.search,
			headers: { ...request.headers, host: "127.0.0.1:" + cfg.providerPort } },
		(answer) => { response.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(response); },
	);
	upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
	request.pipe(upstream);
});
relay.on("connect", (request, socket) => { log("relay.jsonl", { connect: request.url }); socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); });
await new Promise((resolve) => relay.listen(relayPath, resolve));

const invocation = nativeIsolationInvocation({
	configuration: { entryPoint: cfg.entry },
	command: cfg.codex,
	args: codexArgs,
	scratchRoot: root,
	codexHome,
	relayPath,
	fenceSocket,
	// The one addition of slice 1 to the box: the run's own socket to its home, which the runtime opened in this
	// same scratch root (CLOUD_HOME_SOCKET_NAME), bound read-only as the fence's is.
	...(cfg.home ? { homeSocket: join(root, "exec.sock") } : {}),
});
const a = invocation.args;
// Stand-in: the test machine keeps its node outside /usr/bin.
const nodeAt = a.lastIndexOf("/usr/bin/node");
a[nodeAt] = cfg.node;
if (!cfg.node.startsWith("/usr/")) a.splice(a.indexOf("--setenv"), 0, "--ro-bind", cfg.node, cfg.node);
// Stand-in: the fixture provider's bearer, as a plan run's fallback passes its token.
a.splice(a.indexOf("--chdir"), 0, "--setenv", "QORPERA_OFFLINE_PROBE_KEY", cfg.canaries.env);
log("slot.jsonl", { bwrap: a.map((value) => (value === cfg.canaries.env ? "<canary env>" : value)) });

const child = spawn("/usr/bin/bwrap", a, { env: invocation.environment, stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.on("data", (data) => appendFileSync(join(cfg.logDir, "codex-stderr.log"), data));
const stop = () => child.kill("SIGKILL");
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code, signal) => {
	log("slot.jsonl", { exit: code, signal });
	relay.close();
	process.exit(code ?? 1);
});
`;

async function bundles(scratch) {
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
				'export {CloudRunLogCompanyFolder} from "./packages/runtime/src/cloud-run-log-folder.ts";',
				'export {openCloudRunLog} from "./packages/runtime/src/cloud-run-log-open.ts";',
				'export {CloudRunResumeRpc} from "./packages/runtime/src/cloud-run-resume.ts";',
				'export {CloudRunLogRpcProtection} from "./packages/runtime/src/cloud-run-log-protection.ts";',
				'export {MemoryCompactChannel, MemoryCompactLane} from "./packages/runtime/src/memory-tree/compact.ts";',
				'export {cloudNativeContextIdentity} from "./packages/runtime/src/cloud-native-context-composition.ts";',
				'export {CLOUD_NATIVE_TOOL_CATALOG_BYTES, CloudNativeToolBoundary, cloudToolJsonText} from "./packages/runtime/src/cloud-native-tool-boundary.ts";',
				'export {parseMemoryRunFile} from "./packages/cloud-client/src/memory-run-files.ts";',
				'export {CloudCodexHome, CloudCodexHomeSteps, parseCloudCompanyHome} from "./packages/runtime/src/cloud-codex-home.ts";',
				'export {createCloudHomeChannel} from "./packages/runtime/src/cloud-home-channel-client.ts";',
				'export {HttpCloudCodingCommandService} from "./packages/runtime/src/cloud-coding-command-http.ts";',
				'export {proveNativeBinding} from "./deploy/coding-worker/command-authority.ts";',
				'export {authorizeHomeSession} from "./deploy/coding-worker/home-session-authority.ts";',
			].join("\n"),
		},
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: modulePath,
		logLevel: "silent",
	});
	const slot = join(scratch, "slot.mjs");
	await build({
		absWorkingDir: repositoryRoot,
		stdin: { resolveDir: repositoryRoot, contents: SLOT_SOURCE },
		platform: "node",
		format: "esm",
		target: "node22",
		bundle: true,
		outfile: slot,
		logLevel: "silent",
	});
	const entry = join(scratch, "native-entry.mjs");
	writeFileSync(
		entry,
		transformSync(readFileSync(join(repositoryRoot, "packages/runtime/src/cloud-native-isolation-child.ts"), "utf8"), {
			loader: "ts",
			format: "esm",
		}).code,
	);
	return { code: await import(pathToFileURL(modulePath).href), slot, entry };
}

/** The scripted provider. Agent request n is answered with `calls[n](outputs, state)`: `{name, arguments, namespace}`
 * (a function call), `{custom: name, input}` (a custom tool call, as apply_patch is) or null (a final message). */
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
			let raw = "";
			for await (const chunk of request) raw += chunk.toString();
			state.httpRequests.push({
				method: request.method,
				url: request.url,
				bearer: Object.entries(CANARIES).find(([, value]) => request.headers.authorization === `Bearer ${value}`)?.[0] ?? (request.headers.authorization ? "other" : null),
			});
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				response.writeHead(404);
				response.end();
				return;
			}
			const body = JSON.parse(raw);
			const input = JSON.stringify(body.input);
			if (/Compress this step into one line|Merge these two adjacent lines|That line is \d+ bytes/.test(input)) {
				state.compactor.push(input.length);
				stream(response, body.model, message("Worked on the company's files."));
				return;
			}
			const turn = state.agent.length;
			state.agent.push({ body, raw });
			const outputs = body.input
				.filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output")
				.map((item) => ({ callId: item.call_id, type: item.type, output: typeof item.output === "string" ? item.output : JSON.stringify(item.output) }));
			const call = turn < calls.length ? calls[turn](outputs, state) : null;
			if (!call) {
				stream(response, body.model, message("DONE"));
				return;
			}
			const name = call.custom ?? call.name;
			const callId = `call_${String(turn).padStart(2, "0")}_${name}`;
			state.calls.push({ callId, ...call });
			stream(
				response,
				body.model,
				call.custom
					? { type: "custom_tool_call", id: `ctc_${turn}`, call_id: callId, name: call.custom, input: call.input, status: "completed" }
					: {
							type: "function_call",
							id: `fc_${turn}`,
							call_id: callId,
							...(call.namespace ? { namespace: call.namespace } : {}),
							name: call.name,
							arguments: JSON.stringify(call.arguments),
							status: "completed",
						},
			);
		})().catch((error) => {
			state.failure ??= error;
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
}

/** What the model got for a call, from the request right after it: the fenced envelope and Codex's text in it. */
function shown(state, callId) {
	for (const { body } of state.agent) {
		const item = body.input.find(
			(entry) => (entry.type === "function_call_output" || entry.type === "custom_tool_call_output") && entry.call_id === callId,
		);
		if (item) {
			const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
			let envelope = null;
			try {
				envelope = JSON.parse(output);
			} catch {}
			return { output, bytes: Buffer.byteLength(output), envelope, text: envelope?.content?.text ?? null };
		}
	}
	return null;
}
const textOf = (output) => {
	try {
		return JSON.parse(output).content.text;
	} catch {
		return output;
	}
};
const sessionOf = (outputs) => {
	for (const { output } of [...outputs].reverse()) {
		const found = /session ID (\d+)/.exec(textOf(output));
		if (found) return Number(found[1]);
	}
	throw new Error("no running session in the outputs");
};

/** The tools a request offers: its `tools`, and (Responses lite, as gpt-6-astra is) its additional_tools items'. */
function toolsOf(body) {
	return [
		...(body.tools ?? []),
		...body.input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools ?? []),
	].flatMap((tool) =>
		tool.type === "namespace" ? (tool.tools ?? []).map((inner) => ({ ...inner, namespace: tool.name })) : [tool],
	);
}

/** Summary of one request body, for what the provider sees. */
function requestSummary(body) {
	const tools = toolsOf(body).map((tool) => ({
		namespace: tool.namespace ?? null,
		type: tool.type,
		name: tool.name ?? null,
		bytes: Buffer.byteLength(JSON.stringify(tool)),
	}));
	return {
		model: body.model,
		instructionsBytes: Buffer.byteLength(body.instructions ?? ""),
		instructionsSha256: sha256(body.instructions ?? ""),
		toolsBytes: Buffer.byteLength(JSON.stringify(toolsOf(body))),
		additionalToolsKeys: body.input.filter((item) => item.type === "additional_tools").map((item) => Object.keys(item).sort()),
		tools,
		parallelToolCalls: body.parallel_tool_calls ?? null,
		input: body.input.map((item) => ({
			type: item.type,
			role: item.role ?? null,
			callId: item.call_id ?? null,
			name: item.name ?? null,
			bytes: Buffer.byteLength(JSON.stringify(item)),
		})),
	};
}

/** The run's own lease token, so the ingress can prove this run's holder as production does (SQL test 924 pins every
 * run's lease sha, so the proof puts the sha of its own token there, as P4's harness does). */
const HOLDER_TOKEN = randomBytes(32).toString("base64url");

/** The company's files, the switch on for this company, and a machine of Alice's agent running on a node of this
 * test's own: everything `qorpera_company_home_available` and `qorpera_authorize_home_session` ask of a home. */
function setup(on) {
	const node = "12470000-0000-4000-8000-000000000470";
	const policy = `jsonb_build_object('providerId','machine-home','providerPolicySha256',repeat('f',64),'project','machines',
		'imageFingerprint',repeat('a',64),'bootstrapSha256',repeat('b',64),'storagePool','machines','network','qagent0')`;
	const observe = `do $$
		declare v_context jsonb := public.qorpera_runtime_node_inventory_context('${node}');
		begin
			perform public.qorpera_observe_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-observation/v1',
				'nodeId','${node}','machineIdSha256',repeat('c',64),'observationId',extensions.gen_random_uuid(),
				'observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				'cpuMillis',16000,'memoryBytes',68719476736,'state','ready'),v_context ->> 'contextSha256',
				jsonb_build_object('schema','qorpera.runtime-node-inventory/v1','bootId',extensions.gen_random_uuid(),'entries',
					coalesce((select jsonb_agg(jsonb_build_object('project','machines','name','m-' || replace(a ->> 'allocationId','-',''),
						'physicalId',a ->> 'allocationId','type','virtual-machine','state','running','configurationSha256',repeat('7',64),
						'cpuMillis',(a ->> 'cpuMillis')::bigint,'memoryBytes',(a ->> 'memoryBytes')::bigint,'allocation',a,
						'category','managed','reason',null)) from jsonb_array_elements(v_context -> 'allocations') a),'[]'::jsonb)));
		end $$;`;
	return [
		platformCommit("prove-home-folder", [
			{ op: "mkdir", path: "docs" },
			{ op: "write", path: "docs/readme.md", text: README },
		]),
		// This run's holder, as the ingress proves it.
		`set local session_replication_role = replica;
		update public.qorpera_native_provider_connection_leases set lease_token_sha256 = encode(extensions.digest('${HOLDER_TOKEN}','sha256'),'hex')
		where job_id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
		update public.qorpera_runner_jobs set lease_token_sha256 = encode(extensions.digest('${HOLDER_TOKEN}','sha256'),'hex')
		where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId')::uuid;
		set local session_replication_role = origin;`,
		// A node and a machine executor of this test's own.
		`do $$ begin
			perform public.qorpera_configure_runtime_node(jsonb_build_object('schema','qorpera.runtime-node-policy/v1',
				'nodeId','${node}','machineIdSha256',repeat('c',64),'label','machine-home','cpuMillis',16000,
				'memoryBytes',68719476736,'headroomCpuMillis',2000,'headroomMemoryBytes',8589934592,'standardCpuMillis',2000,
				'standardMemoryBytes',4294967296,'enabled',true),0);
			perform public.qorpera_enroll_runtime_node_inventory(jsonb_build_object('schema','qorpera.runtime-node-inventory-policy/v1',
				'nodeId','${node}','host',jsonb_build_object('machineIdSha256',repeat('c',64),
				'socketPath','/var/snap/lxd/common/lxd/unix.socket','socketGid',0,'certificateSha256',repeat('e',64),
				'serverName','lxd','serverVersion','6.9','architecture','x86_64'),'operatingCpuMillis',500,
				'operatingMemoryBytes',536870912,'infrastructure','[]'::jsonb));
		end $$;`,
		observe,
		`do $$ begin
			perform public.qorpera_enroll_runtime_node_provider('${node}', repeat('c',64), 'machine', 'machine-home', repeat('f',64),
				8000, 34359738368);
			perform public.qorpera_configure_machine_executor('mx-home', repeat('c',64), true, ${policy}, 322122547200);
		end $$;`,
		// Alice's agent starts its machine, and the executor's pass brings it up.
		`do $$
		declare v_envelope text; v_sha text; v_receipt uuid := extensions.gen_random_uuid(); v_binding jsonb;
		begin
			v_binding := current_setting('qorpera_test.base_binding')::jsonb;
			v_envelope := jsonb_build_object('schema','qorpera.cloud-tool-operation/v2',
				'principals',(public.qorpera_describe_native_tool_authority(v_binding) -> 'identity')
					- array['assignmentId','runnerId','leaseId','sponsorVersion','providerConnectionId','providerConnectionVersion'],
				'operation',jsonb_build_object('tool','machine_start','toolVersion','qorpera.machine-tools/v1',
					'logicalOperationKey','home-machine',
					'arguments',jsonb_build_object('name','home','purpose','The agent''s home','cpus',2,'memoryGiB',4,
						'diskGiB',40,'lifetime','task'),
					'target',jsonb_build_object('realm','company_machine'),'requiresCompanyRevision',false))::text;
			v_sha := encode(extensions.digest(convert_to(v_envelope,'UTF8'),'sha256'),'hex');
			perform public.qorpera_native_machine_start(v_binding, v_envelope, 'authorize');
			perform public.qorpera_begin_native_tool_operation(v_binding, v_receipt, 'machine_start:home-machine', v_sha,
				repeat('9',64), false);
			perform public.qorpera_native_machine_start(v_binding, v_envelope, 'begin', v_receipt, repeat('9',64));
		end $$;`,
		observe,
		`do $$
		declare v_placement public.qorpera_company_machine_placements%rowtype;
		begin
			for attempt in 1..12 loop
				select p.* into v_placement from public.qorpera_company_machine_placements p
					join public.qorpera_company_machines m on m.id = p.machine_id
					where m.name = 'home' and m.removed_at is null and p.retired_at is null and p.removed_at is null;
				exit when v_placement.id is not null;
				exit when public.qorpera_admit_executor_machines('mx-home', repeat('c',64), 16) = '[]'::jsonb;
			end loop;
			perform public.qorpera_authorize_executor_machine(v_placement.id, v_placement.owner,
				public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256, 'run');
			perform public.qorpera_mark_company_machine_running(v_placement.id, v_placement.owner,
				public.qorpera_company_machine_binding_text(v_placement.binding), v_placement.machine_id_sha256,
				extensions.gen_random_uuid());
		end $$;`,
		// The switch: on for this company, or off, which is how every company starts.
		on
			? `insert into public.qorpera_home_settings(singleton, enabled) values (true, true);
				insert into public.qorpera_home_companies(profile_id)
				select (public.qorpera_describe_native_tool_authority(current_setting('qorpera_test.base_binding')::jsonb)
					#>> '{identity,companyId}')::uuid;`
			: "",
	].join("\n");
}

/**
 * The agent's account on the test machine, made exactly as `deploy/machine/build-machine-image.sh` makes it in the
 * image, with the image's own sudo rule (`deploy/machine/qorpera-agent.sudoers`). Returns how to take it away again:
 * this proof leaves nothing of itself on the test machine.
 */
function agentAccount() {
	const run = (file, args) => execFileSync(file, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
	const rule = "/etc/sudoers.d/qorpera-agent";
	const madeAccount = !existsSync(`/var/lib/${CLOUD_AGENT_ACCOUNT}`) && !hasAccount();
	if (madeAccount) {
		run("/usr/sbin/groupadd", ["--gid", String(CLOUD_AGENT_UID), CLOUD_AGENT_ACCOUNT]);
		run("/usr/sbin/useradd", [
			"--uid", String(CLOUD_AGENT_UID), "--gid", String(CLOUD_AGENT_UID), "--home-dir",
			`/var/lib/${CLOUD_AGENT_ACCOUNT}`, "--create-home", "--shell", "/bin/bash", CLOUD_AGENT_ACCOUNT,
		]);
	}
	const madeRule = !existsSync(rule);
	if (madeRule) {
		run("/usr/bin/install", ["-o", "root", "-g", "root", "-m", "0440",
			join(repositoryRoot, "deploy/machine/qorpera-agent.sudoers"), rule]);
		run("/usr/sbin/visudo", ["-cf", rule]);
	}
	return () => {
		try {
			if (madeRule) execFileSync("/bin/rm", ["-f", rule]);
			if (madeAccount) execFileSync("/usr/sbin/userdel", ["-r", CLOUD_AGENT_ACCOUNT], { stdio: "ignore" });
		} catch {}
	};
}

function hasAccount() {
	try {
		execFileSync("/usr/bin/id", ["-u", CLOUD_AGENT_ACCOUNT], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * The machine, as this proof stands in for it: `codex exec-server --listen stdio` in its own namespaces (user, PID,
 * network, IPC, UTS), with its own /company and home and nothing of the slot, and every line it carries written down.
 * Production runs the same binary inside the run's own company machine, over LXD, as the agent's account.
 *
 * `machine.asAgent` runs it as the agent's own account instead, with the image's own sudo rule in place
 * (`agentAccount` above): a namespace that drops every capability and sets no-new-privileges cannot show what the
 * account may do, and
 * what it may do on its machine is the whole point of the home (13 Nov 2026, the lead's correction). It needs root,
 * so only a run through `run-on-node --sudo` has that scenario.
 */
function standInMachine(machine, logDir, state) {
	const child = machine.asAgent
		? spawn(
				"/usr/bin/setpriv",
				[
					`--reuid=${CLOUD_AGENT_UID}`, `--regid=${CLOUD_AGENT_UID}`, "--init-groups", "--",
					binary, "exec-server", "--listen", "stdio",
				],
				{
					stdio: ["pipe", "pipe", "pipe"],
					cwd: machine.company,
					env: {
						HOME: machine.home, USER: CLOUD_AGENT_ACCOUNT, LOGNAME: CLOUD_AGENT_ACCOUNT,
						CODEX_HOME: join(machine.home, ".codex"), PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
						LANG: "C.UTF-8", TZ: "UTC",
					},
				},
			)
		: spawn(
		"/usr/bin/bwrap",
		[
			"--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
			"--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
			"--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
			"--symlink", "usr/lib64", "/lib64", "--ro-bind", "/etc", "/etc",
			"--ro-bind", binary, binary,
			"--bind", machine.company, "/company",
			"--bind", machine.home, "/home/agent",
			"--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--hostname", "home-machine",
			"--setenv", "HOME", "/home/agent", "--setenv", "USER", "agent",
			"--setenv", "CODEX_HOME", "/home/agent/.codex", "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
			"--setenv", "LANG", "C.UTF-8", "--setenv", "TZ", "UTC",
			"--chdir", "/company",
			"--", binary, "exec-server", "--listen", "stdio",
		],
		{ stdio: ["pipe", "pipe", "pipe"], env: {} },
	);
	child.stderr.on("data", (data) => appendFileSync(join(logDir, "machine-stderr.log"), data));
	const note = (direction) => {
		let rest = "";
		return (chunk) => {
			rest += chunk.toString("utf8");
			let end = rest.indexOf("\n");
			while (end >= 0) {
				const line = rest.slice(0, end);
				rest = rest.slice(end + 1);
				let method = null;
				let decoded = "";
				try {
					const value = JSON.parse(line);
					method = value.method ?? null;
					const chunkOf = value.params?.chunk;
					if (typeof chunkOf === "string") decoded = Buffer.from(chunkOf, "base64").toString("utf8");
					if (typeof value.params?.dataBase64 === "string") decoded += Buffer.from(value.params.dataBase64, "base64").toString("utf8");
				} catch {}
				const canaries = Object.entries(CANARIES).filter(([, value]) => line.includes(value) || decoded.includes(value)).map(([key]) => key);
				state.exec.push({ direction, method, bytes: Buffer.byteLength(line), canaries, line: line.slice(0, 4000), decoded: decoded.slice(0, 1000) });
				end = rest.indexOf("\n");
			}
		};
	};
	const toMachine = note("harness>machine");
	child.stdout.on("data", note("machine>harness"));
	async function* lines() {
		let rest = "";
		for await (const chunk of child.stdout) {
			rest += chunk.toString("utf8");
			let end = rest.indexOf("\n");
			while (end >= 0) {
				yield rest.slice(0, end);
				rest = rest.slice(end + 1);
				end = rest.indexOf("\n");
			}
		}
	}
	return {
		write: (line) => {
			toMachine(Buffer.from(`${line}\n`));
			if (child.stdin.writable) child.stdin.write(`${line}\n`);
		},
		lines: lines(),
		close: async () => {
			child.kill("SIGKILL");
		},
	};
}

/** One run of Alice's (SQL test 924) through the slot, with a home or without, the model making `calls`; `check`
 * judges what was seen. A failed run is returned when `expectFailure`. */
async function scenario(code, built, cluster, name, { home, calls, check, expectFailure = false, asAgent = false }) {
	if (ONLY && !ONLY.has(name)) return;
	process.stdout.write(`\n== scenario ${name}\n`);
	const database = `qorpera_home_${name.replaceAll("-", "_")}`;
	cluster.create(database);
	const db = new Database((sql) => cluster.psql(database, sql, ["-qAt"]));
	// Under the run's own folder, not /tmp: Codex refuses to make its helper aliases in a Codex home under /tmp.
	mkdirSync(join(process.cwd(), ".home-scratch"), { recursive: true });
	const scratch = await mkdtemp(join(process.cwd(), ".home-scratch", `${name}-`));
	const logDir = join(scratch, "logs");
	const machine = { company: join(scratch, "machine/company"), home: join(scratch, "machine/home"), id: undefined, name: undefined, asAgent };
	for (const path of [logDir, join(machine.company, "docs"), join(machine.home, ".codex")]) mkdirSync(path, { recursive: true });
	writeFileSync(join(machine.company, "docs/seed.md"), SEED);
	writeFileSync(join(machine.company, "docs/readme.md"), README);
	writeFileSync(join(machine.company, "pic.png"), png());
	// The machine run as the agent's own account: its folder and home are the account's, as the image's are; the
	// company folder is where the environment says it is (/company, CLOUD_HOME_CWD), bound there for this scenario and
	// unbound after; and one file in it is root's, as a `machine_run` command leaves it.
	let unbind;
	if (machine.asAgent) {
		execFileSync("chown", ["-R", `${CLOUD_AGENT_UID}:${CLOUD_AGENT_UID}`, join(scratch, "machine")]);
		writeFileSync(join(machine.company, "root-owned.txt"), ROOT_OWNED);
		execFileSync("chown", ["root:root", join(machine.company, "root-owned.txt")]);
		execFileSync("chmod", ["0644", join(machine.company, "root-owned.txt")]);
		mkdirSync("/company", { recursive: true });
		execFileSync("mount", ["--bind", machine.company, "/company"]);
		unbind = () => {
			try {
				execFileSync("umount", ["/company"]);
			} catch {}
		};
	}
	const identityRoot = join(scratch, "identity");
	mkdirSync(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
	chmodSync(identityRoot, 0o700);
	writeFileSync(join(identityRoot, "codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: CANARY_AUTH }), { mode: 0o600 });
	const state = { agent: [], calls: [], compactor: [], httpRequests: [], failure: null, items: [], deltas: 0, approvals: [], fence: [], exec: [], reviews: [], logDir, codexHome: join(identityRoot, "codex") };
	let closeIngress;
	fenceTrace = state.fence;
	const server = provider(state, calls);
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const slotDir = join(scratch, "slot");
	mkdirSync(slotDir);
	const modelCatalog = null;
	copyFileSync(built.slot, join(slotDir, "slot.mjs"));
	writeFileSync(
		join(slotDir, "slot.json"),
		JSON.stringify({
			logDir,
			canaries: CANARIES,
			providerBaseUrl: PROVIDER_BASE,
			providerPort: server.address().port,
			codex: binary,
			node: realpathSync(process.execPath),
			entry: built.entry,
			// Whether this run has a home: its socket is the runtime's own, beside the fence's in the scratch root.
			home: home !== undefined,
			modelCatalog,
		}),
	);
	const record = { name, home: { ...home, onApproval: undefined, onItem: undefined, decide: undefined } };
	evidence.scenarios[name] = record;
	try {
		const made = db.json(`${readFileSync(join(repositoryRoot, "supabase/tests/924_folder_runtime_base.test.sql"), "utf8").split("-- The checks start here: a test that runs after this file's fixture part stops at this line.")[0]}
			set local session_replication_role = replica;
			update public.qorpera_execution_runs set memory_mode = 'tree'
			where id = (current_setting('qorpera_test.base_binding')::jsonb ->> 'runId')::uuid;
			set local session_replication_role = origin;
			select pg_temp.base_claims('service_role') \\g /dev/null
			${setup(home !== undefined)}
			select jsonb_build_object('binding', current_setting('qorpera_test.base_binding')::jsonb,
				'home', public.qorpera_company_home_available(current_setting('qorpera_test.base_binding')::jsonb),
				'holderProven', public.qorpera_native_binding_proven(current_setting('qorpera_test.base_binding')::jsonb,
					'job.' || (current_setting('qorpera_test.base_binding')::jsonb ->> 'jobId') || '.${HOLDER_TOKEN}'),
				'nativeBinarySha256', (select bundle.manifest ->> 'nativeBinarySha256' from public.qorpera_active_runtime_bundle active
					join public.qorpera_runtime_bundles bundle on bundle.id = active.runtime_bundle_id))::text;
			commit;`);
		const binding = made.binding;
		// What SQL says of this run's home: the whole truth of it, as the company runtime asks it (parsed by the real
		// parser, so the proof reads it exactly as the runtime does).
		record.home = made.home;
		record.holderProven = made.holderProven;
		const companyHome = code.parseCloudCompanyHome(made.home);
		machine.id = companyHome?.machineId;
		machine.name = companyHome?.machine;
		// The coding executor's ingress, as production runs it: the same token, the same proof of the run's holder, the
		// same SQL authority for the session. Its machine side is this proof's stand-in: `codex exec-server` in a second
		// namespace, where production runs it inside the run's company machine over LXD, as the agent's user.
		const ingressToken = randomBytes(32).toString("base64url");
		const ingress = home
			? new code.HttpCloudCodingCommandService({
					token: ingressToken,
					proveBinding: (bound, held, signal) =>
						code.proveNativeBinding({ call: async (method, args) => db.direct(method, args) }, bound, held, signal),
					authorize: async () => {
						throw new Error("no coding commands in this proof");
					},
					execute: async () => {
						throw new Error("no coding commands in this proof");
					},
					home: {
						authorize: async (asked, signal) => {
							const answer = await code.authorizeHomeSession(
								{ call: async (method, args) => db.direct(method, args) },
								asked,
								signal,
							);
							record.authority = { state: answer.state, reason: answer.reason ?? null };
							return answer;
						},
						open: async (authority) => {
							try {
								const side = standInMachine(machine, logDir, state);
								record.opened = { sessionId: authority.sessionId, machine: authority.machine };
								return side;
							} catch (error) {
								record.openFailed = String(error?.message ?? error).slice(0, 300);
								throw error;
							}
						},
					},
				})
			: undefined;
		const ingressPort = ingress ? await ingress.start(AbortSignal.timeout(20_000)) : 0;
		if (ingress) closeIngress = () => ingress.close();
		// The run's home, exactly as the company runtime builds it: the real host, the real channel client to the
		// ingress above, the run's own review and its work log.
		const homeFactory = home
			? (input) => {
					const built = new code.CloudCodexHome({
						channel: code.createCloudHomeChannel({
							url: `http://127.0.0.1:${ingressPort}/`,
							token: ingressToken,
							binding,
							holder: () => `job.${binding.jobId}.${HOLDER_TOKEN}`,
							allowLoopback: true,
						}),
						sessionId: randomUUID(),
						// Stand-in: this harness's own command is the slot wrapper, so the home names the Codex the
						// namespace really has; in production the session's artifact is that binary.
						program: binary,
						machine: { id: machine.id, name: machine.name },
						review: {
							check: async (action, signal) => {
								const parsed = JSON.parse(action.argumentsText);
								state.reviews.push({
									tool: action.tool,
									callId: action.callId,
									summary: action.summary.slice(0, 200),
									...(parsed.into === undefined ? {} : { into: parsed.into }),
									// The identity an approval covers: the whole action, not the words on the card (F1).
									argumentSha256: action.argumentSha256,
									argumentsBytes: Buffer.byteLength(action.argumentsText),
								});
								const decided = home.decide?.(action);
								if (decided) return decided;
								return await input.review.check(action, signal);
							},
						},
						...(input.log ? { steps: new code.CloudCodexHomeSteps(input.log) } : {}),
						signal: input.signal,
					});
					state.homes.push(built);
					return built;
				}
			: undefined;
		if (home) assert(machine.id, `SQL gave this run no home to reach: ${JSON.stringify(made.home)}`);
		record.homeBuilt = Boolean(homeFactory);
		state.homes = [];
		const session = await attemptRun(code, { db, binding, server, scratch, identityRoot, nativeBinarySha256: made.nativeBinarySha256, state, slotDir, homeFactory });
		record.result = session.error ? { failed: String(session.error?.message ?? session.error) } : { ok: true };
		if (session.error && !expectFailure) throw session.error;
		if (!session.error && expectFailure) throw new Error(`${name} was expected to fail`);
		if (state.failure) throw state.failure;
		const logs = readLogs(logDir);
		record.requests = state.agent.map(({ body }) => requestSummary(body));
		record.firstRaw = state.agent[0]?.raw ?? null;
		record.shown = state.calls.map((call) => {
			const seen = shown(state, call.callId);
			return { callId: call.callId, name: call.custom ?? call.name, bytes: seen?.bytes ?? null, status: seen?.envelope?.status ?? null, text: seen?.text?.slice(0, 4000) ?? seen?.output?.slice(0, 4000) ?? null };
		});
		record.httpRequests = state.httpRequests;
		record.items = state.items;
		record.approvals = state.approvals;
		record.fence = state.fence;
		record.homeCause = state.homes?.map((home) => ({ cause: home.cause ?? null, counts: home.counts })) ?? [];
		process.stdout.write(`home: ${JSON.stringify(record.homeCause)}; reviews ${JSON.stringify(state.reviews)}\n`);
		record.exec = state.exec.map((line) => ({ direction: line.direction, method: line.method, bytes: line.bytes, canaries: line.canaries }));
		record.execMethods = state.exec.reduce((counts, line) => {
			if (line.method) counts[`${line.direction} ${line.method}`] = (counts[`${line.direction} ${line.method}`] ?? 0) + 1;
			return counts;
		}, {});
		record.relay = logs.relay;
		record.slot = logs.slot;
		record.machineStderr = logs.machineStderr.slice(-4000);
		record.codexStderr = logs.codexStderr.slice(-4000);
		const stored = session.error ? null : await storedForms(code, db, session, binding.runId);
		record.stored = stored ? { contextOutputs: stored.contextOutputs, releases: stored.releases, steps: stored.steps, logMissing: stored.logMissing } : null;
		record.review = logs.review;
		await check({ state, logs, record, machine, stored, session, db, binding });
		process.stdout.write(`== scenario ${name}: ${state.agent.length} agent requests, ${state.calls.length} calls\n`);
	} catch (error) {
		const logs = readLogs(logDir);
		process.stdout.write(`scenario ${name} failed: ${error?.stack ?? error}\n`);
		// What the host itself saw, which a failed run never printed before: why a channel would not open, and how
		// much went each way.
		record.homeCause = state.homes?.map((home) => ({ cause: home.cause ?? null, failure: home.failure ?? null, counts: home.counts })) ?? [];
		process.stdout.write(`home: ${JSON.stringify(record.homeCause)}; reviews ${state.reviews.length}; exec lines ${state.exec.length}\n`);
		record.exec = state.exec.map((line) => ({ direction: line.direction, method: line.method, bytes: line.bytes, line: (line.line ?? "").slice(0, 300) }));
		for (const line of state.exec.slice(-12))
			process.stdout.write(`exec ${line.direction} ${line.method ?? "-"} ${(line.line ?? "").slice(0, 200)}\n`);
		for (const refusal of db.refusals) process.stdout.write(`refused ${refusal.slice(0, 400)}\n`);
		process.stdout.write(`codex stderr (last 3000):\n${logs.codexStderr.slice(-3000)}\n`);
		process.stdout.write(`machine stderr (last 3000):\n${logs.machineStderr.slice(-3000)}\n`);
		process.stdout.write(`exec log (last 30 lines):\n${logs.exec.slice(-30).map((line) => JSON.stringify(line).slice(0, 600)).join("\n")}\n`);
		process.stdout.write(`slot log:\n${logs.slot.map((line) => JSON.stringify(line).slice(0, 3000)).join("\n")}\n`);
		throw error;
	} finally {
		await closeIngress?.();
		server.closeAllConnections?.();
		await new Promise((done) => server.close(() => done()));
		unbind?.();
		await rm(scratch, { recursive: true, force: true });
		cluster.drop(database);
	}
}

function readLogs(logDir) {
	const lines = (file) =>
		existsSync(join(logDir, file))
			? readFileSync(join(logDir, file), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	const text = (file) => (existsSync(join(logDir, file)) ? readFileSync(join(logDir, file), "utf8") : "");
	return {
		exec: lines("exec.jsonl"),
		relay: lines("relay.jsonl"),
		slot: lines("slot.jsonl"),
		machineStderr: text("machine-stderr.log"),
		codexStderr: text("codex-stderr.log"),
		review: lines("review.jsonl"),
	};
}

function summarizeExec(lines) {
	const methods = {};
	for (const line of lines) if (line.method) methods[`${line.direction} ${line.method}`] = (methods[`${line.direction} ${line.method}`] ?? 0) + 1;
	return {
		connections: lines.filter((line) => line.event === "connect").length,
		lines: lines.filter((line) => line.direction).length,
		bytes: lines.reduce((sum, line) => sum + (line.bytes ?? 0), 0),
		methods,
		canaryHits: lines.filter((line) => line.canaries?.length).map((line) => ({ direction: line.direction, method: line.method, canaries: line.canaries })),
		starts: lines
			.filter((line) => line.method === "process/start")
			.map((line) => {
				try {
					const params = JSON.parse(line.line).params;
					return { argv: params.argv, cwd: params.cwd, tty: params.tty, pipeStdin: params.pipeStdin, envKeys: Object.keys(params.env ?? {}).sort(), sandbox: params.sandbox ?? null, keys: Object.keys(params).sort() };
				} catch {
					return { cut: true };
				}
			}),
		fs: lines.filter((line) => line.method?.startsWith("fs/")).map((line) => {
			try {
				const params = JSON.parse(line.line).params;
				return { method: line.method, path: params.path ?? params.uri ?? params.sourcePath ?? null, sandbox: params.sandbox ?? null };
			} catch {
				return { method: line.method, cut: true };
			}
		}),
		initialize: lines.find((line) => line.direction === "machine>harness" && line.line?.includes('"environmentInfo"'))?.line ?? null,
	};
}

/** The stored forms of the run: its context views' outputs, its releases and its work log. */
async function storedForms(code, db, session, runId) {
	const contextOutputs = JSON.parse(
		db.query(`select coalesce(jsonb_agg(o), '[]')::text from public.qorpera_native_context_views v,
			jsonb_array_elements(v.view -> 'outputs') o where v.run_id = '${runId}'`),
	);
	const releases = JSON.parse(
		db.query(`select coalesce(jsonb_agg(jsonb_build_object('releaseId', release_id, 'output', output_sha256, 'paths',
			(select coalesce(jsonb_agg(r ->> 'path'), '[]') from jsonb_array_elements(reads) r))), '[]')::text
			from public.qorpera_folder_run_read_records where run_id = '${runId}'`),
	);
	// A run whose only steps are Codex's own keeps no log at all (none of them is a step).
	const log = await runLog(code, db, session, runId).catch((error) => ({ missing: String(error?.message ?? error), steps: [], index: [] }));
	const steps = log.steps.map(({ value }) => ({ j: value.j, tool: value.tool ?? null, call: value.call ?? value.callId ?? null }));
	return { contextOutputs, releases, steps, index: log.index, logMissing: log.missing ?? null };
}

async function attemptRun(code, { db, binding, scratch, identityRoot, nativeBinarySha256, state, slotDir, homeFactory }) {
	const paths = new code.HttpCloudCompanyPathControl({
		supabaseUrl: "https://postgrest.stand-in.invalid/",
		serviceRoleKey: "stand-in",
		fetch: postgrestFetch(db),
	});
	const objects = textObjects([README]);
	const lane = { ms: 15, gets: 0, inFlight: 0, most: 0, busy: 0, objects: new Set() };
	const compactor = new code.MemoryCompactChannel();
	const compactLane = new code.MemoryCompactLane();
	let runWork;
	let opened = null;
	let folder;
	let admitted;
	const prompt = "P1: work on the company's files on your machine.";
	try {
		await code.runCloudNativeRunToolSession({
			binding,
			controlPlane: controlPlane(db),
			beginExecution: async (specification, signal) => {
				const identity = db.direct("qorpera_describe_native_tool_authority", { p_binding: binding }).identity;
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
					fetch: gatewayFetch(db, objects, lane),
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
					lines: { call: (system, signal) => compactor.call(system, signal), lane: compactLane },
				});
				runWork = opened.composeContext;
				return {
					tools: [...code.cloudFolderFileTools({ folder, operations, identity })],
					assertContext: (signal, timeoutMs) => gateway.assertReadableContext(signal, timeoutMs),
					checkRun: (signal, timeoutMs) => gateway.checkRun(signal, timeoutMs),
					recordContextView: (frame, outputs, signal) => gateway.recordContextView(frame, outputs, signal),
					fenceContextView: (frame, outputs, signal) => gateway.fenceContextView(frame, outputs, signal),
					runLog: { log: opened.log, lines: opened.lines },
				};
			},
			composeContext: async (request, signal) => {
				const composed = runWork ? await runWork(request, signal) : code.cloudNativeContextIdentity(request);
				state.compositions = (state.compositions ?? 0) + 1;
				const kept = new Set(composed.input.filter((entry) => "keep" in entry).map((entry) => entry.keep));
				const left = request.items.filter((item, at) => !kept.has(at) && (item.kind === "function_call_output" || item.kind === "custom_tool_call_output"));
				(state.folds ??= []).push({
					items: request.items.length,
					kept: kept.size,
					work: composed.input.some((entry) => "work" in entry),
					leftOutputs: left.map((item) => item.callId),
				});
				return composed;
			},
			compactor,
			...(homeFactory ? { home: homeFactory } : {}),
			command: [process.execPath, join(slotDir, "slot.mjs")],
			binarySha256: sha256(readFileSync(process.execPath)),
			identityRoot,
			prompt,
			signal: AbortSignal.timeout(150_000),
			timeoutMs: 140_000,
		});
	} catch (error) {
		return { error, folder, paths, identity: admitted };
	}
	void scratch;
	return { folder, paths, identity: admitted };
}

// ---- The scenarios -------------------------------------------------------------------------------------------------

const exec = (args) => () => ({ name: "exec_command", arguments: args });
/** A write into the shell the last command left running: its session id, as Codex's own output names it. */
const stdin = (outputs, chars) => {
	const id = outputs.map((output) => /session ID (\d+)|"session_id"\s*:\s*(\d+)/i.exec(output.output)).filter(Boolean).at(-1);
	if (!id) throw new Error(`no running shell to type into: ${outputs.map((output) => output.output.slice(0, 300)).join(" | ")}`);
	return { name: "write_stdin", arguments: { session_id: Number(id[1] ?? id[2]), chars, yield_time_ms: 500 } };
};
/** The slot's scratch root, from the bwrap arguments the slot logged (its workspace is the namespace's --chdir). */
const slotRootOf = (state) => {
	const bwrap = readFileSync(join(state.logDir, "slot.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.find((line) => line.bwrap)?.bwrap;
	return bwrap[bwrap.indexOf("--chdir") + 1].replace(/\/workspace$/, "");
};
const tty = (state) => {
	const spec = toolsOf(state.agent[0]?.body ?? { input: [] }).find((tool) => tool.name === "exec_command");
	return spec?.parameters?.properties?.tty ? { tty: true } : {};
};
const BIG = "seq 1 60000 | sed 's/$/ is a line of a long output, to see where it is cut/'";
const HUNT = [
	"echo HOST $(hostname) USER $(id -un) UID $(id -u)",
	"echo '--- env'; env | sort",
	"echo '--- slot paths'; for p in \"$P1_ROOT\" \"$P1_HOME\" \"$P1_HOME/auth.json\"; do ls -la \"$p\" 2>&1 | head -3; done",
	"echo '--- auth.json and environments.toml anywhere'; find / -xdev \\( -name auth.json -o -name environments.toml -o -name '*.sock' \\) 2>/dev/null | head -20",
	"echo '--- every process environment and command line'; for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null; tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -cE 'HOMECANARY-(auth|env)-[0-9a-f]{32}'",
	"echo '--- files holding the canary'; grep -rIlE 'HOMECANARY-(auth|env)-[0-9a-f]{32}' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=usr --exclude-dir=dev 2>/dev/null | head",
	"echo '--- reach the slot: unix sockets and the network'; (exec 3<>/dev/tcp/127.0.0.1/80) 2>&1 | head -2; ip -brief addr 2>/dev/null || cat /proc/net/dev",
].join("; ");

const PATCH = [
	"*** Begin Patch",
	"*** Add File: notes/plan.md",
	"+# Plan",
	"+",
	"+Written by apply_patch on the machine.",
	"*** Update File: docs/seed.md",
	"@@",
	" The first line of the seed.",
	"-A line apply_patch will change.",
	"+A line changed by apply_patch.",
	" The last line.",
	"*** End Patch",
	"",
].join("\n");

/** What the switch-off run sent, so the switch-on run can be read against it. */
let switchOff;

/** A file on the machine as a `machine_run` command leaves it: root's own, in the company folder. */
const ROOT_OWNED = "written by a machine_run command, which runs as root on a company machine\n";

async function main() {
	if (!binary) {
		process.stdout.write("NOT RUN: set QORPERA_CODEX_FENCE_BINARY to the patched Codex this tree pins\n");
		return;
	}
	process.stdout.write(`Codex ${binary}: sha256 ${sha256(readFileSync(binary))}\nnode ${realpathSync(process.execPath)} ${process.version}\n`);
	const scratch = await mkdtemp(join(tmpdir(), "p1-build-"));
	const built = await bundles(scratch);
	// Every fenced batch: what Codex sent (before the host's envelope) and what was released to the model.
	const original = built.code.CloudNativeToolBoundary.prototype.fenceNativeResults;
	built.code.CloudNativeToolBoundary.prototype.fenceNativeResults = async function (inputs, fence) {
		const released = await original.call(this, inputs, fence);
		fenceTrace?.push(
			inputs.map((input, at) => {
				const wire = typeof input.output === "string" ? input.output : JSON.stringify(input.output);
				let envelope = null;
				try {
					envelope = JSON.parse(released[at].output);
				} catch {}
				return {
					callId: input.callId,
					kind: input.kind,
					sentBytes: Buffer.byteLength(wire),
					releasedBytes: Buffer.byteLength(released[at].output),
					status: envelope?.status ?? null,
					tool: envelope?.provenance?.tool ?? null,
					originalBytes: envelope?.content?.originalBytes ?? null,
					includedBytes: envelope?.content?.includedBytes ?? null,
					truncated: envelope?.content?.truncated ?? null,
				};
			}),
		);
		return released;
	};
	const database = await hostedDatabase("qorpera_p1_base");
	const cluster = database.cluster;
	const failed = [];
	const run = async (name, options) => {
		try {
			await scenario(built.code, built, cluster, name, options);
		} catch (error) {
			failed.push(name);
			process.stdout.write(`FAIL scenario ${name}: ${String(error?.message ?? error).slice(0, 2000)}\n`);
		}
	};
	try {
		// 1. The switch off: a run is EXACTLY as it is on master. The same calls are made with the switch on below, so
		// the two first requests can be compared line by line.
		await run("switch-off", {
			calls: [() => ({ namespace: "qorpera", name: "company_read", arguments: { path: "docs/readme.md" } })],
			check: async ({ record, state }) => {
				const first = record.requests[0];
				assert(!first.tools.some((tool) => tool.namespace !== "qorpera"), "only our own tools are offered");
				assert.equal(record.home?.available, false, `SQL says this run has no home: ${JSON.stringify(record.home)}`);
				assert.equal(shown(state, state.calls[0].callId)?.envelope?.status, "ok");
				assert.equal(record.exec.length, 0, "nothing reached a machine");
				switchOff = { request: record.firstRaw, tools: first.tools, toolsBytes: first.toolsBytes, input: first.input };
				pass(`the switch off: the provider's first request offers only our ${first.tools.length} tools (${first.toolsBytes} B), SQL says the run has no home, and no byte reached a machine`);
			},
		});

		// 2. The switch on: Codex's own tools reach the machine through the whole channel, and work there.
		await run("home", {
			home: {},
			calls: [
				exec({ cmd: "pwd; id -un; hostname; cat /company/docs/seed.md" }),
				() => ({ custom: "apply_patch", input: PATCH }),
				exec({ cmd: "cat /company/notes/plan.md; echo ---; cat /company/docs/seed.md" }),
				() => ({ namespace: "qorpera", name: "company_read", arguments: { path: "docs/readme.md" } }),
			],
			check: async ({ state, record, machine, stored }) => {
				const first = record.requests[0];
				const own = first.tools.filter((tool) => tool.namespace !== "qorpera");
				for (const name of ["exec_command", "write_stdin", "apply_patch"])
					assert(own.some((tool) => tool.name === name), `${name} is offered: ${own.map((tool) => tool.name).join(",")}`);
				assert(!own.some((tool) => tool.name === "view_image"), "view_image is not offered, so its turn cannot die");
				assert.equal(record.home?.available, true);
				assert.equal(record.authority?.state, "authorized", `the ingress authorized the session: ${JSON.stringify(record.authority)}`);
				const t0 = shown(state, state.calls[0].callId)?.text ?? "";
				assert(t0.includes("/company") && t0.includes("home-machine") && t0.includes("The first line of the seed."), t0);
				assert(readFileSync(join(machine.company, "notes/plan.md"), "utf8").includes("Written by apply_patch"));
				assert(readFileSync(join(machine.company, "docs/seed.md"), "utf8").includes("A line changed by apply_patch."));
				assert.equal(shown(state, state.calls[3].callId)?.envelope?.status, "ok", "our own tools still answer");
				pass(`the switch on: Codex's own tools are offered (${own.map((tool) => `${tool.namespace}.${tool.name}`).join(", ")}; ${first.toolsBytes} B of tools) and run on the machine through the host, the channel, the ingress and SQL's authority for session ${record.opened?.sessionId?.slice(0, 8)}: a command answered from ${t0.match(/home-machine/) ? "home-machine" : "?"}, apply_patch changed two files there, and company_read still answers`);
				// 3. The run's work log holds a step for each of Codex's own calls.
				const steps = stored.steps.filter((step) => ["exec_command", "apply_patch"].includes(step.tool));
				assert(steps.length >= 3, `native steps in the log: ${JSON.stringify(stored.steps)}`);
				for (const call of state.calls.filter((call) => !call.namespace))
					assert(stored.steps.some((step) => step.call === call.callId), `${call.callId} is a step`);
				pass(`the work log holds Codex's own work: ${stored.steps.length} steps (${stored.steps.map((step) => `${step.j}:${step.tool}`).join(", ")}), one per call of its own, each with the envelope the model was shown`);
				// What the provider sees with the switch on, against the switch off (when that scenario ran too).
				if (!switchOff) return;
				const same = JSON.parse(switchOff.request);
				const now = JSON.parse(record.firstRaw);
				const ours = (body) => body.input.filter((item) => item.type !== "additional_tools").map((item) => Buffer.byteLength(JSON.stringify(item)));
				note(`what the provider sees, switch off against switch on: tools ${switchOff.toolsBytes} B -> ${first.toolsBytes} B; the items that are not the tool list ${JSON.stringify(ours(same))} -> ${JSON.stringify(ours(now))}`);
			},
		});

		// 4. The review at the host: a declined command never reaches the machine.
		await run("review", {
			home: {
				// What the run's own review gate would answer for this action. A command Codex itself refuses by its own
				// policy (`rm -rf`) never reaches this host at all, so the proof declines what Codex allows: a command, a
				// line typed into a running shell, and a patch.
				decide: (action) =>
					/declined\.txt|forbidden-typed|declined\.md/.test(action.argumentsText)
						? { run: false, text: "REVIEW_DENIED: this action was not allowed. The action did not happen. Do not retry it." }
						: undefined,
			},
			calls: [
				exec({ cmd: "touch /company/reviewed.txt && echo touched" }),
				exec({ cmd: "touch /company/declined.txt && echo oops" }),
				exec({ cmd: "ls /company" }),
				// A shell that keeps running, and what the model types into it (review round 1, F2).
				(_outputs, state) => ({ name: "exec_command", arguments: { cmd: "cat > /company/typed.txt", yield_time_ms: 1000, ...tty(state) } }),
				(outputs) => stdin(outputs, "typed by the model\n"),
				(outputs) => stdin(outputs, "forbidden-typed\n"),
				(outputs) => stdin(outputs, "\u0004"),
				// A patch the review declines, and one it allows: each reviewed once, whole.
				() => ({ custom: "apply_patch", input: "*** Begin Patch\n*** Add File: notes/declined.md\n+never written\n*** End Patch\n" }),
				() => ({ custom: "apply_patch", input: "*** Begin Patch\n*** Add File: notes/allowed.md\n+written once reviewed\n*** Add File: notes/also.md\n+the same patch\n*** End Patch\n" }),
			],
			check: async ({ state, record, machine }) => {
				assert(existsSync(join(machine.company, "reviewed.txt")), "the allowed command ran");
				assert(!existsSync(join(machine.company, "declined.txt")), "the declined command did not");
				const declined = shown(state, state.calls[1].callId)?.text ?? "";
				assert(declined.includes("REVIEW_DENIED"), declined);
				const starts = state.exec.filter((line) => line.method === "process/start");
				assert(!state.exec.some((line) => line.line.includes("declined.txt")), "no line of the declined command reached the machine");
				const listed = shown(state, state.calls[2].callId)?.text ?? "";
				assert(listed.includes("reviewed.txt") && !listed.includes("declined.txt"), listed);
				for (const review of state.reviews)
					assert(review.argumentSha256?.length === 64 && review.argumentsBytes >= review.summary.length,
						`each review's identity is the whole action, not the card's words: ${JSON.stringify(review)}`);
				const commands = state.reviews.filter((review) => review.tool === "home_command" && review.summary.startsWith("touch "));
				pass(`the review at the host: ${commands.length} commands were reviewed before the machine saw them (${commands.map((review) => review.summary.slice(0, 48)).join("; ")}); the declined one never reached it, the machine's own listing shows reviewed.txt and no declined.txt, and the model was told ${JSON.stringify(declined.slice(0, 90))}`);
				// What the model typed into the running shell: each line reviewed with the shell it went into.
				const typed = readFileSync(join(machine.company, "typed.txt"), "utf8");
				assert(typed.includes("typed by the model") && !typed.includes("forbidden-typed"), `typed.txt: ${JSON.stringify(typed)}`);
				const writes = state.reviews.filter((review) => review.into !== undefined);
				assert(writes.some((review) => review.summary === "typed by the model\n" && review.into?.command === "cat > /company/typed.txt"),
					`the line typed was reviewed with its shell: ${JSON.stringify(writes)}`);
				const refusedTyping = shown(state, state.calls[5].callId)?.text ?? "";
				assert(refusedTyping.includes("REVIEW_DENIED"), `the model was told its typing was declined: ${refusedTyping.slice(0, 300)}`);
				assert(!state.exec.some((line) => line.method === "process/write" && line.decoded.includes("forbidden-typed")),
					"no byte of the declined typing reached the machine");
				// The patches: the declined one wrote nothing; the allowed one wrote both files after ONE review.
				assert(!existsSync(join(machine.company, "notes/declined.md")), "the declined patch wrote nothing");
				const refusedPatch = shown(state, state.calls[7].callId)?.text ?? shown(state, state.calls[7].callId)?.output ?? "";
				const told = refusedPatch.includes("REVIEW_DENIED");
				assert(readFileSync(join(machine.company, "notes/allowed.md"), "utf8").includes("written once reviewed"));
				assert(existsSync(join(machine.company, "notes/also.md")), "the allowed patch wrote both its files");
				const allowedReviews = state.reviews.filter((review) => review.callId === state.calls[8].callId);
				assert.equal(allowedReviews.length, 1, `one review for the whole patch: ${JSON.stringify(allowedReviews)}`);
				assert(allowedReviews[0].summary === "Change 2 files: notes/allowed.md, notes/also.md", allowedReviews[0].summary);
				pass(`the review covers what is typed and what is patched: ${writes.length} lines typed into a running shell were reviewed with the shell they went into (the declined one never reached the machine, and the model was told REVIEW_DENIED); a patch of 2 files was reviewed once, whole ("${allowedReviews[0].summary}"), and the declined patch wrote nothing${told ? ", its refusal reaching the model in the review's words" : ` (the model was shown ${JSON.stringify(refusedPatch.slice(0, 160))})`}`);
				if (!told) note(`a declined patch: Codex gave the model ${JSON.stringify(refusedPatch.slice(0, 600))}`);
				record.reviewDetail = { writes, allowedReviews, refusedPatch: refusedPatch.slice(0, 2000) };
			},
		});
		// 5. The two identities on a machine (13 Nov 2026): Codex's own shell is the agent's account, and through it the
		// agent can do everything a `machine_run` command can do there as root — including changing a file root wrote.
		// It needs the real account and the image's own sudo rule, so this scenario runs only as root.
		if (!AS_ROOT) {
			note("the two identities were not proven in this run: it is not root (run it again with run-on-node --sudo and P1_ONLY=home-root)");
		} else {
			const undoAccount = agentAccount();
			try {
				await run("home-root", {
					home: {},
					asAgent: true,
					calls: [
						exec({ cmd: "id -un; sudo -n id -u; sudo -n install -o root -g root -m 0644 /dev/null /etc/qorpera-home-proof && stat -c %U /etc/qorpera-home-proof; sudo -n rm -f /etc/qorpera-home-proof" }),
						exec({ cmd: "cd /company; echo 'from the agent, plainly' >> root-owned.txt; echo plain-rc=$?; echo 'from the agent, as root' | sudo -n tee -a root-owned.txt >/dev/null; echo sudo-rc=$?; stat -c '%U %a' root-owned.txt; cat root-owned.txt" }),
					],
					check: async ({ state, machine }) => {
						const own = shown(state, state.calls[0].callId)?.text ?? "";
						assert(own.includes(CLOUD_AGENT_ACCOUNT), `Codex's own shell runs as the agent's account: ${own}`);
						assert(/(^|\n)0(\n|$)/.test(own) && own.includes("root"), `and reaches root with sudo: ${own}`);
						const both = shown(state, state.calls[1].callId)?.text ?? "";
						assert(both.includes("plain-rc=1"), `a plain write to a file root wrote is refused: ${both}`);
						assert(both.includes("sudo-rc=0"), `the same write through sudo works: ${both}`);
						assert(both.includes("root 644"), `and the file is still root's: ${both}`);
						const kept = readFileSync(join(machine.company, "root-owned.txt"), "utf8");
						assert(kept.includes("from the agent, as root") && !kept.includes("plainly"), kept);
						assert.equal(state.reviews.length, 2, `both went through the review: ${JSON.stringify(state.reviews)}`);
						pass(`the two identities on one machine: Codex's own shell is ${CLOUD_AGENT_ACCOUNT} and reaches root through the image's own sudo rule (it installed a file under /etc as root); a file a machine_run command wrote as root refuses its plain write (plain-rc=1) and takes the same write through sudo (sudo-rc=0), staying root's own`);
					},
				});
			} finally {
				undoAccount();
			}
		}
	} finally {
		database.close();
		await rm(scratch, { recursive: true, force: true });
		// Flushed before the process ends: a pipe takes 64 KiB at a time, and finish() exits at once.
		await new Promise((done) => process.stdout.write(`P1_EVIDENCE_BEGIN\n${JSON.stringify(evidence)}\nP1_EVIDENCE_END\n`, done));
	}
	if (failed.length) throw new Error(`scenarios failed: ${failed.join(", ")}`);
}

finish(main());
