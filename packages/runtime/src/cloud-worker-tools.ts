import { POSTGRES_UUID_PATTERN, parseCloudCodingRepository } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import type { CloudFolderTodoChange, CloudFolderTodoListing, CloudFolderTodos } from "./cloud-folder-todos.ts";
import type {
	CloudFolderWorkerChange,
	CloudFolderWorkerReport,
	CloudFolderWorkerStatus,
	CloudFolderWorkers,
} from "./cloud-folder-workers.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	CLOUD_TOOL_RESULT_RESERVE_BYTES,
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	MAX_CLOUD_TOOL_RESULT_BYTES,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import type { CloudWakeEnvelope } from "./cloud-wake-bus.ts";

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const WORK_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TODO_ACTIONS = ["list", "upsert", "done", "cancel"] as const;
const WORKER_ACTIONS = ["status", "dispatch", "followup", "cancel", "decide", "archive"] as const;
const OUTCOMES = ["succeeded", "blocked", "failed"] as const;
const TODO_STATES = ["open", "blocked", "done", "cancelled"] as const;
const WORKER_STATES = ["active", "blocked", "succeeded", "failed", "cancelled"] as const;
/** A listing cursor: the id of the last item shown before (keyset on creation order). */
export const CURSOR = POSTGRES_UUID_PATTERN;

function object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CloudToolArgumentRefusal("the arguments must be one JSON object");
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new CloudToolArgumentRefusal(`this call takes only these fields: ${allowed.join(", ")}`);
	const missing = required.filter((key) => !Object.hasOwn(value, key));
	if (missing.length) throw new CloudToolArgumentRefusal(`this call also needs: ${missing.join(", ")}`);
	return value as Record<string, unknown>;
}
function text(field: string, value: unknown, maxBytes: number, singleLine = false): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.includes("\0") ||
		(singleLine && /[\r\n]/.test(value)) ||
		Buffer.byteLength(value.trim()) > maxBytes ||
		Buffer.from(value).toString("utf8") !== value
	)
		throw new CloudToolArgumentRefusal(
			`${field} must be text of 1 to ${maxBytes} bytes${singleLine ? " on one line" : ""}`,
		);
	return value.trim();
}
function optionalText(field: string, value: unknown, maxBytes: number): string | undefined {
	if (value === undefined || value === "") return undefined;
	return text(field, value, maxBytes);
}
function key(field: string, value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value))
		throw new CloudToolArgumentRefusal(
			pattern === WORK_KEY
				? `${field} must be lowercase letters, digits, dots, underscores and hyphens, starting with a letter or digit, at most 64 characters`
				: `${field} must be letters, digits, dots, underscores, colons and hyphens, starting with a letter or digit, at most 96 characters`,
		);
	return value;
}
/** The filters and cursor of a listing, each sent only when given. */
function listing(a: Record<string, unknown>, states: readonly string[]): Record<string, unknown> {
	if (a.state !== undefined && (typeof a.state !== "string" || !states.includes(a.state)))
		throw new CloudToolArgumentRefusal(`state must be one of ${states.join(", ")}`);
	if (
		a.search !== undefined &&
		(typeof a.search !== "string" ||
			/[\u0000-\u001f\u007f-\u009f]/.test(a.search) ||
			!a.search.trim() ||
			Buffer.byteLength(a.search.trim()) > 200)
	)
		throw new CloudToolArgumentRefusal("search must be 1 to 200 bytes of text on one line");
	if (a.cursor !== undefined && (typeof a.cursor !== "string" || !CURSOR.test(a.cursor)))
		throw new CloudToolArgumentRefusal("cursor must be a nextCursor from an earlier page, unchanged");
	return {
		...(a.state === undefined ? {} : { state: a.state }),
		...(a.search === undefined ? {} : { search: text("search", a.search, 200, true) }),
		...(a.cursor === undefined ? {} : { cursor: a.cursor }),
	};
}
/** Whether a result text reaches the model whole: the fence escapes it once more
 * inside its provenance and cuts anything past MAX_CLOUD_TOOL_RESULT_BYTES. */
export function fitsOneResult(text: string): boolean {
	return (
		Buffer.byteLength(JSON.stringify(text).replace(/[<>&\u2028\u2029]/g, "\\u0000")) <=
		MAX_CLOUD_TOOL_RESULT_BYTES - CLOUD_TOOL_RESULT_RESERVE_BYTES
	);
}
function paths(field: string, value: unknown, max: number, maxBytes: number): string[] {
	if (value === undefined) return [];
	const listed = Array.isArray(value)
		? value.map((path) => (typeof path === "string" && path.length > 1 ? path.replace(/\/$/, "") : path))
		: value;
	return checkedPaths(field, listed, max, maxBytes);
}
function checkedPaths(field: string, value: unknown, max: number, maxBytes: number): string[] {
	if (
		!Array.isArray(value) ||
		value.length > max ||
		new Set(value).size !== value.length ||
		value.some(
			(path) =>
				typeof path !== "string" ||
				!path ||
				Buffer.byteLength(path) > maxBytes ||
				path.startsWith("/") ||
				path.split("/").some((part) => !part || part === "." || part === ".."),
		)
	)
		throw new CloudToolArgumentRefusal(
			max === 1
				? `${field} must be one relative company path of at most ${maxBytes} bytes (no leading slash, no . or .. parts)`
				: `${field} must be a list of up to ${max} different relative company paths of at most ${maxBytes} bytes each (no leading slash, no . or .. parts)`,
		);
	return value as string[];
}

/** The sentence a dispatch's saveTo adds to its brief's context: where the worker saves the finished files. */
export function workerSaveToText(folder: string): string {
	return `Save the finished files in ${folder}/ in the company folder, where they belong, and list them in your report.`;
}

export const CLOUD_TODO_TOOL_DESCRIPTION = [
	"Your open work as durable todos: a todo survives this run, a restart and an archived chat, where a promise to remember does not. Use one for work that outlives this run: anything you hand to a worker, a multi-step job, or something you told a member you would come back to; not for work you finish now.",
	"Actions:",
	"- list: your open and blocked todos, newest first, as many as fit one result, each with the start of its detail. Name a todoKey to read one whole; narrow with state or search, or widen with includeClosed. More pages while moreTodos is above zero.",
	"- upsert: make or update the todo of todoKey (title, detail, state). One todoKey for one piece of work.",
	"- done: close finished work; refused while a worker is still active on it.",
	"- cancel: close abandoned work and cancel its workers.",
	"Each todo is a file in your folder, at the path in the result, named by its todoKey. A conflict means the file changed since it was read: call again with a new operationKey.",
].join("\n");

const CLOUD_WORKER_TOOL_INTRO =
	"Hand bounded work to a background worker, so you stay free for the conversation. A worker is a blank, separate run of you: it sees nothing of this conversation, speaks to no one and reports only to you. Use one for heavy or parallel work: research, reading many files, a long draft, a slow check";

export const CLOUD_WORKER_TOOL_DESCRIPTION = [
	`${CLOUD_WORKER_TOOL_INTRO}, tests or builds on the company's machines (a worker starts and uses machines as you do, and waits for its own commands). Do quick work yourself.`,
	"Every worker belongs to a todo (make it with manage_todo first) and has a workerKey. Every action takes the todo's todoKey; all but status also take operationKey and workerKey.",
	"Actions:",
	"- dispatch: start one, with title, goal, definitionOfDone and access, and context, sources, saveTo and revival as needed. The worker starts from nothing, so the brief must be complete.",
	"- status: the workers of one todo (name its todoKey), newest first, as many as fit one result, each with the start of its summary; filter with state or search, and name a workerKey too for one whole result. More pages while moreWorkers is above zero.",
	"- followup: new instructions or a missing answer (text) for the same finished or blocked worker, which keeps its history. Prefer it to a new dispatch on the same work.",
	"- cancel: stop one.",
	"- decide: accept or reject a finished result (decision, note). Accept only after checking it against its definition of done.",
	"- archive: close a coding session you no longer need. Its programs stop and it leaves its machine; its files are kept, and a later followup reopens it.",
	"Results: a blocked worker wakes you at once. Reports come back four per continuation, one continuation at a time, so a report waits while a continuation of yours runs; stillActive counts those still to come. When a person stops a continuation, the workers still running for that work stop and their reports are held: read them with status.",
	"Coding sessions (species coding, with harness and repository; access stays read): a session runs for the member who asked, on their own account, on an isolated machine, and ends each turn with a landed change, a report-only finish (when HEAD still equals the session's baseSha with no open pull request, such as a read-only inspection), or a question for that member. Between turns it stands by on its machine with what it left running; the machine sleeps after a quiet period, which stops those programs and keeps the files, and only a busy program keeps it awake (a session busy for hours after a turn brings you check-ins). Only that member talks to it directly; you steer it with followup, from work that member started.",
].join("\n");

/** Without company machines (no node serves them yet), the description names none. */
const CLOUD_WORKER_TOOL_DESCRIPTION_WITHOUT_MACHINES = CLOUD_WORKER_TOOL_DESCRIPTION.replace(
	", tests or builds on the company's machines (a worker starts and uses machines as you do, and waits for its own commands)",
	"",
);

/** Whether report_work's answer, first made or replayed from its receipt, says the folder saved the report. */
function reportSaved(content: CloudToolContent): boolean {
	if (content.kind !== "text") return false;
	try {
		const answer = JSON.parse(content.value) as { schema?: unknown; outcome?: unknown };
		return answer.schema === "qorpera.worker-report-receipt/v1" && answer.outcome === "saved";
	} catch {
		return false;
	}
}

export const CLOUD_WORKER_REPORT_TOOL_DESCRIPTION = [
	"Report your result to the run that started you: your only way out, since you speak to no one and a run that ends without a report counts as failed. Report exactly once, when the definition of done in wake.payload.dispatch is met or you cannot go on; after a confirmed report, stop.",
	"Write the files first, in the folder the dispatch names, else inside wake.payload.outputFolder, and list them in outputs; a path you did not write in this run is refused.",
].join("\n");

/** Order 5 (contract 13). The cloud derives the agent, the parent and the todo
 * from the run; the model chooses only the work. A company run's todos are files
 * in its agent's folder and its workers are folders of those todos: the folder
 * writers (`CloudFolderTodos`, `CloudFolderWorkers`) save each change through the
 * folder core, which decides it (legacy sweep step C, C-P2: no kernel rows).
 */
export function cloudWorkerTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	wake: Pick<CloudWakeEnvelope, "kind" | "source">,
	/** Whether this run's workers can use company machines (only when a node serves them); and the run's todos and
	 * workers as files. */
	options: { machines?: boolean; folderTodos: CloudFolderTodos; folderWorkers: CloudFolderWorkers },
): readonly CloudNativeTool[] {
	const admitted = parseCloudNativeToolBinding(binding),
		expected = Object.freeze({ ...identity });
	if (
		Object.entries(admitted).some(
			([name, value]) => name !== "credentialCapsuleId" && expected[name as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Worker binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([name, value]) => context.identity![name as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Worker tool identity differs");
		context.signal.throwIfAborted();
	};
	const { folderTodos, folderWorkers } = options;

	if (wake.kind === "agent" && wake.source.kind === "worker-dispatch") {
		const report: CloudNativeTool = {
			name: "report_work" satisfies CloudRuntimeToolOperation,
			source: "worker",
			description: CLOUD_WORKER_REPORT_TOOL_DESCRIPTION,
			inputSchema: {
				type: "object",
				additionalProperties: false,
				required: ["operationKey", "outcome", "summary"],
				properties: {
					operationKey: { type: "string", pattern: OPERATION_KEY.source },
					outcome: {
						type: "string",
						enum: [...OUTCOMES],
						description:
							"succeeded: the definition of done is met. blocked: you need something only your parent can give (say what in needs). failed: it cannot be done (say why).",
					},
					summary: {
						type: "string",
						minLength: 1,
						maxLength: 4000,
						description:
							"What your parent acts on, up to 4000 bytes: the result first, then what you verified and what you did not. Long material goes in a file.",
					},
					needs: {
						type: "string",
						maxLength: 1000,
						description: "With blocked only: exactly what you need, up to 1000 bytes.",
					},
					outputs: {
						type: "array",
						maxItems: 4,
						uniqueItems: true,
						items: { type: "string", minLength: 1, maxLength: 256 },
						description: "Up to 4 company paths of files you wrote in this run.",
					},
				},
			},
			parseArguments(value) {
				const a = object(
					value,
					["operationKey", "outcome", "summary", "needs", "outputs"],
					["operationKey", "outcome", "summary"],
				);
				if (typeof a.outcome !== "string" || !OUTCOMES.includes(a.outcome as (typeof OUTCOMES)[number]))
					throw new CloudToolArgumentRefusal(`outcome must be one of ${OUTCOMES.join(", ")}`);
				const needs = optionalText("needs", a.needs, 1000);
				if ((a.outcome === "blocked") !== (needs !== undefined))
					throw new CloudToolArgumentRefusal("needs is given with outcome blocked, and only then");
				const outputs = paths("outputs", a.outputs, 4, 256);
				return {
					operationKey: key("operationKey", a.operationKey, OPERATION_KEY),
					outcome: a.outcome,
					summary: text("summary", a.summary, 4000),
					...(needs === undefined ? {} : { needs }),
					...(outputs.length ? { outputs } : {}),
				};
			},
			async execute(value, context) {
				assertContext(context);
				// A worker reports in its results file; the folder core decides the save.
				const content = await folderWorkers.report(value as unknown as CloudFolderWorkerReport, context);
				// A saved report is the worker's last act: its answer says "stop now", and nobody reads what the model writes
				// next. A report that was not saved says to report again, so that turn goes on.
				return reportSaved(content) ? { ...content, completesTurn: true } : content;
			},
		};
		return [report];
	}

	const todo: CloudNativeTool = {
		name: "manage_todo" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_TODO_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: [...TODO_ACTIONS] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				todoKey: {
					type: "string",
					pattern: WORK_KEY.source,
					description:
						"The todo's file name: lowercase letters, digits and single hyphens, at most 64 characters.",
				},
				title: { type: "string", minLength: 1, maxLength: 200 },
				detail: {
					type: "string",
					maxLength: 4000,
					description:
						"Your plan and where things stand, up to 4000 bytes, so that a later run of you or a new colleague can pick it up cold.",
				},
				state: {
					type: "string",
					enum: [...TODO_STATES],
					description: "upsert: open, or blocked while you wait for a person. list: a filter.",
				},
				includeClosed: { type: "boolean" },
				search: {
					type: "string",
					minLength: 1,
					maxLength: 200,
					description: "Text in a title or todoKey, any case.",
				},
				cursor: { type: "string", pattern: CURSOR.source },
			},
		},
		parseArguments(value) {
			const action = (value as { action?: unknown } | null)?.action;
			if (typeof action !== "string" || !TODO_ACTIONS.includes(action as (typeof TODO_ACTIONS)[number]))
				throw new CloudToolArgumentRefusal(`action must be one of ${TODO_ACTIONS.join(", ")}`);
			if (action === "list") {
				const a = object(value, ["action", "includeClosed", "todoKey", "state", "search", "cursor"], ["action"]);
				if (a.includeClosed !== undefined && typeof a.includeClosed !== "boolean")
					throw new CloudToolArgumentRefusal("includeClosed must be true or false");
				return {
					action,
					...(a.includeClosed ? { includeClosed: true } : {}),
					...(a.todoKey === undefined ? {} : { todoKey: key("todoKey", a.todoKey, WORK_KEY) }),
					...listing(a, TODO_STATES),
				} as never;
			}
			if (action !== "upsert") {
				const a = object(value, ["action", "operationKey", "todoKey"], ["action", "operationKey", "todoKey"]);
				return {
					action,
					operationKey: key("operationKey", a.operationKey, OPERATION_KEY),
					todoKey: key("todoKey", a.todoKey, WORK_KEY),
				} as never;
			}
			const a = object(
				value,
				["action", "operationKey", "todoKey", "title", "detail", "state"],
				["action", "operationKey", "todoKey", "title"],
			);
			if (a.state !== undefined && a.state !== "open" && a.state !== "blocked")
				throw new CloudToolArgumentRefusal("upsert state is open or blocked; close a todo with done or cancel");
			return {
				action,
				operationKey: key("operationKey", a.operationKey, OPERATION_KEY),
				todoKey: key("todoKey", a.todoKey, WORK_KEY),
				title: text("title", a.title, 200, true),
				detail: optionalText("detail", a.detail, 4000) ?? "",
				state: (a.state as string | undefined) ?? "open",
			} as never;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as Record<string, unknown>;
			// An agent's todos are files in its folder; the folder core decides each save.
			return request.action === "list"
				? folderTodos.list(request as unknown as CloudFolderTodoListing, context, fitsOneResult)
				: folderTodos.change(request as unknown as CloudFolderTodoChange, context);
		},
	};

	const worker: CloudNativeTool = {
		name: "manage_worker" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: options.machines ? CLOUD_WORKER_TOOL_DESCRIPTION : CLOUD_WORKER_TOOL_DESCRIPTION_WITHOUT_MACHINES,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: [...WORKER_ACTIONS] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				todoKey: {
					type: "string",
					pattern: WORK_KEY.source,
					description: "The todo the workers belong to, by its todoKey: every action names it, status too.",
				},
				workerKey: {
					type: "string",
					pattern: WORK_KEY.source,
					description:
						"The short name you give the worker, such as competitor-prices (lowercase letters, digits and single hyphens): the name of its folder in the todo's folder, which holds brief.md (what it was asked) and results.md (its report and your decision).",
				},
				title: { type: "string", minLength: 1, maxLength: 200 },
				goal: { type: "string", minLength: 1, maxLength: 4000, description: "What to produce, up to 4000 bytes." },
				definitionOfDone: {
					type: "string",
					minLength: 1,
					maxLength: 2000,
					description: "How the worker knows it is finished, up to 2000 bytes.",
				},
				context: {
					type: "string",
					maxLength: 4000,
					description:
						"Every fact, name and constraint it needs, bounded, not the whole chat: up to 4000 bytes, together with the sentence saveTo adds.",
				},
				sources: {
					type: "array",
					maxItems: 8,
					uniqueItems: true,
					items: { type: "string", minLength: 1, maxLength: 512 },
					description: "Up to 8 company paths to read; a folder covers the files in it.",
				},
				access: { type: "string", enum: ["read", "write"], description: "write when it should save files." },
				saveTo: {
					type: "string",
					minLength: 1,
					maxLength: 512,
					description: "With access write only: the folder where its files belong, such as product/designs/.",
				},
				revival: {
					type: "string",
					enum: ["batch", "each"],
					description:
						"batch (the default): you are woken once every worker you dispatched in this run has reported. each: as soon as this one reports.",
				},
				species: { type: "string", enum: ["in-house", "coding"], description: "coding for a coding session." },
				harness: {
					type: "string",
					enum: ["codex", "claude-code"],
					description:
						"A coding session's agent. On any other worker, claude-code: Claude Code does the work instead of a run of you, on your machine and on the asking member's own Claude sign-in, in parallel up to that member's configured parallel limit (extras wait in the queue); only when a member asks for Claude Code or picked Claude for the conversation. Give it access write: it works with your own rights on your machine and in the company's files, and saveTo is where its files go, not a limit.",
				},
				repository: {
					type: "object",
					additionalProperties: false,
					required: ["host", "owner", "name", "baseBranch"],
					properties: {
						host: {
							type: "string",
							enum: ["qorpera", "github.com"],
							description:
								"qorpera: kept in the company folder at code/<owner>/<name>/ (main/ holds the default branch's files). A new one is made empty by the session's first turn: start one yourself, without asking anyone, and reuse it for later work on the same thing. A finished change lands on the default branch at once. github.com: only for code that already lives on GitHub, or when a member asks for GitHub by name; a finished change becomes a draft pull request.",
						},
						owner: {
							type: "string",
							minLength: 1,
							maxLength: 39,
							description: "On qorpera, a short lowercase area of the company's code, such as company.",
						},
						name: {
							type: "string",
							minLength: 1,
							maxLength: 100,
							description: "On qorpera, a short lowercase name, such as shop.",
						},
						baseBranch: {
							type: "string",
							minLength: 1,
							maxLength: 200,
							description: "On qorpera, always main.",
						},
					},
				},
				claimedPaths: {
					type: "array",
					maxItems: 32,
					uniqueItems: true,
					items: { type: "string", minLength: 1, maxLength: 256 },
					description:
						"With species coding: up to 32 relative file paths or globs this session owns, to warn on overlap.",
				},
				text: {
					type: "string",
					minLength: 1,
					maxLength: 4000,
					description: "followup's instructions, up to 4000 bytes.",
				},
				decision: { type: "string", enum: ["accept", "reject"] },
				note: { type: "string", maxLength: 1000, description: "decide's reason, up to 1000 bytes." },
				state: {
					type: "string",
					enum: [...WORKER_STATES],
					description: "status filter; active covers queued and running.",
				},
				search: {
					type: "string",
					minLength: 1,
					maxLength: 200,
					description: "Text in a title or workerKey, any case.",
				},
				cursor: { type: "string", pattern: CURSOR.source },
			},
		},
		parseArguments(value) {
			const action = (value as { action?: unknown } | null)?.action;
			if (typeof action !== "string" || !WORKER_ACTIONS.includes(action as (typeof WORKER_ACTIONS)[number]))
				throw new CloudToolArgumentRefusal(`action must be one of ${WORKER_ACTIONS.join(", ")}`);
			if (action === "status") {
				const a = object(value, ["action", "todoKey", "workerKey", "state", "search", "cursor"], ["action"]);
				if (a.workerKey !== undefined && a.todoKey === undefined)
					throw new CloudToolArgumentRefusal("workerKey is given together with its todoKey");
				return {
					action,
					...(a.todoKey === undefined ? {} : { todoKey: key("todoKey", a.todoKey, WORK_KEY) }),
					...(a.workerKey === undefined ? {} : { workerKey: key("workerKey", a.workerKey, WORK_KEY) }),
					...listing(a, WORKER_STATES),
				} as never;
			}
			const base = ["action", "operationKey", "todoKey", "workerKey"];
			const fields =
				action === "dispatch"
					? [
							...base,
							"title",
							"goal",
							"definitionOfDone",
							"context",
							"sources",
							"access",
							"saveTo",
							"revival",
							"species",
							"harness",
							"repository",
							"claimedPaths",
						]
					: action === "followup"
						? [...base, "text"]
						: action === "decide"
							? [...base, "decision", "note"]
							: base;
			const required =
				action === "dispatch"
					? [...base, "title", "goal", "definitionOfDone", "access"]
					: action === "followup"
						? [...base, "text"]
						: action === "decide"
							? [...base, "decision"]
							: base;
			const a = object(value, fields, required);
			const request: Record<string, unknown> = {
				action,
				operationKey: key("operationKey", a.operationKey, OPERATION_KEY),
				todoKey: key("todoKey", a.todoKey, WORK_KEY),
				workerKey: key("workerKey", a.workerKey, WORK_KEY),
			};
			if (action === "dispatch") {
				if (a.access !== "read" && a.access !== "write")
					throw new CloudToolArgumentRefusal("access must be read or write");
				if (a.revival !== undefined && a.revival !== "batch" && a.revival !== "each")
					throw new CloudToolArgumentRefusal("revival must be batch or each");
				const sources = paths("sources", a.sources, 8, 512);
				const context = optionalText("context", a.context, 4000) ?? "";
				// The folder where the finished files belong (21 October 2026): the worker may write there as its agent may,
				// so the brief says so in its context, which the worker reads. The folder core decides each write.
				const saveTo = a.saveTo === undefined ? undefined : paths("saveTo", [a.saveTo], 1, 512)[0];
				if (saveTo !== undefined && (a.access !== "write" || a.species === "coding"))
					throw new CloudToolArgumentRefusal("saveTo needs access write, and a coding session has none");
				const placed =
					saveTo === undefined ? context : [context, workerSaveToText(saveTo)].filter(Boolean).join("\n\n");
				if (Buffer.byteLength(placed) > 4000)
					throw new CloudToolArgumentRefusal("context and the saveTo sentence together must fit in 4000 bytes");
				Object.assign(request, {
					title: text("title", a.title, 200, true),
					goal: text("goal", a.goal, 4000),
					definitionOfDone: text("definitionOfDone", a.definitionOfDone, 2000),
					context: placed,
					...(sources.length ? { sources } : {}),
					access: a.access,
					...(saveTo === undefined ? {} : { saveTo }),
					revival: a.revival ?? "batch",
				});
				if (a.species !== undefined && a.species !== "in-house" && a.species !== "coding")
					throw new CloudToolArgumentRefusal("species must be in-house or coding");
				if (a.species === "coding") {
					// A coding session: one harness, one repository, read access; it runs for the member who asked.
					if (a.harness !== "codex" && a.harness !== "claude-code")
						throw new CloudToolArgumentRefusal("a coding session needs harness codex or claude-code");
					if (a.access !== "read")
						throw new CloudToolArgumentRefusal(
							"a coding session takes access read; its changes land in its repository",
						);
					const repository = a.repository as Record<string, unknown> | undefined;
					if (
						!repository ||
						typeof repository !== "object" ||
						Object.keys(repository).sort().join() !== "baseBranch,host,name,owner" ||
						(repository.host !== "github.com" && repository.host !== "qorpera") ||
						typeof repository.owner !== "string" ||
						typeof repository.name !== "string" ||
						typeof repository.baseBranch !== "string"
					)
						throw new CloudToolArgumentRefusal(
							"a coding session needs repository with exactly host (qorpera or github.com), owner, name and baseBranch, each text",
						);
					// A repository kept in Qorpera names a folder, code/<owner>/<name>/: lower case only, said plainly.
					if (repository.host === "qorpera")
						try {
							parseCloudCodingRepository(repository);
						} catch {
							throw new CloudToolArgumentRefusal(
								"A repository kept in Qorpera has a lowercase owner (letters, digits, hyphens), a lowercase name (letters, digits, hyphens, dots, underscores; not ending with a dot) and baseBranch main, such as owner company and name shop",
							);
						}
					let claimedPaths: string[] | undefined;
					if (a.claimedPaths !== undefined) {
						if (!Array.isArray(a.claimedPaths) || a.claimedPaths.length > 32)
							throw new CloudToolArgumentRefusal(
								"claimedPaths must be a list of up to 32 relative file paths or globs of at most 256 bytes each",
							);
						const normalized = a.claimedPaths.map((entry) => {
							if (
								typeof entry !== "string" ||
								!entry.trim() ||
								entry.includes("\\") ||
								/[\u0000-\u001f\u007f]/.test(entry)
							)
								throw new CloudToolArgumentRefusal(
									"claimedPaths must be a list of up to 32 relative file paths or globs of at most 256 bytes each",
								);
							const cleaned = entry.trim().replace(/\/+$/, "");
							if (
								!cleaned ||
								Buffer.byteLength(cleaned, "utf8") > 256 ||
								cleaned.startsWith("/") ||
								cleaned.split("/").some((part) => !part || part === "." || part === "..")
							)
								throw new CloudToolArgumentRefusal(
									"claimedPaths must be a list of up to 32 relative file paths or globs of at most 256 bytes each",
								);
							return cleaned;
						});
						if (new Set(normalized).size !== normalized.length)
							throw new CloudToolArgumentRefusal("claimedPaths must not contain duplicate patterns");
						claimedPaths = normalized;
					}
					Object.assign(request, {
						species: "coding",
						harness: a.harness,
						repository: {
							host: repository.host,
							owner: text("repository.owner", repository.owner, 39, true),
							name: text("repository.name", repository.name, 100, true),
							baseBranch: text("repository.baseBranch", repository.baseBranch, 200, true),
						},
						...(claimedPaths && claimedPaths.length > 0 ? { claimedPaths } : {}),
					});
				} else if (a.repository !== undefined)
					throw new CloudToolArgumentRefusal("repository is given only with species coding");
				else if (a.claimedPaths !== undefined)
					throw new CloudToolArgumentRefusal("claimedPaths is given only with species coding");
				else if (a.harness === "claude-code" || a.harness === "codex") request.harness = a.harness;
				else if (a.harness !== undefined)
					throw new CloudToolArgumentRefusal("harness must be codex or claude-code");
			} else if (action === "followup") request.text = text("text", a.text, 4000);
			else if (action === "decide") {
				if (a.decision !== "accept" && a.decision !== "reject")
					throw new CloudToolArgumentRefusal("decision must be accept or reject");
				const note = optionalText("note", a.note, 1000);
				Object.assign(request, { decision: a.decision, ...(note === undefined ? {} : { note }) });
			}
			return request as never;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as Record<string, unknown>;
			// An agent's workers are folders of its todos; the folder core decides each save.
			return request.action === "status"
				? folderWorkers.status(request as CloudFolderWorkerStatus, context, fitsOneResult)
				: folderWorkers.change(request as unknown as CloudFolderWorkerChange, context);
		},
	};
	return [todo, worker];
}

/** How much open work the agent has, for its prompt: counts, never the list itself. */
export interface CloudAgentOpenWork {
	todos: { open: number; blocked: number };
	workers: { active: number; blocked: number };
	/** Commands the platform stopped on the agent's computer, told once in their conversation. */
	computerStopped?: { command: string; startedAt: string; endedAt: string; reason: string }[];
	/** Machine commands, and containers on a machine the agent started, that a stop or restart of the machine ended,
	 * told once in their conversation. */
	machineStopped?: (
		| { machine: string; work: "command"; command: string; startedAt: string; endedAt: string; reason: string }
		| { machine: string; work: "containers"; endedAt: string; reason: string }
	)[];
	/** Code a member or another agent brought into Qorpera (the import's follow-ups, 20260930741000), told once to each
	 * agent but the one that asked: the repository's place, where it came from as a member reads it, who asked, when it
	 * came in, how many earlier changes its main branch brought, and the other lines of work with changes main lacks. */
	codeBroughtIn?: {
		owner: string;
		name: string;
		from: { github: string } | { file: string };
		by: "member" | "agent";
		at: string;
		earlierChanges: number | null;
		otherWork: { lines: number; changes: number } | null;
	}[];
}

export async function describeCloudAgentOpenWork(
	binding: CloudNativeToolBinding,
	control: CloudCompanyPathControl,
	signal: AbortSignal,
): Promise<CloudAgentOpenWork> {
	const admitted = parseCloudNativeToolBinding(binding);
	const result = (await cloudToolRequest(
		(requestSignal) => control.call("qorpera_describe_agent_open_work", { p_binding: admitted }, requestSignal),
		signal,
	)) as Record<string, unknown> | null;
	if (!result || result.schema !== "qorpera.agent-open-work/v1" || result.runId !== admitted.runId)
		throw new Error("Open work differs");
	const count = (value: unknown) => {
		if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Open work differs");
		return value as number;
	};
	const todos = object(result.todos, ["open", "blocked"], ["open", "blocked"]);
	const workers = object(result.workers, ["active", "blocked"], ["active", "blocked"]);
	let computerStopped: CloudAgentOpenWork["computerStopped"];
	if (result.computerStopped !== undefined) {
		if (
			!Array.isArray(result.computerStopped) ||
			result.computerStopped.length < 1 ||
			result.computerStopped.length > 32
		)
			throw new Error("Open work differs");
		computerStopped = result.computerStopped.map((item) => {
			const stopped = object(
				item,
				["command", "startedAt", "endedAt", "reason"],
				["command", "startedAt", "endedAt", "reason"],
			);
			if (
				typeof stopped.command !== "string" ||
				typeof stopped.startedAt !== "string" ||
				typeof stopped.endedAt !== "string" ||
				!["slept", "closed", "paused", "pressure", "lost"].includes(stopped.reason as string)
			)
				throw new Error("Open work differs");
			return {
				command: stopped.command,
				startedAt: stopped.startedAt,
				endedAt: stopped.endedAt,
				reason: stopped.reason as string,
			};
		});
	}
	let machineStopped: CloudAgentOpenWork["machineStopped"];
	if (result.machineStopped !== undefined) {
		if (
			!Array.isArray(result.machineStopped) ||
			result.machineStopped.length < 1 ||
			result.machineStopped.length > 32
		)
			throw new Error("Open work differs");
		machineStopped = result.machineStopped.map((item) => {
			const work = (item as { work?: unknown } | null)?.work;
			const keys =
				work === "command"
					? ["machine", "work", "command", "startedAt", "endedAt", "reason"]
					: ["machine", "work", "endedAt", "reason"];
			const stopped = object(item, keys, keys);
			if (
				(work !== "command" && work !== "containers") ||
				keys.some((key) => typeof stopped[key] !== "string") ||
				!["slept", "hours", "stopped", "lost"].includes(stopped.reason as string)
			)
				throw new Error("Open work differs");
			const shared = {
				machine: stopped.machine as string,
				endedAt: stopped.endedAt as string,
				reason: stopped.reason as string,
			};
			return work === "command"
				? { ...shared, work, command: stopped.command as string, startedAt: stopped.startedAt as string }
				: { ...shared, work };
		});
	}
	let codeBroughtIn: CloudAgentOpenWork["codeBroughtIn"];
	if (result.codeBroughtIn !== undefined) {
		if (!Array.isArray(result.codeBroughtIn) || result.codeBroughtIn.length < 1 || result.codeBroughtIn.length > 8)
			throw new Error("Open work differs");
		const keys = ["owner", "name", "from", "by", "at", "earlierChanges", "otherWork"];
		codeBroughtIn = result.codeBroughtIn.map((item) => {
			const brought = object(item, keys, keys);
			// Where it came from as a member reads it (`qorpera_code_import_member_source`): a GitHub project or a file's name.
			const from = object(brought.from, ["github", "file"], []);
			const source = Object.keys(from);
			const other =
				brought.otherWork === null ? null : object(brought.otherWork, ["lines", "changes"], ["lines", "changes"]);
			try {
				// The place the code came in at, code/<owner>/<name>/, by the rule its coding sessions are started under.
				parseCloudCodingRepository({
					host: "qorpera",
					owner: brought.owner,
					name: brought.name,
					baseBranch: "main",
				});
			} catch {
				throw new Error("Open work differs");
			}
			const earlierChanges = brought.earlierChanges === null ? null : count(brought.earlierChanges);
			const otherWork = other === null ? null : { lines: count(other.lines), changes: count(other.changes) };
			if (
				source.length !== 1 ||
				typeof from[source[0]] !== "string" ||
				(brought.by !== "member" && brought.by !== "agent") ||
				typeof brought.at !== "string" ||
				(otherWork !== null && (otherWork.lines < 1 || otherWork.changes < 1))
			)
				throw new Error("Open work differs");
			return {
				owner: brought.owner as string,
				name: brought.name as string,
				from: "github" in from ? { github: from.github as string } : { file: from.file as string },
				by: brought.by as "member" | "agent",
				at: brought.at as string,
				earlierChanges,
				otherWork,
			};
		});
	}
	return {
		todos: { open: count(todos.open), blocked: count(todos.blocked) },
		workers: { active: count(workers.active), blocked: count(workers.blocked) },
		...(computerStopped ? { computerStopped } : {}),
		...(machineStopped ? { machineStopped } : {}),
		...(codeBroughtIn ? { codeBroughtIn } : {}),
	};
}

/** What a worker may use: its parent's reading tools, writing only when the
 * dispatch grants it, its office tools, and its single report. It has no mouth,
 * no coworker channel, no hiring, no routines and no workers of its own.
 */
export function cloudWorkerToolFilter(wake: Pick<CloudWakeEnvelope, "kind" | "source" | "payload">) {
	const isWorker = wake.kind === "agent" && wake.source.kind === "worker-dispatch";
	// A coding session runs the coding composition, never the in-house worker tools.
	if (isWorker && wake.payload.species === "coding")
		throw new Error("Coding sessions run in the coding composition, which this node does not carry");
	const readOnly = isWorker && wake.payload.access !== "write";
	return {
		isWorker,
		// Rows of a table are written as files are.
		companyFile: (tool: CloudNativeTool) =>
			!readOnly ||
			![
				"company_write",
				"company_edit",
				"company_move",
				"company_mkdir",
				"company_delete",
				"table_write",
				"save_app",
				"post_app",
				"make_picture",
				"narrate_app",
				// How an app is made, which only a run that may make one reads.
				"app_guide",
			].includes(tool.name),
	};
}
