import {
	companyStatePath,
	ROUTINE_CODE_CHANGE_EVENTS,
	ROUTINE_DATA_CHANGE_OPERATIONS,
	type RoutineCheckBeforeWake,
	type RoutineCodeChangeEvent,
	type RoutineDataChangeOperation,
} from "@qorpera/cloud-client/company-state-files";
import { UUID_ANY_CASE_PATTERN as UUID } from "@qorpera/contracts";
import type { CloudFolderRoutineDecision, CloudFolderRoutineDecisionRequest } from "./cloud-folder-routine-decision.ts";
import {
	CLOUD_FOLDER_ROUTINE_NAME,
	CLOUD_FOLDER_ROUTINE_NAME_BYTES,
	type CloudFolderRoutineChange,
	type CloudFolderRoutineListing,
	type CloudFolderRoutines,
} from "./cloud-folder-routines.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { type CloudNativeTool, CloudToolArgumentRefusal, type CloudToolContext } from "./cloud-native-tool-boundary.ts";
import {
	cloudRoutineAgentOffsetMinutes,
	cloudRoutineSpreadInstant,
	cloudRoutineSpreadLocalTime,
} from "./cloud-routine-pace.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import { CLOUD_RUNTIME_ROUTINE_EFFORTS, isCloudRuntimeRoutineEffort } from "./cloud-runtime-policy.ts";
import { CURSOR, fitsOneResult } from "./cloud-worker-tools.ts";

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ROUTINE_KEY = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const LOCAL_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const BUSINESS_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
const REPLY = ["optional", "required", "silent"] as const;
const ACTIONS = ["list", "upsert", "pause", "resume", "remove", "conclude"] as const;
/** An event type as a sender names it: printable ASCII without spaces, at most 128 characters. */
const EVENT_TYPE = /^[\x21-\x7e]{1,128}$/;
const REPO_OWNER = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const REPO_FULL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const SITE_SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const DATA_DB = /^[a-z][a-z0-9_-]{0,63}$/;
const DATA_TABLE = /^[a-z][a-z0-9_]{0,63}$/;
const CHECK_URL = /^https:\/\/[^/@\s\u0000-\u001f\u007f]+(?:\/[^\s\u0000-\u001f\u007f]*)?$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DECISIONS = ["next", "conclude"] as const;

function fits(
	value: unknown,
	allowed: readonly string[],
	required: readonly string[],
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => allowed.includes(key)) &&
		required.every((key) => Object.hasOwn(value, key))
	);
}
function object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
	if (!fits(value, allowed, required)) throw new Error("Invalid routine request");
	return value;
}
const words = (keys: readonly string[]) =>
	keys.length < 2 ? keys.join("") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
/** A trigger's keys, for its kind. A missing or unknown key is refused with the keys the kind takes and an example; the
 * model's own keys are not repeated, as a reason the boundary cannot pass on as plain text would be dropped. */
function triggerKeys(
	value: unknown,
	kind: string,
	required: readonly string[],
	optional: readonly string[],
	example: Record<string, unknown>,
): Record<string, unknown> {
	if (!fits(value, ["kind", ...required, ...optional], ["kind", ...required]))
		throw new CloudToolArgumentRefusal(
			`a trigger of kind ${kind} takes ${words(required)}, and optionally ${words(optional)}, nothing else, like ${JSON.stringify({ kind, ...example })}`,
		);
	return value;
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
// A bad value is refused in words that name the argument (label) and show a good one, so the model can correct it.
function timeZone(value: unknown, label: string): string {
	const refusal = () => new CloudToolArgumentRefusal(`${label} is an IANA time zone, like Europe/Copenhagen`);
	if (typeof value !== "string" || !value || value === "auto" || value.length > 64) throw refusal();
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
	} catch {
		throw refusal();
	}
	return value;
}
function localTime(value: unknown, label: string): string {
	if (typeof value !== "string" || !LOCAL_TIME.test(value))
		throw new CloudToolArgumentRefusal(`${label} is a time of day as HH:MM on a 24-hour clock, like 08:00`);
	return value;
}
function reply(value: unknown): (typeof REPLY)[number] {
	if (value === undefined) return "optional";
	if (typeof value !== "string" || !REPLY.includes(value as (typeof REPLY)[number]))
		throw new CloudToolArgumentRefusal("report is optional, required or silent");
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

/** What a listener waits for: a todo's or a human task's file, as a path inside the company. A trailing slash is
 * dropped and `.md` added when it is missing, so a todo named the way list output shows it still reads. */
export function cloudRoutineListenedPath(value: unknown, label: string): string {
	const refusal = () =>
		new CloudToolArgumentRefusal(
			`${label} is the path of a todo or a human task file, like QorperaOS/agents/product-builder/todos/landing-page.md or QorperaOS/human-tasks/sign-contract.md`,
		);
	if (typeof value !== "string" || Buffer.byteLength(value) > 1024) throw refusal();
	const trimmed = value.trim().replace(/\/+$/, "");
	for (const path of trimmed.endsWith(".md") ? [trimmed] : [`${trimmed}.md`, trimmed]) {
		const kind = companyStatePath(path)?.kind;
		if (kind === "todo" || kind === "human-task") return path;
	}
	throw refusal();
}

/** A listener's latest time: ahead, and at most 30 days ahead, so a todo nobody closes is not waited on for months (the
 * routine rules allow 31). */
const LISTENER_DAYS = 30;
function latestTime(value: unknown, label: string): string {
	const at = instant(value, label);
	const ms = Date.parse(at) - Date.now();
	if (ms <= 0 || ms > LISTENER_DAYS * 86_400_000)
		throw new CloudToolArgumentRefusal(
			`${label} is when you look at the latest, ahead and within ${LISTENER_DAYS} days; if it is still open then, wait again`,
		);
	return at;
}

/** The model describes a cadence in the three shapes people use; the cloud
 * scheduler's closed trigger forms are compiled here. The trigger id is
 * host-owned and every routine has exactly one trigger (contract 16.3). A
 * dynamic routine has one next run instead of a cadence ("once"); its runs
 * choose the next one. Without firstRunAt the routine file's writer stamps the
 * save instant, so a retried save with the same key stays the same request.
 */
function compileTrigger(value: unknown): Record<string, unknown> {
	const kind = (value as { kind?: unknown } | null)?.kind;
	const zone = "Europe/Copenhagen";
	if (kind === "every") {
		const t = triggerKeys(value, kind, ["minutes"], ["firstRunAt", "report"], { minutes: 60 });
		if (!Number.isSafeInteger(t.minutes) || (t.minutes as number) < 5 || (t.minutes as number) > 10_080)
			throw new CloudToolArgumentRefusal("minutes is a whole number from 5 to 10080 (one week), like 60");
		const trigger: Record<string, unknown> = { kind: "schedule", intervalMinutes: t.minutes };
		if (t.firstRunAt !== undefined) trigger.startAt = instant(t.firstRunAt, "firstRunAt");
		return { ...trigger, replyPolicy: reply(t.report) };
	}
	if (kind === "weekly") {
		const t = triggerKeys(value, kind, ["localTime", "timeZone"], ["weekdays", "firstRunAt", "report"], {
			localTime: "08:00",
			timeZone: zone,
		});
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
			throw new CloudToolArgumentRefusal(
				'weekdays is 1 to 7 different days, sunday to saturday in lowercase, like ["monday", "thursday"]',
			);
		return {
			kind: "schedule",
			intervalMinutes: 1440,
			...startAt,
			weekdays: days,
			localTime: localTime(t.localTime, "localTime"),
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "dynamic") {
		const t = triggerKeys(value, kind, ["timeZone"], ["firstRunAt", "report"], { timeZone: zone });
		return {
			kind: "once",
			...(t.firstRunAt === undefined ? {} : { at: instant(t.firstRunAt, "firstRunAt") }),
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "when_done") {
		// A listener: a dynamic routine whose first run waits for the todo or human task, with latestAt as its fallback.
		const t = triggerKeys(value, kind, ["path", "latestAt", "timeZone"], ["report"], {
			path: "QorperaOS/agents/product-builder/todos/landing-page.md",
			latestAt: "2026-11-06T09:00:00+01:00",
			timeZone: zone,
		});
		return {
			kind: "once",
			at: latestTime(t.latestAt, "latestAt"),
			after: cloudRoutineListenedPath(t.path, "path"),
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "file_change") {
		const t = triggerKeys(value, kind, ["path", "timeZone"], ["match", "report"], {
			path: "sales/leads",
			timeZone: zone,
		});
		const match = t.match ?? "exact";
		if (match !== "exact" && match !== "subtree")
			throw new CloudToolArgumentRefusal("match is exact (the path itself) or subtree (anything under it)");
		// A folder is often written with a slash at the end (inbox/l23/): it is dropped, as the routine file's
		// parser does. Any other bad path is refused with the parser's reason, so the model can correct it.
		const path = typeof t.path === "string" ? t.path.replace(/\/+$/, "") : "";
		if (
			!path ||
			Buffer.byteLength(path) > 1024 ||
			path.startsWith("/") ||
			path.split("/").some((part) => !part || part === "." || part === "..")
		)
			throw new CloudToolArgumentRefusal("path is a folder or file path inside the company, like sales/leads");
		return {
			kind: "listener",
			source: "company-file",
			path,
			match,
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "event") {
		// An example id would be called as it is, so the example names where a real one comes from.
		const t = triggerKeys(value, kind, ["hookId", "timeZone"], ["only", "report"], {
			hookId: "<an id from list_hooks>",
			timeZone: zone,
		});
		if (typeof t.hookId !== "string" || !UUID.test(t.hookId))
			throw new CloudToolArgumentRefusal(
				"hookId is the id of one of the company's hooks or mailboxes, a UUID copied from list_hooks",
			);
		const only =
			t.only === undefined
				? {}
				: Array.isArray(t.only) &&
						t.only.length >= 1 &&
						t.only.length <= 20 &&
						new Set(t.only).size === t.only.length &&
						t.only.every((type) => typeof type === "string" && EVENT_TYPE.test(type))
					? { only: [...t.only] }
					: undefined;
		if (!only)
			throw new CloudToolArgumentRefusal(
				'only is 1 to 20 different event types, each up to 128 ASCII letters, digits or punctuation marks without spaces, like ["invoice.paid"]',
			);
		return {
			kind: "listener",
			source: "event",
			hookId: t.hookId.toLowerCase(),
			...only,
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "code_change") {
		const t = triggerKeys(value, kind, ["owner", "name", "timeZone"], ["events", "paths", "report"], {
			owner: "acme",
			name: "web",
			events: ["landed", "checks_failed"],
			paths: ["src/**/*.ts"],
			timeZone: zone,
		});
		if (typeof t.owner !== "string" || !REPO_OWNER.test(t.owner))
			throw new CloudToolArgumentRefusal("owner is the repository owner name, like acme");
		if (typeof t.name !== "string" || !REPO_NAME.test(t.name))
			throw new CloudToolArgumentRefusal("name is the repository name, like web");
		const rawEvents = t.events === undefined ? ["landed"] : t.events;
		if (
			!Array.isArray(rawEvents) ||
			rawEvents.length < 1 ||
			rawEvents.length > 4 ||
			new Set(rawEvents).size !== rawEvents.length ||
			rawEvents.some(
				(ev) => typeof ev !== "string" || !ROUTINE_CODE_CHANGE_EVENTS.includes(ev as RoutineCodeChangeEvent),
			)
		)
			throw new CloudToolArgumentRefusal(
				'events is 1 to 4 distinct values from landed, undone, checks_failed, or conflict, like ["landed"]',
			);
		const paths =
			t.paths === undefined
				? {}
				: Array.isArray(t.paths) &&
						t.paths.length >= 1 &&
						t.paths.length <= 20 &&
						new Set(t.paths).size === t.paths.length &&
						t.paths.every(
							(pat) =>
								typeof pat === "string" && pat.length >= 1 && pat.length <= 256 && !CONTROL_CHARS.test(pat),
						)
					? { paths: [...(t.paths as string[])] }
					: undefined;
		if (!paths)
			throw new CloudToolArgumentRefusal(
				'paths is 1 to 20 distinct glob patterns of at most 256 characters, like ["src/**/*.ts"]',
			);
		return {
			kind: "listener",
			source: "code-change",
			repo: `${t.owner}/${t.name}`.toLowerCase(),
			events: [...(rawEvents as RoutineCodeChangeEvent[])],
			...paths,
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "app_unhealthy") {
		const t = triggerKeys(value, kind, ["site", "timeZone"], ["report"], {
			site: "billing-app",
			timeZone: zone,
		});
		if (typeof t.site !== "string" || (!SITE_SLUG.test(t.site) && !UUID.test(t.site)))
			throw new CloudToolArgumentRefusal("site is a hosted app slug (like billing-app) or site UUID");
		return {
			kind: "listener",
			source: "app-unhealthy",
			site: t.site.toLowerCase(),
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	if (kind === "data_change") {
		const t = triggerKeys(value, kind, ["database", "timeZone"], ["tables", "operations", "report"], {
			database: "billing",
			tables: ["invoices"],
			operations: ["insert"],
			timeZone: zone,
		});
		if (typeof t.database !== "string" || !DATA_DB.test(t.database))
			throw new CloudToolArgumentRefusal("database is a lowercase company database name, like billing");
		const tables =
			t.tables === undefined
				? {}
				: Array.isArray(t.tables) &&
						t.tables.length >= 1 &&
						t.tables.length <= 20 &&
						new Set(t.tables).size === t.tables.length &&
						t.tables.every((tb) => typeof tb === "string" && DATA_TABLE.test(tb))
					? { tables: [...(t.tables as string[])] }
					: undefined;
		if (!tables)
			throw new CloudToolArgumentRefusal('tables is 1 to 20 distinct lowercase table names, like ["invoices"]');
		const operations =
			t.operations === undefined
				? {}
				: Array.isArray(t.operations) &&
						t.operations.length >= 1 &&
						t.operations.length <= 3 &&
						new Set(t.operations).size === t.operations.length &&
						t.operations.every(
							(op) =>
								typeof op === "string" &&
								ROUTINE_DATA_CHANGE_OPERATIONS.includes(op as RoutineDataChangeOperation),
						)
					? { operations: [...(t.operations as RoutineDataChangeOperation[])] }
					: undefined;
		if (!operations)
			throw new CloudToolArgumentRefusal("operations is 1 to 3 distinct values from insert, update, or delete");
		return {
			kind: "listener",
			source: "data-change",
			database: t.database,
			...tables,
			...operations,
			timeZone: timeZone(t.timeZone, "timeZone"),
			replyPolicy: reply(t.report),
		};
	}
	throw new CloudToolArgumentRefusal(
		`trigger is an object whose kind is dynamic, when_done, every, weekly, file_change, event, code_change, app_unhealthy or data_change, like ${JSON.stringify({ kind: "dynamic", timeZone: zone })}`,
	);
}

function compileCheckBeforeWake(value: unknown): RoutineCheckBeforeWake {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (kind === "http_probe") {
		const c = object(value, ["kind", "url", "expectStatus", "timeoutMs"], ["kind", "url"]);
		if (typeof c.url !== "string" || c.url.length < 10 || c.url.length > 1024 || !CHECK_URL.test(c.url))
			throw new CloudToolArgumentRefusal("checkBeforeWake.url must be an https URL without embedded credentials");
		if (
			c.expectStatus !== undefined &&
			(!Number.isSafeInteger(c.expectStatus) || (c.expectStatus as number) < 100 || (c.expectStatus as number) > 599)
		)
			throw new CloudToolArgumentRefusal("checkBeforeWake.expectStatus must be an HTTP status code from 100 to 599");
		if (
			c.timeoutMs !== undefined &&
			(!Number.isSafeInteger(c.timeoutMs) || (c.timeoutMs as number) < 500 || (c.timeoutMs as number) > 30000)
		)
			throw new CloudToolArgumentRefusal("checkBeforeWake.timeoutMs must be between 500 and 30000");
		return {
			kind: "http_probe",
			url: c.url,
			...(c.expectStatus === undefined ? {} : { expectStatus: c.expectStatus as number }),
			...(c.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs as number }),
		};
	}
	if (kind === "code_checks") {
		const c = object(value, ["kind", "repo", "timeoutMs"], ["kind"]);
		if (c.repo !== undefined && (typeof c.repo !== "string" || !REPO_FULL.test(c.repo)))
			throw new CloudToolArgumentRefusal("checkBeforeWake.repo must be owner/name");
		if (
			c.timeoutMs !== undefined &&
			(!Number.isSafeInteger(c.timeoutMs) || (c.timeoutMs as number) < 1000 || (c.timeoutMs as number) > 300000)
		)
			throw new CloudToolArgumentRefusal("checkBeforeWake.timeoutMs must be between 1000 and 300000");
		return {
			kind: "code_checks",
			...(c.repo === undefined ? {} : { repo: (c.repo as string).toLowerCase() }),
			...(c.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs as number }),
		};
	}
	throw new CloudToolArgumentRefusal(
		'checkBeforeWake must be { kind: "http_probe", url, expectStatus?, timeoutMs? } or { kind: "code_checks", repo?, timeoutMs? }',
	);
}

/** The compiled trigger's start times, spread for the agent (cloud-routine-pace.ts): a weekly time of day, a first run,
 * a dynamic routine's next run or a listener's latest time, never to or past the routine's end. */
function spreadTrigger(trigger: Record<string, unknown>, offsetMinutes: number, end: unknown): Record<string, unknown> {
	const before = typeof end === "string" ? end : null;
	const spread = { ...trigger };
	if (typeof spread.localTime === "string")
		spread.localTime = cloudRoutineSpreadLocalTime(spread.localTime, offsetMinutes);
	if (typeof spread.startAt === "string")
		spread.startAt = cloudRoutineSpreadInstant(spread.startAt, offsetMinutes, before);
	if (typeof spread.at === "string") spread.at = cloudRoutineSpreadInstant(spread.at, offsetMinutes, before);
	return spread;
}

export const CLOUD_ROUTINE_TOOL_DESCRIPTION = [
	"Your own standing work: a routine wakes you, this agent, with its stored intent, also while no member is online. Use one whenever a responsibility or a request needs repeated attention, and tell the member what you set up. Each change passes a quick automatic review against your job; your own routines need no member's approval unless a member's own rule asks for it. A routine is not a reminder to a person and acts only within your own authority.",
	"Actions:",
	"- list: your routines a page at a time (cursor), or one whole by routineKey. For one paused with pauseReason needs_model_account or authorization_failed it says what it waits for and what to tell the member.",
	"- upsert: make or change the routine of routineKey. One routineKey for one standing work makes a change a new version, not a duplicate; list first when unsure.",
	"- pause and resume: resume switches it back on, also after a member or a failing model account stopped it.",
	"- conclude: end it with a one-sentence summary of why; it stays listed as concluded, and saving it again restarts it.",
	"- remove: delete its file and free its name.",
	"trigger.kind:",
	"- dynamic: each run chooses the next (decide_routine). The first run is at firstRunAt, by default now or, for an existing dynamic routine, its next run while still ahead. For a new responsibility or a situation to watch, where the next look depends on what you find.",
	"- when_done: one run when the todo or human task file at path is done, or at latestAt (wake.payload.state says which): to follow it up instead of guessing a time.",
	"- every (minutes) and weekly (localTime HH:MM, weekdays): work tied to the clock, such as a Monday report. A new one runs once at once as a kickoff, then on its schedule; give firstRunAt only when the first run must wait.",
	"- file_change: each saved change under path, a company path you can read (match exact or subtree), wakes you once with what changed, never your own.",
	"- event: what other services send to a hook or mailbox (hookId from list_hooks; only, its event types): each run gets up to 20 new events.",
	"- code_change: triggers on landed, undone, checks_failed, or conflict for a repo (owner, name) with optional paths globs.",
	"- app_unhealthy: triggers when a hosted app (site slug or id) fails health checks or crash-loops.",
	"- data_change: triggers on Company Database table changes (database, optional tables and operations).",
	"checkBeforeWake (optional on recurring scheduled routines — every or weekly): deterministic http_probe or code_checks gate that wakes you only on failure or state change.",
	"file_change and event listen from their last save, which drops what was not delivered yet. timeZone is the member's IANA time zone, from the wake's time; times are ISO 8601 with an offset, and a time on the hour or half hour moves a few minutes later per agent. report: optional (speak only when useful), required (always; it needs your public thread, or the run is skipped) or silent (never).",
	"Start dense while a responsibility is new: while you can move it without a member, the next run is minutes to a few hours away, not the next morning. Give a finite watch an expiresAt, or for every and weekly a maxOccurrences, so it ends by itself. When you pick a threshold or a cadence nobody gave you, tell the member it is your starting assumption.",
	"The routine is the file routines/<routineKey>.md in your folder. A conflict means it changed since it was read: call again with a new operationKey.",
].join("\n");

export const CLOUD_ROUTINE_DECISION_DESCRIPTION = [
	"Decide what comes after this run of your dynamic routine: once a run, before your final message, or as your last act when you send none. When you hand work to workers, decide first: this run must decide, and the continuation cannot.",
	"- next: at is when the next run starts (a time already past means right away). Choose it by what you found: minutes to a few hours ahead while you can move the work without a member or a reply is due; the next day only when all waits for someone or is quiet. When the next look waits for a coworker's todo or a person's human task, give its file as whenDone: the next run comes as soon as it is done, with at as the latest time (within 30 days). intent, title, effort and report change only when given; a new intent or title goes through the automatic review, and if it is not approved, decide again without them.",
	"- conclude: summary is one sentence on why the routine is done (the goal reached, the question answered, the watch no longer needed); the member sees it.",
	"state settled: the routine already moved on, changed in another conversation or passed its end date, so nothing is owed. state refused carries the reason: decide again under a new operationKey, or conclude. A time on the hour or half hour moves a few minutes later per agent.",
].join("\n");

/** The cloud derives the agent, requester and model account from the run. The
 * model chooses only what to do, when, and how long. Returns the check of each
 * call's context.
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
	return (context: CloudToolContext) => {
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
}

export function cloudRoutineTools(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	/** In a dynamic routine's run: its key, whether its decision is still owed, and a
	 * callback for a conclusion made here (which settles that decision). */
	ownDynamicRoutine:
		| {
				readonly routineKey: string;
				readonly decisionOwed: () => boolean;
				readonly settled: () => void;
		  }
		| undefined,
	/** The run's routines, written as the files in its folder. */
	folderRoutines: CloudFolderRoutines,
): readonly CloudNativeTool[] {
	const assertContext = routineAuthority(binding, identity);
	const offsetMinutes = cloudRoutineAgentOffsetMinutes(identity.staffAgentId);
	const reportSchema = { type: "string", enum: [...REPLY] };
	const zoneSchema = { type: "string", minLength: 1, maxLength: 64 };
	const timeSchema = { type: "string", pattern: LOCAL_TIME.source };
	// A change binds its operation key to its request: reusing the key with other arguments is refused with the
	// arguments, before the automatic review, as hire_agent and create_group_chat do.
	const bound = new Map<string, string>();
	const refuseRebinding = (request: Record<string, unknown>) => {
		const previous = bound.get(request.operationKey as string);
		if (previous !== undefined && previous !== JSON.stringify(request))
			throw new CloudToolArgumentRefusal(
				"operationKey is already used in this run for a different routine change, which may already have been made: list your routines before changing them again, and repeat this operationKey only with identical arguments",
			);
	};
	const tool: CloudNativeTool = {
		name: "manage_routine" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		parallelRead: (value) =>
			value !== null && typeof value === "object" && !Array.isArray(value) && value.action === "list",
		description: CLOUD_ROUTINE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action"],
			properties: {
				action: { type: "string", enum: [...ACTIONS] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				// A routine's key is its file's name.
				routineKey: {
					type: "string",
					pattern: CLOUD_FOLDER_ROUTINE_NAME.source,
					maxLength: CLOUD_FOLDER_ROUTINE_NAME_BYTES,
					description: "The routine's file name: lowercase letters, digits and single hyphens.",
				},
				title: { type: "string", minLength: 1, maxLength: 160 },
				intent: {
					type: "string",
					minLength: 1,
					maxLength: 32768,
					description:
						"A complete instruction to your future self: what to read, what to decide, when to tell someone and when to stay silent.",
				},
				summary: { type: "string", minLength: 1, maxLength: 2000, description: "conclude: one sentence on why." },
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
							required: ["kind", "path", "latestAt", "timeZone"],
							properties: {
								kind: { const: "when_done" },
								path: { type: "string", minLength: 1, maxLength: 1024 },
								latestAt: { type: "string", format: "date-time" },
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
								minutes: { type: "integer", minimum: 5, maximum: 10080, description: "5 to 10080." },
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
									description: "Monday to Friday by default.",
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
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "hookId", "timeZone"],
							properties: {
								kind: { const: "event" },
								hookId: { type: "string", pattern: UUID.source },
								only: {
									type: "array",
									minItems: 1,
									maxItems: 20,
									uniqueItems: true,
									items: { type: "string", pattern: EVENT_TYPE.source },
								},
								timeZone: zoneSchema,
								report: reportSchema,
							},
						},
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "owner", "name", "timeZone"],
							properties: {
								kind: { const: "code_change" },
								owner: { type: "string" },
								name: { type: "string" },
								events: {
									type: "array",
									minItems: 1,
									maxItems: 4,
									items: { type: "string", enum: [...ROUTINE_CODE_CHANGE_EVENTS] },
								},
								paths: {
									type: "array",
									minItems: 1,
									maxItems: 20,
									items: { type: "string" },
								},
								timeZone: zoneSchema,
								report: reportSchema,
							},
						},
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "site", "timeZone"],
							properties: {
								kind: { const: "app_unhealthy" },
								site: { type: "string" },
								timeZone: zoneSchema,
								report: reportSchema,
							},
						},
						{
							type: "object",
							additionalProperties: false,
							required: ["kind", "database", "timeZone"],
							properties: {
								kind: { const: "data_change" },
								database: { type: "string" },
								tables: {
									type: "array",
									minItems: 1,
									maxItems: 20,
									items: { type: "string" },
								},
								operations: {
									type: "array",
									minItems: 1,
									maxItems: 3,
									items: { type: "string", enum: [...ROUTINE_DATA_CHANGE_OPERATIONS] },
								},
								timeZone: zoneSchema,
								report: reportSchema,
							},
						},
					],
				},
				checkBeforeWake: {
					type: "object",
					additionalProperties: false,
					required: ["kind"],
					properties: {
						kind: { type: "string", enum: ["http_probe", "code_checks"] },
						url: { type: "string" },
						expectStatus: { type: "integer", minimum: 100, maximum: 599 },
						repo: { type: "string" },
						timeoutMs: { type: "integer", minimum: 500, maximum: 300000 },
					},
				},
				expiresAt: { type: "string", format: "date-time" },
				maxOccurrences: {
					type: "integer",
					minimum: 1,
					maximum: 100000,
					description: "every and weekly: 1 to 100000 runs.",
				},
				effort: {
					type: "string",
					enum: [...CLOUD_RUNTIME_ROUTINE_EFFORTS],
					description:
						"Each run's thinking depth: high for judgement-heavy analysis, low for a quick check. A new routine starts at medium; a save without it keeps what it has.",
				},
				quietHours: {
					type: "object",
					additionalProperties: false,
					required: ["start", "end", "timeZone"],
					description: "Non-urgent runs wait until this window ends.",
					properties: { start: timeSchema, end: timeSchema, timeZone: zoneSchema },
				},
				cursor: { type: "string", pattern: CURSOR.source },
			},
		},
		parseArguments(value) {
			const action = (value as { action?: unknown } | null)?.action;
			if (typeof action !== "string" || !ACTIONS.includes(action as (typeof ACTIONS)[number]))
				throw new Error("Invalid routine action");
			if (action === "list") {
				// A list pages, or shows one routine.
				const l = object(value, ["action", "routineKey", "cursor"], ["action"]);
				if (l.routineKey !== undefined && l.cursor !== undefined)
					throw new CloudToolArgumentRefusal("list takes a routineKey or a cursor, not both");
				if (l.routineKey !== undefined) {
					if (typeof l.routineKey !== "string") throw new Error("Invalid routine key");
					folderRoutines.path(l.routineKey);
				}
				if (l.cursor !== undefined && (typeof l.cursor !== "string" || !CURSOR.test(l.cursor)))
					throw new CloudToolArgumentRefusal("cursor must be a nextCursor from an earlier page, unchanged");
				return {
					action,
					...(l.routineKey === undefined ? {} : { routineKey: l.routineKey }),
					...(l.cursor === undefined ? {} : { cursor: l.cursor }),
				} as never;
			}
			// A routine's key is its file's name; the rule is said in words.
			const named = (value as { routineKey?: unknown } | null)?.routineKey;
			if (typeof named === "string") folderRoutines.path(named);
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
				const request = {
					action,
					operationKey: c.operationKey,
					routineKey: c.routineKey,
					summary: text(c.summary, 2000),
				};
				refuseRebinding(request);
				folderRoutines.check(request as CloudFolderRoutineChange);
				return request as never;
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
							"checkBeforeWake",
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
			// Refused here, in words the model can act on.
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
			if (!upsert) {
				const request = { action, operationKey: a.operationKey, routineKey: a.routineKey };
				refuseRebinding(request);
				folderRoutines.check(request as CloudFolderRoutineChange);
				return request as never;
			}
			const request: Record<string, unknown> = {
				action,
				operationKey: a.operationKey,
				routineKey: a.routineKey,
				title: text(a.title, 160, true),
				intent: text(a.intent, 32768),
				trigger: compileTrigger(a.trigger),
			};
			if (a.checkBeforeWake !== undefined) {
				if ((request.trigger as { kind: string }).kind !== "schedule")
					throw new CloudToolArgumentRefusal("checkBeforeWake is only supported on recurring scheduled routines");
				request.checkBeforeWake = compileCheckBeforeWake(a.checkBeforeWake);
			}
			if (a.expiresAt !== undefined) request.expiresAt = instant(a.expiresAt, "expiresAt");
			request.trigger = spreadTrigger(request.trigger as Record<string, unknown>, offsetMinutes, request.expiresAt);
			// A dynamic routine's run after its end would never happen.
			const firstRunAt = (request.trigger as { kind: string; at?: string }).at;
			if (
				firstRunAt !== undefined &&
				request.expiresAt !== undefined &&
				Date.parse(firstRunAt) >= Date.parse(request.expiresAt as string)
			)
				throw new CloudToolArgumentRefusal(
					"firstRunAt must come before expiresAt: choose an earlier first run or a later end",
				);
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
			if (a.effort !== undefined && !isCloudRuntimeRoutineEffort(a.effort))
				throw new Error("Invalid routine effort");
			// The routine file's writer starts a new routine at medium and keeps a saved routine's effort when none is given.
			if (a.effort !== undefined) request.effort = a.effort;
			if (a.quietHours !== undefined) {
				const quiet = object(a.quietHours, ["start", "end", "timeZone"], ["start", "end", "timeZone"]);
				const start = localTime(quiet.start, "quietHours.start"),
					end = localTime(quiet.end, "quietHours.end");
				if (start === end)
					throw new CloudToolArgumentRefusal("quietHours.start and quietHours.end differ, like 22:00 and 07:00");
				request.quietHours = { start, end, timeZone: timeZone(quiet.timeZone, "quietHours.timeZone") };
			}
			// The file's own checks, before the automatic review, so a card is never raised for a save that cannot be.
			refuseRebinding(request);
			folderRoutines.check(request as unknown as CloudFolderRoutineChange);
			return request as never;
		},
		async execute(value, context) {
			assertContext(context);
			// The boundary passes the already parsed request; its compiled trigger is not re-parseable input.
			const request = value as Record<string, unknown>;
			// An agent's routines are files; the folder core decides each save.
			if (request.action === "list")
				return folderRoutines.list(request as unknown as CloudFolderRoutineListing, context, fitsOneResult);
			refuseRebinding(request);
			if (!bound.has(request.operationKey as string))
				bound.set(request.operationKey as string, JSON.stringify(request));
			const changed = await folderRoutines.change(request as unknown as CloudFolderRoutineChange, context);
			// Concluding its own routine here is a decision too.
			if (ownDynamicRoutine && changed.concluded && request.routineKey === ownDynamicRoutine.routineKey)
				ownDynamicRoutine.settled();
			return changed.content;
		},
	};
	return [tool];
}

/** Offered only in a run of a dynamic routine. The host refuses this run's final
 * message and its completion, showing the model why, until the routine moved on
 * (`decided` tells it so). Once nothing is owed, a second
 * decision is refused here: the routine's file would answer settled and change nothing.
 */
export function cloudRoutineDecisionTool(
	binding: CloudNativeToolBinding,
	identity: CloudNativeToolIdentity,
	options: {
		readonly decisionOwed: () => boolean;
		readonly decided: () => void;
		/** The run's decision, written into the routine's file. */
		readonly folderDecision: CloudFolderRoutineDecision;
	},
): CloudNativeTool {
	const assertContext = routineAuthority(binding, identity);
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
				at: { type: "string", format: "date-time", description: "ISO 8601 with an offset." },
				intent: {
					type: "string",
					minLength: 1,
					maxLength: 32768,
					description:
						"When the work changed: the complete new instruction for your future self (what to check, what you learned, when to speak). Without it the next run keeps this run's.",
				},
				title: { type: "string", minLength: 1, maxLength: 160 },
				effort: { type: "string", enum: [...CLOUD_RUNTIME_ROUTINE_EFFORTS] },
				report: { type: "string", enum: [...REPLY] },
				summary: { type: "string", minLength: 1, maxLength: 2000 },
				whenDone: { type: "string", minLength: 1, maxLength: 1024 },
			},
		},
		parseArguments(value) {
			if (!options.decisionOwed())
				throw new CloudToolArgumentRefusal(
					"nothing is owed any more: this run already decided its routine, or it moved on elsewhere. To change the next run or its instructions again, use manage_routine upsert with its routineKey; to end it, manage_routine conclude",
				);
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
				["action", "operationKey", "at", "intent", "title", "effort", "report", "whenDone"],
				["action", "operationKey"],
			);
			if (typeof n.operationKey !== "string" || !OPERATION_KEY.test(n.operationKey))
				throw new Error("Invalid routine key");
			const request: Record<string, unknown> = {
				action,
				operationKey: n.operationKey,
				at: n.whenDone === undefined ? instant(n.at, "at") : latestTime(n.at, "at"),
			};
			if (n.intent !== undefined) request.intent = text(n.intent, 32768);
			if (n.title !== undefined) request.title = text(n.title, 160, true);
			if (n.effort !== undefined) {
				if (!isCloudRuntimeRoutineEffort(n.effort)) throw new Error("Invalid routine effort");
				request.effort = n.effort;
			}
			if (n.report !== undefined) request.report = reply(n.report);
			if (n.whenDone !== undefined) request.after = cloudRoutineListenedPath(n.whenDone, "whenDone");
			// A rewrite's file is checked now, before the automatic review.
			options.folderDecision.check(request as unknown as CloudFolderRoutineDecisionRequest);
			return request as never;
		},
		async execute(value, context) {
			assertContext(context);
			const request = value as Record<string, unknown>;
			// A routine is a file; the folder core takes the save as the decision while it is owed.
			const decision = await options.folderDecision.decide(
				request as unknown as CloudFolderRoutineDecisionRequest,
				context,
			);
			if (decision.decided) options.decided();
			return decision.content;
		},
	};
}
