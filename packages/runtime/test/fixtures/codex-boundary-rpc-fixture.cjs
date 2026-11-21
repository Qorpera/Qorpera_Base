const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, truncateSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { connect } = require("node:net");
const { createInterface } = require("node:readline");

const mode = process.argv[2];
const evidencePath = process.argv[3];
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const threadId = "thread_fixture";
const turnId = "turn_fixture";
// One more turn in the agent's thread (the host's turnCorrection): Codex gives it its own turn id, and the thread's
// usage carries on from the first.
const correctionTurnId = "turn_fixture_2";
let mainTurns = 0;
const correction = { turn: null, reply: null, interrupt: null, pending: null };
const correctionUsage = {
	first: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 1, totalTokens: 105 },
	second: { inputTokens: 60, outputTokens: 4, cachedInputTokens: 90, cacheWriteInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 64 },
	both: { inputTokens: 160, outputTokens: 9, cachedInputTokens: 90, cacheWriteInputTokens: 0, reasoningOutputTokens: 1, totalTokens: 169 },
};
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
	: mode === "company-cards-long-key"
	? [
			// The longest key ask_member accepts, then its retry: both must finish the turn.
			{ tool: "ask_member", arguments: { idempotencyKey: `digest-channel-${"k".repeat(113)}`, text: "One thing to decide first.", surface: "question", title: "Which channel should the digest go to?", payload: { options: [{ label: "#general" }, { label: "#finance" }] } } },
			{ tool: "ask_member", arguments: { idempotencyKey: `digest-channel-${"k".repeat(113)}`, text: "One thing to decide first.", surface: "question", title: "Which channel should the digest go to?", payload: { options: [{ label: "#general" }, { label: "#finance" }] } } },
		]
	: mode === "company-cards-again-refused"
	? [
			{ tool: "send_message", arguments: { idempotencyKey: "progress", text: "Reworking the look.", phase: "progress" } },
			{ tool: "ask_member", arguments: { idempotencyKey: "look-2", text: "Here are the warmer looks.", surface: "question", title: "Which of the warmer looks?", payload: { options: [{ label: "Amber" }, { label: "Sand" }], asksAgain: "5a1e9f04-7c2b-4d3e-a1b2-0123456789ab" } } },
			{ tool: "ask_member", arguments: { idempotencyKey: "look-2-plain", text: "Here are the warmer looks.", surface: "question", title: "Which of the warmer looks?", payload: { options: [{ label: "Amber" }, { label: "Sand" }] } } },
		]
	: mode === "company-cards-retry"
	? [
			// What the live model sent (options as plain strings), then the card its refusal asked for.
			{ tool: "ask_member", arguments: { idempotencyKey: "fruit", text: "Pick one.", surface: "question", title: "Apples or pears?", payload: { options: ["Apples", "Pears"] } } },
			{ tool: "ask_member", arguments: { idempotencyKey: "fruit", text: "Pick one.", surface: "question", title: "Apples or pears?", payload: { options: [{ label: "Apples" }, { label: "Pears" }] } } },
		]
	: mode === "company-dynamic"
	? [
			// A dynamic routine run: the early final is refused with the reason, the run decides, then speaks.
			{ tool: "send_message", arguments: { idempotencyKey: "progress", text: "Checking invoice 42.", phase: "progress" } },
			{ tool: "send_message", arguments: { idempotencyKey: "early", text: "Invoice 42 is still open.", phase: "final" } },
			{ tool: "manage_routine", arguments: { action: "upsert", operationKey: "self", routineKey: "invoice-watch", title: "Invoice follow-up", intent: "Look again at noon.", trigger: { kind: "dynamic", timeZone: "Europe/Copenhagen" } } },
			{ tool: "decide_routine", arguments: { action: "next", operationKey: "next-1", at: "2026-09-02T12:00:00+02:00", intent: "Invoice 42 was still open at 10:00. Look again at noon." } },
			{ tool: "send_message", arguments: { idempotencyKey: "final", text: "Invoice 42 is still open; I will look again at noon.", phase: "final" } },
		]
	: mode === "company-describe"
	? [
			// Tools on demand (T3-6): four tools' descriptions and forms through more_tools, then the answer.
			{ tool: "more_tools", arguments: { action: "describe", names: ["organize_sidebar", "hire_agent", "create_group_chat", "manage_routine"] } },
			{ tool: "send_message", arguments: { idempotencyKey: "final", text: "The company note has been checked.", phase: "final" } },
		]
	: mode === "company-limit-after-answer"
	? [{ tool: "send_message", arguments: { idempotencyKey: "final", text: "The company note has been checked.", phase: "final" } }]
	: mode === "company-cards-unavailable"
	? [
			// Valid protocol shapes with no executor: neither may publish a card or end the turn.
			{ tool: "ask_member", arguments: { idempotencyKey: "page-form", text: "Enter your email.", surface: "form", title: "Sign in", payload: { domain: "app.example.com", fields: [{ id: "email", label: "Email", type: "email" }] } } },
			{ tool: "ask_member", arguments: { idempotencyKey: "vault-login", text: "Signing in.", surface: "credential", title: "Company account", payload: { name: "example-login", domain: "app.example.com" } } },
			{ tool: "send_message", arguments: { idempotencyKey: "fallback", text: "This app cannot fill the page or sign in from the vault. No sign-in was performed.", phase: "final" } },
		]
	: mode === "company-removed-tools"
	? [
			// The page tools the scope reset (C6b) took out of the catalog: a call that still arrives is refused.
			{ tool: "interface_read", arguments: { interface: "pulse", view: null, after: null } },
			{ tool: "save_interface", arguments: { operationKey: "pulse", files: [], effect: "internal" } },
			{ tool: "send_message", arguments: { idempotencyKey: "final", text: "The pages are not mine to change.", phase: "final" } },
		]
	: mode === "company-silent" || mode === "company-no-send" || mode === "company-worker" || mode === "company-corrected"
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
	const value = setting.slice(equal + 1);
	// A TOML inline table (a model provider): bare keys become JSON keys; the fixture's values hold no "=".
	const toml = (text) => JSON.parse(text.replace(/([{,])([A-Za-z_][A-Za-z0-9_]*)=/g, '$1"$2":'));
	target[path[path.length - 1]] = path.join(".") === "features.code_mode"
		? { enabled: false, direct_only_tool_namespaces: ["qorpera"], excluded_tool_namespaces: ["skills"] }
		: value.startsWith("{") ? toml(value) : JSON.parse(value);
}
// A ChatGPT plan run: what the configured provider would send as its bearer, by its token command (run as
// Codex runs it) or its environment variable.
if (configuration.model_provider && evidencePath) {
	const provider = configuration.model_providers?.[configuration.model_provider] ?? {};
	const token = provider.auth
		? spawnSync(provider.auth.command, provider.auth.args ?? [], { encoding: "utf8" }).stdout.trim()
		: process.env[provider.env_key ?? ""] ?? null;
	writeFileSync(`${evidencePath}.plan`, JSON.stringify({
		provider: configuration.model_provider,
		baseUrl: provider.base_url,
		serviceTier: configuration.service_tier,
		token,
		codexHomeEntries: require("node:fs").readdirSync(process.env.CODEX_HOME),
	}));
}
const done = () => write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
const sendEvidence = { reply: null, fenced: null, interrupt: null, pending: null };
// A call the model made, and the answers of the calls so far, as the fence is asked to release them.
const call = (id, tool, args) => ({ id, method: "item/tool/call", params: { threadId, turnId, callId: id, namespace: "qorpera", tool, arguments: args } });
const answered = [];
const outputOf = (message) => answered.push({ kind: "function_call_output", callId: message.id, output: message.result.contentItems[0].text });
// Auto-review (v130): a reviewer thread started while the agent's tool call is open.
const reviewThreadId = "thread_review";
const reviewTurnId = "turn_review";
let reviewClosingFence;
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
const exchange = (body) => new Promise((resolve, reject) => {
	const request = Buffer.from(JSON.stringify(body));
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
const fence = (outputs = [], patch = {}) => exchange({ schema: "qorpera.native-result-fence/v1", requestId: randomUUID(), threadId, turnId, purpose: "turn", outputs, ...patch });
// Context composition: before its fence, a request's manifest (its items' kinds and sizes, never their content).
const manifest = [
	{ kind: "message", role: "developer", callId: null, id: null, bytes: 1200, media: 0 },
	{ kind: "message", role: "user", callId: null, id: null, bytes: 18, media: 0 },
];
const compose = (patch = {}) => exchange({ schema: "qorpera.native-context-composition/v1", requestId: randomUUID(), threadId, turnId, purpose: "turn", model: "offline-probe", items: manifest, ...patch });
const contextEvidence = { agent: null, reviewer: null };
// Memory compactor (M1b-4b): a fresh tool-less thread in the same app-server, opened at the opening (settle), during
// the turn or at closing. A company run with a work log (W1c-3): its step lines open compactor threads, several at once.
const compacting = mode.startsWith("compact") || mode === "review-compact" || mode === "company-logged";
// The modes whose compactor turns reply; compact-opening composes the agent's request too.
const compactReplies = mode === "compact" || mode === "compact-opening" || mode === "compact-gate";
const compactThreadId = "thread_compact";
// Each compactor thread has its own id, as Codex gives it: the first thread_compact, the later ones numbered.
const compactThreadIds = [];
let compactReplied;
const compactReply1 = new Promise((resolve) => { compactReplied = resolve; });
// order: the compactor's and the agent's thread starts, as this app-server answered them.
const compactEvidence = { compactThreads: [], compactTurns: [], prewarms: [], composed: null, fenced: [], refused: null, interrupt: null, order: [], mainPrewarm: null };
let compactAt;
const compactWrite = () => writeFileSync(evidencePath, JSON.stringify({ ...compactEvidence, mainThread: threadParameters, mainTurn: turnParameters, agent: contextEvidence.agent }));
const compactCompleted = (status, error = null) => write({ method: "turn/completed", params: { threadId: compactAt.threadId, turn: { id: compactAt.turnId, status, error } } });
const compactReply = (line) => {
	write({ method: "item/agentMessage/delta", params: { ...compactAt, delta: "LINE " } });
	write({ method: "item/agentMessage/delta", params: { ...compactAt, delta: line } });
	compactWrite();
	compactCompleted("completed");
};

// A voice call (VOICE-TOOL-DESIGN-20261110): a side thread that can do nothing, with a realtime session whose voice
// reads the lines it is handed. The agent's turn waits meanwhile, until the test lets it end.
const voiceMode = mode.startsWith("voice");
const voiceThreadId = "thread_voice";
// events: the voice threads' starts and the first call's stop, in the order this app-server saw or sent them.
const voiceEvidence = { thread: null, prewarm: null, start: null, appended: [], stops: [], interrupts: [], refused: null, delegatedFence: null, events: [] };
const voiceWrite = () => writeFileSync(evidencePath, JSON.stringify({ ...voiceEvidence, mainThread: threadParameters }));
// Each call's thread has its own id: the first thread_voice, the later ones numbered.
let voiceThreads = 0;
let voiceCurrent = voiceThreadId;
const voiceSay = (method, params = {}) => write({ method, params: { threadId: voiceCurrent, ...params } });
// voice-reopen (and voice-reopen-refused, whose first stop is refused): the second call's line is answered only once
// the first call's late words were sent.
const voiceReopen = mode === "voice-reopen" || mode === "voice-reopen-refused";
let voiceLateSent;
const voiceLate = new Promise((resolve) => { voiceLateSent = resolve; });

// A picture call (cloud-picture-channel.ts): a side thread with Codex's image tool on, whose one turn makes one picture,
// saved where Codex 0.155.1 keeps it. The agent's turn waits meanwhile, until the test lets it end.
const pictureMode = mode.startsWith("picture");
const pictureThreadId = "thread_picture";
const pictureTurnId = "turn_picture";
const pictureItemId = "ig_1";
// followUp: the host's answer to the turn's request after a failed generation, whose text output reaches the fence.
const pictureEvidence = { threads: [], prewarm: null, turn: null, composed: null, followUp: null, interrupts: [], refused: null, savedPath: null };
// Written whole and renamed into place: a test reads it while later messages are still being recorded, and must never
// read half a line.
const pictureWrite = () => {
	writeFileSync(`${evidencePath}.writing`, JSON.stringify({ ...pictureEvidence, mainThread: threadParameters, configuration }));
	renameSync(`${evidencePath}.writing`, evidencePath);
};
// The one-pixel PNG of Codex's own image tests.
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const pictureItem = (patch) => ({ type: "imageGeneration", id: pictureItemId, status: "completed", revisedPrompt: "a red apple", result: "", failure: null, ...patch });
/** Saves the picture as Codex does (under its canonical home), or elsewhere, and says it is done. */
const pictureSave = (at, itemId = pictureItemId) => {
	const home = realpathSync(process.env.CODEX_HOME);
	const folder = join(home, "generated_images", at.threadId);
	mkdirSync(folder, { recursive: true });
	let saved = join(folder, `${itemId}.png`);
	if (mode === "picture-outside") saved = join(home, "outside.png");
	writeFileSync(saved, mode === "picture-not-png" ? "PRIVATE_NOT_A_PNG" : tinyPng);
	// Past the bound: the file says so by its size alone.
	if (mode === "picture-large") truncateSync(saved, 12 * 1024 * 1024 + 1);
	if (itemId === pictureItemId) pictureEvidence.savedPath = saved;
	else pictureEvidence.secondPath = saved;
	pictureWrite();
	// The picture model's own prompt argument, which nothing in Codex bounds: 40 KiB of it, in characters of two bytes.
	const revised = mode === "picture-long-revised" ? { revisedPrompt: "é".repeat(20 * 1024) } : {};
	write({ method: "item/completed", params: { ...at, item: pictureItem({ id: itemId, savedPath: saved, transparentBackground: true, ...revised }), completedAtMs: 1 } });
};

if (mode === "descendant") {
	spawn(process.execPath, ["-e", `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(evidencePath)},'UNEXPECTED_DESCENDANT_EFFECT'),1500);setTimeout(()=>{},10000);`], { stdio: "ignore" });
}

async function handle(message) {
	if (message.method === "initialize") {
		// Warm conversations: tests count started processes (spares included).
		if (evidencePath) appendFileSync(`${evidencePath}.starts`, `${process.pid}\n`);
		// Like the real harness, a process writes its own state into its Codex home.
		if (mode === "writes-home" && process.env.CODEX_HOME)
			writeFileSync(join(process.env.CODEX_HOME, "state_5.sqlite"), "fixture state");
		if (mode === "stall-first" && !existsSync(`${evidencePath}.stalled`)) {
			writeFileSync(`${evidencePath}.stalled`, "");
			return;
		}
		if (mode === "stalled" || mode === "descendant") return;
		if (mode === "invalid-json") { process.stdout.write("PRIVATE_BAD_WIRE\n"); return; }
		if (mode === "oversized") { process.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
		// Far more diagnostics than the removed 16 MiB output cap; the turn still completes.
		if (mode === "wire-flood") process.stderr.write("x".repeat(17 * 1024 * 1024));
		if (mode === "missing-result") { write({ id: message.id }); return; }
		write({ id: message.id, result: { userAgent: `qorpera_cloud_boundary/${mode === "wrong-version" ? "0.146.0" : "0.170.0"} (fixture)${mode === "missing-capture-image" ? "" : " qorpera.native-capture-images/v1"}${mode === "missing-composition" ? "" : " qorpera.native-message-composition/v1"}${mode === "missing-context-composition" ? "" : " qorpera.native-context-composition/v1"}${mode === "missing-prompt-cache-key" ? "" : " qorpera.native-prompt-cache-key/v1"}${mode === "missing-fence" ? "" : " qorpera.native-result-fence/v1"}${mode === "missing-fence" || mode === "missing-direct-tools" ? "" : " qorpera.native-direct-tools/v1"}` } });
	} else if (message.method === "config/read") {
		if (mode === "unsafe-config") configuration.features.shell_tool = true;
		if (mode === "extra-mcp") configuration.mcp_servers.uncontrolled = { url: "http://uncontrolled.invalid/mcp" };
		if (mode === "unsafe-code-mode") configuration.features.code_mode.enabled = true;
		if (mode === "nested-cloud-tools") configuration.features.code_mode.direct_only_tool_namespaces = [];
		if (mode === "skill-route") configuration.orchestrator.skills.enabled = true;
		if (mode === "fast-mode-off") configuration.features.fast_mode = false;
		if (mode === "web-search-off") delete configuration.features.standalone_web_search;
		if (mode === "plan-web-search") configuration.features.standalone_web_search = true;
		if (mode === "tier-dropped") delete configuration.service_tier;
		if (mode === "plan-provider-dropped") delete configuration.model_provider;
		if (mode === "plan-provider-on-codex") configuration.model_provider = "qorpera_chatgpt_plan";
		if (mode.startsWith("test-provider")) configuration.model_provider = "fixture_provider";
		if (mode === "test-provider-search") configuration.model_providers = { fixture_provider: { name: "Fixture", supports_standalone_web_search: true } };
		write({ id: message.id, result: { config: configuration } });
	} else if (message.method === "skills/list") {
		write({ id: message.id, result: { data: [{ skills: mode === "extra-skills" ? [{ name: "PRIVATE_UNCONTROLLED_SKILL" }] : [], errors: [] }] } });
		// The last handshake answer: tests wait for it before counting on a ready spare.
		if (evidencePath) appendFileSync(`${evidencePath}.handshakes`, `${process.pid}\n`);
		// Requests before any run is bound: the host must refuse both.
		if (mode === "fence-before-bind") fence([], { turnId: "", purpose: "prewarm" }).catch(() => undefined);
		if (mode === "tool-before-bind")
			write({ id: "early_tool", method: "item/tool/call", params: { threadId, turnId, callId: "early", namespace: "qorpera", tool: "read_document", arguments: {} } });
	} else if (message.method === "thread/start" && compacting && message.params.dynamicTools?.length === 0) {
		compactEvidence.compactThreads.push(message.params);
		compactEvidence.order.push("compact-thread");
		// Codex starts a thread's prewarm in the background: here the reviewer's lands while a compactor thread starts.
		if (mode === "review-compact") reviewEvidence.prewarm = await fence([], { threadId: reviewThreadId, turnId: "", purpose: "prewarm" });
		const id = compactThreadIds.length === 0 ? compactThreadId : `${compactThreadId}_${compactThreadIds.length + 1}`;
		compactThreadIds.push(id);
		compactEvidence.prewarms.push(await fence([], { threadId: id, turnId: "", purpose: "prewarm" }));
		write({ id: message.id, result: { thread: { id } } });
	} else if (message.method === "thread/start" && mode.startsWith("review") && threadParameters) {
		reviewEvidence.reviewerThread = message.params;
		if (mode === "review-compact") writeFileSync(`${evidencePath}.review-started`, "");
		else reviewEvidence.prewarm = await fence([], { threadId: reviewThreadId, turnId: "", purpose: "prewarm" });
		write({ id: message.id, result: { thread: { id: reviewThreadId } } });
	} else if (message.method === "turn/start" && mode.startsWith("review") && message.params.threadId === reviewThreadId) {
		reviewEvidence.reviewerTurn = message.params;
		if (mode === "review-turn-start-stalled") {
			writeFileSync(`${evidencePath}.review-turn-start`, "");
			setTimeout(() => write({ id: message.id, result: { turn: { id: reviewTurnId } } }), 350);
			return;
		}
		write({ id: message.id, result: { turn: { id: reviewTurnId } } });
		write({ method: "turn/started", params: { threadId: reviewThreadId, turn: { id: reviewTurnId } } });
		if (mode === "review-context") contextEvidence.reviewer = await compose({ threadId: reviewThreadId, turnId: reviewTurnId });
		await fence([], { threadId: reviewThreadId, turnId: reviewTurnId });
		// The reviewer's text never matters; only its verdict tool call does.
		write({ method: "item/agentMessage/delta", params: { threadId: reviewThreadId, turnId: reviewTurnId, delta: "PRIVATE_REVIEW_CANARY" } });
		if (mode === "review-no-verdict") {
			write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: "completed", error: null } } });
			return;
		}
		if (mode === "review-busy-notice" || mode === "review-busy-retrying") {
			const codexErrorInfo = { responseTooManyFailedAttempts: { httpStatusCode: 429 } };
			const retrying = mode === "review-busy-retrying";
			write({ method: "error", params: { threadId: reviewThreadId, turnId: reviewTurnId, willRetry: retrying, error: { message: "Too many requests", codexErrorInfo } } });
			write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: retrying ? "completed" : "failed", error: null } } });
			return;
		}
		if (mode === "review-busy-turn") {
			write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: "failed", error: { message: "Usage limit", codexErrorInfo: "usageLimitExceeded" } } } });
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
	} else if (message.method === "turn/start" && compacting && compactThreadIds.includes(message.params.threadId)) {
		const turn = compactEvidence.compactTurns.push(message.params);
		if (mode === "compact-side-turn-start-stalled") {
			compactAt = { threadId: message.params.threadId, turnId: `turn_compact_${turn}` };
			writeFileSync(`${evidencePath}.compact-turn-start`, "");
			setTimeout(() => write({ id: message.id, result: { turn: { id: compactAt.turnId } } }), 350);
			return;
		}
		if (mode === "company-logged") {
			// Each of a work log's turns answers one line, while the agent's turn goes on or at its closing.
			const at = { threadId: message.params.threadId, turnId: `turn_compact_${turn}` };
			write({ id: message.id, result: { turn: { id: at.turnId } } });
			write({ method: "turn/started", params: { threadId: at.threadId, turn: { id: at.turnId } } });
			await fence([], at);
			write({ method: "item/agentMessage/delta", params: { ...at, delta: `LINE ${turn}` } });
			write({ method: "turn/completed", params: { threadId: at.threadId, turn: { id: at.turnId, status: "completed", error: null } } });
			return;
		}
		compactAt = { threadId: message.params.threadId, turnId: `turn_compact_${turn}` };
		write({ id: message.id, result: { turn: { id: compactAt.turnId } } });
		write({ method: "turn/started", params: { threadId: compactAt.threadId, turn: { id: compactAt.turnId } } });
		if (compactReplies) compactEvidence.composed = await compose(compactAt);
		compactEvidence.fenced.push(await fence([], compactAt));
		if (compactReplies) {
			// The thread's cumulative usage: each reply used what it grew by since the one before.
			tokenUpdate(usage(turn === 1 ? { inputTokens: 500, cachedInputTokens: 100, outputTokens: 40 } : { inputTokens: 1200, cachedInputTokens: 600, outputTokens: 70 }), compactAt);
			compactReply(String(turn));
			compactReplied();
		} else if (mode === "compact-tool") {
			// The compactor has no tools; a model that reaches for one is refused.
			write({ id: "compact_tool", method: "item/tool/call", params: { ...compactAt, callId: "compact_call", namespace: "qorpera", tool: "send_email", arguments: { to: "x@evil.test" } } });
		} else if (mode === "compact-usage-limit") {
			nativeError("usageLimitExceeded", false, compactAt);
			compactCompleted("failed", { message: "PRIVATE_PROVIDER_ERROR" });
		} else if (mode === "compact-rate-limit" || mode === "compact-outage") {
			compactCompleted("failed", { message: "PRIVATE_PROVIDER_ERROR", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: mode === "compact-rate-limit" ? 429 : 503 } } });
		} else if (mode === "review-compact") {
			compactReply("1");
			compactReplied();
		} else if (mode === "compact-large") {
			// Past the bound on one reply: the host ends the thread and interrupts its turn.
			write({ method: "item/agentMessage/delta", params: { ...compactAt, delta: "x".repeat(16 * 1024 + 1) } });
		} else if (mode === "compact-failed") {
			// What the failed request used reaches no reply.
			tokenUpdate(usage({ inputTokens: 300, cachedInputTokens: 50, outputTokens: 20 }), compactAt);
			compactCompleted("failed", { message: "PRIVATE_PROVIDER_ERROR" });
		} else {
			// compact-stalled and compact-open-*: the turn waits for its interrupt or for the run's end.
			compactWrite();
		}
	} else if (message.method === "thread/start" && voiceMode && threadParameters) {
		voiceEvidence.thread = message.params;
		voiceThreads++;
		const id = voiceThreads === 1 ? voiceThreadId : `${voiceThreadId}_${voiceThreads}`;
		voiceCurrent = id;
		voiceEvidence.events.push(`thread-start:${id}`);
		// Codex prewarms a new thread in the background: the voice thread's lands on the fence while it starts.
		voiceEvidence.prewarm = await fence([], { threadId: id, turnId: "", purpose: "prewarm" });
		voiceWrite();
		write({ id: message.id, result: { thread: { id } } });
	} else if (message.method === "thread/realtime/start") {
		voiceEvidence.start = message.params;
		voiceWrite();
		if (mode === "voice-start-error") {
			write({ id: message.id, error: { code: -32000, message: "PRIVATE_REALTIME_START_ERROR" } });
			return;
		}
		write({ id: message.id, result: {} });
		voiceSay("thread/realtime/started", { sessionId: "PRIVATE_SESSION" });
		voiceSay("thread/realtime/sdp", { sdp: "v=0\r\nPRIVATE_ANSWER_SDP\r\n" });
	} else if (message.method === "account/rateLimits/read" && voiceMode) {
		if (mode === "voice-error") {
			write({ id: message.id, error: { code: -32600, message: "PRIVATE_USAGE_ERROR" } });
			return;
		}
		const full = mode === "voice-limit";
		write({ id: message.id, result: { ordinaryUsageAllowed: !full, accountId: "PRIVATE_ACCOUNT", rateLimits: { limitId: "codex", planType: "prolite", primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: Date.parse("2026-11-18T19:00:00Z") / 1000 }, secondary: { usedPercent: full ? 100 : 84, windowDurationMins: 10080, resetsAt: Date.parse("2026-11-24T13:22:00Z") / 1000 } } } });
	} else if (message.method === "thread/realtime/appendSpeech") {
		voiceEvidence.appended.push(message.params);
		voiceWrite();
		write({ id: message.id, result: {} });
		const line = voiceEvidence.appended.length;
		if (mode === "voice-delegates") {
			// The voice hands over to a model turn: its request carries an output, which gets nothing of the agent's.
			write({ method: "turn/started", params: { threadId: voiceThreadId, turn: { id: "turn_voice" } } });
			voiceEvidence.delegatedFence = await fence([{ kind: "function_call_output", callId: "voice_call", output: "PRIVATE_VOICE_OUTPUT" }], { threadId: voiceThreadId, turnId: "turn_voice" });
			voiceWrite();
			return;
		}
		if (mode === "voice-error") {
			voiceSay("thread/realtime/error", { message: "PRIVATE_REALTIME_ERROR" });
			return;
		}
		if (mode === "voice-limit") {
			voiceSay("thread/realtime/error", { message: "You have reached your usage limit." });
			return;
		}
		if (mode === "voice-silent" || (voiceReopen && line === 1)) return;
		if (voiceReopen) await voiceLate;
		if (mode === "voice-request" && line === 1)
			write({ id: "voice_request", method: "item/tool/call", params: { threadId: voiceThreadId, turnId: "turn_voice", callId: "voice_call", namespace: "qorpera", tool: "send_email", arguments: {} } });
		voiceSay("thread/realtime/transcript/delta", { role: "assistant", delta: "PRIVATE_DELTA" });
		voiceSay("thread/realtime/transcript/done", { role: "user", text: "PRIVATE_USER_TEXT" });
		const said = { role: "assistant", text: message.params.text === "LONG" ? "é".repeat(3000) : `SAID ${message.params.text}` };
		// The second line's transcript comes without its thread: the lane takes it as the one call's.
		if (line === 2) write({ method: "thread/realtime/transcript/done", params: said });
		else voiceSay("thread/realtime/transcript/done", said);
	} else if (message.method === "thread/realtime/stop") {
		voiceEvidence.stops.push(message.params);
		voiceWrite();
		// The stop is never confirmed: no answer, no close.
		if (mode === "voice-stop-silent") return;
		// A refused stop confirms nothing: the session may still be up.
		const refuse = () => write({ id: message.id, error: { code: -32000, message: "PRIVATE_REALTIME_STOP_ERROR" } });
		if (mode === "voice-stop-refused") {
			refuse();
			return;
		}
		const refused = mode === "voice-reopen-refused" && voiceEvidence.stops.length === 1;
		if (refused) refuse();
		if (voiceReopen && voiceEvidence.stops.length === 1) {
			// The first call's stop is slow (or refused), and its session still speaks meanwhile: a line's late transcript
			// and its close, neither naming its thread, before the stop is answered.
			voiceEvidence.events.push("stop");
			await new Promise((resolve) => setTimeout(resolve, 300));
			write({ method: "thread/realtime/transcript/done", params: { role: "assistant", text: "PRIVATE_LATE_TRANSCRIPT" } });
			write({ method: "thread/realtime/closed", params: {} });
			voiceEvidence.events.push("late");
			voiceWrite();
			voiceLateSent();
			if (refused) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		write({ id: message.id, result: {} });
		write({ method: "thread/realtime/closed", params: { threadId: message.params.threadId } });
	} else if (message.method === "turn/interrupt" && message.params.threadId === voiceThreadId) {
		voiceEvidence.interrupts.push(message.params);
		voiceWrite();
		write({ id: message.id, result: {} });
		write({ method: "turn/completed", params: { threadId: voiceThreadId, turn: { id: message.params.turnId, status: "interrupted", error: null } } });
	} else if (message.id === "voice_request") {
		voiceEvidence.refused = message;
		voiceWrite();
	} else if (message.method === "thread/start" && pictureMode && (threadParameters || mode === "picture-light")) {
		pictureEvidence.threads.push(message.params);
		if (mode === "picture-thread-refused") {
			pictureWrite();
			write({ id: message.id, error: { code: -32600, message: "PRIVATE_CONFIG_ERROR" } });
			return;
		}
		const id = pictureEvidence.threads.length === 1 ? pictureThreadId : `${pictureThreadId}_${pictureEvidence.threads.length}`;
		// Codex prewarms a new thread in the background: the picture thread's lands on the fence while it starts.
		pictureEvidence.prewarm = await fence([], { threadId: id, turnId: "", purpose: "prewarm" });
		pictureWrite();
		write({ id: message.id, result: { thread: { id } } });
	} else if (message.method === "turn/start" && pictureMode && message.params.threadId.startsWith(pictureThreadId)) {
		const at = { threadId: message.params.threadId, turnId: pictureTurnId };
		pictureEvidence.turn = message.params;
		pictureWrite();
		if (mode === "picture-turn-refused") {
			write({ id: message.id, error: { code: -32000, message: "PRIVATE_TURN_ERROR" } });
			return;
		}
		write({ id: message.id, result: { turn: { id: pictureTurnId } } });
		write({ method: "turn/started", params: { threadId: at.threadId, turn: { id: pictureTurnId } } });
		pictureEvidence.composed = await compose(at);
		await fence([], at);
		// The model's words on the picture's thread reach no one.
		write({ method: "item/agentMessage/delta", params: { ...at, delta: "PRIVATE_PICTURE_CANARY" } });
		if (mode === "picture-request")
			write({ id: "picture_request", method: "item/tool/call", params: { ...at, callId: "picture_call", namespace: "qorpera", tool: "send_email", arguments: {} } });
		// What Codex says of the member's plan, without a thread: a sign-in's update, or a rate-limit update's plan.
		if (mode === "picture-free" || mode === "picture-pro")
			write({ method: "account/updated", params: { authMode: "chatgpt", planType: mode === "picture-free" ? "free" : "pro" } });
		if (mode === "picture-free-limits")
			write({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", planType: "free", primary: null, secondary: null } } });
		if (mode === "picture-silent" || mode === "picture-free" || mode === "picture-pro" || mode === "picture-free-limits") {
			// The model draws nothing: its turn ends with words alone.
			write({ method: "turn/completed", params: { threadId: at.threadId, turn: { id: pictureTurnId, status: "completed", error: null } } });
			return;
		}
		if (mode === "picture-usage-limit") {
			nativeError("usageLimitExceeded", false, at);
			write({ method: "turn/completed", params: { threadId: at.threadId, turn: { id: pictureTurnId, status: "failed", error: { message: "PRIVATE_PROVIDER_ERROR" } } } });
			return;
		}
		write({ method: "item/started", params: { ...at, item: pictureItem({ status: "in_progress", revisedPrompt: null }), startedAtMs: 1 } });
		if (mode === "picture-started") {
			// The tool was called, and its turn ends without the picture.
			write({ method: "turn/completed", params: { threadId: at.threadId, turn: { id: pictureTurnId, status: "failed", error: { message: "PRIVATE_PROVIDER_ERROR" } } } });
			return;
		}
		// The generation never ends (picture-slow), or ends only after the call gave up on it (picture-late).
		if (mode === "picture-slow" || mode === "picture-late") return;
		if (mode === "picture-limit" || mode === "picture-refused") {
			write({ method: "item/completed", params: { ...at, item: pictureItem({ status: "failed", failure: mode === "picture-limit" ? { type: "usageLimitExceeded", limitId: "image_gen", resetsAt: 1763049600 } : null }), completedAtMs: 1 } });
			// The tool's failure goes back to the model as text, which reaches the fence and gets nothing; the pinned fence
			// then fails the turn inside Codex.
			pictureEvidence.followUp = await fence([{ kind: "function_call_output", callId: "imagegen_call", output: "image generation failed: PRIVATE_IMAGES_ERROR" }], at);
			pictureWrite();
			write({ method: "turn/completed", params: { threadId: at.threadId, turn: { id: pictureTurnId, status: "failed", error: { message: "Cloud result boundary unavailable" } } } });
			return;
		}
		pictureSave(at);
		// The model draws a second picture in the same turn: the call took the first.
		if (mode === "picture-twice") pictureSave(at, "ig_2");
	} else if (message.method === "turn/interrupt" && pictureMode && message.params.threadId.startsWith(pictureThreadId)) {
		pictureEvidence.interrupts.push(message.params);
		pictureWrite();
		write({ id: message.id, result: {} });
		// A picture finished after its call ended: Codex saves it all the same.
		if (mode === "picture-late") pictureSave({ threadId: message.params.threadId, turnId: message.params.turnId });
		write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted", error: null } } });
	} else if (message.id === "picture_request") {
		pictureEvidence.refused = message;
		pictureWrite();
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
		if (mode === "compact-gate") {
			// A compactor call arrives while the agent's thread starts; its prewarm, sent meanwhile, is the agent's.
			writeFileSync(`${evidencePath}.main-starting`, "");
			while (!existsSync(`${evidencePath}.continue`)) await new Promise((resolve) => setTimeout(resolve, 5));
			compactEvidence.mainPrewarm = await fence([], { turnId: "", purpose: "prewarm" });
		}
		if (compacting) compactEvidence.order.push("main-thread");
		write({ id: message.id, result: { thread: { id: threadId } } });
	} else if (message.method === "turn/start" && mainTurns > 0) {
		// The agent's turn ended with its closing act undone, and the host starts one more in the same thread (in any
		// mode: the reviewer's and the compactor's turns are taken above). Its first request carries every earlier
		// output, as any request of the thread does.
		mainTurns++;
		const at = { threadId, turnId: correctionTurnId };
		const outputs = mode.startsWith("company-") ? companyOutputs : answered;
		correction.turn = message.params;
		if (mode === "correct-stale-turn") {
			// A request that still names the turn that ended: no part of the new one, and the host refuses it.
			await fence(outputs, { turnId }).catch(() => undefined);
			return;
		}
		write({ id: message.id, result: { turn: { id: correctionTurnId } } });
		write({ method: "turn/started", params: { threadId, turn: { id: correctionTurnId } } });
		await fence(outputs, at);
		if (mode.startsWith("correct-")) tokenUpdate(usage(correctionUsage.both, correctionUsage.second), at);
		if (mode === "correct-final" || mode === "company-corrected") {
			// Told what was missing, the model sends its final message.
			write({ id: "correction_send", method: "item/tool/call", params: { ...at, callId: "send_2", namespace: "qorpera", tool: "send_message", arguments: { idempotencyKey: "corrected", text: "Here is what I found.", phase: "final" } } });
			return;
		}
		// Any other mode (correct-silent, a company run or a coding turn that says nothing again): the added turn ends
		// as the first did.
		writeFileSync(`${evidencePath}.correction`, JSON.stringify({ ...correction, pending: undefined, turns: mainTurns }));
		write({ method: "item/agentMessage/delta", params: { ...at, delta: "PRIVATE_OUTPUT_CANARY" } });
		write({ method: "turn/completed", params: { threadId, turn: { id: correctionTurnId, status: "completed", error: null } } });
	} else if (message.method === "turn/start") {
		mainTurns++;
		turnParameters = message.params;
		if (mode === "model-selection" || mode.startsWith("test-provider")) writeFileSync(evidencePath, JSON.stringify({ threadParameters, turnParameters, configuration }));
		if (mode === "turn-request-rejected") {
			write({ id: message.id, error: { code: -32000, message: "PRIVATE_TURN_REQUEST_ERROR" } });
			return;
		}
		if (mode === "turn-start-stalled" || mode === "compact-turn-start-stalled") {
			// Never answered; the marker says the request arrived.
			writeFileSync(`${evidencePath}.turn-start`, "");
			return;
		}
		const notification = { method: "turn/started", params: { threadId, turn: { id: turnId } } };
		if (mode === "fence-before-started") await fence();
		if (mode === "notify-first") write(notification);
		write({ id: message.id, result: { turn: { id: turnId } } });
		if (mode !== "notify-first") write(notification);
		// A company run's request is composed too: its evidence keeps the reply (the prompt cache key a run sets).
		if (mode.startsWith("context-") || mode === "review-context" || mode === "company-context" || mode === "compact-opening") {
			contextEvidence.agent = await compose(mode === "context-wrong-turn" ? { turnId: "other_turn" } : {});
			if (mode.startsWith("context-")) writeFileSync(evidencePath, JSON.stringify({ context: contextEvidence }));
		}
		if (mode !== "fence-before-started" && mode !== "skip-fence") await fence([], {
			...(mode === "wrong-fence-thread" ? { threadId: "other_thread" } : {}),
			...(mode === "wrong-fence-turn" ? { turnId: "other_turn" } : {}),
		});
		if (mode === "turn-stalled") return;
		if (mode === "web-search") {
			const search = (method, id, at, query) => write({ method, params: { ...at, item: { type: "webSearch", id, query, action: query ? { type: "search", query } : null } } });
			search("item/started", "ws_call", { threadId, turnId }, "");
			search("item/completed", "ws_call", { threadId, turnId }, "PRIVATE_QUERY_CANARY prices");
			search("item/completed", "ws_other", { threadId: "other_thread", turnId: "other_turn" }, "OTHER_QUERY");
			const reply = await fence([
				{ kind: "function_call_output", callId: "ws_call", output: [{ type: "input_text", text: "SEARCH_RESULT_CANARY" }] },
				{ kind: "function_call_output", callId: "ws_other", output: "OTHER_RESULT" },
			]);
			writeFileSync(evidencePath, JSON.stringify({ threadParameters, configuration, reply }));
			done();
			return;
		}
		if (mode.startsWith("compact-open-")) {
			// The run ends while a compactor send is open: its provider's signal, or none, stops that send.
			while (!existsSync(evidencePath)) await new Promise((resolve) => setTimeout(resolve, 5));
			if (mode === "compact-open-usage-limit") {
				nativeError("usageLimitExceeded", false);
				failed();
			} else done();
			return;
		}
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
		} else if (mode === "per-request-usage") {
			// Codex adds each response's usage to total and sends it as last (append_last_usage).
			const counters = (inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, totalTokens) =>
				({ inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens: 0, reasoningOutputTokens, totalTokens });
			const first = counters(40, 5, 0, 1, 45);
			const second = counters(60, 4, 38, 0, 64);
			const both = counters(100, 9, 38, 1, 109);
			tokenUpdate(usage(first, first));
			tokenUpdate(usage(both, second));
			// A repeat (rate limits), a compaction estimate and a filled context window do not add up.
			tokenUpdate(usage(both, second));
			tokenUpdate(usage(both, counters(0, 0, 0, 0, 9000)));
			tokenUpdate(usage(counters(0, 0, 0, 0, 8192), counters(0, 0, 0, 0, 8083)));
			const third = counters(70, 3, 60, 0, 73);
			tokenUpdate(usage({ ...third, totalTokens: 8192 + 73 }, third));
			done();
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
		} else if (mode === "terminal-unauthorized") {
			failed({ message: "PRIVATE_PROVIDER_ERROR", codexErrorInfo: "unauthorized" });
		} else if (mode === "terminal-notice-then-null") {
			nativeError("unauthorized", false);
			failed({ message: "PRIVATE_PROVIDER_ERROR", codexErrorInfo: null });
		} else if (mode === "terminal-null-error") {
			failed({ message: "PRIVATE_PROVIDER_ERROR", codexErrorInfo: null });
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
		} else if (mode === "final-send-natural" || mode === "progress-send-no-end") {
			write({ id: "public_send", method: "item/tool/call", params: { threadId, turnId, callId: "send_1", namespace: "qorpera", tool: "send_message", arguments: { idempotencyKey: "k1", text: "Done.", phase: mode === "progress-send-no-end" ? "progress" : "final" } } });
		} else if (mode === "report-then-note" || mode.startsWith("final-send-then-") || mode === "final-send-replay") {
			// One response's two calls, the second made once the first is answered, as Codex may run them.
			write(call("first_1", mode === "report-then-note" ? "report_work" : "send_message", mode === "report-then-note" ? { operationKey: "k1", outcome: "succeeded", summary: "Done." } : { idempotencyKey: "k1", text: "Done.", phase: "final" }));
		} else if (mode === "report-after-note") {
			write(call("note_1", "read_note", {}));
		} else if (mode === "report-with-codex-answer") {
			write(call("report_2", "report_work", { operationKey: "k1", outcome: "succeeded", summary: "Done." }));
		} else if (mode === "report-ends-turn" || mode === "report-goes-on") {
			write({ id: "public_send", method: "item/tool/call", params: { threadId, turnId, callId: "send_1", namespace: "qorpera", tool: "report_work", arguments: { operationKey: "k1", outcome: "succeeded", summary: "Done." } } });
		} else if (mode.startsWith("correct-")) {
			// The turn ends on the model's own word, with no closing act.
			tokenUpdate(usage(correctionUsage.first, correctionUsage.first));
			write({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "PRIVATE_OUTPUT_CANARY" } });
			done();
		} else if (mode === "failed-turn") {
			failed();
		} else if (mode === "duplicate-id" || mode === "callback-flood") {
			// Past the removed 16,384-request cap, each callback is still answered and the turn completes.
			for (let index = 0; index < (mode === "duplicate-id" ? 2 : 20_000); index++)
				write({ id: mode === "duplicate-id" ? "duplicate" : `denied_${index}`, method: "item/commandExecution/requestApproval", params: {} });
			if (mode === "callback-flood") done();
		} else {
			// The compactor's thread replies during the agent's turn.
			if (mode === "compact-gate") await compactReply1;
			if (voiceMode) {
				// A voice call is placed while the agent's turn is open; the test ends the turn.
				writeFileSync(`${evidencePath}.voice-ready`, "");
				while (!existsSync(`${evidencePath}.continue`)) await new Promise((resolve) => setTimeout(resolve, 5));
			}
			if (pictureMode) {
				// So is a picture call.
				pictureWrite();
				writeFileSync(`${evidencePath}.picture-ready`, "");
				while (!existsSync(`${evidencePath}.continue`)) await new Promise((resolve) => setTimeout(resolve, 5));
			}
			// Just under the 1 MiB wire limit: one line over many pipe reads, split inside 3-byte characters.
			if (mode === "large-line") write({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "\u20ac".repeat(349_000) } });
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
			writeFileSync(evidencePath, JSON.stringify({ threadParameters, turnParameters, configuration, fenced, outputs: companyOutputs, context: contextEvidence, cwd: process.cwd(), environmentKeys: Object.keys(process.env) }));
			write({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "PRIVATE_OUTPUT_CANARY" } });
			write({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, delta: "PRIVATE_REASONING_CANARY" } });
			// The answer is out, then the login's usage limit fails the turn (the 2026-11-13 amendment).
			if (mode === "company-limit-after-answer") failed({ message: "PRIVATE_PROVIDER_ERROR", codexErrorInfo: "usageLimitExceeded" });
			else done();
		}
	} else if (message.id === "capture_request" && mode === "capture-image") {
		const [envelope, image] = message.result.contentItems;
		if (!message.result.success || envelope.type !== "inputText" || image.type !== "inputImage" || !image.imageUrl.startsWith("data:image/png;base64,")) throw new Error("invalid capture fixture response");
		const pixels = Buffer.from(image.imageUrl.slice("data:image/png;base64,".length), "base64");
		const sha256 = createHash("sha256").update(pixels).digest("hex");
		const fenced = await fence([{ kind: "function_call_output", callId: "capture_1", output: [{ type: "input_text", text: envelope.text }, { type: "input_image", sha256 }] }]);
		writeFileSync(evidencePath, JSON.stringify({ imageBytes: pixels.length, sha256, fenced }));
		done();
	} else if (message.id === "first_1" && (mode === "final-send-then-failed" || mode === "final-send-then-limit")) {
		// The answer is out; the provider fails the turn's next request (2026-11-13 amendment).
		outputOf(message);
		sendEvidence.fenced = await fence(answered);
		writeFileSync(evidencePath, JSON.stringify({ ...sendEvidence, pending: undefined }));
		failed({
			message: "PRIVATE_PROVIDER_ERROR",
			codexErrorInfo: mode === "final-send-then-limit" ? "usageLimitExceeded" : { httpConnectionFailed: { httpStatusCode: 503 } },
		});
	} else if (message.id === "first_1") {
		outputOf(message);
		// After the answer: bookkeeping, the answer again exactly, or anything else.
		if (mode === "final-send-then-tail") write(call("tail_1", "manage_todo", {}));
		else if (mode === "final-send-replay") write(call("first_2", "send_message", { idempotencyKey: "k1", text: "Done.", phase: "final" }));
		else write(call("note_1", "read_note", {}));
	} else if (message.id === "tail_1" || message.id === "first_2") {
		// The turn goes on after the answer: no interrupt comes, and the model ends the turn itself.
		outputOf(message);
		sendEvidence.fenced = await fence(answered);
		await new Promise((resolve) => setTimeout(resolve, 100));
		writeFileSync(evidencePath, JSON.stringify({ ...sendEvidence, pending: undefined, outputs: answered }));
		if (sendEvidence.interrupt) { failed({ message: "PRIVATE_UNEXPECTED_INTERRUPT" }); return; }
		done();
	} else if (message.id === "note_1" && mode === "final-send-then-note") {
		outputOf(message);
		sendEvidence.outputs = answered;
		sendEvidence.pending = fence(answered);
		sendEvidence.fenced = await sendEvidence.pending;
	} else if (message.id === "note_1" && mode === "report-then-note") {
		// The report's response: the turn goes on, and a later response of one other call does not end it either.
		outputOf(message);
		await fence(answered);
		await new Promise((resolve) => setTimeout(resolve, 100));
		write(call("note_2", "read_note", {}));
	} else if (message.id === "note_2") {
		outputOf(message);
		await fence(answered);
		await new Promise((resolve) => setTimeout(resolve, 100));
		writeFileSync(evidencePath, JSON.stringify({ ...sendEvidence, pending: undefined }));
		if (sendEvidence.interrupt) { failed({ message: "PRIVATE_UNEXPECTED_INTERRUPT" }); return; }
		done();
	} else if (message.id === "note_1" && mode === "report-after-note") {
		// An earlier response's call is no sibling: the report alone in its own response ends the turn.
		outputOf(message);
		await fence(answered);
		await new Promise((resolve) => setTimeout(resolve, 100));
		sendEvidence.earlyInterrupt = sendEvidence.interrupt;
		write(call("report_1", "report_work", { operationKey: "k1", outcome: "succeeded", summary: "Done." }));
	} else if (message.id === "report_2") {
		// The same response's other call named a tool Codex does not have: Codex answered it itself, and only the fence
		// carries that answer.
		outputOf(message);
		answered.push({ kind: "function_call_output", callId: "codex_1", output: "unsupported call: qorpera.made_up" });
		await fence(answered);
		await new Promise((resolve) => setTimeout(resolve, 100));
		writeFileSync(evidencePath, JSON.stringify({ ...sendEvidence, pending: undefined }));
		if (sendEvidence.interrupt) { failed({ message: "PRIVATE_UNEXPECTED_INTERRUPT" }); return; }
		done();
	} else if (message.id === "report_1") {
		outputOf(message);
		sendEvidence.pending = fence(answered);
		sendEvidence.fenced = await sendEvidence.pending;
	} else if (message.id === "public_send") {
		sendEvidence.reply = message;
		sendEvidence.pending = fence([{ kind: "function_call_output", callId: "send_1", output: message.result.contentItems[0].text }]);
		sendEvidence.fenced = await sendEvidence.pending;
		if (mode !== "report-ends-turn") {
			// Give a (wrong) interrupt time to arrive before completing naturally.
			await new Promise((resolve) => setTimeout(resolve, 100));
			writeFileSync(evidencePath, JSON.stringify(sendEvidence));
			if (sendEvidence.interrupt) { failed({ message: "PRIVATE_UNEXPECTED_INTERRUPT" }); return; }
			done();
		}
	} else if (message.method === "turn/interrupt" && mode.startsWith("review") && message.params.threadId === reviewThreadId) {
		reviewEvidence.interrupt = message.params;
		if (mode === "review-turn-start-stalled") writeFileSync(`${evidencePath}.review-interrupt`, JSON.stringify(message.params));
		write({ id: message.id, result: {} });
		write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: "interrupted", error: null } } });
	} else if (message.id === "reviewer_wrong_tool") {
		reviewEvidence.wrongTool = message;
		write({ method: "turn/completed", params: { threadId: reviewThreadId, turn: { id: reviewTurnId, status: "completed", error: null } } });
	} else if (message.id === "verdict_request") {
		reviewEvidence.verdictReply = message;
		// A closing request of the reviewer can still arrive before the interrupt lands.
		reviewClosingFence = fence([{ kind: "function_call_output", callId: "verdict_1", output: message.result.contentItems[0].text }], { threadId: reviewThreadId, turnId: reviewTurnId });
		reviewEvidence.closingFence = await reviewClosingFence;
	} else if (message.id === "review_tool") {
		const mainFenced = await fence([{ kind: "function_call_output", callId: "email_1", output: message.result.contentItems[0].text }]);
		// Readline handlers run concurrently: record the reviewer's closing fence before writing the evidence.
		if (reviewClosingFence) reviewEvidence.closingFence = await reviewClosingFence;
		// The compactor's thread replies during the agent's turn.
		if (mode === "review-compact") await compactReply1;
		writeFileSync(evidencePath, JSON.stringify({ ...reviewEvidence, context: contextEvidence, compact: compactEvidence, mainThread: threadParameters, reply: message, mainFenced }));
		done();
	} else if (message.method === "turn/interrupt" && mode.startsWith("compact") && compactThreadIds.includes(message.params.threadId)) {
		compactEvidence.interrupt = message.params;
		write({ id: message.id, result: {} });
		compactWrite();
		compactCompleted("interrupted");
	} else if (message.id === "compact_tool") {
		compactEvidence.refused = message;
		// Codex hands the refusal back to the model: its next request carries it, answered as unavailable. That answer
		// is no cloud tool result, so the pinned Codex fails the turn.
		compactEvidence.fenced.push(await fence([{ kind: "function_call_output", callId: "compact_call", output: "PRIVATE_COMPACT_OUTPUT" }], compactAt));
		compactWrite();
		compactCompleted("failed", { message: "Cloud result boundary unavailable" });
	} else if (message.id === "correction_send") {
		const outputs = mode.startsWith("company-") ? companyOutputs : answered;
		outputs.push({ kind: "function_call_output", callId: "send_2", output: message.result.contentItems[0].text });
		correction.reply = message;
		correction.pending = fence(outputs, { turnId: correctionTurnId });
		await correction.pending;
		// The final send leaves the added turn open for the run's bookkeeping, as any turn (the 2026-11-13 amendment): with
		// nothing more to do, the model ends it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (correction.interrupt) return;
		writeFileSync(`${evidencePath}.correction`, JSON.stringify({ ...correction, pending: undefined, turns: mainTurns }));
		write({ method: "turn/completed", params: { threadId, turn: { id: correctionTurnId, status: "completed", error: null } } });
	} else if (message.method === "turn/interrupt" && message.params.turnId === correctionTurnId) {
		// An interrupt of the added turn (none is asked for after its final send) ends it.
		correction.interrupt = message.params;
		write({ id: message.id, result: {} });
		await correction.pending;
		writeFileSync(`${evidencePath}.correction`, JSON.stringify({ ...correction, pending: undefined, turns: mainTurns }));
		write({ method: "turn/completed", params: { threadId, turn: { id: correctionTurnId, status: "interrupted", error: null } } });
	} else if (message.method === "turn/interrupt") {
		sendEvidence.interrupt = message.params;
		write({ id: message.id, result: {} });
		if (["report-ends-turn", "report-after-note", "final-send-then-note"].includes(mode)) {
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
