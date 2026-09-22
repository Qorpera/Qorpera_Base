import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { type CloudNativeTool, type CloudToolContext, cloudToolJsonText } from "./cloud-native-tool-boundary.ts";

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ROUTINE_KEY = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const BUSINESS_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
const REPLY = ["optional", "required", "silent"] as const;
const ACTIONS = ["list", "upsert", "pause", "resume", "remove"] as const;

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

/** The model describes a cadence in the three shapes people use; the cloud
 * scheduler's closed trigger forms are compiled here. The trigger id is
 * host-owned and every routine has exactly one trigger (contract 16.3).
 */
function compileTrigger(value: unknown): Record<string, unknown> {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (kind === "every") {
		const t = object(value, ["kind", "minutes", "firstRunAt", "report"], ["kind", "minutes"]);
		if (!Number.isSafeInteger(t.minutes) || (t.minutes as number) < 5 || (t.minutes as number) > 10_080)
			throw new Error("Invalid routine interval");
		const trigger: Record<string, unknown> = { kind: "schedule", intervalMinutes: t.minutes };
		if (t.firstRunAt !== undefined) {
			if (typeof t.firstRunAt !== "string" || !Number.isFinite(Date.parse(t.firstRunAt)))
				throw new Error("Invalid routine start");
			trigger.startAt = new Date(t.firstRunAt).toISOString();
		}
		return { ...trigger, replyPolicy: reply(t.report) };
	}
	if (kind === "weekly") {
		const t = object(
			value,
			["kind", "weekdays", "localTime", "timeZone", "firstRunAt", "report"],
			["kind", "localTime", "timeZone"],
		);
		const startAt: Record<string, unknown> = {};
		if (t.firstRunAt !== undefined) {
			if (typeof t.firstRunAt !== "string" || !Number.isFinite(Date.parse(t.firstRunAt)))
				throw new Error("Invalid routine start");
			startAt.startAt = new Date(t.firstRunAt).toISOString();
		}
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
	"Actions: list, upsert, pause, resume, remove. A routine always belongs to you. Reuse one routineKey for the same standing work so a change becomes a new version instead of a duplicate; list first when unsure. " +
	"trigger is exactly one of: every (minutes 5-10080, optional firstRunAt), weekly (localTime HH:MM, IANA timeZone, weekdays default Monday to Friday, optional firstRunAt), or file_change (a Company File path you can read, match exact or subtree). Use the member's time zone from the wake time context. " +
	"A new routine runs once right away as a kickoff, then on its schedule; give firstRunAt only when the first run really must wait. Start dense while a responsibility is new to you, every hour or two or daily, and use those early runs to investigate and learn what the work needs; once you know, upsert the same routineKey with the steady cadence and say so. Never leave new standing work idle for days waiting for its first slot. " +
	"Write intent as a complete instruction to your future self: what to read, what to decide, when to tell someone and when to stay silent. report is optional (speak only when useful), required (always report) or silent (never speak). When you pick a threshold or cadence nobody gave you, tell the member it is your starting assumption so they can correct it. " +
	"Give a finite watch an expiresAt or maxOccurrences so it ends by itself. quietHours holds non-urgent occurrences until the window ends. " +
	"status paused with pauseReason needs_model_account means no model account of the requesting member allows unattended runs yet: say so plainly, it is a one-time account setting. authorization_failed means the account stopped working. " +
	"Keep operationKey stable for one intended change; an unconfirmed result needs the same key again, never a new one. A routine is not a reminder to a person and cannot act beyond your own authority.";

/** The cloud derives the agent, requester and model account from the run. The
 * model chooses only what to do, when, and how long.
 */
export function cloudRoutineTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	control: CloudCompanyPathControl,
): readonly CloudNativeTool[] {
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
	const reportSchema = { type: "string", enum: [...REPLY] };
	const zoneSchema = { type: "string", minLength: 1, maxLength: 64 };
	const timeSchema = { type: "string", pattern: LOCAL_TIME.source };
	const tool: CloudNativeTool = {
		name: "manage_routine",
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
				trigger: {
					oneOf: [
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
			if (!upsert) return { action, operationKey: a.operationKey, routineKey: a.routineKey } as never;
			const request: Record<string, unknown> = {
				action,
				operationKey: a.operationKey,
				routineKey: a.routineKey,
				title: text(a.title, 160, true),
				intent: text(a.intent, 32768),
				trigger: compileTrigger(a.trigger),
			};
			if (a.expiresAt !== undefined) {
				if (typeof a.expiresAt !== "string" || !Number.isFinite(Date.parse(a.expiresAt)))
					throw new Error("Invalid routine expiry");
				request.expiresAt = new Date(a.expiresAt).toISOString();
			}
			if (a.maxOccurrences !== undefined) {
				if (
					!Number.isSafeInteger(a.maxOccurrences) ||
					(a.maxOccurrences as number) < 1 ||
					(a.maxOccurrences as number) > 100000
				)
					throw new Error("Invalid routine occurrence limit");
				request.maxOccurrences = a.maxOccurrences;
			}
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
			return { kind: "text", value: cloudToolJsonText(r) };
		},
	};
	return [tool];
}
