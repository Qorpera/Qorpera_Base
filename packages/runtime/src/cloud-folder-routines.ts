import {
	COMPANY_STATE_FILE_MAX_BYTES,
	type CompanyStateEffort,
	canonicalCompanyStateInstant,
	osPath,
	parseCompanyStateFile,
	type RoutineDay,
	type RoutineFile,
	type RoutineTrigger,
	setCompanyStateSettings,
	writeRoutineFile,
} from "@qorpera/cloud-client/company-state-files";
import type { JsonValue } from "@qorpera/contracts";
import type {
	CloudCompanyFolderClient,
	CloudCompanyFolderFileEntry,
	CloudCompanyFolderRoutine,
	CloudCompanyFolderUnit,
} from "./cloud-company-folder-client.ts";
import { hashedId, invalidMessage } from "./cloud-folder-hiring.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

/*
 * `manage_routine` as a thin writer of a folder-v2 agent's routine files (deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md
 * §2 "routine", §5 "Plan (W4c)"; RUNTIME-COMPANY-FOLDER-C2.md §4):
 * `QorperaOS/agents/<handle>/routines/<routineKey>.md`, whose name is the routine's key. The folder core's commit
 * decides each save and keeps the routine index with the files. A routine change is delegation (later runs read its
 * instructions as their request), so every save carries the automatic review's approval of this call, recorded for
 * exactly its change set (C2 R1).
 *
 * An upsert's file is checked with the arguments, before the review (`check`). Every other refusal, and every answer
 * that changes nothing, comes before the receipt: a begun receipt that ends in an error holds the run's other
 * operations until it is resolved. A repeat of a saved call finds nothing to change, so it is answered, never refused.
 * The receipt binds the model's request; the commit carries the version read, so a file changed in between is a
 * conflict the model redoes under a new operation key. A new routine's id comes from the run and the operation key.
 *
 * The platform records three pauses in the index only (a member's Stop, a failing model account, a wait for one), so
 * the file still says active: a resume then saves the file unchanged, which ends that pause and pays like a resume
 * (20260929990000). A list reads the routine index, which the commit keeps (one read, as W1's todo list).
 */

const TOOL_VERSION = "folder-v2/1";
/** A routine's file name is its key (§1 "Names"). */
export const CLOUD_FOLDER_ROUTINE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CLOUD_FOLDER_ROUTINE_NAME_BYTES = 64;
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";
/** The pauses the platform records in the index only, an archive's (`agent_archived`, P15's follow-up queue) included. */
const PLATFORM_PAUSES = new Set(["member", "authorization_failed", "needs_model_account", "agent_archived"]);
const UNREADABLE = "That routine's file does not read as a routine; correct it with the file tools first";
const MISSING = "You have no routine with that routineKey: list your routines to see their keys";
const INVALID = "This routine cannot be saved as the company's files";
/** An upsert restates the whole routine, so a cut view is never its source. */
const CUT =
	"Some instructions are cut here: read the routine's file (company_read at its path) before restating them in an upsert.";
/** A routine file to check a conclusion against before the review. */
const PLACEHOLDER_FILE = writeRoutineFile({
	id: "00000000-0000-4000-8000-000000000000",
	title: "Routine",
	status: "active",
	trigger: { when: "every", minutes: 60, starts: null },
	timezone: null,
	ends: null,
	runs: null,
	quiet: null,
	effort: "medium",
	reply: "optional",
	conclusion: null,
	instructions: "Routine.",
});

/** A file concluded with the summary: the file's conclusion is one line, so line breaks and tabs become spaces. */
const concludedFile = (text: string, summary: string) =>
	setCompanyStateSettings(text, { status: "concluded", conclusion: summary.replace(/\s+/g, " ").trim() });

type Reply = RoutineFile["reply"];

/** manage_routine's compiled trigger (cloud-routine-tools.ts): a clock trigger, a file change (P29, read from the
 * folder journal) or an event at one of the company's hooks (E2, W2's listener). */
export type CloudFolderRoutineTrigger =
	| {
			readonly kind: "schedule";
			readonly intervalMinutes: number;
			readonly startAt?: string;
			readonly weekdays?: readonly string[];
			readonly localTime?: string;
			readonly timeZone?: string;
			readonly replyPolicy: Reply;
	  }
	| { readonly kind: "once"; readonly at?: string; readonly timeZone: string; readonly replyPolicy: Reply }
	| {
			readonly kind: "listener";
			readonly source: "company-file";
			readonly path: string;
			readonly match: "exact" | "subtree";
			readonly timeZone: string;
			readonly replyPolicy: Reply;
	  }
	| {
			readonly kind: "listener";
			readonly source: "event";
			readonly hookId: string;
			readonly only?: readonly string[];
			readonly timeZone: string;
			readonly replyPolicy: Reply;
	  };

export interface CloudFolderRoutineListing {
	readonly routineKey?: string;
	/** The cursor of the last routine an earlier page showed (its nextCursor). */
	readonly cursor?: string;
}

export interface CloudFolderRoutineUpsert {
	readonly action: "upsert";
	readonly operationKey: string;
	readonly routineKey: string;
	readonly title: string;
	readonly intent: string;
	readonly trigger: CloudFolderRoutineTrigger;
	readonly expiresAt?: string;
	readonly maxOccurrences?: number;
	readonly quietHours?: { readonly start: string; readonly end: string; readonly timeZone: string };
	readonly effort?: CompanyStateEffort;
}

export type CloudFolderRoutineChange =
	| CloudFolderRoutineUpsert
	| { readonly action: "pause" | "resume" | "remove"; readonly operationKey: string; readonly routineKey: string }
	| {
			readonly action: "conclude";
			readonly operationKey: string;
			readonly routineKey: string;
			readonly summary: string;
	  };

interface Current {
	readonly entry: CloudCompanyFolderFileEntry;
	readonly text: string;
	readonly routine: RoutineFile;
}

/** The platform's form of an instant (the compiled trigger's are ISO strings). */
const instant = (value: string) => canonicalCompanyStateInstant(value) ?? value;

/** The file an upsert writes: the whole routine, as today's upsert replaces it. A dynamic routine's next run is the
 * one given, else the file's while it is still ahead, else now. */
function upsertFile(request: CloudFolderRoutineUpsert, id: string, current: RoutineFile | null, now: number) {
	const given = request.trigger;
	let trigger: RoutineTrigger;
	let timezone: string | null;
	if (given.kind === "once") {
		const kept =
			current?.trigger.when === "once" && Date.parse(current.trigger.at) > now ? current.trigger.at : undefined;
		trigger = { when: "once", at: instant(given.at ?? kept ?? new Date(now).toISOString()) };
		timezone = given.timeZone;
	} else if (given.kind === "listener") {
		trigger =
			given.source === "event"
				? // The save's rules check that the hook is a live one of this company (E2).
					{ when: "event", hook: given.hookId, only: given.only ? [...given.only] : null }
				: // The path as given: the folder core folds it into the key it watches (P29).
					{ when: "file-change", watch: given.path, match: given.match };
		timezone = given.timeZone;
	} else if (given.weekdays) {
		trigger = {
			when: "weekly",
			days: given.weekdays.map((day) => day.slice(0, 3) as RoutineDay),
			time: given.localTime ?? "",
			starts: given.startAt === undefined ? null : instant(given.startAt),
		};
		timezone = given.timeZone ?? null;
	} else {
		// every has no time zone of its own: quiet hours carry theirs.
		trigger = {
			when: "every",
			minutes: given.intervalMinutes,
			starts: given.startAt === undefined ? null : instant(given.startAt),
		};
		timezone = null;
	}
	return writeRoutineFile({
		id,
		title: request.title,
		status: "active",
		trigger,
		timezone,
		ends: request.expiresAt === undefined ? null : instant(request.expiresAt),
		runs: request.maxOccurrences ?? null,
		quiet: request.quietHours
			? { start: request.quietHours.start, end: request.quietHours.end, timezone: request.quietHours.timeZone }
			: null,
		effort: request.effort ?? current?.effort ?? "medium",
		reply: given.replyPolicy,
		conclusion: null,
		instructions: request.intent,
	});
}

function parsed(path: string, text: string): { routine: RoutineFile | null; problems: readonly { message: string }[] } {
	const result = parseCompanyStateFile(path, text);
	if (!result) return { routine: null, problems: [{ message: `${path} is not a company state file` }] };
	if (!result.ok) return { routine: null, problems: result.problems };
	return result.file.kind === "routine"
		? { routine: result.file, problems: [] }
		: { routine: null, problems: [{ message: `${path} is not a routine` }] };
}

/** A routine as the index has it, for the model: how it runs now, and what its file says. */
function shown(routine: CloudCompanyFolderRoutine) {
	const { kind: _kind, id: _id, ...file } = routine.file ?? {};
	return {
		routineKey: routine.routineKey,
		path: routine.path,
		status: routine.status,
		...(routine.pauseReason ? { pauseReason: routine.pauseReason } : {}),
		nextRunAt: routine.nextRunAt,
		runsUsed: routine.occurrences,
		file: routine.file ? file : null,
		...(routine.instructionsTruncated ? { instructionsTruncated: true } : {}),
	};
}

/** What a routine that is paused now still needs, in words for the model. */
function waiting(routine: CloudCompanyFolderRoutine): string | null {
	if (routine.status !== "paused") return null;
	if (routine.pauseReason === "needs_model_account")
		return "It waits: no model account of the member you work for allows unattended runs yet. Tell the member it is a one-time account setting; the routine starts once it is on.";
	if (routine.pauseReason === "authorization_failed")
		return "It is paused because its model account stopped working: tell the member, and resume it once the account works again.";
	if (routine.pauseReason === "member") return "A member stopped it: resume it only if they want it back.";
	if (routine.pauseReason === "agent_archived")
		return "It was paused when its agent was archived: once the agent is active again, resume it if it should still run.";
	return null;
}

/** The run agent's routines as files. `handle` is the agent's folder name from the run context; `ownRoutineId` is the
 * routine that woke this run, if one did. */
export class CloudFolderRoutines {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	readonly #routines: string;
	readonly #ownRoutineId: string | undefined;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		handle: string;
		ownRoutineId?: string;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#routines = osPath(`agents/${options.handle}/routines`);
		this.#ownRoutineId = options.ownRoutineId;
	}

	/** The path of a routine, or a refusal the model can act on. */
	path(routineKey: string): string {
		if (
			!CLOUD_FOLDER_ROUTINE_NAME.test(routineKey) ||
			Buffer.byteLength(routineKey) > CLOUD_FOLDER_ROUTINE_NAME_BYTES
		)
			throw new CloudToolArgumentRefusal(
				"In this company a routineKey is the routine's file name: lowercase letters, digits and single hyphens, at most 64 characters",
			);
		return `${this.#routines}/${routineKey}.md`;
	}

	/** The checks that need no reads: with the arguments, before the automatic review. An upsert's file is made with a
	 * placeholder id; the real one cannot add a problem. */
	check(request: CloudFolderRoutineChange): void {
		const path = this.path(request.routineKey);
		if (request.action === "conclude") {
			const { problems } = parsed(path, concludedFile(PLACEHOLDER_FILE, request.summary));
			if (problems.length) throw new CloudToolArgumentRefusal(invalidMessage(problems, INVALID));
			return;
		}
		if (request.action !== "upsert") return;
		// A saved routine whose end has passed ends again at once.
		if (request.expiresAt !== undefined && Date.parse(request.expiresAt) <= Date.now())
			throw new CloudToolArgumentRefusal("expiresAt has already passed: choose a later end, or leave it out");
		const { problems } = parsed(path, upsertFile(request, PLACEHOLDER_ID, null, Date.now()));
		if (problems.length) throw new CloudToolArgumentRefusal(invalidMessage(problems, INVALID));
	}

	/**
	 * The agent's routines from the routine index, newest first, as many as fit one result (`fits`), with the cursor
	 * for the next page; `routineKey` shows one, whole. Each shows how it runs now (status, the platform's pause reason,
	 * the next run, the runs used) and what its file says.
	 */
	async list(
		request: CloudFolderRoutineListing,
		context: CloudToolContext,
		fits: (text: string) => boolean,
	): Promise<CloudToolContent> {
		const page = await this.#folder.agentRoutines(
			request.routineKey !== undefined
				? { routineKey: request.routineKey }
				: request.cursor !== undefined
					? { cursor: request.cursor }
					: {},
			context.signal,
		);
		const routines = page.routines.map(shown);
		const render = (count: number) => {
			const left = page.moreRoutines + page.routines.length - count;
			const listed = routines.slice(0, count);
			return cloudToolJsonText({
				schema: "qorpera.agent-routines/v2",
				runId: this.#identity.runId,
				routines: listed,
				moreRoutines: left,
				nextCursor: left === 0 ? null : (page.routines[count - 1]?.cursor ?? null),
				...(listed.some((routine) => routine.instructionsTruncated) ? { next: CUT } : {}),
			});
		};
		// Grown from one routine, so a wide page is never rendered whole.
		let count = Math.min(page.routines.length, 1);
		while (count < page.routines.length && fits(render(count + 1))) count++;
		// One routine that does not fit one result (its instructions hold up to 32 KiB): its instructions are cut, at a
		// character, to fit, and marked.
		const first = routines[0];
		const whole = typeof first?.file?.instructions === "string" ? Array.from(first.file.instructions) : null;
		if (first?.file && whole && !fits(render(count))) {
			const cut = (length: number) => {
				routines[0] = {
					...first,
					file: { ...first.file, instructions: whole.slice(0, length).join("") },
					instructionsTruncated: true,
				};
			};
			let low = 0;
			let high = whole.length;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				cut(middle);
				if (fits(render(count))) low = middle;
				else high = middle - 1;
			}
			cut(low);
		}
		return { kind: "text", value: render(count) };
	}

	/** A change, and whether the routine is now concluded (a dynamic routine's run that concluded its own owes no
	 * decision). */
	async change(
		request: CloudFolderRoutineChange,
		context: CloudToolContext,
	): Promise<{ content: CloudToolContent; concluded: boolean }> {
		const signal = context.signal;
		const { routineKey } = request;
		const path = this.path(routineKey);
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const found = await this.#folder.readText(path, COMPANY_STATE_FILE_MAX_BYTES, signal);
		let current: Current | null = null;
		if (found) {
			const { routine } = parsed(path, found.text);
			if (!routine) throw new CloudToolRefusal(UNREADABLE);
			current = { entry: found.entry, text: found.text, routine };
		}
		// How it runs now, from the index: the row of this file's routine, if it has one.
		const indexed = current
			? ((await this.#folder.agentRoutines({ routineKey }, signal)).routines.find(
					(routine) => routine.routineId === current.routine.id,
				) ?? null)
			: null;
		const unchanged = (next: string, concluded = false) => ({
			content: {
				kind: "text" as const,
				value: cloudToolJsonText({
					schema: "qorpera.agent-routine-receipt/v2",
					runId: this.#identity.runId,
					action: request.action,
					outcome: "unchanged",
					routine: indexed ? shown(indexed) : { routineKey, path },
					next,
				}),
			},
			concluded,
		});
		const platformPause = indexed?.status === "paused" && PLATFORM_PAUSES.has(indexed.pauseReason ?? "");
		let text: string;
		if (request.action === "upsert") {
			text = upsertFile(
				request,
				current?.routine.id ?? hashedId("qorpera.folder-routine/v1", this.#identity.runId, request.operationKey),
				current?.routine ?? null,
				Date.now(),
			);
			const made = parsed(path, text);
			if (!made.routine) throw new CloudToolRefusal(invalidMessage(made.problems, INVALID));
			if (current && JSON.stringify(made.routine) === JSON.stringify(current.routine))
				return unchanged(
					platformPause
						? "Nothing to change: the routine already reads like this. To switch it back on, use resume."
						: indexed?.status === "expired"
							? "Nothing to change: the routine already reads like this, and it has ended. To restart it, save it with a later end or more runs."
							: "Nothing to change: the routine already reads like this.",
				);
		} else {
			if (!current) {
				// A repeat of a saved removal finds no file.
				if (request.action === "remove")
					return unchanged("Nothing to change: there is no routine with that routineKey.");
				throw new CloudToolRefusal(MISSING);
			}
			const own = current.routine.id === this.#ownRoutineId;
			const status = current.routine.status;
			if (request.action === "pause") {
				if (own)
					throw new CloudToolRefusal(
						"This is the routine you are running: pausing it would stop this run. Conclude it instead.",
					);
				if (status === "paused") return unchanged("Nothing to change: the routine is already paused.");
				if (status === "concluded")
					throw new CloudToolRefusal("That routine is concluded: save it again (upsert) to restart it");
				text = setCompanyStateSettings(current.text, { status: "paused" });
			} else if (request.action === "resume") {
				if (status === "concluded")
					throw new CloudToolRefusal("That routine is concluded: save it again (upsert) to restart it");
				if (indexed?.status === "expired")
					throw new CloudToolRefusal(
						"That routine has ended: save it again (upsert) with a later end or more runs to restart it",
					);
				if (status === "active" && !platformPause)
					return unchanged("Nothing to change: the routine is already on.");
				// A pause in the file is lifted in the file; the platform's pause by saving the file unchanged.
				text = status === "paused" ? setCompanyStateSettings(current.text, { status: "active" }) : current.text;
			} else if (request.action === "conclude") {
				if (status === "concluded") return unchanged("Nothing to change: the routine is already concluded.", true);
				text = concludedFile(current.text, request.summary);
			} else {
				if (own)
					throw new CloudToolRefusal(
						"This is the routine you are running: removing it would stop this run. Conclude it instead.",
					);
				text = "";
			}
		}
		const actionReviewId = context.actionReviewId;
		if (!actionReviewId)
			throw new CloudToolRefusal(
				"A routine change needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
			);
		const units: CloudCompanyFolderUnit[] = [];
		// The folder core never invents a parent folder.
		if (!current && !(await this.#folder.read(this.#routines, signal)).entry)
			units.push({ op: "mkdir", path: this.#routines });
		units.push(
			request.action === "remove" && current
				? { op: "delete", path, expectedVersion: current.entry.version }
				: {
						op: "write",
						path,
						content: { text, mediaType: "text/markdown" },
						...(current ? { expectedVersion: current.entry.version } : {}),
					},
		);
		// The login that pays, last before the receipt: for the saves that start or extend work. The consent it records is
		// the requester's standing consent, so it stays if the save is then refused.
		if (request.action === "upsert" || request.action === "resume") {
			const prepared = await this.#folder.prepareRoutineLogin(signal);
			if ("refused" in prepared)
				throw new CloudToolRefusal(
					prepared.refused === "acknowledgement"
						? "This conversation needs your first reply before any work: answer the member, then call again"
						: prepared.refused === "final"
							? "This run already sent its final reply, so it starts no more work"
							: "The company's work is paused, so nothing can be saved now",
				);
			// A resume changes nothing while no login pays: the routine would wait for one all the same.
			if (request.action === "resume" && prepared.login === null)
				return unchanged(
					"Nothing was changed: no model account of the member you work for allows unattended runs yet, so the routine stays as it is. Tell the member it is a one-time account setting, then resume it again.",
				);
		}
		const content = await this.#operations.execute({
			operation: {
				tool: "manage_routine",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `routine:${request.operationKey}`,
				// The model's request as parsed (its compiled trigger included), never the defaults filled in here.
				arguments: JSON.parse(JSON.stringify(request)) as JsonValue,
				target: { path },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const staged = await this.#folder.stage(units, performSignal);
				const reviewId = await this.#folder.recordReview(
					{ actionReviewId, tool: "manage_routine", argumentSha256: context.argumentSha256 },
					staged,
					performSignal,
				);
				const committed = await this.#folder.commitStaged(
					`routine-file:${request.operationKey}`,
					staged,
					{ reviewId, receiptId },
					performSignal,
				);
				const written = committed.units.at(-1);
				if (!written) throw new Error("Company folder commit answered no unit");
				const saved = written.outcome === "saved";
				const output = cloudToolJsonText({
					schema: "qorpera.agent-routine-receipt/v2",
					runId: this.#identity.runId,
					receiptId,
					action: request.action,
					outcome: written.outcome,
					...(written.reason ? { reason: written.reason } : {}),
					...(written.problems.length ? { problems: written.problems } : {}),
					// A removed file's version is its deletion's, which shows the model nothing.
					routine: {
						routineKey,
						path,
						...(saved && request.action !== "remove" ? { version: written.version } : {}),
					},
					next: saved
						? request.action === "remove"
							? "The routine is removed, and its name is free again."
							: request.action === "upsert"
								? "Saved: tell the member what you set up or changed."
								: request.action === "conclude"
									? "Concluded: it stays listed as concluded, and saving it again restarts it."
									: request.action === "pause"
										? "Paused: it does not run until it is resumed."
										: "Switched back on."
						: written.outcome === "conflict"
							? "The routine's file changed since it was read: list it and call again with a new operationKey."
							: written.outcome === "waiting_for_review"
								? "The change waits for a member's approval: do not make it again; tell the member it is waiting for them."
								: "Nothing was saved: say why to the member, or correct the arguments and call again with a new operationKey.",
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
		const value = JSON.parse(content.kind === "text" ? content.value : "{}") as Record<string, unknown>;
		const concluded = request.action === "conclude" && value.outcome === "saved";
		if (value.outcome !== "saved" || request.action === "remove") return { content, concluded };
		// How it runs now, read back after the receipt, best effort: a failed read never turns a saved change into an error.
		const now = await this.#folder
			.agentRoutines({ routineKey }, signal)
			.then((page) => page.routines[0] ?? null)
			.catch(() => undefined);
		return {
			content: {
				kind: "text",
				value: cloudToolJsonText({
					...value,
					...(now ? { routine: shown(now) } : {}),
					next:
						now === undefined
							? "Saved. List it (manage_routine list with this routineKey) to see how it runs now."
							: ((now && waiting(now)) ?? value.next),
				}),
			},
			concluded,
		};
	}
}
