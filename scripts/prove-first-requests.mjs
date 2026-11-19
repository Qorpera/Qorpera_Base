import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { finish, pass, platformCommit, proveCompanyRun, repositoryRoot, textObjects } from "./prove-company-run.mjs";

// What the provider is sent (agents' instructions, track 3, step S0): the first request of four kinds of company run,
// as the real patched Codex sends it to a scripted provider (scripts/prove-company-run.mjs says what is real and what
// stands in), with the run's developer instructions compiled by the runtime's own compile function and its tools made
// by the runtime's own tool factories, composed as the company runtime composes a run of that kind
// (cloud-native-company-runtime.ts): machines available, the company's databases on, no Company Computer, no folder
// search, no company accounts, no connectors, no waiting proposals, no Shared context view. The factories' outside
// parts (the control plane, the gateways, the writers) are stand-ins: the scripted model calls no tool. The tools are
// offered as the company runtime offers that kind's (T3-6): its catalog describes in full what the kind uses most, and
// more_tools lists the rest, which the run still has.
//
//   QORPERA_CODEX_FENCE_BINARY=<patched codex> node scripts/prove-first-requests.mjs
//
// Kinds: a Co-Founder's member turn before and after its company's vision is agreed, its scheduled routine (its planning
// run) and its worker with write access; an employee's member turn, its worker with write access and its scheduled
// routine. The instructions are compiled for the run's own tools (their names, from a dry making of the same tools with
// the runtime's test authority, checked against the run's catalog) and the vision's state. A coding turn is not among them: its instructions and two of its five tools are made
// inside CloudNativeCodingRuntime, which this harness does not drive.
// For each kind it prints the bytes of every part of the request, then three checks on the developer instructions: the
// tools they name that the run lacks, the "when … is offered" clauses, and the founder rules (lanes'
// agent-instructions PLAN.md §3) by one phrase each. A line "FIRST-REQUEST <kind> <json>" carries the whole request.
// The head (vision, job, notebook facts) and the context message are small stand-ins of fixed size; their bytes are
// reported but are not a measure of a real company.

const NOTE = "# Prices\n\nThe price list is ready: 40 kr a cup.\n";
/** Each kind of run; "agreed" is a Co-Founder whose company's vision ends with its "Agreed by" line. */
const KINDS = [
	"cofounder-member",
	"cofounder-member-agreed",
	"cofounder-routine",
	"cofounder-worker",
	"employee-member",
	"employee-worker",
	"employee-routine",
];

/** The founder rules of PLAN.md §3, each by one phrase of the text and its count (track 3, T3-3 words). Every other rule
 * the rewrite kept is checked per kind of run by packages/runtime/test/cloud-agent-instruction-rules.test.ts. */
const FOUNDER_RULES = [
	["P1 a capable colleague", "Act; do not ask for permission you have."],
	["P2 the gate is in code", "What you can do is what your tools allow"],
	["P3 fewer human touches", "Never hand them long reading or work the team can do."],
	["P4 company first", "The company is its files"],
	["P5 the Co-Founder hires", "You hire and manage"],
	["P5 from the first conversation", "from the first conversation on"],
	["P6 full ambition", "full ambition"],
	["P7 show, do not tell", "write little and show a lot"],
	["P7 work started: the acknowledgement", "it is how the member learns that work has started"],
	["P8 purpose before rules", "# Your company\n"],
	["P9 the tool-result rules once", "# Tool results\n"],
];

async function bundle(scratch) {
	const modulePath = join(scratch, "first-requests.mjs");
	const src = (file) => `./packages/runtime/src/${file}.ts`;
	await build({
		absWorkingDir: repositoryRoot,
		stdin: {
			resolveDir: repositoryRoot,
			contents: [
				`export {compileCloudNativeCompanyInstructions, composeCloudNativeCompanyPrompt, cloudCompanyContextTool} from "${src("cloud-native-company-context")}";`,
				`export {CLOUD_TOOL_RESULT_INSTRUCTIONS, redactCloudWebhookSecrets} from "${src("cloud-native-tool-boundary")}";`,
				`export {CLOUD_RUNTIME_TOOL_OPERATIONS} from "${src("cloud-runtime-observability")}";`,
				`export {CLOUD_CONNECTORS} from "${src("cloud-connector-catalog")}";`,
				`export {cloudInterfaceTools} from "${src("cloud-folder-interface-tools")}";`,
				`export {cloudInterfaceWriteTools} from "${src("cloud-folder-interface-writes")}";`,
				`export {cloudAppTools} from "${src("cloud-folder-app-tools")}";`,
				`export {cloudPictureTool} from "${src("cloud-folder-picture-tool")}";`,
				`export {CloudPictureChannel} from "${src("cloud-picture-channel")}";`,
				`export {cloudDataTools} from "${src("cloud-data-tools")}";`,
				`export {cloudCoworkerMessageTool} from "${src("cloud-wake-bus")}";`,
				`export {cloudRoutineTools} from "${src("cloud-routine-tools")}";`,
				`export {cloudSidebarTools} from "${src("cloud-sidebar-tools")}";`,
				`export {cloudAppGroupsTool} from "${src("cloud-folder-app-groups")}";`,
				`export {cloudReviewRuleTools} from "${src("cloud-review-rule-tools")}";`,
				`export {cloudGoodWillTools} from "${src("cloud-good-will-tools")}";`,
				`export {cloudMemberOfferTools} from "${src("cloud-member-offer-tools")}";`,
				`export {cloudRecordReflectionTool, cloudPlatformUpdatesContext, PLATFORM_UPDATES} from "${src("cloud-platform-updates")}";`,
				`export {cloudReadingTool} from "${src("cloud-folder-reading")}";`,
				`export {cloudEventTools} from "${src("cloud-event-tools")}";`,
				`export {cloudSiteTools} from "${src("cloud-site-tools")}";`,
				`export {cloudMachineTools} from "${src("cloud-machine-tools")}";`,
				`export {cloudMemoryTools} from "${src("cloud-memory-tools")}";`,
				`export {cloudSkillTools} from "${src("cloud-skill-tools")}";`,
				`export {cloudHiringTools} from "${src("cloud-hiring-tools")}";`,
				`export {cloudWorkerTools, cloudWorkerToolFilter} from "${src("cloud-worker-tools")}";`,
				`export {cloudCodeTools} from "${src("cloud-code-tools")}";`,
				`export {CLOUD_AGENT_SEND_INSTRUCTIONS} from "${src("cloud-agent-mouth")}";`,
				`export {cloudFolderFileTools} from "${src("cloud-folder-file-tools")}";`,
				`export {CloudNativeToolRun} from "${src("cloud-native-tool-authority")}";`,
				'export {nativeToolAuthorityFixture} from "./packages/runtime/test/fixtures/native-tool-authority-fixture.ts";',
				`export * from "${src("cloud-thread-interactions")}";`,
				`export {cloudToolsOnDemand} from "${src("cloud-native-tools-on-demand")}";`,
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

/** A stand-in for every outside part a tool factory keeps: any property, call or construction gives another. Never
 * called here: the scripted model makes no tool call. */
function standIn() {
	const target = () => undefined;
	return new Proxy(target, {
		get(_target, key) {
			if (key === "then") return undefined;
			if (key === Symbol.iterator) return function* () {};
			if (key === Symbol.toPrimitive || key === "toString") return () => "stand-in";
			return standIn();
		},
		apply: () => standIn(),
		construct: () => standIn(),
	});
}

const uuid = (n) => `92400000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POLICY = {
	member: { initial: "required", final: "required", silenceAllowed: false, maxPublicSends: null },
	worker: { initial: "forbidden", final: "forbidden", silenceAllowed: true, maxPublicSends: 0 },
	routine: { initial: "forbidden", final: "optional", silenceAllowed: true, maxPublicSends: null },
};

/** The wake of each kind, as the context composer and the compile function read it. */
function wakeOf(kind, identity) {
	const base = {
		id: uuid(901),
		runId: identity.runId,
		companyId: identity.companyId,
		staffAgentId: identity.staffAgentId,
		actorStaffId: null,
		actorUserId: null,
		time: { utc: "2026-11-14T09:00:00Z", local: "2026-11-14T10:00:00+01:00", timeZone: "Europe/Copenhagen" },
		routine: null,
		payload: {},
		parentRunId: null,
		causal: { agentIds: [] },
	};
	if (kind.includes("-member"))
		return {
			...base,
			kind: "human",
			actorUserId: uuid(1),
			source: { kind: "input", id: uuid(902), occurrenceKey: "input:1" },
			policy: POLICY.member,
		};
	if (kind.endsWith("-worker"))
		return {
			...base,
			kind: "agent",
			source: { kind: "worker-dispatch", id: uuid(903), occurrenceKey: "worker-dispatch:1" },
			payload: { access: "write", species: "worker", outputFolder: "research/suppliers" },
			parentRunId: uuid(904),
			policy: POLICY.worker,
		};
	return {
		...base,
		kind: "routine",
		source: { kind: "schedule", id: uuid(905), occurrenceKey: "schedule:1" },
		routine: { id: uuid(905), dynamic: false, intent: "Every Monday: the week's sales in two lines." },
		policy: POLICY.routine,
	};
}

/** A small, fixed head (stand-in): the vision, the job and two notebook facts; an agreed vision ends with its line. */
const headOf = (agreed) => JSON.stringify({
	schema: "qorpera.agent-head/v1",
	parts: [
		{ part: "vision", path: "QorperaOS/vision/vision.md", trust: "company_instructions_not_authority", text: `${"We make coffee cups that keep coffee hot for an hour. ".repeat(12)}${agreed ? "\nAgreed by Jonas, 2026-11-14." : ""}` },
		{ part: "job", path: "QorperaOS/agents/alice/agent.md", trust: "job_specification_not_authority", text: "Owns sales: prices, the shop and the first customers. ".repeat(6) },
		{ part: "profile", path: "QorperaOS/agents/alice/memory/profile.md", trust: "own_notebook_not_authority", facts: ["Jonas likes short replies with the numbers first.", "The price list lives in sales/price-list.md."] },
	],
});

/** An identity of the run's shape for the compiled texts: the same lengths as the harness run's own. */
const STAND_IN_IDENTITY = {
	companyId: uuid(10),
	environmentId: uuid(11),
	runId: uuid(12),
	staffAgentId: uuid(13),
	staffVersion: 3,
	runtimeBundleId: uuid(14),
	runtimeBundleSha256: "a".repeat(64),
	audienceKind: "company",
};

/** The context the run is compiled from (cloud-native-company-context.ts), for one kind. */
function contextOf(kind, identity) {
	const agentKind = kind.startsWith("cofounder") ? "cofounder" : "employee";
	const sessionId = kind.endsWith("-worker") ? null : uuid(906);
	const source = (id, sourceKind, text) => ({
		kind: sourceKind === "input" ? "current_human_request" : "historical_data",
		sourceKind,
		id,
		actorKind: sourceKind === "input" ? "human" : "control_plane",
		authorUserId: sourceKind === "input" ? uuid(1) : null,
		sequence: sourceKind === "input" ? 1 : null,
		images: [],
		content: { text, originalBytes: Buffer.byteLength(text), sha256: "0".repeat(64), offset: 0, nextOffset: null, truncated: false },
	});
	const input = kind.includes("-member")
		? [source(uuid(907), "input", "Is the price list ready?")]
		: [];
	return {
		schema: "qorpera.native-company-context/v1",
		identity: { ...identity, sessionId },
		observedAt: "2026-11-14T09:00:00Z",
		company: { id: identity.companyId, name: "Kopper" },
		agent: { id: identity.staffAgentId, version: identity.staffVersion, name: agentKind === "cofounder" ? "Co-Founder" : "Alice", role: agentKind === "cofounder" ? "Co-Founder" : "Sales lead" },
		agentKind,
		initialAcknowledgementSatisfied: false,
		audience: { kind: "company", userId: null },
		runtimeBundle: { id: identity.runtimeBundleId, sha256: identity.runtimeBundleSha256 },
		sourceKind: kind.includes("-member") ? "session_turn" : "wake",
		sourceId: uuid(908),
		currentInputs: input,
		history: [],
		historyTruncated: false,
		coworkers: [],
		coworkersTruncated: false,
		job: source(uuid(909), "job", "{}"),
		jobSpecification: source(uuid(910), "job_spec", "Owns sales."),
		continuation: null,
		folder: { agent: "alice", coworkers: {} },
	};
}

/** The names of a run's tools of this kind, from a dry making of them with the runtime's test authority (nothing is
 * called): the folder file tools the harness gives, then the rest. */
async function dryNames(mine, kind) {
	const { binding, authority } = mine.nativeToolAuthorityFixture();
	const run = await mine.CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	const identity = run.identity;
	const context = contextOf(kind, identity);
	// The folder client stands in too; the event tools check it acts for this run.
	const actor = { runId: identity.runId.toLowerCase() };
	const folder = new Proxy(standIn(), { get: (target, key) => (key === "actor" ? actor : target[key]) });
	const made = [
		...mine.cloudFolderFileTools({ folder, operations: standIn(), identity }),
		...toolsOf(mine, kind, context, wakeOf(kind, context.identity), {
			binding,
			folder,
			operations: standIn(),
			identity,
		}),
	];
	// more_tools too, as the company runtime compiles a run that opens tools through it (T3-6).
	const onDemand = mine.cloudToolsOnDemand(made, onDemandKind(kind));
	return new Set(onDemand.tools.map((tool) => tool.name));
}

/** The run's tools beside the folder file tools the harness gives, in the company runtime's order. */
function toolsOf(mine, kind, context, wake, { binding, folder, operations, identity }) {
	const work = mine.cloudWorkerToolFilter(wake);
	const machines = { gateway: standIn(), operations };
	const send = {
		name: "send_message",
		source: "runtime",
		description: mine.CLOUD_AGENT_SEND_INSTRUCTIONS,
		inputSchema: {
			type: "object",
			properties: {
				idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
				text: { type: "string", minLength: 1, maxLength: 65536 },
				phase: { type: "string", enum: ["progress", "final"] },
			},
			required: ["idempotencyKey", "text", "phase"],
			additionalProperties: false,
		},
		parseArguments: (value) => value,
		execute: async () => ({ kind: "text", value: "{}" }),
	};
	// ask_member as the company runtime makes it, for a run without Gmail's tools (no connectors here).
	const ask = {
		name: "ask_member",
		source: "runtime",
		description: mine.cloudAskMemberInstructions
			? mine.cloudAskMemberInstructions(false)
			: mine.CLOUD_ASK_MEMBER_INSTRUCTIONS,
		inputSchema: mine.CLOUD_ASK_MEMBER_INPUT_SCHEMA ?? {
			type: "object",
			properties: {
				idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
				text: { type: "string", minLength: 1, maxLength: 4096 },
				surface: { type: "string", enum: [...mine.CLOUD_ASK_MEMBER_SURFACES] },
				title: { type: "string", minLength: 1, maxLength: 200 },
				body: { type: "string", maxLength: mine.CLOUD_ASK_MEMBER_BODY_MAX_BYTES },
				expiresAt: { type: "string" },
				payload: mine.CLOUD_ASK_MEMBER_PAYLOAD_SCHEMA,
			},
			required: ["idempotencyKey", "text", "surface", "title", "payload"],
			additionalProperties: false,
		},
		parseArguments: (value) => value,
		execute: async () => ({ kind: "text", value: "{}" }),
	};
	const place = { core: "folder-v2", handle: "alice" };
	return [
		...[
			...mine.cloudInterfaceTools({ folder, identity, timeZone: "Europe/Copenhagen" }),
			...mine.cloudInterfaceWriteTools({ folder, operations, identity }),
			...mine.cloudAppTools({ folder, operations, identity }),
			mine.cloudPictureTool({ folder, operations, identity, pictures: new mine.CloudPictureChannel() }),
		].filter(work.companyFile),
		...mine.cloudDataTools({ folder, door: standIn(), apply: !work.isWorker }),
		mine.cloudCompanyContextTool(context, binding, standIn()),
		...(work.isWorker
			? []
			: [
					mine.cloudCoworkerMessageTool(binding, identity, standIn()),
					...mine.cloudRoutineTools(binding, identity, undefined, standIn()),
					...mine.cloudSidebarTools(binding, identity, { folderSidebar: standIn() }),
					mine.cloudAppGroupsTool({ folder, operations, identity }),
					...mine.cloudReviewRuleTools(binding, identity, standIn()),
					...mine.cloudGoodWillTools(binding, identity, standIn()),
					...(context.agentKind === "cofounder" ? mine.cloudMemberOfferTools(binding, identity, standIn()) : []),
					...(context.agentKind === "cofounder" ? [mine.cloudRecordReflectionTool({ folder, operations, identity })] : []),
					// The company's reading of itself (20260930766000): the Co-Founder's company runs.
					...(context.agentKind === "cofounder" ? [mine.cloudReadingTool(identity, standIn())] : []),
					...mine.cloudEventTools(binding, identity, standIn(), folder),
					...mine.cloudSiteTools({ binding, identity, control: standIn(), folder, machines }),
				]),
		...mine.cloudMachineTools({
			binding,
			identity,
			control: standIn(),
			operations,
			gateway: standIn(),
			worker: work.isWorker,
			codingValues: standIn(),
		}),
		...mine
			.cloudMemoryTools(standIn(), identity, place)
			.filter((tool) => tool.name === "recall_memory" || work.companyFile({ ...tool, name: "company_write" })),
		...mine
			.cloudSkillTools(standIn(), identity, place)
			.filter((tool) => tool.name !== "update_skill" || work.companyFile({ ...tool, name: "company_write" })),
		...(work.isWorker ? [] : mine.cloudHiringTools(identity, { folderHiring: standIn(), folderGroupChats: standIn() })),
		...mine.cloudWorkerTools(binding, identity, wake, {
			machines: true,
			folderTodos: standIn(),
			folderWorkers: standIn(),
		}),
		...(work.isWorker ? [] : mine.cloudCodeTools({ folder, identity })),
		...(context.identity.sessionId && wake.policy.final !== "forbidden" ? [send] : []),
		...(context.identity.sessionId && wake.policy.final !== "forbidden" && !work.isWorker ? [ask] : []),
	];
}

/** The kind of run whose tools the company runtime offers (T3-6): what its catalog describes in full. */
const onDemandKind = (kind) => (kind.endsWith("-worker") ? "worker" : kind.startsWith("cofounder") ? "cofounder" : "employee");

/** The tools more_tools' description lists, by name. */
const listedBy = (tool) => (tool ? [...tool.description.matchAll(/^- ([a-z][a-z0-9_]*)(?::|$)/gm)].map((match) => match[1]) : []);

const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every text a message item carries. */
function textOf(item) {
	if (typeof item.content === "string") return item.content;
	if (Array.isArray(item.content)) return item.content.map((part) => part.text ?? "").join("");
	return "";
}

/** Bytes of each part of the request, ours told apart from Codex's own. */
function measure(body, developer, prompt, ourTools) {
	const parts = {};
	for (const [key, value] of Object.entries(body)) parts[`body.${key}`] = bytes(value);
	const input = body.input.map((item) => {
		const text = textOf(item);
		// Codex may wrap a text of ours: the bytes it adds around it are its own.
		const ours = text.includes(developer)
			? `our developer instructions (+${bytes(text) - bytes(developer)} B around them)`
			: text.includes(prompt)
				? `our context message (+${bytes(text) - bytes(prompt)} B around it)`
				: null;
		return { type: item.type, role: item.role ?? null, bytes: bytes(item), textBytes: bytes(text), ours, start: text.slice(0, 80) };
	});
	// The tools: our namespace wherever Codex put it, the rest Codex's own.
	let namespace = null;
	const find = (value, path) => {
		if (!value || typeof value !== "object") return;
		if (!Array.isArray(value) && value.type === "namespace" && value.name === "qorpera") {
			namespace = { path, value };
			return;
		}
		for (const [key, child] of Object.entries(value)) find(child, `${path}.${key}`);
	};
	find(body, "body");
	assert(namespace, "the request carries the qorpera namespace");
	const sent = namespace.value.tools ?? [];
	const names = new Set(sent.map((tool) => tool.name));
	for (const name of ourTools) assert(names.has(name), `the request carries ${name}`);
	return {
		parts,
		input,
		namespacePath: namespace.path,
		namespaceBytes: bytes(namespace.value),
		toolCount: sent.length,
		toolDescriptionBytes: sent.reduce((sum, tool) => sum + bytes(tool.description ?? ""), 0),
		perTool: Object.fromEntries(sent.map((tool) => [tool.name, bytes(tool)])),
		// A schema over about 5,000 bytes as sent loses every field description (T3-5's probe): each tool's, as sent.
		perToolParameters: Object.fromEntries(sent.map((tool) => [tool.name, bytes(tool.parameters ?? {})])),
		perToolFieldDescriptions: Object.fromEntries(
			sent.map((tool) => [tool.name, (JSON.stringify(tool.parameters ?? {}).match(/"description"/g) ?? []).length]),
		),
		codexInstructionsBytes: typeof body.instructions === "string" ? bytes(body.instructions) : 0,
	};
}

/** The three checks on the developer instructions. */
function checks(mine, developer, toolNames) {
	const universe = new Set([
		...mine.CLOUD_RUNTIME_TOOL_OPERATIONS,
		...mine.CLOUD_CONNECTORS.flatMap((connector) => connector.operations.map((operation) => operation.toolName)),
	]);
	universe.delete("zoom"); // also a plain word
	const lacking = [...universe]
		.filter((name) => !toolNames.has(name) && new RegExp(`\\b${escape(name)}\\b`).test(developer))
		.sort();
	const offered = developer.match(/\b(?:when|while|if)\b[^.;:\n]{0,160}?\b(?:is|are)\s+offered\b/gi) ?? [];
	const isOffered = (developer.match(/\b(?:is|are)\s+offered\b/gi) ?? []).length;
	const rules = Object.fromEntries(
		FOUNDER_RULES.map(([rule, phrase]) => [rule, developer.split(phrase).length - 1]),
	);
	return { lacking, offeredClauses: offered.length, isOfferedPhrases: isOffered, rules };
}

async function main() {
	const scratch = await mkdtemp(join(tmpdir(), "prove-first-requests-"));
	try {
		const mine = await bundle(scratch);
		const summary = {};
		for (const kind of KINDS) {
			// The instructions and the context message are compiled before the run from a stand-in identity of the same
			// shape (ids and hashes of the same length): only the binding record and the context's identity print them.
			// The tools are made in the run, from its own identity, which their factories check against its binding.
			const shown = contextOf(kind, STAND_IN_IDENTITY);
			const shownWake = wakeOf(kind, shown.identity);
			const agreed = kind.endsWith("-agreed");
			const HEAD = headOf(agreed);
			const names = await dryNames(mine, kind);
			const instructions = mine.compileCloudNativeCompanyInstructions(shown, shownWake, {
				head: HEAD,
				tools: names,
				visionAgreed: agreed,
			});
			const prompt = mine.composeCloudNativeCompanyPrompt(
				shown,
				shownWake,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				[],
				kind === "cofounder-routine" ? mine.cloudPlatformUpdatesContext(mine.PLATFORM_UPDATES) : undefined,
			);
			// A company run's instructions carry the tool-result rules after its purpose and files (track 3, T3-3).
			const developer = mine.redactCloudWebhookSecrets(instructions);
			let tools;
			await proveCompanyRun({
				name: `qorpera_prove_first_${kind.replaceAll("-", "_")}`,
				prompt,
				runtimeInstructions: instructions,
				resultRulesInside: true,
				// One read, so the run keeps a log (the harness reads it back); the first request comes before it.
				setup: platformCommit("prove-first-notes", [
					{ op: "mkdir", path: "notes" },
					{ op: "write", path: "notes/prices.md", text: NOTE },
				]),
				objects: textObjects([NOTE]),
				calls: [() => ({ name: "company_list", arguments: { path: "notes" } })],
				onDemand: onDemandKind(kind),
				tools: (_code, { binding, folder, operations, identity }) => {
					const context = contextOf(kind, identity);
					tools = toolsOf(mine, kind, context, wakeOf(kind, context.identity), { binding, folder, operations, identity });
					return tools;
				},
				check: async ({ state }) => {
					assert(tools, "the run's tools were made");
					const body = state.agent[0].body;
					// The run's tools as offered (T3-6): its catalog, and more_tools for the rest, as the request carries them
					// (the harness adds the folder file tools to these, then offers them by the kind).
					const offered = mine.cloudToolsOnDemand(tools, onDemandKind(kind));
					const measured = measure(
						body,
						developer,
						prompt,
						offered.tools.filter((tool) => !offered.deferred.has(tool.name)).map((tool) => tool.name),
					);
					const sentMore = body.input[0]?.tools?.[0]?.tools?.find((tool) => tool.name === "more_tools");
					const onDemand = listedBy(sentMore);
					for (const name of offered.deferred) assert(onDemand.includes(name), `more_tools lists ${name}`);
					assert.deepEqual(
						[...Object.keys(measured.perTool).filter((name) => name !== "more_tools"), ...onDemand].sort(),
						[...names].filter((name) => name !== "more_tools").sort(),
						"the instructions were compiled for the run's own tools, every one in its catalog or in more_tools",
					);
					assert.equal(Object.hasOwn(measured.perTool, "more_tools"), onDemand.length > 0);
					assert(
						measured.input.some((item) => item.ours?.startsWith("our developer instructions")) ||
							(typeof body.instructions === "string" && body.instructions.includes(developer)),
						"the request carries our developer instructions whole",
					);
					const checked = checks(mine, developer, names);
					const result = {
						kind,
						developerInstructionsBytes: bytes(developer),
						toolResultRulesBytes: bytes(mine.CLOUD_TOOL_RESULT_INSTRUCTIONS),
						compiledInstructionsBytes: bytes(instructions),
						headBytes: bytes(HEAD),
						contextMessageBytes: bytes(prompt),
						requestBytes: bytes(body),
						...measured,
						onDemand,
						moreTools: sentMore ?? null,
						checks: checked,
					};
					summary[kind] = result;
					pass(
						`${kind}: the first request carries our instructions (${result.developerInstructionsBytes} B) and ${result.toolCount} tools (${result.namespaceBytes} B as sent)`,
					);
					process.stdout.write(`S0 ${kind} ${JSON.stringify(result)}\n`);
					process.stdout.write(`FIRST-REQUEST ${kind} ${JSON.stringify(body)}\n`);
				},
			});
		}
		process.stdout.write(`S0 SUMMARY ${JSON.stringify(Object.fromEntries(Object.entries(summary).map(([kind, r]) => [kind, { request: r.requestBytes, codex: r.codexInstructionsBytes, developer: r.developerInstructionsBytes, tools: r.namespaceBytes, toolCount: r.toolCount, onDemand: r.onDemand.length, context: r.contextMessageBytes, lacking: r.checks.lacking, offered: r.checks.offeredClauses }])))}\n`);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

finish(main());
