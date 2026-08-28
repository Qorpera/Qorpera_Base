const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { connect } = require("node:net");
const { createInterface } = require("node:readline");

const mode = process.argv[2];
const evidencePath = process.argv[3];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const threadId = "thread_fixture";
const turnId = "turn_fixture";
const configuration = {};
let threadParameters;
let turnParameters;
const companyOutputs = [];
const companyCalls = mode === "company-silent" || mode === "company-no-send"
	? [{ tool: "company_read", arguments: { path: "note.md", offset: 0, limit: 256 } }]
	: [
		{ tool: "send_message", arguments: { idempotencyKey: "progress", text: "Checking the company note.", phase: "progress" } },
		{ tool: "company_read", arguments: { path: "note.md", offset: 0, limit: 256 } },
		{ tool: "send_message", arguments: { idempotencyKey: "final", text: "The company note has been checked.", phase: "final" } },
		{ tool: "send_message", arguments: { idempotencyKey: "final", text: "The company note has been checked.", phase: "final" } },
	];
const companyCall = (index) => write({ id: `company_request_${index}`, method: "item/tool/call", params: {
	threadId, turnId, callId: `company_call_${index}`, namespace: "qorpera", ...companyCalls[index],
} });
const args = process.argv.slice(4);
for (let index = 0; index < args.length; index++) {
	if (args[index] !== "-c") continue;
	const setting = args[++index];
	const equal = setting.indexOf("=");
	const path = setting.slice(0, equal).split(".");
	let target = configuration;
	for (const key of path.slice(0, -1)) target = target[key] ??= {};
	target[path[path.length - 1]] = path.join(".") === "features.code_mode"
		? { enabled: false, direct_only_tool_namespaces: ["qorpera"], excluded_tool_namespaces: ["skills"] }
		: JSON.parse(setting.slice(equal + 1));
}
const done = () => write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
const fence = (outputs = [], patch = {}) => new Promise((resolve, reject) => {
	const request = Buffer.from(JSON.stringify({ schema: "qorpera.native-result-fence/v1", requestId: randomUUID(), threadId, turnId, purpose: "turn", outputs, ...patch }));
	const size = Buffer.alloc(4);
	size.writeUInt32BE(request.length);
	const socket = connect(process.env.QORPERA_NATIVE_RESULT_FENCE_SOCKET);
	let result = Buffer.alloc(0);
	let completed = false;
	socket.on("connect", () => socket.write(Buffer.concat([size, request])));
	socket.on("error", reject);
	socket.on("data", (chunk) => {
		result = Buffer.concat([result, chunk]);
		if (result.length > 4 && result.length === result.readUInt32BE() + 4) {
			completed = true;
			resolve(JSON.parse(result.subarray(4).toString()));
			socket.end();
		}
	});
	socket.on("close", () => { if (!completed) reject(new Error("Fence closed")); });
});

if (mode === "descendant") {
	spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(evidencePath)},'UNEXPECTED_DESCENDANT_EFFECT'),1500);setTimeout(()=>{},10000);`], { stdio: "ignore" });
}

async function handle(message) {
	if (message.method === "initialize") {
		if (mode === "stalled" || mode === "descendant") return;
		if (mode === "invalid-json") { process.stdout.write("PRIVATE_BAD_WIRE\n"); return; }
		if (mode === "oversized") { process.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
		if (mode === "wire-budget") { process.stderr.write("x".repeat(17 * 1024 * 1024)); return; }
		if (mode === "missing-result") { write({ id: message.id }); return; }
		write({ id: message.id, result: { userAgent: `qorpera_cloud_boundary/${mode === "wrong-version" ? "0.146.0" : "0.147.0"} (fixture)${mode === "missing-fence" ? "" : " qorpera.native-result-fence/v1"}` } });
	} else if (message.method === "config/read") {
		if (mode === "unsafe-config") configuration.features.shell_tool = true;
		if (mode === "extra-mcp") configuration.mcp_servers.uncontrolled = { url: "http://uncontrolled.invalid/mcp" };
		if (mode === "unsafe-code-mode") configuration.features.code_mode.enabled = true;
		if (mode === "nested-cloud-tools") configuration.features.code_mode.direct_only_tool_namespaces = [];
		if (mode === "skill-route") configuration.orchestrator.skills.enabled = true;
		write({ id: message.id, result: { config: configuration } });
	} else if (message.method === "skills/list") {
		write({ id: message.id, result: { data: [{ skills: mode === "extra-skills" ? [{ name: "PRIVATE_UNCONTROLLED_SKILL" }] : [], errors: [] }] } });
	} else if (message.method === "thread/start") {
		threadParameters = message.params;
		if (mode === "prewarm-before-thread") await fence([], { turnId: "", purpose: "prewarm" });
		write({ id: message.id, result: { thread: { id: threadId } } });
	} else if (message.method === "turn/start") {
		turnParameters = message.params;
		const notification = { method: "turn/started", params: { threadId, turn: { id: turnId } } };
		if (mode === "fence-before-started") await fence();
		if (mode === "notify-first") write(notification);
		write({ id: message.id, result: { turn: { id: turnId } } });
		if (mode !== "notify-first") write(notification);
		if (mode !== "fence-before-started" && mode !== "skip-fence") await fence([], {
			...(mode === "wrong-fence-thread" ? { threadId: "other_thread" } : {}),
			...(mode === "wrong-fence-turn" ? { turnId: "other_turn" } : {}),
		});
		if (mode.startsWith("company-")) {
			companyCall(0);
		} else if (mode === "wrong-thread" || mode === "wrong-turn" || mode === "wrong-namespace" || mode === "pending-tool" || mode === "cloud-tool") {
			write({ id: "tool_request", method: "item/tool/call", params: { threadId: mode === "wrong-thread" ? "other_thread" : threadId, turnId: mode === "wrong-turn" ? "other_turn" : turnId, callId: "call_1", namespace: mode === "wrong-namespace" ? "other_namespace" : "qorpera", tool: "read_document", arguments: {} } });
			if (mode === "pending-tool") done();
		} else if (mode === "approval") {
			write({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId, turnId, command: "PRIVATE_APPROVAL_COMMAND" } });
		} else if (mode === "failed-turn") {
			write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error: { message: "PRIVATE_PROVIDER_ERROR" } } } });
		} else if (mode === "duplicate-id" || mode === "callback-budget") {
			for (let index = 0; index < (mode === "duplicate-id" ? 2 : 257); index++)
				write({ id: mode === "duplicate-id" ? "duplicate" : `denied_${index}`, method: "item/commandExecution/requestApproval", params: {} });
		} else {
			write({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "PRIVATE_OUTPUT_CANARY" } });
			write({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, delta: "PRIVATE_REASONING_CANARY" } });
			done();
		}
	} else if (typeof message.id === "string" && message.id.startsWith("company_request_") && mode.startsWith("company-")) {
		const index = Number(message.id.slice("company_request_".length));
		companyOutputs.push({ kind: "function_call_output", callId: `company_call_${index}`, output: message.result.contentItems[0].text });
		const fenced = await fence(companyOutputs);
		if (index + 1 < companyCalls.length) companyCall(index + 1);
		else {
			writeFileSync(evidencePath, JSON.stringify({ threadParameters, turnParameters, fenced, outputs: companyOutputs, cwd: process.cwd(), environmentKeys: Object.keys(process.env) }));
			write({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "PRIVATE_OUTPUT_CANARY" } });
			write({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, delta: "PRIVATE_REASONING_CANARY" } });
			done();
		}
	} else if (message.id === "approval") {
		writeFileSync(evidencePath, JSON.stringify(message));
		done();
	} else if (message.id === "tool_request" && mode === "cloud-tool") {
		const fenced = await fence([{ kind: "function_call_output", callId: "call_1", output: message.result.contentItems[0].text }]);
		writeFileSync(evidencePath, JSON.stringify({ threadParameters, reply: message, fenced }));
		write({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "PRIVATE_OUTPUT_CANARY" } });
		write({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, delta: "PRIVATE_REASONING_CANARY" } });
		done();
	}
}
createInterface({ input: process.stdin }).on("line", (line) => {
	void handle(JSON.parse(line)).catch(() => process.exit(126));
});
