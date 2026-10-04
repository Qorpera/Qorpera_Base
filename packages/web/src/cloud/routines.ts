import {
	type CloudMemberFolderCommit,
	CloudMemberFolderError,
	type CloudMemberFolderUnit,
	type CloudMemberFolderUnitResult,
} from "@qorpera/cloud-client/cloud-member-folder";
import {
	cloudRoutineTriggerOfFile,
	routineFileSettings,
	routineFileTrigger,
} from "@qorpera/cloud-client/cloud-routine-file";
import {
	type CloudRoutine,
	CloudRoutineClient,
	type CloudRoutineOccurrence,
	type CloudRoutineTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import {
	type CompanyStateEffort,
	companyStatePath,
	freeCompanyStateName,
	type RoutineFile,
	type RoutineTrigger,
	setCompanyStateSettings,
	writeRoutineFile,
} from "@qorpera/cloud-client/company-state-files";
import type { Cloud } from "./client.ts";
import {
	folderNames,
	invalid,
	parentPath,
	parseStateFile,
	readStateFile,
	rewriteStateFile,
	unsaved,
	type WebMemberFolder,
	withStateBody,
} from "./company-folder-writes.ts";
import { planLogin, type WebMemberConnection } from "./native-subscription.ts";
import { UUID_PATTERN } from "./parse.ts";
import type { HostedProfile } from "./types.ts";

/*
 * A routine is a file, `agents/<handle>/routines/<key>.md` (folder core C4, P34r;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §6): every company is folder-v2, so a member's new routine,
 * edit, pause and resume write that file through the member commit route, as the member. The list and the runs still
 * come from the routine index. The file does not say who pays: before a save that needs a login (a new routine, a
 * resume, an edit of what a run pins), the member's account gets today's consent and binding, and the core takes the
 * routine's own login when it still pays for this member, else the member's newest one that pays for unattended work.
 */

/** A ChatGPT plan never pays for a file-change or webhook routine (the kernel refuses it too). */
const LISTENER_ON_PLAN = "A ChatGPT plan can't pay for routines that start on a file change or a webhook.";
/** The plain message when a routine's file is not saved. */
const NOT_SAVED = "The routine could not be saved.";
/** Tries of a new routine's file whose name another writer took since the listing. */
const CREATE_TRIES = 3;
/** Retries of an edit whose file changed between its read and the commit. */
const RETRIES = 3;

export interface WebRoutineDraft {
	/** The routine file's id: a new routine's comes from the view, one per draft, so a retry is the same routine. */
	clientRoutineId: string;
	staffAgentId: string;
	title: string;
	prompt: string;
	/** Every N minutes, or days at a time; no `replyPolicy` is `required`. */
	trigger: CloudRoutineTrigger;
	/** A new routine's. An edit keeps the file's own (an agent may have chosen medium or high). */
	effort: CompanyStateEffort;
	/** The routine's file as the editor opened it; none for a new routine. */
	opened?: WebRoutineFile;
}

/** A routine's file as one read found it: what the editor shows, and the version an edit of it names. */
export interface WebRoutineFile {
	readonly routineId: string;
	readonly path: string;
	readonly version: string;
	readonly text: string;
	readonly file: RoutineFile;
	/** The file's trigger as the editor shows it; none for one a member's editor does not make (a time window, a
	 * dynamic routine's next run, a file change). */
	readonly trigger?: CloudRoutineTrigger;
}

/** A routine with what the web reads beside the SDK's fields (migration 20260929970000): why a paused
 * routine waits, and the member its current version runs for. */
export type WebRoutine = CloudRoutine & {
	pauseReason?: string;
	runsForUserId?: string;
	/** The current version is a resume (20260929985000): `plan_turned_on` when its member turned on work while
	 * away for the ChatGPT plan that pays. */
	resumeReason?: string;
	resumedAt?: string;
	resumedByUserId?: string;
};

export interface WebRoutines {
	list(): Promise<WebRoutine[]>;
	runs(): Promise<CloudRoutineOccurrence[]>;
	/** The routines whose file this member finds, by routine id. One without is read-only (no switch, no Edit): its
	 * file is out of the member's reach or from before the files, or the cloud does not list routines' files yet. */
	files(): Promise<ReadonlySet<string>>;
	/** Reads a routine's file for the editor. */
	open(routine: CloudRoutine): Promise<WebRoutineFile>;
	/** Writes a new routine's file, or an edit of one. `saveId` is the editor's: a request whose answer never came is
	 * sent again as it was by the next save with the same id, and only an answer frees it. "unchanged" when an edit
	 * changes nothing: nothing is written, since an unchanged save would resume a routine the platform paused. */
	save(
		draft: WebRoutineDraft,
		account: WebMemberConnection | undefined,
		saveId: string,
	): Promise<"saved" | "unchanged">;
	/** Pauses or resumes, changing nothing else. A resume is paid by `account`; a pause needs no login. */
	setEnabled(
		routine: CloudRoutine,
		account: WebMemberConnection | undefined,
		enabled: boolean,
		saveId: string,
	): Promise<void>;
}

/** The routine has no file this member can change, or its file is gone: nothing was written. */
export class WebRoutineGoneError extends Error {}
/** What the editor shows of the routine changed since it was opened: nothing was written; open it again. */
export class WebRoutineChangedError extends Error {}
/** The routine has ended (concluded, or expired): nothing was written; the list says so. */
export class WebRoutineEndedError extends Error {}
/** The save needs a login and was given no account that can pay: nothing was written. */
export class WebRoutineNoPayerError extends Error {}

/** A Claude login is for coding only: it never pays for an agent's routines. */
export function claudeLogin(account: WebMemberConnection): boolean {
	return account.provider === "anthropic" || account.nativeHarness === "claude-code";
}

/** Whether an account can pay for a routine's runs: never a Claude login, and a ChatGPT plan only once its member
 * turned on work while away, and never for a routine that starts on a file change or a webhook. */
export function canPayForRoutine(account: WebMemberConnection, listening = false): boolean {
	return !claudeLogin(account) && (!planLogin(account) || (account.allowAutonomous === true && !listening));
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cloud response");
	return value as Record<string, unknown>;
}

/** One sponsor per account version: saving again reuses it instead of piling up. */
async function sponsorKey(connectionId: string, version: number): Promise<string> {
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`qorpera.routine-sponsor/v1:${connectionId}:${version}`),
		),
	).slice(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x80;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The gateway refused the change set before the core saw it (a malformed request, the member's access, a company
 * paused or being deleted): nothing was written. A lock conflict (409), the member's change set in flight (429), an
 * outage or no answer at all may have left it written, or may yet. */
function refusedBeforeCommit(error: unknown): boolean {
	const status = error instanceof CloudMemberFolderError ? error.status : null;
	return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

/** What the editor shows of a routine's file. A version_changed is retried only while these are as the form had them. */
function editorFields(file: RoutineFile): string {
	return JSON.stringify([file.title, file.trigger, file.timezone, file.reply, file.instructions]);
}

/** What a draft makes of the editor's fields in a file. */
interface RoutineEdit {
	readonly title: string;
	readonly trigger: RoutineTrigger;
	readonly timezone: string | null;
	readonly reply: RoutineFile["reply"];
	readonly instructions: string;
}

function editOf(draft: WebRoutineDraft, file: RoutineFile | null): RoutineEdit {
	const mapped = routineFileTrigger(draft.trigger);
	if (!mapped) throw new Error("A member's routine runs every few minutes or on chosen days.");
	let trigger = mapped.trigger;
	// The same days in another order are no change: the file keeps its own order.
	const before = file?.trigger;
	if (
		trigger.when === "weekly" &&
		before?.when === "weekly" &&
		trigger.days.length === before.days.length &&
		trigger.days.every((day) => before.days.includes(day))
	)
		trigger = { ...trigger, days: before.days };
	return {
		title: draft.title.trim(),
		trigger,
		timezone: mapped.timezone,
		reply: draft.trigger.replyPolicy ?? "required",
		instructions: draft.prompt.trim(),
	};
}

/** An edit of a routine file's text: the settings the edit changes (`setCompanyStateSettings`) and the body when the
 * instructions changed. Effort, the end, the runs, quiet hours, notes and every other byte stay as read. */
function rewriteRoutine(text: string, file: RoutineFile, edit: RoutineEdit): string {
	const settings = routineFileSettings(file, edit);
	const next = Object.keys(settings).length ? setCompanyStateSettings(text, settings) : text;
	return edit.instructions === file.instructions ? next : withStateBody(next, edit.instructions);
}

/** A routine file as this save knows it: the one the editor opened, or one this save wrote (found by its path). */
interface RoutineBase {
	readonly routineId: string | null;
	readonly path: string;
	readonly version: string;
	readonly text: string;
	readonly file: RoutineFile;
}

/** A change set sent whose answer has not come back. */
interface PendingSave {
	readonly key: string;
	readonly units: readonly CloudMemberFolderUnit[];
	/** The draft it was made from, and the routine file it writes. */
	readonly draft: string;
	readonly path: string;
}

interface SaveState {
	base: RoutineBase | null;
	pending: PendingSave | null;
}

const drafted = (draft: WebRoutineDraft) =>
	JSON.stringify([draft.staffAgentId, draft.title, draft.prompt, draft.trigger, draft.effort]);

export function createWebRoutines(
	cloud: Cloud,
	profile: HostedProfile,
	signal: AbortSignal,
	current: () => void,
	/** The member's own client for the company's folder (P27, P34a). */
	memberFolder: () => WebMemberFolder,
): WebRoutines {
	const check = () => {
		signal.throwIfAborted();
		current();
	};
	const rpc = async (name: string, args: Record<string, unknown>) => {
		check();
		const value = await cloud.rpc(name, args);
		check();
		return value;
	};
	const client = new CloudRoutineClient((name, args) => rpc(name, args));
	const folder = () => {
		check();
		return memberFolder();
	};
	/** Today's idempotent consent and binding, so the account has a binding in this company that pays for unattended
	 * work. A ChatGPT plan is never consented here: its member turns on work while away in Settings. */
	const sponsor = async (account: WebMemberConnection) => {
		if (claudeLogin(account)) throw new Error("A Claude login can't pay for routines.");
		if (account.connectionStatus !== "active" || account.authorizationState !== "active")
			throw new Error("This model account needs to be signed in again.");
		let version: number;
		if (planLogin(account)) {
			// A ChatGPT plan works while its member is away only once they turned that on in Settings;
			// saving a routine never turns it on for them.
			if (account.allowAutonomous !== true)
				throw new Error("Turn on “Work while you're away” for this ChatGPT plan in Settings first.");
			version = account.connectionVersion;
		} else {
			const consent = record(
				await rpc("qorpera_consent_provider_connection_autonomous", {
					p_profile_id: profile.profileId,
					p_connection_id: account.connectionId,
					p_allow_autonomous: true,
				}),
			);
			if (
				consent.connection_id !== account.connectionId ||
				consent.allow_autonomous !== true ||
				!Number.isSafeInteger(consent.version)
			)
				throw new Error("Invalid cloud response");
			version = consent.version as number;
		}
		const bound = record(
			await rpc("qorpera_create_member_execution_sponsor", {
				p_profile_id: profile.profileId,
				p_client_binding_id: await sponsorKey(account.connectionId, version),
				p_provider_connection_id: account.connectionId,
				p_provider_connection_version: version,
				p_allow_autonomous: true,
			}),
		);
		if (typeof bound.binding_id !== "string" || !Number.isSafeInteger(bound.version))
			throw new Error("Invalid cloud response");
	};
	/** The login a save needs, once per call, and only once it is known to write. */
	const payer = (account: WebMemberConnection | undefined) => {
		let paid: Promise<void> | undefined;
		return async () => {
			if (!account) throw new WebRoutineNoPayerError("Choose a model account that can pay for this routine.");
			paid ??= sponsor(account);
			await paid;
		};
	};
	const list = async () => {
		// The SDK reads the fields it knows; these come from the same answer.
		let answer: unknown;
		const listed = await new CloudRoutineClient(async (name, args) => {
			const value = await rpc(name, args);
			if (name === "qorpera_list_cloud_routines") answer = value;
			return value;
		}).list(profile.environmentId, signal);
		const rows = Array.isArray(answer) ? (answer as unknown[]) : [];
		return listed.map((routine): WebRoutine => {
			const row = rows.find(
				(item): item is Record<string, unknown> =>
					Boolean(item) &&
					typeof item === "object" &&
					(item as Record<string, unknown>).routine_id === routine.routineId,
			);
			const reason = row?.pause_reason;
			const member = row?.runs_for_user_id;
			const resumed = row?.resume_reason;
			const resumedAt = row?.resumed_at;
			const resumedBy = row?.resumed_by_user_id;
			return {
				...routine,
				...(typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? { pauseReason: reason } : {}),
				...(typeof member === "string" && UUID_PATTERN.test(member) ? { runsForUserId: member } : {}),
				...(typeof resumed === "string" &&
				/^[a-z_]{1,64}$/.test(resumed) &&
				typeof resumedAt === "string" &&
				Number.isFinite(Date.parse(resumedAt)) &&
				typeof resumedBy === "string" &&
				UUID_PATTERN.test(resumedBy)
					? { resumeReason: resumed, resumedAt, resumedByUserId: resumedBy }
					: {}),
			};
		});
	};
	/** A routine's file from the member's state folders (by the index's routine id). */
	const routinePath = async (from: WebMemberFolder, routineId: string): Promise<string> => {
		const listed = (await from.stateFolders(signal)).routines;
		check();
		const path = listed?.find((item) => item.routineId === routineId)?.file;
		if (!path || companyStatePath(path)?.kind !== "routine")
			throw new WebRoutineGoneError("This routine has no file you can change.");
		return path;
	};
	/** A routine file's text, version and parse; null when nothing is at the path. */
	const readRoutine = async (
		from: WebMemberFolder,
		path: string,
		routineId: string | null,
		id: string,
	): Promise<RoutineBase | null> => {
		const read = await readStateFile(from, path, signal);
		check();
		if (!read) return null;
		const parsed = parseStateFile(path, read.text);
		if (!parsed.ok || parsed.file.kind !== "routine" || parsed.file.id !== id)
			throw new WebRoutineChangedError("This routine's file has changed.");
		return { routineId, path, version: read.entry.version, text: read.text, file: parsed.file };
	};
	/** The file again after a version_changed: its new version, while what the form shows is as it opened. */
	const reread = async (from: WebMemberFolder, known: RoutineBase, opened: string): Promise<RoutineBase> => {
		const path = known.routineId === null ? known.path : await routinePath(from, known.routineId);
		const read = await readRoutine(from, path, known.routineId, known.file.id);
		if (!read) throw new WebRoutineGoneError("This routine is no longer available.");
		// A change to what the form shows is the member's to see before anything is written over it.
		if (editorFields(read.file) !== opened)
			throw new WebRoutineChangedError("This routine changed while you were editing it.");
		return read;
	};
	const saves = new Map<string, SaveState>();
	/** Sends a change set, kept as the save's pending one until an answer comes. */
	const send = async (
		from: WebMemberFolder,
		state: SaveState,
		pending: PendingSave,
	): Promise<readonly CloudMemberFolderUnitResult[]> => {
		state.pending = pending;
		let answer: CloudMemberFolderCommit;
		try {
			answer = await from.commit(pending.key, pending.units, signal);
		} catch (error) {
			if (refusedBeforeCommit(error)) state.pending = null;
			throw error;
		}
		state.pending = null;
		check();
		return answer.units;
	};
	/** A new routine's file: `agents/<handle>/routines/<key>.md`, its key from the title, free in the member's listing.
	 * The routines folder comes first in the same change set when it is missing. */
	const createFile = async (
		from: WebMemberFolder,
		state: SaveState,
		draft: WebRoutineDraft,
		login: () => Promise<void>,
	): Promise<"saved"> => {
		const fields = editOf(draft, null);
		const text = writeRoutineFile({
			id: draft.clientRoutineId,
			title: fields.title,
			status: "active",
			trigger: fields.trigger,
			timezone: fields.timezone,
			ends: null,
			runs: null,
			quiet: null,
			effort: draft.effort,
			reply: fields.reply,
			conclusion: null,
			instructions: fields.instructions,
		});
		const tried = new Set<string>();
		for (let attempt = 1; ; attempt++) {
			const agent = (await from.stateFolders(signal)).agents.find(
				(item) => item.staffAgentId === draft.staffAgentId,
			)?.file;
			check();
			if (!agent || companyStatePath(agent)?.kind !== "agent")
				throw new WebRoutineGoneError("This agent's folder is not available.");
			const routines = `${parentPath(agent)}/routines`;
			const listed = await from.read(routines, signal);
			check();
			if (listed.entry && listed.entry.kind !== "folder") throw new Error(`${routines} is not a folder`);
			const taken = new Set(tried);
			if (listed.entry)
				for (const name of await folderNames(from, routines, signal))
					if (name.endsWith(".md")) taken.add(name.slice(0, -3));
			check();
			const key = freeCompanyStateName(fields.title, "routine", taken);
			const path = `${routines}/${key}.md`;
			const parsed = parseStateFile(path, text);
			if (!parsed.ok) throw invalid(NOT_SAVED, parsed.problems);
			await login();
			const units: CloudMemberFolderUnit[] = [
				...(listed.entry ? [] : [{ op: "mkdir" as const, path: routines }]),
				{ op: "write", path, text },
			];
			const results = await send(from, state, {
				key: `web:routine-create:${crypto.randomUUID()}`,
				units,
				draft: drafted(draft),
				path,
			});
			const write = results.at(-1)!;
			const made = listed.entry ? null : results[0]!;
			if (write.outcome === "saved") return "saved";
			if (write.outcome === "conflict" && write.reason === "exists") {
				// The file there with this draft's id is this routine, saved by a try whose answer was lost.
				const there = await readStateFile(from, path, signal);
				check();
				const found = there ? parseStateFile(path, there.text) : null;
				if (found?.ok && found.file.kind === "routine" && found.file.id === draft.clientRoutineId) return "saved";
				if (attempt < CREATE_TRIES) {
					tried.add(key);
					continue;
				}
			} else if (made?.outcome === "conflict" && made.reason === "exists" && attempt < CREATE_TRIES)
				// Another writer made the routines folder since the read: read again, and write without it.
				continue;
			throw unsaved(made && made.outcome !== "saved" && write.reason === "parent_missing" ? made : write, NOT_SAVED);
		}
	};
	/** An edit of a routine's file from what this save knows of it. */
	const editFile = async (
		from: WebMemberFolder,
		state: SaveState,
		base: RoutineBase,
		draft: WebRoutineDraft,
		login: () => Promise<void>,
	): Promise<"saved" | "unchanged"> => {
		const opened = editorFields(base.file);
		let known = base;
		for (let attempt = 0; ; attempt++) {
			const text = rewriteRoutine(known.text, known.file, editOf(draft, known.file));
			const parsed = parseStateFile(known.path, text);
			if (!parsed.ok) throw invalid(NOT_SAVED, parsed.problems);
			if (JSON.stringify(parsed.file) === JSON.stringify(known.file)) return attempt ? "saved" : "unchanged";
			await login();
			const [result] = await send(from, state, {
				key: `web:routine-update:${crypto.randomUUID()}`,
				units: [{ op: "write", path: known.path, text, expectedVersion: known.version }],
				draft: drafted(draft),
				path: known.path,
			});
			if (result!.outcome === "saved") return "saved";
			if (result!.outcome === "conflict" && result!.reason === "version_changed" && attempt < RETRIES) {
				state.base = known = await reread(from, known, opened);
				continue;
			}
			throw unsaved(result!, NOT_SAVED);
		}
	};
	return {
		list,
		runs: () => client.occurrences(profile.environmentId, signal, 200),
		async files() {
			const listed = (await folder().stateFolders(signal)).routines;
			check();
			return new Set((listed ?? []).map((item) => item.routineId));
		},
		async open(routine) {
			const from = folder();
			const path = await routinePath(from, routine.routineId);
			const read = await readRoutine(from, path, routine.routineId, routine.clientRoutineId);
			if (!read) throw new WebRoutineGoneError("This routine is no longer available.");
			const when = read.file.trigger.when;
			const trigger = when === "every" || when === "weekly" ? cloudRoutineTriggerOfFile(read.file) : null;
			return { ...read, routineId: routine.routineId, ...(trigger ? { trigger } : {}) };
		},
		async save(draft, account, saveId) {
			const from = folder();
			const state = saves.get(saveId) ?? { base: draft.opened ?? null, pending: null };
			saves.set(saveId, state);
			const login = payer(account);
			// A change set whose answer never came goes again first, as it was: a replay when it was saved.
			const lost = state.pending;
			if (lost) {
				await login();
				const results = await send(from, state, lost);
				const write = results.at(-1)!;
				if (write.outcome === "saved") {
					if (lost.draft === drafted(draft)) {
						saves.delete(saveId);
						return "saved";
					}
					// The draft changed since: the file as that change set wrote it is what this edit starts from.
					const written = await readRoutine(
						from,
						lost.path,
						state.base?.routineId ?? null,
						state.base?.file.id ?? draft.clientRoutineId,
					);
					if (!written) throw new WebRoutineGoneError("This routine is no longer available.");
					state.base = written;
				} else if (write.outcome === "conflict" && write.reason === "version_changed" && state.base)
					state.base = await reread(from, state.base, editorFields(state.base.file));
				else if (write.outcome !== "conflict") {
					// Refused or denied: nothing was written, and the same draft would be refused again.
					const made = results.length > 1 ? results[0]! : null;
					throw unsaved(
						made && made.outcome !== "saved" && write.reason === "parent_missing" ? made : write,
						NOT_SAVED,
					);
				}
				// Any other conflict (a name taken, a folder made meanwhile) is the steps' own, from a new read.
			}
			const result = state.base
				? await editFile(from, state, state.base, draft, login)
				: await createFile(from, state, draft, login);
			saves.delete(saveId);
			return result;
		},
		async setEnabled(routine, account, enabled, saveId) {
			const from = folder();
			// A routine without a file this member can change stops here, before any login.
			const path = await routinePath(from, routine.routineId);
			if (enabled) {
				if (!account) throw new WebRoutineNoPayerError("Choose a model account that can pay for this routine.");
				if (planLogin(account) && routine.triggers.some((item) => item.kind === "listener"))
					throw new Error(LISTENER_ON_PLAN);
				await sponsor(account);
			}
			let tries = 0;
			await rewriteStateFile(
				from,
				{
					locate: async () => {
						if (tries++ === 0) return path;
						// The file changed under the switch: a routine that ended meanwhile stays as it is.
						const row = (await list()).find((item) => item.routineId === routine.routineId);
						if (!row || row.status === "expired" || row.status === "concluded" || row.status === "retired")
							throw new WebRoutineEndedError("This routine has ended.");
						return routinePath(from, routine.routineId);
					},
					rewrite: (text, at) => {
						const parsed = parseStateFile(at, text);
						if (!parsed.ok || parsed.file.kind !== "routine" || parsed.file.id !== routine.clientRoutineId)
							throw new WebRoutineChangedError("This routine's file has changed.");
						if (parsed.file.status === "concluded") throw new WebRoutineEndedError("This routine has ended.");
						if (!enabled)
							return parsed.file.status === "paused"
								? null
								: setCompanyStateSettings(text, { status: "paused" });
						// An active file saved as it is ends a pause the platform recorded in the index only, and pays,
						// as the runtime's manage_routine does.
						return parsed.file.status === "active" ? text : setCompanyStateSettings(text, { status: "active" });
					},
					key: () => `web:routine-${enabled ? "resume" : "pause"}:${saveId}:${tries}`,
					gone: "This routine is no longer available.",
					failure: enabled ? "The routine could not be resumed." : "The routine could not be paused.",
				},
				signal,
				check,
			);
		},
	};
}
