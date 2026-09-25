const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
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
const companyCalls = mode === "company-office"
	? [
		{ tool: "send_message", arguments: { idempotencyKey: "progress", text: "Checking the office workbench.", phase: "progress" } },
		{ tool: "computer_shell", arguments: { operationKey: "office-check", action: { kind: "shell", command: "printf office", timeoutMs: 1000 } } },
		{ tool: "send_message", arguments: { idempotencyKey: "final", text: "The office check is complete.", phase: "final" } },
	]
	: mode === "company-cards"
	? [
			{ tool: "send_message", arguments: { idempotencyKey: "progress", text: "Setting up the Slack digest.", phase: "progress" } },
			{ tool: "ask_member", arguments: { idempotencyKey: "channel", text: "One thing to decide first.", surface: "question", title: "Which channel should the digest go to?", payload: { options: [{ label: "#general", value: "general" }, { label: "#finance", value: "finance", style: "primary" }] } } },
			{ tool: "ask_member", arguments: { idempotencyKey: "channel", text: "One thing to decide first.", surface: "question", title: "Which channel should the digest go to?", payload: { options: [{ label: "#general", value: "general" }, { label: "#finance", value: "finance", style: "primary" }] } } },
		]
	: mode === "company-cards-retry"
	? [
			// What the live model sent (options as plain strings), then the card its refusal asked for.
			{ tool: "ask_member", arguments: { idempotencyKey: "fruit", text: "Pick one.", surface: "question", title: "Apples or pears?", payload: { options: ["Apples", "Pears"] } } },
			{ tool: "ask_member", arguments: { idempotencyKey: "fruit", text: "Pick one.", surface: "question", title: "Apples or pears?", payload: { options: [{ label: "Apples" }, { label: "Pears" }] } } },
		]
	: mode === "company-silent" || mode === "company-no-send" || mode === "company-worker"
	? [{ tool: "company_read", arguments: { path: "note.md", offset: 0, limit: 256 } }]
	: mode === "company-secret"
		? [
			{ tool: "send_message", arguments: { idempotencyKey: "progress", text: "Filing the company issue.", phase: "progress" } },
			{ tool: "linear_issue_create", arguments: { idempotencyKey: "login-broken", input: { title: "Login is broken" } } },
			{ tool: "send_message", arguments: { idempotencyKey: "final", text: "The company issue was filed.", phase: "final" } },
		]
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
const sendEvidence = { reply: null, fenced: null, interrupt: null, pending: null };
// Auto-review (v115): a reviewer thread started while the agent's tool call is open.
const reviewThreadId = "thread_review";
const reviewTurnId = "turn_review";
const reviewEvidence = { reviewerThread: null, reviewerTurn: null, prewarm: null, verdictReply: null, closingFence: null, interrupt: null };
const usage = (total = {}, last = {}) => ({
	total: { inputTokens: 23, outputTokens: 7, cachedInputTokens: 3, cacheWriteInputTokens: 5, reasoningOutputTokens: 2, totalTokens: 30, ...total },
	last: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3, ...last },
	modelContextWindow: 8192,
});
const tokenUpdate = (tokenUsage = usage(), patch = {}) => write({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage, ...patch } });
const nativeError = (codexErrorInfo, willRetry, patch = {}) => write({ method: "error", params: {
	threadId, turnId, willRetry, error: { message: "PRIVATE_PROVIDER_ERROR", additionalDetails: "PRIVATE_PROVIDER_DETAILS", codexErrorInfo }, ...patch,
} });
const failed = (error = { message: "PRIVATE_PROVIDER_ERROR" }) => write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error } } });
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
		// Far more diagnostics than the removed 16 MiB output cap; the turn still completes.
		if (mode === "wire-flood") process.stderr.write("x".repeat(17 * 1024 * 1024));
		if (mode === "missing-result") { write({ id: message.id }); return; }
		write({ id: message.id, result: { userAgent: `qorpera_cloud_boundary/${mode === "wrong-version" ? "0.146.0" : "0.155.1"} (fixture)${mode === "capture-image" ? " qorpera.native-capture-images/v1" : ""}${mode === "missing-composition" ? "" : " qorpera.native-message-composition/v1"}${mode === "missing-fence" ? "" : " qorpera.native-result-fence/v1"}${mode === "missing-fence" || mode === "missing-direct-tools" ? "" : " qorpera.native-direct-tools/v1"}` } });
	} else if (message.method === "config/read") {
		if (mode === "unsafe-config") configuration.features.shell_tool = true;
		if (mode === "extra-mcp") configuration.mcp_servers.uncontrolled = { url: "http://uncontrolled.invalid/mcp" };
		if (mode === "unsafe-code-mode") configuration.features.code_mode.enabled = true;
		if (mode === "nested-cloud-tools") configuration.features.code_mode.direct_only_tool_namespaces = [];
		if (mode === "skill-route") configuration.orchestrator.skills.enabled = true;
		write({ id: message.id, result: { config: configuration } });
	} else if (message.method === "skills/list") {
		write({ id: message.id, result: { data: [{ skills: mode === "extra-skills" ? [{ name: "PRIVATE_UNCONTROLLED_SKILL" }] : [], errors: [] }] } });
	} else if (message.method === "thread/start" && mode.startsWith("review") && threadParameters) {
		reviewEvidence.reviewerThread = message.params;
		reviewEvidence.prewarm = await fence([], { threadId: reviewThreadId, turnId: "", purpose: "prewarm" });
		write({ id: message.id, result: { thread: { id: reviewThreadId } } });
	} else if (message.method === "turn/start" && mode.startsWith("review") && message.params.threadId === reviewThreadId) {
		reviewEvidence.reviewerTurn = message.params;
		write({ id: message.id, result: { turn: { id: reviewTurnId } } });
		write({ method: "turn/started", params: { threadId: reviewThreadId, turn: { id: reviewTurnId } } });
		await fence([], { threadId: reviewThreadId, turnId: reviewTurnId });
		// The reviewer's text never matters; only its verdict tool call does.
		write({ method: "item/agentMessage/delta", params: { threadId: reviewThreadId, turnId: reviewTurnId, delta: "PRIVATE_REVIEW_CANARY" } });
		if (mode === "review-no-verdict") {
			write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: "completed", error: null } } });
			return;
		}
		if (mode === "review-wrong-tool") {
			// The reviewer reaches for the agent's tool: refused, and no verdict follows.
			write({ id: "reviewer_wrong_tool", method: "item/tool/call", params: {
				threadId: reviewThreadId, turnId: reviewTurnId, callId: "wrong_1", namespace: "qorpera", tool: "send_email", arguments: { to: "x@evil.test" },
			} });
			return;
		}
		write({ id: "verdict_request", method: "item/tool/call", params: {
			threadId: reviewThreadId, turnId: reviewTurnId, callId: "verdict_1", namespace: "qorpera", tool: "review_verdict",
			arguments: { decision: "allow", ruleIds: [], builtIn: "none", reason: "Fine.", proposedRule: "" },
		} });
	} else if (message.method === "thread/start") {
		threadParameters = message.params;
		if (mode === "bootstrap") {
			const path = join(message.params.cwd, "AGENTS.md");
			writeFileSync(evidencePath, JSON.stringify({
				bootstrap: readFileSync(path, "utf8"),
				mode: statSync(path).mode & 0o777,
				threadParameters,
			}));
		}
		if (mode === "prewarm-before-thread") await fence([], { turnId: "", purpose: "prewarm" });
		write({ id: message.id, result: { thread: { id: threadId } } });
	} else if (message.method === "turn/start") {
		turnParameters = message.params;
		if (mode === "model-selection") writeFileSync(evidencePath, JSON.stringify({ threadParameters, turnParameters, configuration }));
		if (mode === "turn-request-rejected") {
			write({ id: message.id, error: { code: -32000, message: "PRIVATE_TURN_REQUEST_ERROR" } });
			return;
		}
		if (mode === "turn-start-stalled") return;
		const notification = { method: "turn/started", params: { threadId, turn: { id: turnId } } };
		if (mode === "fence-before-started") await fence();
		if (mode === "notify-first") write(notification);
		write({ id: message.id, result: { turn: { id: turnId } } });
		if (mode !== "notify-first") write(notification);
		if (mode !== "fence-before-started" && mode !== "skip-fence") await fence([], {
			...(mode === "wrong-fence-thread" ? { threadId: "other_thread" } : {}),
			...(mode === "wrong-fence-turn" ? { turnId: "other_turn" } : {}),
		});
		if (mode === "turn-stalled") return;
		if (mode.startsWith("composition-")) {
			const composition = (phase, patch = {}) => write({ method: "qorpera/messageComposition", params: { threadId, turnId, callId: "public_reply", phase, ...patch } });
			composition("start", { threadId: "other_thread" });
			composition("start", { turnId: "other_turn" });
			composition("start", { callId: "private_extra", text: "PRIVATE_ARGUMENT_CANARY" });
			write({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "PRIVATE_OUTPUT_CANARY" } });
			write({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, delta: "PRIVATE_REASONING_CANARY" } });
			if (mode === "composition-replayed") composition("finish");
			composition("start");
			composition("start");
			writeFileSync(evidencePath, JSON.stringify({ stage: "composing" }));
			while (!existsSync(`${evidencePath}.continue`)) await new Promise(resolve => setTimeout(resolve, 5));
			if (mode === "composition-unfinished") { done(); return; }
			composition("finish");
			composition("start");
			write({ id: "composition_send", method: "item/tool/call", params: { threadId, turnId, callId: "public_reply", namespace: "qorpera", tool: "send_message", arguments: { text: "PUBLIC_REPLY_CANARY" } } });
			return;
		}
		if (mode === "observed-zero-usage") {
			tokenUpdate(usage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }));
			done();
		} else if (mode === "observed-usage" || mode === "usage-after-completion") {
			tokenUpdate(usage({ inputTokens: 100, totalTokens: 107 }));
			tokenUpdate();
			// Rate-limit changes can repeat totals; compaction can replace last with an estimate.
			tokenUpdate(usage({}, { inputTokens: 0, outputTokens: 0, totalTokens: 9000 }));
			done();
			if (mode === "usage-after-completion") tokenUpdate(usage({ inputTokens: 999, totalTokens: 1006 }));
		} else if (mode.startsWith("invalid-usage-")) {
			const invalid = usage();
			const fault = mode.slice("invalid-usage-".length);
			if (fault === "negative") invalid.total.inputTokens = -1;
			else if (fault === "unsafe") invalid.total.inputTokens = Number.MAX_SAFE_INTEGER + 1;
			else if (fault === "fraction") invalid.total.outputTokens = 0.25;
			else if (fault === "string") invalid.total.cachedInputTokens = "PRIVATE_TOKEN_VALUE";
			else if (fault === "null") invalid.total.reasoningOutputTokens = null;
			else if (fault === "missing") delete invalid.total.cacheWriteInputTokens;
			else if (fault === "extra") invalid.total.secret = "PRIVATE_EXTRA_COUNTER";
			else if (fault === "last") invalid.last.totalTokens = "PRIVATE_ESTIMATE";
			else if (fault === "window") invalid.modelContextWindow = -1;
			else if (fault === "primitive") invalid.total = "PRIVATE_USAGE_BODY";
			else throw new Error("Unknown synthetic usage fault");
			tokenUpdate(invalid);
			done();
		} else if (mode === "diagnostic-binding") {
			tokenUpdate(usage(), { threadId: "unrelated_private_thread" });
			tokenUpdate(usage(), { turnId: "unrelated_private_turn" });
			nativeError("usageLimitExceeded", false, { threadId: "unrelated_private_thread" });
			nativeError("usageLimitExceeded", false, { turnId: "unrelated_private_turn" });
			write({ method: "thread/tokenUsage/updated", params: null });
			write({ method: "error", params: { threadId, turnId, willRetry: "PRIVATE_RETRY_VALUE", error: {} } });
			failed();
		} else if (mode === "retry-notice") {
			nativeError({ responseStreamDisconnected: { httpStatusCode: null } }, true);
			nativeError("usageLimitExceeded", true);
			tokenUpdate();
			done();
		} else if (mode === "terminal-error-notice") {
			nativeError("usageLimitExceeded", false);
			failed();
		} else if (mode === "terminal-http-error") {
			failed({ message: "PRIVATE_PROVIDER_ERROR", additionalDetails: "PRIVATE_PROVIDER_DETAILS", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } } });
		} else if (mode === "terminal-rate-error") {
			failed({ message: "PRIVATE_PROVIDER_ERROR", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } });
		} else if (mode === "terminal-context-error") {
			failed({ message: "PRIVATE_PROVIDER_ERROR", codexErrorInfo: "contextWindowExceeded" });
		} else if (mode === "unknown-error-notice") {
			nativeError("PRIVATE_UNRECOGNIZED_CODE", false);
			nativeError({ httpConnectionFailed: { httpStatusCode: "PRIVATE_STATUS" } }, false);
			nativeError({ responseStreamDisconnected: { httpStatusCode: 503, message: "PRIVATE_EXTRA_ERROR" } }, false);
			failed();
		} else if (mode === "interrupted-turn") {
			write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", error: null } } });
		} else if (mode.startsWith("review")) {
			write({ id: "review_tool", method: "item/tool/call", params: { threadId, turnId, callId: "email_1", namespace: "qorpera", tool: "send_email", arguments: { to: "bob@acme.test" } } });
		} else if (mode === "capture-image") {
			write({ id: "capture_request", method: "item/tool/call", params: { threadId, turnId, callId: "capture_1", namespace: "qorpera", tool: "computer_screenshot", arguments: {} } });
		} else if (mode.startsWith("company-")) {
			if (mode === "company-composition") {
				write({ method: "qorpera/messageComposition", params: { threadId, turnId, callId: "company_call_0", phase: "start" } });
				while (!existsSync(`${evidencePath}.continue`)) await new Promise(resolve => setTimeout(resolve, 5));
				write({ method: "qorpera/messageComposition", params: { threadId, turnId, callId: "company_call_0", phase: "finish" } });
			}
			companyCall(0);
		} else if (mode === "wrong-thread" || mode === "wrong-turn" || mode === "wrong-namespace" || mode === "pending-tool" || mode === "cloud-tool") {
			write({ id: "tool_request", method: "item/tool/call", params: { threadId: mode === "wrong-thread" ? "other_thread" : threadId, turnId: mode === "wrong-turn" ? "other_turn" : turnId, callId: "call_1", namespace: mode === "wrong-namespace" ? "other_namespace" : "qorpera", tool: "read_document", arguments: {} } });
			if (mode === "pending-tool") done();
		} else if (mode === "approval") {
			write({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId, turnId, command: "PRIVATE_APPROVAL_COMMAND" } });
		} else if (mode === "final-send-ends-turn" || mode === "final-send-natural" || mode === "progress-send-no-end") {
			write({ id: "public_send", method: "item/tool/call", params: { threadId, turnId, callId: "send_1", namespace: "qorpera", tool: "send_message", arguments: { idempotencyKey: "k1", text: "Done.", phase: mode === "progress-send-no-end" ? "progress" : "final" } } });
		} else if (mode === "failed-turn") {
			failed();
		} else if (mode === "duplicate-id" || mode === "callback-flood") {
			// Past the removed 16,384-request cap, each callback is still answered and the turn completes.
			for (let index = 0; index < (mode === "duplicate-id" ? 2 : 20_000); index++)
				write({ id: mode === "duplicate-id" ? "duplicate" : `denied_${index}`, method: "item/commandExecution/requestApproval", params: {} });
			if (mode === "callback-flood") done();
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
	} else if (message.id === "capture_request" && mode === "capture-image") {
		const [envelope, image] = message.result.contentItems;
		if (!message.result.success || envelope.type !== "inputText" || image.type !== "inputImage" || !image.imageUrl.startsWith("data:image/png;base64,")) throw new Error("invalid capture fixture response");
		const pixels = Buffer.from(image.imageUrl.slice("data:image/png;base64,".length), "base64");
		const sha256 = createHash("sha256").update(pixels).digest("hex");
		const fenced = await fence([{ kind: "function_call_output", callId: "capture_1", output: [{ type: "input_text", text: envelope.text }, { type: "input_image", sha256 }] }]);
		writeFileSync(evidencePath, JSON.stringify({ imageBytes: pixels.length, sha256, fenced }));
		done();
	} else if (message.id === "public_send") {
		sendEvidence.reply = message;
		sendEvidence.pending = fence([{ kind: "function_call_output", callId: "send_1", output: message.result.contentItems[0].text }]);
		sendEvidence.fenced = await sendEvidence.pending;
		if (mode !== "final-send-ends-turn") {
			// Give a (wrong) interrupt time to arrive before completing naturally.
			await new Promise((resolve) => setTimeout(resolve, 100));
			writeFileSync(evidencePath, JSON.stringify(sendEvidence));
			if (mode === "progress-send-no-end" && sendEvidence.interrupt) { failed({ message: "PRIVATE_UNEXPECTED_INTERRUPT" }); return; }
			done();
		}
	} else if (message.method === "turn/interrupt" && mode.startsWith("review") && message.params.threadId === reviewThreadId) {
		reviewEvidence.interrupt = message.params;
		write({ id: message.id, result: {} });
		write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: "interrupted", error: null } } });
	} else if (message.id === "reviewer_wrong_tool") {
		reviewEvidence.wrongTool = message;
		write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: "completed", error: null } } });
	} else if (message.id === "verdict_request") {
		reviewEvidence.verdictReply = message;
		// A closing request of the reviewer can still arrive before the interrupt lands.
		reviewEvidence.closingFence = await fence([{ kind: "function_call_output", callId: "verdict_1", output: message.result.contentItems[0].text }], { threadId: reviewThreadId, turnId: reviewTurnId });
	} else if (message.id === "review_tool") {
		const mainFenced = await fence([{ kind: "function_call_output", callId: "email_1", output: message.result.contentItems[0].text }]);
		writeFileSync(evidencePath, JSON.stringify({ ...reviewEvidence, mainThread: threadParameters, reply: message, mainFenced }));
		done();
	} else if (message.method === "turn/interrupt") {
		sendEvidence.interrupt = message.params;
		write({ id: message.id, result: {} });
		if (mode === "final-send-ends-turn") {
			// The interrupt arrives while the fence reply is still pending, as it does live.
			sendEvidence.fenced = await sendEvidence.pending;
			writeFileSync(evidencePath, JSON.stringify({ ...sendEvidence, pending: undefined }));
			write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", error: null } } });
		}
	} else if (message.id === "composition_send") {
		done();
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
