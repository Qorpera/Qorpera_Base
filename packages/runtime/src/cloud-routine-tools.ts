import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContext,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import { CLOUD_RUNTIME_REASONING_EFFORTS, isCloudRuntimeReasoningEffort } from "./cloud-runtime-policy.ts";

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ROUTINE_KEY = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const BUSINESS_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
const REPLY = ["optional", "required", "silent"] as const;
const ACTIONS = ["list", "upsert", "pause", "resume", "remove", "conclude"] as const;
const DECISIONS = ["next", "conclude"] as const;

function object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key)) ||
		required.some((key) => !Object.hasOwn(value, key))
	)
		throw new Error("Invalid routine request");
	return value as Record<string, unknown>;
}
function text(value: unknown, maxBytes: number, singleLine = false): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.includes("\0") ||
		(singleLine && /[\r\n]/.test(value)) ||
		Buffer.byteLength(value.trim()) > maxBytes ||
		Buffer.from(value).toString("utf8") !== value
	)
		throw new Error("Invalid routine text");
	return value.trim();
}
function timeZone(value: unknown): string {
	if (typeof value !== "string" || !value || value === "auto" || value.length > 64)
		throw new Error("Invalid time zone");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
	} catch {
		throw new Error("Invalid time zone");
	}
	return value;
}
function localTime(value: unknown): string {
	if (typeof value !== "string" || !LOCAL_TIME.test(value)) throw new Error("Invalid local time");
	return value;
}
function reply(value: unknown): (typeof REPLY)[number] {
	if (value === undefined) return "optional";
	if (typeof value !== "string" || !REPLY.includes(value as (typeof REPLY)[number]))
		throw new Error("Invalid routine reporting");
	return value as (typeof REPLY)[number];
}

/** A time without an offset would be read in the host's zone, not the member's. */
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
function instant(value: unknown, label: string): string {
	if (typeof value !== "string" || !WITH_OFFSET.test(value) || !Number.isFinite(Date.parse(value)))
		throw new CloudToolArgumentRefusal(
			`${label} must be an ISO 8601 date and time with its offset, such as 2026-10-01T09:00:00+02:00`,
		);
	return new Date(value).toISOString();
}

/** The model describes a cadence in the three shapes people use; the cloud
 * scheduler's closed trigger forms are compiled here. The trigger id is
 * host-owned and every routine has exactly one trigger (contract 16.3). A
 * dynamic routine has one next run instead of a cadence ("once"); its runs
 * choose the next one. Without firstRunAt the kernel stamps the save instant,
 * so a retried save with the same key stays the same request.
 */
function compileTrigger(value: unknown): Record<string, unknown> {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (kind === "every") {
		const t = object(value, ["kind", "minutes", "firstRunAt", "report"], ["kind", "minutes"]);
		if (!Number.isSafeInteger(t.minutes) || (t.minutes as number) < 5 || (t.minutes as number) > 10_080)
			throw new Error("Invalid routine interval");
		const trigger: Record<string, unknown> = { kind: "schedule", intervalMinutes: t.minutes };
		if (t.firstRunAt !== undefined) trigger.startAt = instant(t.firstRunAt, "firstRunAt");
		return { ...trigger, replyPolicy: reply(t.report) };
	}
	if (kind === "weekly") {
		const t = object(
			value,
			["kind", "weekdays", "localTime", "timeZone", "firstRunAt", "report"],
			["kind", "localTime", "timeZone"],
		);
		const startAt: Record<string, unknown> =
			t.firstRunAt === undefined ? {} : { startAt: instant(t.firstRunAt, "firstRunAt") };
		// Weekday default: a wall-clock routine runs on business days unless the agent says otherwise.
		const days = t.weekdays === undefined ? [...BUSINESS_DAYS] : t.weekdays;
		if (
			!Array.isArray(days) ||
			days.length < 1 ||
			days.length > 7 ||
			new Set(days).size !== days.length ||
			days.some((day) => !WEEKDAYS.includes(day as (typeof WEEKDAYS)[number]))
		)
			throw new Error("Invalid routine weekdays");
		return {
			kind: "schedule",
			intervalMinutes: 1440,
			...startAt,
			weekdays: days,
			localTime: localTime(t.localTime),
			timeZone: timeZone(t.timeZone),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "dynamic") {
		const t = object(value, ["kind", "firstRunAt", "timeZone", "report"], ["kind", "timeZone"]);
		return {
			kind: "once",
			...(t.firstRunAt === undefined ? {} : { at: instant(t.firstRunAt, "firstRunAt") }),
			timeZone: timeZone(t.timeZone),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "file_change") {
		const t = object(value, ["kind", "path", "match", "timeZone", "report"], ["kind", "path", "timeZone"]);
		const match = t.match ?? "exact";
		if (match !== "exact" && match !== "subtree") throw new Error("Invalid routine path match");
		if (
			typeof t.path !== "string" ||
			!t.path ||
			Buffer.byteLength(t.path) > 1024 ||
			t.path.startsWith("/") ||
			t.path.split("/").some((part) => !part || part === "." || part === "..")
		)
			throw new Error("Invalid routine path");
		return {
			kind: "listener",
			source: "company-file",
			path: t.path,
			match,
			timeZone: timeZone(t.timeZone),
			replyPolicy: reply(t.report),
		};
	}
	throw new Error("Invalid routine trigger");
}

export const CLOUD_ROUTINE_TOOL_DESCRIPTION =
	"Set up your own standing work. A routine wakes you, this same agent, with the stored intent, while no member is online. " +
	"No member approval is needed; use it whenever a responsibility or a request calls for repeated attention, and tell the member what you set up. " +
	"Actions: list, upsert, pause, resume, conclude, remove. A routine always belongs to you. Reuse one routineKey for the same standing work so a change becomes a new version instead of a duplicate; list first when unsure. " +
	"trigger is exactly one of: dynamic (you choose each next run: optional firstRunAt with its offset, default now, or for an existing dynamic routine its next run if that is still ahead; and the member's IANA timeZone), every (minutes 5-10080, optional firstRunAt with its offset), weekly (localTime HH:MM, IANA timeZone, weekdays default Monday to Friday, optional firstRunAt with its offset), or file_change (a Company File path you can read, match exact or subtree). Use the member's time zone from the wake time context. " +
	"Prefer dynamic when the right time for the next look depends on what you find: learning a new responsibility, following something up, watching a situation. It runs once at firstRunAt; each run then sets the next run, with adjusted instructions if the work changed, or concludes the routine. Use every or weekly for work tied to the clock, such as a Monday report, and file_change to react to a file. " +
	"A new every or weekly routine runs once right away as a kickoff, then on its schedule; give firstRunAt only when the first run really must wait. Start dense while a responsibility is new to you and use those early runs to learn what the work needs. Never leave new standing work idle for days waiting for its first slot. " +
	"Write intent as a complete instruction to your future self: what to read, what to decide, when to tell someone and when to stay silent. report is optional (speak only when useful), required (always report) or silent (never speak). When you pick a threshold or cadence nobody gave you, tell the member it is your starting assumption so they can correct it. " +
	"effort is the thinking depth of each routine run: low, medium or high; a new routine starts at medium and a save without effort keeps what it has. Choose high for judgement-heavy analysis, low for a quick check; conversations with members stay at the thread default. " +
	"Give a finite watch an expiresAt, or for every or weekly a maxOccurrences, so it ends by itself. quietHours holds non-urgent runs until the window ends. " +
	"conclude ends a routine with a one-sentence summary of why, and keeps it in the list as concluded; saving it again restarts it. remove deletes it from the list for good. " +
	"status paused with pauseReason needs_model_account means no model account of the requesting member allows unattended runs yet: say so plainly, it is a one-time account setting. authorization_failed means the account stopped working. " +
	"Keep operationKey stable for one intended change; an unconfirmed result needs the same key again, never a new one. A routine is not a reminder to a person and cannot act beyond your own authority.";

export const CLOUD_ROUTINE_DECISION_DESCRIPTION =
	"Decide what happens after this run of your dynamic routine. Call it exactly once per run, before your final message, or as the last thing you do when you send none. " +
	"next: at is when the next run starts (ISO 8601 with offset; a time already passed means right away). Choose it from what you found: soon while things move or a reply is due, later when they are quiet. " +
	"intent, when the work changed, is the complete new instruction for your future self: what to check, what you learned, when to speak; without it the next run keeps this run's intent. title, effort (low, medium, high) and report (optional, required, silent) likewise change only when given. " +
	"conclude: summary is one sentence on why the routine is done (the goal was reached, the question answered, the watch no longer needed); the member sees it. " +
	"If you hand work to workers or wait for the Company Computer, decide first: this run must decide before it ends, and the continuation cannot. " +
	"state settled means the routine already moved on, changed in another conversation or past its end date, so nothing is owed. state refused carries the reason, such as a next run after the routine's end date: choose again or conclude. " +
	"Keep operationKey stable for one decision; an unconfirmed result needs the same key and arguments again.";

/** The cloud derives the agent, requester and model account from the run. The
 * model chooses only what to do, when, and how long.
 */
function routineAuthority(binding: CloudNativeToolBinding, identity: CloudNativeToolIdentity) {
	const admitted = parseCloudNativeToolBinding(binding),
		expected = Object.freeze({ ...identity });
	if (
		Object.entries(admitted).some(
			([key, value]) => key !== "credentialCapsuleId" && expected[key as keyof CloudNativeToolIdentity] !== value,
		)
	)
		throw new Error("Routine binding differs");
	const assertContext = (context: CloudToolContext) => {
		if (
			context.runId !== expected.runId ||
			context.companyId !== expected.companyId ||
			!context.identity ||
			Object.entries(expected).some(
				([key, value]) => context.identity![key as keyof CloudNativeToolIdentity] !== value,
			)
		)
			throw new Error("Routine tool identity differs");
		context.signal.throwIfAborted();
	};
	return { admitted, assertContext };
}

export function cloudRoutineTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCompanyPathControl,
	/** In a dynamic routine's run: its key, whether its decision is still owed, and a
	 * callback for a conclusion made here (which settles that decision). */
	ownDynamicRoutine?: {
		readonly routineKey: string;
		readonly decisionOwed: () => boolean;
		readonly settled: () => void;
	},
): readonly CloudNativeTool[] {
	const { admitted, assertContext } = routineAuthority(binding, identity);
	const reportSchema = { type: "string", enum: [...REPLY] };
	const zoneSchema = { type: "string", minLength: 1, maxLength: 64 };
	const timeSchema = { type: "string", pattern: LOCAL_TIME.source };
	const tool: CloudNativeTool = {
		name: "manage_routine" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_ROUTINE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: [...ACTIONS] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				routineKey: { type: "string", pattern: ROUTINE_KEY.source },
				title: { type: "string", minLength: 1, maxLength: 160 },
				intent: { type: "string", minLength: 1, maxLength: 32768 },
				summary: { type: "string", minLength: 1, maxLength: 2000 },
				trigger: {
					oneOf: [
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "timeZone"],
							properties: {
								kind: { const: "dynamic" },
								firstRunAt: { type: "string", format: "date-time" },
								timeZone: zoneSchema,
								report: reportSchema,
							},
						},
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "minutes"],
							properties: {
								kind: { const: "every" },
								minutes: { type: "integer", minimum: 5, maximum: 10080 },
								firstRunAt: { type: "string", format: "date-time" },
								report: reportSchema,
							},
						},
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "localTime", "timeZone"],
							properties: {
								kind: { const: "weekly" },
								weekdays: {
									type: "array",
									minItems: 1,
									maxItems: 7,
									uniqueItems: true,
									items: { type: "string", enum: [...WEEKDAYS] },
								},
								localTime: timeSchema,
								timeZone: zoneSchema,
								firstRunAt: { type: "string", format: "date-time" },
								report: reportSchema,
							},
						},
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "path", "timeZone"],
							properties: {
								kind: { const: "file_change" },
								path: { type: "string", minLength: 1, maxLength: 1024 },
								match: { type: "string", enum: ["exact", "subtree"] },
								timeZone: zoneSchema,
								report: reportSchema,
							},
						},
					],
				},
				expiresAt: { type: "string", format: "date-time" },
				maxOccurrences: { type: "integer", minimum: 1, maximum: 100000 },
				effort: { type: "string", enum: [...CLOUD_RUNTIME_REASONING_EFFORTS] },
				quietHours: {
					type: "object",
					additionalProperties: false,
					required: ["start", "end", "timeZone"],
					properties: { start: timeSchema, end: timeSchema, timeZone: zoneSchema },
				},
			},
		},
		parseArguments(value) {
			const action = (value as { action?: unknown } | null)?.action;
			if (typeof action !== "string" || !ACTIONS.includes(action as (typeof ACTIONS)[number]))
				throw new Error("Invalid routine action");
			if (action === "list") {
				object(value, ["action"], ["action"]);
				return { action } as never;
			}
			if (action === "conclude") {
				const c = object(
					value,
					["action", "operationKey", "routineKey", "summary"],
					["action", "operationKey", "routineKey", "summary"],
				);
				if (
					typeof c.operationKey !== "string" ||
					!OPERATION_KEY.test(c.operationKey) ||
					typeof c.routineKey !== "string" ||
					!ROUTINE_KEY.test(c.routineKey)
				)
					throw new Error("Invalid routine key");
				return {
					action,
					operationKey: c.operationKey,
					routineKey: c.routineKey,
					summary: text(c.summary, 2000),
				} as never;
			}
			const upsert = action === "upsert";
			const a = object(
				value,
				upsert
					? [
							"action",
							"operationKey",
							"routineKey",
							"title",
							"intent",
							"trigger",
							"expiresAt",
							"maxOccurrences",
							"quietHours",
							"effort",
						]
					: ["action", "operationKey", "routineKey"],
				upsert
					? ["action", "operationKey", "routineKey", "title", "intent", "trigger"]
					: ["action", "operationKey", "routineKey"],
			);
			if (
				typeof a.operationKey !== "string" ||
				!OPERATION_KEY.test(a.operationKey) ||
				typeof a.routineKey !== "string" ||
				!ROUTINE_KEY.test(a.routineKey)
			)
				throw new Error("Invalid routine key");
			// The kernel refuses these too; this says why in words the model can act on.
			// Pausing or removing it would revoke this very run; saving or resuming it
			// before the decision would drop that decision.
			if (ownDynamicRoutine?.routineKey === a.routineKey) {
				if (action === "pause" || action === "remove")
					throw new CloudToolArgumentRefusal(
						"this is the routine you are running: conclude it (manage_routine conclude, or decide_routine conclude) instead of pausing or removing it",
					);
				if (ownDynamicRoutine.decisionOwed())
					throw new CloudToolArgumentRefusal(
						"this is the routine you are running: use decide_routine (next sets the next run and can change its instructions; conclude ends it)",
					);
			}
			if (!upsert) return { action, operationKey: a.operationKey, routineKey: a.routineKey } as never;
			const request: Record<string, unknown> = {
				action,
				operationKey: a.operationKey,
				routineKey: a.routineKey,
				title: text(a.title, 160, true),
				intent: text(a.intent, 32768),
				trigger: compileTrigger(a.trigger),
			};
			if (a.expiresAt !== undefined) request.expiresAt = instant(a.expiresAt, "expiresAt");
			if (a.maxOccurrences !== undefined && (request.trigger as { kind: string }).kind === "once")
				throw new CloudToolArgumentRefusal(
					"a dynamic routine takes no maxOccurrences: it ends when a run concludes it (expiresAt still applies)",
				);
			if (a.maxOccurrences !== undefined) {
				if (
					!Number.isSafeInteger(a.maxOccurrences) ||
					(a.maxOccurrences as number) < 1 ||
					(a.maxOccurrences as number) > 100000
				)
					throw new Error("Invalid routine occurrence limit");
				request.maxOccurrences = a.maxOccurrences;
			}
			if (a.effort !== undefined && !isCloudRuntimeReasoningEffort(a.effort))
				throw new Error("Invalid routine effort");
			// The kernel starts a new routine at medium and keeps a saved routine's effort when none is given.
			if (a.effort !== undefined) request.effort = a.effort;
			if (a.quietHours !== undefined) {
				const quiet = object(a.quietHours, ["start", "end", "timeZone"], ["start", "end", "timeZone"]);
				const start = localTime(quiet.start),
					end = localTime(quiet.end);
				if (start === end) throw new Error("Invalid routine quiet hours");
				request.quietHours = { start, end, timeZone: timeZone(quiet.timeZone) };
			}
			return request as never;
		},
		async execute(value, context) {
			assertContext(context);
			// The boundary passes the already parsed request; its compiled trigger is not re-parseable input.
			const request = value as Record<string, unknown>;
			const result = await cloudToolRequest(
				(requestSignal) =>
					control.call("qorpera_manage_agent_routine", { p_binding: admitted, p_request: request }, requestSignal),
				context.signal,
			);
			const r = result as Record<string, unknown> | null;
			if (
				!r ||
				typeof r !== "object" ||
				r.runId !== admitted.runId ||
				(request.action === "list"
					? r.schema !== "qorpera.agent-routines/v1" || !Array.isArray(r.routines)
					: r.schema !== "qorpera.agent-routine-receipt/v1" ||
						r.action !== request.action ||
						!r.routine ||
						typeof r.routine !== "object" ||
						(r.routine as { routineKey?: unknown }).routineKey !== request.routineKey)
			)
				throw new Error("Routine receipt differs");
			// Concluding its own routine here is a decision too.
			if (ownDynamicRoutine && request.action === "conclude" && request.routineKey === ownDynamicRoutine.routineKey)
				ownDynamicRoutine.settled();
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	return [tool];
}

/** Offered only in a run of a dynamic routine. The kernel refuses this run's final
 * message and its completion until the routine moved on; `decided` tells the host
 * mouth, which shows the model that reason first.
 */
export function cloudRoutineDecisionTool(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCompanyPathControl,
	options: { readonly decided: () => void },
): CloudNativeTool {
	const { admitted, assertContext } = routineAuthority(binding, identity);
	return {
		name: "decide_routine" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_ROUTINE_DECISION_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action", "operationKey"],
			properties: {
				action: { type: "string", enum: [...DECISIONS] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				at: { type: "string", format: "date-time" },
				intent: { type: "string", minLength: 1, maxLength: 32768 },
				title: { type: "string", minLength: 1, maxLength: 160 },
				effort: { type: "string", enum: [...CLOUD_RUNTIME_REASONING_EFFORTS] },
				report: { type: "string", enum: [...REPLY] },
				summary: { type: "string", minLength: 1, maxLength: 2000 },
			},
		},
		parseArguments(value) {
			const action = (value as { action?: unknown } | null)?.action;
			if (typeof action !== "string" || !DECISIONS.includes(action as (typeof DECISIONS)[number]))
				throw new CloudToolArgumentRefusal("action must be next or conclude");
			if (action === "conclude") {
				const c = object(value, ["action", "operationKey", "summary"], ["action", "operationKey", "summary"]);
				if (typeof c.operationKey !== "string" || !OPERATION_KEY.test(c.operationKey))
					throw new Error("Invalid routine key");
				return { action, operationKey: c.operationKey, summary: text(c.summary, 2000) } as never;
			}
			const n = object(
				value,
				["action", "operationKey", "at", "intent", "title", "effort", "report"],
				["action", "operationKey"],
			);
			if (typeof n.operationKey !== "string" || !OPERATION_KEY.test(n.operationKey))
				throw new Error("Invalid routine key");
			const request: Record<string, unknown> = { action, operationKey: n.operationKey, at: instant(n.at, "at") };
			if (n.intent !== undefined) request.intent = text(n.intent, 32768);
			if (n.title !== undefined) request.title = text(n.title, 160, true);
			if (n.effort !== undefined) {
				if (!isCloudRuntimeReasoningEffort(n.effort)) throw new Error("Invalid routine effort");
				request.effort = n.effort;
			}
			if (n.report !== undefined) request.report = reply(n.report);
			return request as never;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as Record<string, unknown>;
			const result = await cloudToolRequest(
				(requestSignal) =>
					control.call("qorpera_decide_agent_routine", { p_binding: admitted, p_request: request }, requestSignal),
				context.signal,
			);
			const r = result as Record<string, unknown> | null;
			const receipt =
				r?.schema === "qorpera.agent-routine-receipt/v1" &&
				r.action === (request.action === "next" ? "upsert" : "conclude") &&
				!!r.routine &&
				typeof r.routine === "object";
			const outcome =
				r?.schema === "qorpera.agent-routine-decision/v1" && (r.state === "settled" || r.state === "refused")
					? r.state
					: undefined;
			if (!r || typeof r !== "object" || r.runId !== admitted.runId || (!receipt && !outcome))
				throw new Error("Routine decision receipt differs");
			if (outcome === "refused") return { kind: "text", value: cloudToolJsonText(r) };
			options.decided();
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
}
