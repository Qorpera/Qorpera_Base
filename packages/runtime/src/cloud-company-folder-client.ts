import { createHash, randomInt } from "node:crypto";
import { parseCloudCompanyInnerPath, parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import {
	COMPANY_STATE_PARSER_VERSION,
	type CompanyStateProblem,
	companyStatePath,
	parseCompanyStateFile,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudFileReference } from "@qorpera/cloud-client/node/cloud-object-store";
import type { CloudCodingRepository } from "@qorpera/contracts";
import {
	type CloudCompanyPathControl,
	CloudCompanyPathNotText,
	type CloudCompanyPathRpc,
} from "./cloud-company-path-gateway.ts";
import { CloudCompanyFolderRpcError } from "./cloud-company-path-refusal.ts";
import { type EventHookAnswer, type EventHookCreate, isEventHookRefusal } from "./cloud-event-hook-vault.ts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	cloudToolRequest,
	parseCloudNativeToolBinding,
} from "./cloud-native-tool-authority.ts";
import { recordCloudRunLogRelease } from "./cloud-run-log.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/*
 * A run's client of the company folder core, for folder-v2 companies (RUNTIME-COMPANY-FOLDER-CORE.md §11 C3; the shape
 * F1 reviewed on #533, 2026-09-29). It reads, lists, commits change sets and records releases over the core's four
 * entry points, as the run: `{kind:'run', runId, jobId, runnerId, assignmentId}` from its binding. It passes no fence
 * and holds no lock between calls: reads and listings take SQL's plain checks, and a commit or a release runs SQL's run
 * check (the stop, the job and the fence at KEY SHARE, the run's principals and its wake).
 *
 * Nothing uses it yet. Its writers go live once core C1c-2b gives a tool call its folder receipt (the gate a commit
 * then carries) and core C1d lets a folder-v2 run move bytes (upload intents, and a byte check that never locks the
 * company row); until then the object store refuses a folder-v2 run's uploads and downloads (C1c-1).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
/** The commit's rule for an operation key (C1B §4: unique within the run). */
const OPERATION_KEY = /^[A-Za-z0-9._:-]{8,200}$/;
/** The core's media type rule for a stored file. */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;
/** The commit's bound on units in one change set. */
const MAX_UNITS = 1000;
/** One listing page. SQL accepts up to 1000. An entry with its receipt is about 550 bytes plus its path (at most
 * 4096, twice that escaped) and a link's target (at most 4095, six times that escaped): about 33 KB, so 200 fit the
 * control's 8 MiB bound for listings. */
const LIST_PAGE = 200;
/** A release names at most this many reads (SQL's bound). */
const MAX_RELEASED = 10_000;
/** Tries of one commit or release that met a retryable error: the same operation key or release id each time. */
const ATTEMPTS = 4;
/** Retried with the same key (F1, #533): an authority change after the commit decided (QRC01), a deadlock, a
 * parallel change set that took an index row first (the structured hook's 23505; the retry's decide refuses the unit),
 * and a path claim that gave up waiting (55P03). A release retries the first two with the same id. */
const COMMIT_RETRY = new Set(["QRC01", "40P01", "23505", "55P03"]);
const RELEASE_RETRY = new Set(["QRC01", "40P01"]);
/** A review recording is retried when its answer was lost or it met a deadlock: a replay of the same change set returns
 * the record. 23505 (the approval stands for another change set) and 42501 are answers. */
const RECORD_RETRY = new Set(["40P01"]);
/** One try of a signed hook's creation through the secret broker: its 15 s, which hold the broker's 12 s. */
const SIGNED_HOOK_MS = 20_000;
/** The run effects called with exactly the arguments given (the run's binding), not as the folder actor. */
const RUN_EFFECTS: ReadonlySet<CloudCompanyPathRpc> = new Set([
	"qorpera_folder_record_review",
	"qorpera_prepare_routine_login",
	"qorpera_folder_cancel_agent_worker",
	"qorpera_folder_close_proposal",
	"qorpera_folder_manage_hook",
	"qorpera_folder_archive_coding_worker",
	"qorpera_folder_note_interface_changes",
]);
/** SQL's refusal (55000) of an archive or a cancel by the run that was asked about a quiet coding session, once the
 * session has a new turn (`qorpera_coding_question_stale`). */
export const CODING_QUESTION_STALE = "The session has a new turn since you were asked; leave it";
/** A coding session's archive refusals, by SQL's message, with their SQLSTATE (C3b). */
export const CODING_ARCHIVE_REFUSALS: ReadonlyMap<string, string> = new Map([
	["Only a coding session can be archived", "22023"],
	[CODING_QUESTION_STALE, "55000"],
]);
/** The answers of `qorpera_folder_manage_hook` (E3a, 20260930106000) and of the secret broker's signed path (E3b,
 * 20260930160000) the model reads, by SQLSTATE and SQL's message, in the model's words: the request's rules, the
 * company's state, the run's authority and the wake's refusals. Each is raised in the call's one transaction, so that
 * call changed nothing. Any other error is a failure. */
export const CLOUD_HOOK_REFUSALS: ReadonlyMap<string, string> = new Map([
	...(
		[
			[
				"22023",
				"A hook name uses lowercase letters, digits and hyphens, starts with a letter and has at most 64 characters",
			],
			["22023", "A hook needs a purpose of one line, 1 to 512 characters"],
			["22023", "A hook body limit is between 1 KiB and 256 KiB"],
			["22023", "A hook accepts between 1 and 120 deliveries a minute"],
			["22023", "Only a signed hook names the site its secret is typed into"],
			["22023", "An HMAC hook names the site its secret is typed into"],
			["22023", "A site is a host name such as github.com"],
			["22023", "A Stripe hook's secret is taken from dashboard.stripe.com"],
			["22023", "A mailbox name is 1 to 64 lowercase letters, digits, dots, hyphens and underscores"],
			["22023", "This mailbox name is reserved"],
			["22023", "A mailbox name that reads as Qorpera is reserved"],
			["22023", "A mailbox purpose is one line of at most 512 characters"],
			["0A000", "Company mail is not set up yet"],
			["P0002", "No hook has this name"],
			["55000", "This hook was removed"],
			["55000", "A run this hook woke cannot remove it; pause it instead"],
			["54000", "A company has at most 20 mailboxes"],
			["54000", "A company has at most 50 hooks"],
			["23505", "This address is taken"],
			["23505", "A hook with this name already exists"],
			["42501", "Only owners and admins can open hooks; ask one of them"],
		] as const
	).map(([code, message]) => [`${code} ${message}`, message] as const),
	// The run receipt's: the key names an earlier, different request of this run.
	[
		"23505 logical operation key is already bound to other work",
		"That operationKey was used for a different request: use a new one",
	],
	["42501 Hook authority is unavailable", "Only an agent's own run opens or changes hooks, never a worker's"],
	[
		"55000 Wake requires an acknowledgement before work",
		"This conversation needs your first reply before any work: answer the member, then call again",
	],
	["55000 Wake public output is already final", "This run already sent its final reply, so it starts no more work"],
	["55000 Company execution is paused", "The company's work is paused, so nothing can be changed now"],
]);
/** A hook as `qorpera_event_hook_descriptor` gives it (E1 and the signed hooks' secret), and, in a creation's answer, its
 * address, path and URL. */
const HOOK_KEYS = [
	"schema",
	"id",
	"companyId",
	"environmentId",
	"name",
	"purpose",
	"proof",
	"status",
	"maxBodyBytes",
	"perMinute",
	"createdAt",
] as const;
const HOOK_OPTIONAL = ["email", "lastReceivedAt", "signingSecret", "address", "path", "url"] as const;
const HOOK_STATUS = { create: "active", pause: "paused", resume: "active", remove: "removed" } as const;
/** The recorder's answer for a proposal that is no longer open for the run (P40a): an answer, not a defect. */
const PROPOSAL_NOT_OPEN = "This proposal is not open for this run";
const PROPOSAL_STATUSES = ["applied", "not_applied", "declined", "discarded"] as const;
/** The wake's refusals of work (`qorpera_assert_wake_work_allowed`), by SQL's message. */
const WAKE_REFUSALS: ReadonlyMap<string, "acknowledgement" | "final" | "paused"> = new Map([
	["Wake requires an acknowledgement before work", "acknowledgement"],
	["Wake public output is already final", "final"],
	["Company execution is paused", "paused"],
]);
const ROUTINE_STATUSES = ["active", "paused", "concluded", "expired", "retired"] as const;
const ROUTINE_KEYS = [
	"routineKey",
	"routineId",
	"version",
	"status",
	"pauseReason",
	"title",
	"trigger",
	"effort",
	"expiresAt",
	"maxOccurrences",
	"quietHours",
	"occurrences",
	"nextRunAt",
	"conclusion",
	"concludedAt",
	"path",
	"folderVersion",
	"cursor",
	"file",
] as const;
/** The recheck's refusals in commit and release: the model saw something it may no longer see. */
const READ_REVOKED = new Set(["A read is no longer readable", "A released read is no longer readable"]);

export interface CloudCompanyFolderRunActor {
	readonly kind: "run";
	readonly runId: string;
	readonly jobId: string;
	readonly runnerId: string;
	readonly assignmentId: string;
}

/** The authority an entry was read under, as a receipt for a release (C1B §C1b-2 3). The grant is null only on
 * `rules/`, which every agent reads by its scope. */
export interface CloudCompanyFolderAuthority {
	readonly resourceId: string;
	readonly resourceRevision: number;
	readonly grantId: string | null;
	readonly grantRevision: number | null;
}

export interface CloudCompanyFolderFile {
	readonly manifestSha256: string;
	readonly fileSha256: string;
	readonly bytes: number;
	readonly mediaType: string;
	readonly executable: boolean;
}

interface CloudCompanyFolderEntryBase {
	readonly path: string;
	readonly version: string;
	/** The change set that last wrote it. */
	readonly seq: number;
	readonly updatedAt: string;
	readonly authority: CloudCompanyFolderAuthority;
}

/** A link (`symlink`, made through a view, LK1) holds its target exactly as written: 1 to 4,095 bytes naming any path,
 * which the folder never follows. Nothing is below a link. */
export type CloudCompanyFolderEntry =
	| (CloudCompanyFolderEntryBase & { readonly kind: "file"; readonly file: CloudCompanyFolderFile })
	| (CloudCompanyFolderEntryBase & { readonly kind: "folder" })
	| (CloudCompanyFolderEntryBase & { readonly kind: "symlink"; readonly target: string });

export type CloudCompanyFolderFileEntry = Extract<CloudCompanyFolderEntry, { kind: "file" }>;

/** A todo as the todo index lists it (`agentTodos`): the start of its detail, and its file. */
export interface CloudCompanyFolderTodo {
	readonly todoKey: string;
	readonly title: string;
	readonly state: "open" | "blocked" | "done" | "cancelled";
	readonly detail: string;
	readonly detailTruncated?: true;
	readonly path: string;
	readonly version: string;
	readonly updatedAt: string;
	readonly cursor: string;
}

export interface CloudCompanyFolderTodoPage {
	readonly todos: readonly CloudCompanyFolderTodo[];
	/** How many more match after this page; `nextCursor` (the last todo's cursor) continues it. */
	readonly moreTodos: number;
	readonly nextCursor: string | null;
}

/** A routine as the routine index lists it (`agentRoutines`, thin writers W4c): how it runs now (the index's status
 * and the platform's pause reason, the next run, the runs used) and what its file says (`file`, the file's parse; on
 * a page its instructions are cut to 200 characters). */
export interface CloudCompanyFolderRoutine {
	readonly routineKey: string;
	readonly routineId: string;
	readonly status: "active" | "paused" | "concluded" | "expired" | "retired";
	readonly pauseReason: string | null;
	readonly nextRunAt: string | null;
	readonly occurrences: number;
	readonly path: string;
	readonly folderVersion: string;
	readonly file: Readonly<Record<string, unknown>> | null;
	readonly instructionsTruncated?: true;
	readonly cursor: string;
}

export interface CloudCompanyFolderRoutinePage {
	readonly routines: readonly CloudCompanyFolderRoutine[];
	/** How many more there are after this page; `nextCursor` (the last routine's cursor) continues it. */
	readonly moreRoutines: number;
	readonly nextCursor: string | null;
}

/** One unit of an open proposal as its run's list shows it (P40, `qorpera_folder_agent_proposals`): the op, its path (a
 * move's or copy's source) and target, a new folder's item count and items (each path and kind, P40b), and the
 * structured files it writes with their parses (SQL leaves out a parse's null fields). */
export interface CloudCompanyFolderProposalUnit {
	readonly unit: number;
	readonly op: CloudCompanyFolderOp;
	readonly path: string;
	readonly to: string | null;
	readonly items: number | null;
	/** A link's item carries its target. */
	readonly contains: readonly {
		readonly path: string;
		readonly kind: "file" | "folder" | "symlink";
		readonly target?: string;
	}[];
	readonly structured: readonly {
		readonly path: string;
		readonly kind: string;
		readonly parse: Readonly<Record<string, unknown>>;
	}[];
}

/** A change set the agent saved through a view (a computer, a shell command, a coding session) that needed review, parked
 * until it is applied, declined or discarded (P40a): its first 50 units, and whether it makes an agent. */
export interface CloudCompanyFolderProposal {
	readonly proposalId: string;
	readonly createdAt: string;
	readonly viewKind: string;
	readonly effect: "delegation" | "destructive";
	readonly createsAgent: boolean;
	readonly unitCount: number;
	readonly units: readonly CloudCompanyFolderProposalUnit[];
	readonly moreUnits: number;
	/** Every path it names, as the run releases them with the context that shows them (P40b): a revoked grant then
	 * fences the run as for any read. */
	readonly reads: readonly CloudCompanyFolderRelease[];
}

export interface CloudCompanyFolderProposalPage {
	readonly proposals: readonly CloudCompanyFolderProposal[];
	/** How many more there are after this page; `nextCursor` (the last proposal's id) continues it. */
	readonly moreProposals: number;
	readonly nextCursor: string | null;
}

/** The login that pays a run's routine (`prepareRoutineLogin`), or why the run's wake may do no work now. */
export type CloudCompanyFolderRoutineLogin =
	| { readonly login: { readonly bindingId: string; readonly version: number } | null }
	| { readonly refused: "acknowledgement" | "final" | "paused" };

/** A run agent's change to its company's hooks (E3a): an address hook or a mailbox opened, or one, by its name, paused,
 * resumed or removed. A creation leaves out a limit to take SQL's default. A signed hook (E3b) names its proof and the
 * site its secret may be typed into, and is opened through the secret broker, which makes the secret. */
export type CloudCompanyFolderHookRequest =
	| {
			readonly action: "create";
			readonly kind: "hook";
			readonly name: string;
			readonly purpose: string;
			readonly maxBodyBytes?: number;
			readonly perMinute?: number;
			readonly operationKey: string;
	  }
	| (EventHookCreate & { readonly site: string })
	| {
			readonly action: "create";
			readonly kind: "mailbox";
			readonly localPart: string;
			readonly purpose: string;
			readonly operationKey: string;
	  }
	| { readonly action: "pause" | "resume" | "remove"; readonly hook: string; readonly operationKey: string };

/** The hook a change left, under the change's receipt, or why it was refused, in the model's words. A signed hook's
 * creation also names the site its secret may be typed into. */
export type CloudCompanyFolderHookAnswer =
	| {
			readonly receiptId: string;
			readonly action: CloudCompanyFolderHookRequest["action"];
			readonly hook: Readonly<Record<string, unknown>>;
			readonly secretSite?: string;
	  }
	| { readonly refused: string };

/** The company's secret broker, which opens a signed hook with the secret it makes (E3b-2): the hook's receipt, or the
 * database's refusal. */
export interface CloudCompanyFolderSignedHooks {
	eventHook(
		request: { readonly binding: CloudNativeToolBinding; readonly request: EventHookCreate },
		signal: AbortSignal,
	): Promise<EventHookAnswer>;
}

/** The run's own view of the folder, for the node's folder service (its pass opens the view there). */
export interface CloudCompanyFolderRunView {
	readonly viewId: string;
	readonly pass: string;
}

export interface CloudCompanyFolderReadResult {
	/** The folder's clock when the read was answered. */
	readonly asOfSeq: number;
	readonly entry: CloudCompanyFolderEntry | null;
}

export interface CloudCompanyFolderPage {
	readonly asOfSeq: number;
	readonly entries: readonly CloudCompanyFolderEntry[];
	/** The last path of a full page, to pass as `after`; null on a page that is not full. A full last page still names
	 * it, and the next page is then empty. */
	readonly next: string | null;
}

/** Where a folder-v2 run's file bytes go and come from. Core C1d provides the one runs use (upload intents, and a
 * byte check that never locks the company row). The client checks what `put` returns against its own hash, and what
 * `get` returns against the entry. `put` must return the same reference for the same bytes and media type: a retried
 * commit sends the same units, and SQL refuses an operation key reused for a different change set (22023). */
export interface CloudCompanyFolderBytes {
	/** Stages one file; its version-2 manifest carries the media type and the executable bit (C1D §2). */
	put(bytes: Uint8Array, mediaType: string, executable: boolean, signal: AbortSignal): Promise<CloudFileReference>;
	get(file: CloudCompanyFolderFile, signal: AbortSignal): Promise<Uint8Array>;
	/** Bytes `offset` to `offset + length` of a file (fewer at its end), fetching only the chunks they fall in, each
	 * checked against its hash. */
	range(file: CloudCompanyFolderFile, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
}

/** A file's content in a change set. Text is stored as UTF-8. */
export type CloudCompanyFolderContent =
	| { readonly text: string; readonly mediaType?: string; readonly executable?: boolean }
	| { readonly bytes: Uint8Array; readonly mediaType: string; readonly executable?: boolean };

export type CloudCompanyFolderNewEntry =
	| { readonly path: string; readonly kind: "file"; readonly content: CloudCompanyFolderContent }
	| { readonly path: string; readonly kind: "folder" };

/** A change set's units (core §3). A write without `expectedVersion` creates the file and is refused if the path
 * exists. A folder's delete or move carries the `asOfSeq` its writer saw the subtree at. */
export type CloudCompanyFolderUnit =
	| {
			readonly op: "write";
			readonly path: string;
			readonly content: CloudCompanyFolderContent;
			readonly expectedVersion?: string;
	  }
	| { readonly op: "mkdir"; readonly path: string }
	| { readonly op: "new_folder"; readonly path: string; readonly contents: readonly CloudCompanyFolderNewEntry[] }
	| { readonly op: "delete"; readonly path: string; readonly expectedVersion: string; readonly asOfSeq?: number }
	| {
			readonly op: "move";
			readonly from: string;
			readonly to: string;
			readonly expectedVersion: string;
			readonly asOfSeq?: number;
	  }
	| { readonly op: "copy"; readonly from: string; readonly to: string; readonly expectedVersion?: string };

/** A unit's op as the core answers it. A run's change set never makes a link, but a view's does (`symlink`, LK1), and
 * a view's parked change set is listed and applied with it. */
export type CloudCompanyFolderOp = CloudCompanyFolderUnit["op"] | "symlink";

export type CloudCompanyFolderOutcome = "saved" | "conflict" | "refused" | "denied" | "waiting_for_review";

export interface CloudCompanyFolderUnitResult {
	readonly unit: number;
	readonly op: CloudCompanyFolderOp;
	/** The path as stored for a saved write, mkdir, new folder or delete; the requested path of a unit that was not
	 * saved; and the source of a move or copy, whose target is `to`. */
	readonly path: string;
	readonly to: string | null;
	/** The new version of a saved unit's path, where it has one. */
	readonly version: string | null;
	readonly outcome: CloudCompanyFolderOutcome;
	/** Why a unit was not saved: `version_changed`, `exists`, `missing`, `unseen_change` (a conflict), `denied`,
	 * `review_required`, `review_denied`, `structured_invalid`, `parent_missing`, `too_long` and the others of
	 * core §3. */
	readonly reason: string | null;
	/** A structured file's problems, as the shared parser words them. */
	readonly problems: readonly CompanyStateProblem[];
}

/** A change set whose bytes are staged: the units exactly as the review recorder and the commit receive them, so both
 * hash the same text (RUNTIME-COMPANY-FOLDER-C2.md, R1). Only this client makes one. */
export interface CloudCompanyFolderStagedChangeSet {
	readonly unitCount: number;
}

const STAGED = new WeakMap<
	CloudCompanyFolderStagedChangeSet,
	{
		readonly client: CloudCompanyFolderClient;
		readonly units: readonly CloudCompanyFolderUnit[];
		readonly sent: unknown[];
	}
>();

export interface CloudCompanyFolderCommitResult {
	readonly commitId: string;
	/** Null when no unit was saved. */
	readonly seq: number | null;
	readonly replay: boolean;
	readonly units: readonly CloudCompanyFolderUnitResult[];
}

/** `applyProposal`'s answer for a proposal decided or erased before the apply reached it (a member discarded it after
 * the run recorded its review): nothing applied, and the kernel cancelled the call's receipt. */
export interface CloudCompanyFolderProposalUnapplied {
	readonly unapplied: "applied" | "not_applied" | "declined" | "discarded" | "erased";
}

/** A worker tool's request, which the folder core's hook checks against exactly the units it names (F2-5b §3): the
 * worker's folder `agents/<agent>/todos/<todo>/<worker>`, and the action's own fields as the files hold them. */
export type CloudCompanyFolderWorkerRequest =
	| {
			readonly action: "dispatch";
			readonly folder: string;
			readonly title: string;
			readonly access: "read" | "write";
			readonly revival: "each" | "batch";
			readonly goal: string;
			readonly doneWhen: string;
			readonly context: string | null;
			readonly sources: readonly string[];
			/** A coding session's (C3a): the database checks them as the legacy dispatch did. */
			readonly species?: "in-house" | "coding";
			readonly harness?: string;
			readonly repository?: CloudCodingRepository;
			readonly owner?: string;
	  }
	/** `resultsVersion`: the results the follow-up removes, as read (null: none); other results now make it a conflict. */
	| {
			readonly action: "followup";
			readonly folder: string;
			readonly text: string;
			readonly resultsVersion: string | null;
	  }
	| {
			readonly action: "decide";
			readonly folder: string;
			readonly decision: "accepted" | "rejected";
			readonly note: string | null;
	  }
	| { readonly action: "report"; readonly folder: string };

/** One worker as the worker index shows it (`qorpera_worker_view`, its summary cut to 400 characters), with its folder. */
export interface CloudCompanyFolderWorker {
	readonly workerKey: string;
	readonly title: string;
	/** queued or running while active; then blocked, succeeded, failed or cancelled. */
	readonly state: string;
	readonly sequence: number;
	readonly access: "read" | "write";
	readonly revival: "each" | "batch";
	readonly outcome: string | null;
	readonly summary: string | null;
	readonly needs: string | null;
	readonly outputs: readonly string[];
	readonly reportedAt: string | null;
	readonly decision: { readonly decision: string; readonly note: string | null; readonly at: string | null } | null;
	readonly folder: string;
}

/** A page of one todo's workers (`agentWorkers`): at most 16, newest first, each with its cursor. */
export interface CloudCompanyFolderWorkerPage {
	readonly workers: readonly (CloudCompanyFolderWorker & { readonly cursor: string })[];
	/** How many more match after this page; `nextCursor` (the last worker's cursor) continues it. */
	readonly moreWorkers: number;
	readonly nextCursor: string | null;
}

/** A read released to the model: its path, the version read, and the receipt it was read under. */
export interface CloudCompanyFolderRelease {
	readonly path: string;
	/** The version read; null for a path the context names without reading a file (a proposal's, P40b). */
	readonly version: string | null;
	readonly authority: CloudCompanyFolderAuthority;
	/** Audit data only (contract 9.1): the file's content hash, when a file's content was released. */
	readonly fileSha256?: string;
}

export interface CloudCompanyFolderReleaseResult {
	readonly releaseId: string;
	readonly reads: number;
	readonly replay: boolean;
}

/**
 * Why a folder call did not complete, for the caller to tell the model:
 * - `stopped`: the company's work is stopped (paused or being deleted, 55000);
 * - `unavailable`: the run ended, lost its authority, or the company is not folder-v2 (42501, 0A000);
 * - `read_revoked`: something the model saw may no longer be seen (the recheck's 42501); the change or release was
 *   not recorded, and the caller reports it as denied;
 * - `contended`: the folder kept changing under a retried commit or release; nothing was recorded;
 * - `full`: the company's storage allowance has no room for new bytes (checked before they are written); nothing was
 *   stored;
 * - `unknown`: a try of a commit or release timed out, lost its connection or was cancelled while it was sent, and
 *   no later try gave an answer, so it may have been recorded. The caller retries with the same operation key (or
 *   release id), the same units and the same receipt, whose replay returns the stored outcome.
 * Other SQL errors (22023, 25000) and PostgREST's answers about the request (`PGRST1nn`-`PGRST3nn`) are defects and
 * stay a `CloudCompanyFolderRpcError`.
 */
export type CloudCompanyFolderFailure = "stopped" | "unavailable" | "read_revoked" | "contended" | "full" | "unknown";

export class CloudCompanyFolderError extends CloudRuntimeDiagnosticError {
	readonly failure: CloudCompanyFolderFailure;

	constructor(failure: CloudCompanyFolderFailure) {
		super(
			failure === "contended"
				? "stale_version"
				: failure === "unknown"
					? "transport_unavailable"
					: failure === "full"
						? "budget_exhausted"
						: "authority_unavailable",
			failure === "stopped"
				? "Company work is stopped"
				: failure === "read_revoked"
					? "Company folder read is no longer readable"
					: failure === "contended"
						? "Company folder kept changing"
						: failure === "unknown"
							? "Company folder outcome is unknown"
							: failure === "full"
								? "Company storage is full"
								: "Company folder is unavailable",
		);
		this.failure = failure;
	}
}

/** What a folder call's error means to its caller (see {@link CloudCompanyFolderFailure}); other errors unchanged. */
export function cloudCompanyFolderFailure(error: unknown): unknown {
	if (!(error instanceof CloudCompanyFolderRpcError)) return error;
	if (error.code === "55000") return new CloudCompanyFolderError("stopped");
	if (error.code === "42501")
		return new CloudCompanyFolderError(READ_REVOKED.has(error.detail) ? "read_revoked" : "unavailable");
	// 55P03: a lock wait past the budget. QRC01: the folder core's conflict envelope, which a commit or release
	// retries first and which staging answers for an object GC holds (C1D §9.7). Both are asked again later.
	if (error.code === "55P03" || error.code === "QRC01") return new CloudCompanyFolderError("contended");
	if (error.code === "0A000") return new CloudCompanyFolderError("unavailable");
	return error;
}

/** A commit's own arguments, checked before anything is staged or sent. */
function checkCommit(operationKey: string, options: { reviewId?: string; receiptId?: string }): void {
	if (!OPERATION_KEY.test(operationKey)) throw new Error("Invalid Company folder operation key");
	if (
		(options.reviewId !== undefined && !UUID.test(options.reviewId)) ||
		(options.receiptId !== undefined && !UUID.test(options.receiptId))
	)
		throw new Error("Invalid Company folder review or receipt");
}

function invalid(): never {
	throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder response is invalid");
}

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/** One worker of the worker index (`qorpera_worker_view` with its folder), checked key by key. */
function folderWorker(value: unknown): CloudCompanyFolderWorker {
	const worker = record(
		value,
		[
			"workerKey",
			"title",
			"state",
			"sequence",
			"access",
			"revival",
			"outcome",
			"summary",
			"needs",
			"outputs",
			"reportedAt",
			"decision",
			"folder",
		],
		["cursor"],
	);
	// The index keeps each output as `{path}` (a report's files).
	const outputs = Array.isArray(worker.outputs)
		? worker.outputs.map((output) =>
				output && typeof output === "object" && !Array.isArray(output) && typeof output.path === "string"
					? (output.path as string)
					: null,
			)
		: null;
	const decision = worker.decision === null ? null : record(worker.decision, ["decision", "note", "at"]);
	if (
		typeof worker.workerKey !== "string" ||
		typeof worker.title !== "string" ||
		typeof worker.state !== "string" ||
		(worker.access !== "read" && worker.access !== "write") ||
		(worker.revival !== "each" && worker.revival !== "batch") ||
		!nullableString(worker.outcome) ||
		!nullableString(worker.summary) ||
		!nullableString(worker.needs) ||
		outputs === null ||
		outputs.some((path) => path === null) ||
		!nullableString(worker.reportedAt) ||
		typeof worker.folder !== "string" ||
		(decision !== null &&
			(typeof decision.decision !== "string" || !nullableString(decision.note) || !nullableString(decision.at)))
	)
		invalid();
	return {
		workerKey: worker.workerKey as string,
		title: worker.title as string,
		state: worker.state as string,
		sequence: counter(worker.sequence),
		access: worker.access as "read" | "write",
		revival: worker.revival as "each" | "batch",
		outcome: worker.outcome as string | null,
		summary: worker.summary as string | null,
		needs: worker.needs as string | null,
		outputs: outputs as string[],
		reportedAt: worker.reportedAt as string | null,
		decision:
			decision === null
				? null
				: {
						decision: decision.decision as string,
						note: decision.note as string | null,
						at: decision.at as string | null,
					},
		folder: worker.folder as string,
	};
}

function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		keys.some((key) => !Object.hasOwn(value, key)) ||
		Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key))
	)
		invalid();
	return value as Record<string, unknown>;
}

function counter(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
	return value as number;
}

function uuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) invalid();
	return value;
}

/** A byte string's SHA-256, as lower-case hex. */
export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function authority(value: unknown): CloudCompanyFolderAuthority {
	const input = record(value, ["resourceId", "resourceRevision", "grantId", "grantRevision"]);
	if ((input.grantId === null) !== (input.grantRevision === null)) invalid();
	return {
		resourceId: uuid(input.resourceId),
		resourceRevision: counter(input.resourceRevision),
		grantId: input.grantId === null ? null : uuid(input.grantId),
		grantRevision: input.grantRevision === null ? null : counter(input.grantRevision),
	};
}

const ENTRY_KEYS = ["path", "kind", "version", "seq", "updatedAt", "authority"] as const;
const FILE_KEYS = ["manifestSha256", "fileSha256", "bytes", "mediaType", "executable"] as const;

/** Whether a link's target is one the core keeps: a string of 1 to 4,095 UTF-8 bytes. */
function linkTarget(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 4095;
}

function entry(value: unknown): CloudCompanyFolderEntry {
	const kind = (value as { kind?: unknown } | null)?.kind;
	const input = record(
		value,
		kind === "file" ? [...ENTRY_KEYS, ...FILE_KEYS] : kind === "symlink" ? [...ENTRY_KEYS, "target"] : ENTRY_KEYS,
	);
	if (typeof input.path !== "string" || !input.path || typeof input.updatedAt !== "string") invalid();
	const base = {
		path: input.path,
		version: uuid(input.version),
		seq: counter(input.seq),
		updatedAt: input.updatedAt,
		authority: authority(input.authority),
	};
	if (input.kind === "folder") return { ...base, kind: "folder" };
	if (input.kind === "symlink") {
		if (!linkTarget(input.target)) invalid();
		return { ...base, kind: "symlink", target: input.target };
	}
	if (
		input.kind !== "file" ||
		typeof input.manifestSha256 !== "string" ||
		!SHA.test(input.manifestSha256) ||
		typeof input.fileSha256 !== "string" ||
		!SHA.test(input.fileSha256) ||
		typeof input.mediaType !== "string" ||
		!MEDIA_TYPE.test(input.mediaType) ||
		typeof input.executable !== "boolean"
	)
		invalid();
	return {
		...base,
		kind: "file",
		file: {
			manifestSha256: input.manifestSha256,
			fileSha256: input.fileSha256,
			bytes: counter(input.bytes),
			mediaType: input.mediaType,
			executable: input.executable,
		},
	};
}

function problems(value: unknown): CompanyStateProblem[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 51) invalid();
	// The commit strips nulls from each outcome, nested ones included: a problem without a line or key comes back
	// without those keys.
	return value.map((item) => {
		const problem = record(item, ["code", "message"], ["line", "key"]);
		const line = problem.line ?? null;
		const key = problem.key ?? null;
		if (
			(line !== null && (!Number.isSafeInteger(line) || (line as number) < 1)) ||
			(key !== null && typeof key !== "string") ||
			typeof problem.code !== "string" ||
			typeof problem.message !== "string"
		)
			invalid();
		return { line, key, code: problem.code, message: problem.message } as CompanyStateProblem;
	});
}

const OUTCOMES: readonly CloudCompanyFolderOutcome[] = ["saved", "conflict", "refused", "denied", "waiting_for_review"];

const OPS: readonly CloudCompanyFolderOp[] = ["write", "mkdir", "new_folder", "delete", "move", "copy", "symlink"];

/** A commit's answer for one unit, whose op is the one sent (undefined: a proposal's unit past its list, any op). */
function unitResult(value: unknown, index: number, op: CloudCompanyFolderOp | undefined): CloudCompanyFolderUnitResult {
	const input = record(value, ["unit", "op", "path", "outcome"], ["to", "version", "reason", "problems"]);
	if (
		input.unit !== index + 1 ||
		!OPS.includes(input.op as CloudCompanyFolderOp) ||
		(op !== undefined && input.op !== op) ||
		typeof input.path !== "string" ||
		!OUTCOMES.includes(input.outcome as CloudCompanyFolderOutcome) ||
		(input.to !== undefined && typeof input.to !== "string") ||
		(input.reason !== undefined && typeof input.reason !== "string") ||
		(input.outcome === "saved") !== (input.reason === undefined)
	)
		invalid();
	return {
		unit: index + 1,
		op: input.op as CloudCompanyFolderOp,
		path: input.path,
		to: (input.to as string | undefined) ?? null,
		version: input.version === undefined ? null : uuid(input.version),
		outcome: input.outcome as CloudCompanyFolderOutcome,
		reason: (input.reason as string | undefined) ?? null,
		problems: problems(input.problems),
	};
}

function mediaTypeFor(path: string): string {
	return path.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain";
}

/** A run as the folder core's actor, with its ids in the lower case SQL checks. */
export function cloudCompanyFolderRunActor(binding: CloudNativeToolBinding): CloudCompanyFolderRunActor {
	return Object.freeze({
		kind: "run",
		runId: binding.runId.toLowerCase(),
		jobId: binding.jobId.toLowerCase(),
		runnerId: binding.runnerId.toLowerCase(),
		assignmentId: binding.assignmentId.toLowerCase(),
	});
}

/** The entry to release for a read: its path, version and receipt, with the content hash of a file. */
export function cloudCompanyFolderRelease(entry: CloudCompanyFolderEntry): CloudCompanyFolderRelease {
	return entry.kind === "file"
		? { path: entry.path, version: entry.version, authority: entry.authority, fileSha256: entry.file.fileSha256 }
		: { path: entry.path, version: entry.version, authority: entry.authority };
}

/** A unit after its checks, before its bytes are staged. */
interface PlannedFile {
	readonly path: string;
	readonly bytes: Uint8Array;
	readonly mediaType: string;
	readonly executable: boolean;
}

type PlannedUnit =
	| { readonly op: "write"; readonly sql: Record<string, unknown>; readonly file: PlannedFile }
	| {
			readonly op: "new_folder";
			readonly sql: Record<string, unknown>;
			readonly contents: readonly (
				| { readonly path: string; readonly file: PlannedFile }
				| { readonly path: string }
			)[];
	  }
	| { readonly op: "mkdir" | "delete" | "move" | "copy"; readonly sql: Record<string, unknown> };

function planned(content: CloudCompanyFolderContent, path: string): PlannedFile {
	const mediaType = content.mediaType ?? mediaTypeFor(path);
	if (!MEDIA_TYPE.test(mediaType)) throw new Error("Invalid Company folder media type");
	return {
		path,
		bytes: "text" in content ? new TextEncoder().encode(content.text) : content.bytes,
		mediaType,
		executable: content.executable ?? false,
	};
}

/** Checks one unit and shapes it as SQL takes it (move and copy name `from`), without staging anything. */
function plan(unit: CloudCompanyFolderUnit): PlannedUnit {
	const version = (value: string | undefined): Record<string, unknown> => {
		if (value === undefined) return {};
		if (!UUID.test(value)) throw new Error("Invalid Company folder version");
		return { expectedVersion: value };
	};
	const asOf = (value: number | undefined): Record<string, unknown> => {
		if (value === undefined) return {};
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Company folder sequence");
		return { asOfSeq: value };
	};
	switch (unit.op) {
		case "write": {
			const path = parseCloudCompanyPath(unit.path);
			return {
				op: "write",
				sql: { op: "write", path, ...version(unit.expectedVersion) },
				file: planned(unit.content, path),
			};
		}
		case "mkdir":
			return { op: "mkdir", sql: { op: "mkdir", path: parseCloudCompanyPath(unit.path) } };
		case "new_folder": {
			const path = parseCloudCompanyPath(unit.path);
			return {
				op: "new_folder",
				sql: { op: "new_folder", path },
				contents: unit.contents.map((item) => {
					// SQL checks only the joined path, for the whole change set; a bad one is this unit's, not a defect.
					const inner = parseCloudCompanyInnerPath(path, item.path);
					const whole = `${path}/${inner}`;
					return item.kind === "folder" ? { path: inner } : { path: inner, file: planned(item.content, whole) };
				}),
			};
		}
		case "delete":
			return {
				op: "delete",
				sql: {
					op: "delete",
					path: parseCloudCompanyPath(unit.path),
					...version(unit.expectedVersion),
					...asOf(unit.asOfSeq),
				},
			};
		case "move":
			return {
				op: "move",
				sql: {
					op: "move",
					from: parseCloudCompanyPath(unit.from),
					to: parseCloudCompanyPath(unit.to),
					...version(unit.expectedVersion),
					...asOf(unit.asOfSeq),
				},
			};
		case "copy":
			return {
				op: "copy",
				sql: {
					op: "copy",
					from: parseCloudCompanyPath(unit.from),
					to: parseCloudCompanyPath(unit.to),
					...version(unit.expectedVersion),
				},
			};
	}
}

export class CloudCompanyFolderClient {
	readonly #binding: CloudNativeToolBinding;
	readonly #identity: CloudNativeToolIdentity;
	readonly #control: CloudCompanyPathControl;
	readonly #bytes: CloudCompanyFolderBytes;
	readonly #actor: CloudCompanyFolderRunActor;
	readonly #signedHooks: CloudCompanyFolderSignedHooks | undefined;
	/** Hook changes, by operation key, whose call ended without an answer: they may have committed. */
	readonly #uncertainHooks = new Set<string>();

	constructor(options: {
		binding: CloudNativeToolBinding;
		identity: CloudNativeToolIdentity;
		control: CloudCompanyPathControl;
		bytes: CloudCompanyFolderBytes;
		/** The company's secret broker, for signed hooks; without it they are unavailable. */
		signedHooks?: CloudCompanyFolderSignedHooks;
	}) {
		this.#binding = parseCloudNativeToolBinding(options.binding);
		if (
			Object.entries(this.#binding).some(
				([key, value]) =>
					key !== "credentialCapsuleId" && options.identity[key as keyof CloudNativeToolIdentity] !== value,
			) ||
			!UUID.test(options.identity.companyId) ||
			!UUID.test(options.identity.environmentId)
		)
			throw new Error("Company folder client does not match the admitted run");
		this.#identity = Object.freeze({ ...options.identity });
		this.#control = options.control;
		this.#bytes = options.bytes;
		this.#signedHooks = options.signedHooks;
		this.#actor = cloudCompanyFolderRunActor(this.#binding);
	}

	/** The actor every call sends. */
	get actor(): CloudCompanyFolderRunActor {
		return this.#actor;
	}

	/** A folder call as the run's actor, or, for a run effect (the review recorder, the routine login), with exactly the
	 * arguments given. */
	#call(method: CloudCompanyPathRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		const sent = RUN_EFFECTS.has(method)
			? args
			: { p_environment_id: this.#identity.environmentId, p_actor: this.#actor, ...args };
		return cloudToolRequest((requestSignal) => this.#control.call(method, sent, requestSignal), signal);
	}

	async #once(method: CloudCompanyPathRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		try {
			return await this.#call(method, args, signal);
		} catch (error) {
			throw cloudCompanyFolderFailure(error);
		}
	}

	/** One commit or release, tried again with the same key or id while SQL says so, or while the answer was lost (a
	 * timeout or a dropped connection: the transaction may have committed, and a replay returns its outcome). An error
	 * `kept` names is thrown as SQL gave it, for the caller to read; after a lost answer it says nothing of the try that
	 * lost it, which may have committed, so the outcome is unknown. */
	#retried(
		method: CloudCompanyPathRpc,
		args: Record<string, unknown>,
		retryable: ReadonlySet<string>,
		signal: AbortSignal,
		kept?: (error: CloudCompanyFolderRpcError) => boolean,
	): Promise<unknown> {
		return this.#resent((trySignal) => this.#call(method, args, trySignal), retryable, signal, kept);
	}

	/** A signed hook's creation through the company's secret broker (E3b-2), which makes the hook's secret and opens the
	 * hook with it in one database step. The database's refusal comes back as SQL's error. Any other failure of the
	 * broker is a lost answer: the step may have committed, and the same key asked again answers from its receipt. */
	#signedHook(request: EventHookCreate, signal: AbortSignal): Promise<unknown> {
		const hooks = this.#signedHooks;
		if (!hooks) return Promise.reject(new CloudCompanyFolderError("unavailable"));
		return cloudToolRequest(
			async (requestSignal) => {
				let answer: EventHookAnswer;
				try {
					answer = await hooks.eventHook({ binding: this.#binding, request }, requestSignal);
				} catch (error) {
					if (error instanceof CloudRuntimeDiagnosticError) throw error;
					throw new CloudRuntimeDiagnosticError("transport_unavailable", "Cloud tool authority unavailable");
				}
				if (isEventHookRefusal(answer)) throw new CloudCompanyFolderRpcError(answer.code, answer.message);
				return answer;
			},
			signal,
			SIGNED_HOOK_MS,
		);
	}

	/** {@link #retried}'s tries, each sent by `send`. */
	async #resent(
		send: (signal: AbortSignal) => Promise<unknown>,
		retryable: ReadonlySet<string>,
		signal: AbortSignal,
		kept?: (error: CloudCompanyFolderRpcError) => boolean,
	): Promise<unknown> {
		let uncertain = false;
		for (let attempt = 1; ; attempt++) {
			// Cancelled before a try is sent: nothing more was sent, and the outcome is what the earlier tries left.
			if (signal.aborted) {
				if (uncertain) throw new CloudCompanyFolderError("unknown");
				throw new CloudRuntimeDiagnosticError("cancelled", "Cloud tool authority unavailable");
			}
			try {
				return await send(signal);
			} catch (error) {
				// Cancelled while a try was sent (cloudToolRequest answers a cancel): that try may have committed.
				if (error instanceof CloudRuntimeDiagnosticError && error.category === "cancelled" && signal.aborted)
					throw new CloudCompanyFolderError("unknown");
				const lost =
					error instanceof CloudRuntimeDiagnosticError &&
					!(error instanceof CloudCompanyFolderRpcError) &&
					(error.category === "timeout" || error.category === "transport_unavailable");
				if (error instanceof CloudCompanyFolderRpcError && kept?.(error))
					throw uncertain ? new CloudCompanyFolderError("unknown") : error;
				if (!lost && !(error instanceof CloudCompanyFolderRpcError && retryable.has(error.code)))
					throw cloudCompanyFolderFailure(error);
				uncertain ||= lost;
				if (attempt === ATTEMPTS) throw new CloudCompanyFolderError(uncertain ? "unknown" : "contended");
				// A cancel during the pause ends the next try before it is sent, as a cancel (cloudToolRequest).
				await new Promise((resolve) => setTimeout(resolve, 20 * attempt + randomInt(20)));
			}
		}
	}

	/** The entry at a path, as SQL found it by the path's key (its stored spelling may differ), or none. */
	async read(path: string, signal: AbortSignal): Promise<CloudCompanyFolderReadResult> {
		const input = record(await this.#once("qorpera_folder_read", { p_path: parseCloudCompanyPath(path) }, signal), [
			"schema",
			"asOfSeq",
			"found",
			"entry",
		]);
		if (input.schema !== "qorpera.folder-read/v1" || typeof input.found !== "boolean") invalid();
		if (!input.found) {
			if (input.entry !== null) invalid();
			return { asOfSeq: counter(input.asOfSeq), entry: null };
		}
		return { asOfSeq: counter(input.asOfSeq), entry: entry(input.entry) };
	}

	/** Opens the run's own view of the folder (`qorpera_folder_run_view_open`, 20260929999970), for the node's folder
	 * search: the folder service serves and renews it by its pass, and the run's end closes it. Opening again in the
	 * same job closes the earlier one. */
	async openRunView(signal: AbortSignal): Promise<CloudCompanyFolderRunView> {
		const input = record(await this.#once("qorpera_folder_run_view_open", {}, signal), [
			"schema",
			"viewId",
			"pass",
			"leaseUntil",
		]);
		if (
			input.schema !== "qorpera.folder-view/v1" ||
			typeof input.viewId !== "string" ||
			!UUID.test(input.viewId) ||
			typeof input.pass !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(input.pass) ||
			typeof input.leaseUntil !== "string"
		)
			invalid();
		return { viewId: input.viewId, pass: input.pass };
	}

	/** A page of the run agent's own todos from the todo index, which the commit updates with the files (thin writers
	 * W1, `qorpera_folder_agent_todos`, 20260929770000): newest first, 32 at most, each with its cursor. */
	async agentTodos(
		request: { includeClosed?: boolean; state?: string; search?: string; cursor?: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderTodoPage> {
		const input = record(await this.#once("qorpera_folder_agent_todos", { p_request: request }, signal), [
			"schema",
			"todos",
			"moreTodos",
			"nextCursor",
		]);
		if (input.schema !== "qorpera.folder-agent-todos/v1" || !Array.isArray(input.todos) || input.todos.length > 32)
			invalid();
		const todos = input.todos.map((value) => {
			const todo = record(
				value,
				["todoKey", "title", "state", "detail", "path", "version", "updatedAt", "cursor"],
				["detailTruncated"],
			);
			if (
				typeof todo.todoKey !== "string" ||
				typeof todo.title !== "string" ||
				!["open", "blocked", "done", "cancelled"].includes(todo.state as string) ||
				typeof todo.detail !== "string" ||
				typeof todo.path !== "string" ||
				typeof todo.updatedAt !== "string" ||
				(todo.detailTruncated !== undefined && todo.detailTruncated !== true)
			)
				invalid();
			return {
				todoKey: todo.todoKey,
				title: todo.title,
				state: todo.state as CloudCompanyFolderTodo["state"],
				detail: todo.detail,
				...(todo.detailTruncated ? { detailTruncated: true as const } : {}),
				path: todo.path,
				version: uuid(todo.version),
				updatedAt: todo.updatedAt,
				cursor: uuid(todo.cursor),
			};
		});
		const moreTodos = counter(input.moreTodos);
		const nextCursor = input.nextCursor === null ? null : uuid(input.nextCursor);
		if (moreTodos > 0 !== (nextCursor !== null) || (nextCursor !== null && nextCursor !== todos.at(-1)?.cursor))
			invalid();
		return { todos, moreTodos, nextCursor };
	}

	/** A page of one of the run agent's todos' workers from the worker index (F2-5b, `qorpera_folder_agent_workers`,
	 * 20260930075000): 16 at most, newest first, filtered by key, state and search, after `cursor`. A todo the run does
	 * not have, or may not read, and a cursor that is not one of its workers, are SQL's P0002. */
	async agentWorkers(
		request: {
			readonly todoKey: string;
			readonly workerKey?: string;
			readonly state?: string;
			readonly search?: string;
			readonly cursor?: string;
		},
		signal: AbortSignal,
	): Promise<CloudCompanyFolderWorkerPage> {
		const input = record(await this.#once("qorpera_folder_agent_workers", { p_request: request }, signal), [
			"schema",
			"todoKey",
			"workers",
			"moreWorkers",
			"nextCursor",
		]);
		if (
			input.schema !== "qorpera.folder-agent-workers/v1" ||
			input.todoKey !== request.todoKey ||
			!Array.isArray(input.workers) ||
			input.workers.length > 16
		)
			invalid();
		const workers = input.workers.map((value) => {
			const worker = folderWorker(value);
			return { ...worker, cursor: uuid((value as { cursor?: unknown }).cursor) };
		});
		const moreWorkers = counter(input.moreWorkers);
		const nextCursor = input.nextCursor === null ? null : uuid(input.nextCursor);
		if (moreWorkers > 0 !== (nextCursor !== null) || (nextCursor !== null && nextCursor !== workers.at(-1)?.cursor))
			invalid();
		return { workers, moreWorkers, nextCursor };
	}

	/** Cancels one of the run agent's workers (F2-5b, `qorpera_folder_cancel_agent_worker`), a run effect under its own
	 * receipt, keyed by the operation key: a retry with the same key replays it. A worker that changed while the cancel
	 * waited (QRC01) is asked again; one the agent does not have is SQL's P0002, and a coding session with a new turn
	 * since the agent was asked about it (C3c) is SQL's 55000, both kept for the caller. */
	async cancelWorker(
		request: { readonly folder: string; readonly operationKey: string },
		signal: AbortSignal,
	): Promise<{ readonly receiptId: string; readonly worker: CloudCompanyFolderWorker }> {
		const input = record(
			await this.#retried(
				"qorpera_folder_cancel_agent_worker",
				{ p_binding: this.#binding, p_request: { folder: request.folder, operationKey: request.operationKey } },
				RELEASE_RETRY,
				signal,
				(error) => error.code === "P0002" || (error.code === "55000" && error.detail === CODING_QUESTION_STALE),
			),
			["schema", "runId", "receiptId", "action", "folder", "worker"],
		);
		if (
			input.schema !== "qorpera.agent-worker-receipt/v1" ||
			input.runId !== this.#identity.runId ||
			input.action !== "cancel" ||
			input.folder !== request.folder
		)
			invalid();
		return {
			receiptId: uuid(input.receiptId),
			worker: folderWorker({ ...(input.worker as Record<string, unknown>), folder: request.folder }),
		};
	}

	/** Opens, pauses, resumes or removes one of the company's hooks or mailboxes (E3a, `qorpera_folder_manage_hook`), a
	 * run effect under its own receipt, keyed by the operation key: a retry with the same key replays it, and a
	 * creation's replay reads the address from the hook again. A change that met a changed authority (QRC01) or a
	 * deadlock is asked again. SQL's refusals come back as `refused`, unless an earlier call with the key ended without
	 * a checked answer: that call may have changed the hook, so the outcome is unknown. A signed hook's creation goes
	 * through the secret broker, which makes its secret and opens it under the same key (E3b-2); its answer names the
	 * site the secret may be typed into, and the hook's secret is there. A Stripe hook's secret is Stripe's: it opens
	 * with none, and the vault reads it off dashboard.stripe.com later (E3c-2). */
	async manageHook(
		request: CloudCompanyFolderHookRequest,
		signal: AbortSignal,
	): Promise<CloudCompanyFolderHookAnswer> {
		const refusal = (error: unknown) =>
			error instanceof CloudCompanyFolderRpcError
				? CLOUD_HOOK_REFUSALS.get(`${error.code} ${error.detail}`)
				: undefined;
		const kept = (error: CloudCompanyFolderRpcError) => refusal(error) !== undefined;
		const signed = request.action === "create" && request.kind === "hook" && "proof" in request ? request : undefined;
		// Without the company's secret broker a signed hook cannot be opened: nothing is sent.
		if (signed && !this.#signedHooks) throw new CloudCompanyFolderError("unavailable");
		try {
			const input = record(
				await (signed
					? this.#resent((trySignal) => this.#signedHook(signed, trySignal), RELEASE_RETRY, signal, kept)
					: this.#retried(
							"qorpera_folder_manage_hook",
							{ p_binding: this.#binding, p_request: request },
							RELEASE_RETRY,
							signal,
							kept,
						)),
				["schema", "runId", "receiptId", "action", "hook"],
				signed ? ["secretSite"] : [],
			);
			const hook = record(input.hook, HOOK_KEYS, HOOK_OPTIONAL);
			const { address, path, url, signingSecret } = hook;
			if (
				input.schema !== "qorpera.agent-hook-receipt/v1" ||
				input.runId !== this.#identity.runId ||
				input.action !== request.action ||
				hook.schema !== "qorpera.event-hook/v1" ||
				hook.companyId !== this.#identity.companyId ||
				hook.environmentId !== this.#identity.environmentId ||
				hook.status !== HOOK_STATUS[request.action] ||
				// A signed hook's creation names the site its secret may be typed into, and the secret is the hook's own and
				// there; a Stripe hook's is not yet, until the vault reads it off Stripe's page (E3c). An unsigned creation
				// has none. A change to a hook already open may find either.
				(signed
					? input.secretSite !== signed.site ||
						!signingSecret ||
						typeof signingSecret !== "object" ||
						Array.isArray(signingSecret) ||
						Object.keys(signingSecret).length !== 3 ||
						(signingSecret as Record<string, unknown>).connectorId !== "event_hook" ||
						(signingSecret as Record<string, unknown>).secretName !== `h${String(hook.id).replaceAll("-", "")}` ||
						(signingSecret as Record<string, unknown>).ready !== (signed.proof !== "stripe")
					: request.action === "create" && signingSecret !== undefined) ||
				(request.action !== "create"
					? hook.name !== request.hook || address !== undefined
					: request.kind === "hook"
						? hook.name !== request.name || hook.proof !== (signed ? signed.proof : "address")
						: typeof hook.name !== "string" ||
							!hook.name.startsWith("mail-") ||
							hook.proof !== "mail" ||
							typeof hook.email !== "string" ||
							!hook.email.startsWith(`${request.localPart}@`) ||
							address !== undefined) ||
				// A creation's answer has the address while the hook is live, with its path and, once the platform has one,
				// its URL; no other answer has them.
				(address === undefined
					? path !== undefined || url !== undefined
					: typeof address !== "string" ||
						!/^[A-Za-z0-9_-]{43}$/.test(address) ||
						path !== `/functions/v1/event-intake/${address}` ||
						(url !== undefined &&
							(typeof url !== "string" || !url.endsWith(`/functions/v1/event-intake/${address}`))))
			)
				invalid();
			uuid(hook.id);
			return {
				receiptId: uuid(input.receiptId),
				action: request.action,
				hook,
				...(signed ? { secretSite: signed.site } : {}),
			};
		} catch (error) {
			const refused = refusal(error);
			if (refused !== undefined && !this.#uncertainHooks.has(request.operationKey)) return { refused };
			this.#uncertainHooks.add(request.operationKey);
			throw refused === undefined ? error : new CloudCompanyFolderError("unknown");
		}
	}

	/** Archives one of the run agent's coding sessions (C3b, `qorpera_folder_archive_coding_worker`): an active one is
	 * cancelled first, and the session leaves its machine, keeping its files. A run effect under its own receipt, as
	 * `cancelWorker`. A worker the agent does not have (P0002), one that is no coding session and one with a new turn
	 * since the agent was asked are SQL's answers, kept for the caller. */
	async archiveCodingWorker(
		request: { readonly folder: string; readonly operationKey: string },
		signal: AbortSignal,
	): Promise<{
		readonly receiptId: string;
		readonly archived: boolean;
		readonly phase: string;
		readonly worker: CloudCompanyFolderWorker;
	}> {
		const input = record(
			await this.#retried(
				"qorpera_folder_archive_coding_worker",
				{ p_binding: this.#binding, p_request: { folder: request.folder, operationKey: request.operationKey } },
				RELEASE_RETRY,
				signal,
				(error) => error.code === "P0002" || CODING_ARCHIVE_REFUSALS.get(error.detail) === error.code,
			),
			["schema", "runId", "receiptId", "action", "folder", "archived", "worker", "phase"],
		);
		if (
			input.schema !== "qorpera.agent-worker-receipt/v1" ||
			input.runId !== this.#identity.runId ||
			input.action !== "archive" ||
			input.folder !== request.folder ||
			typeof input.archived !== "boolean" ||
			typeof input.phase !== "string"
		)
			invalid();
		return {
			receiptId: uuid(input.receiptId),
			archived: input.archived,
			phase: input.phase,
			worker: folderWorker({ ...(input.worker as Record<string, unknown>), folder: request.folder }),
		};
	}

	/** A page of the run agent's own file routines from the routine index, which the commit updates with the files (thin
	 * writers W4c, `qorpera_folder_agent_routines`, 20260929990000): newest first, 32 at most, each with its cursor, or
	 * the one routine `routineKey` names, whole. */
	async agentRoutines(
		request: { routineKey?: string; cursor?: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderRoutinePage> {
		const input = record(await this.#once("qorpera_folder_agent_routines", { p_request: request }, signal), [
			"schema",
			"routines",
			"moreRoutines",
			"nextCursor",
		]);
		if (
			input.schema !== "qorpera.folder-agent-routines/v1" ||
			!Array.isArray(input.routines) ||
			input.routines.length > 32 ||
			(request.routineKey !== undefined && input.routines.length > 1)
		)
			invalid();
		const routines = input.routines.map((value) => {
			const routine = record(value, ROUTINE_KEYS, ["instructionsTruncated"]);
			if (
				typeof routine.routineKey !== "string" ||
				(request.routineKey !== undefined && routine.routineKey !== request.routineKey) ||
				!ROUTINE_STATUSES.includes(routine.status as (typeof ROUTINE_STATUSES)[number]) ||
				(routine.pauseReason !== null && typeof routine.pauseReason !== "string") ||
				(routine.nextRunAt !== null && typeof routine.nextRunAt !== "string") ||
				typeof routine.path !== "string" ||
				(routine.file !== null &&
					(!routine.file || typeof routine.file !== "object" || Array.isArray(routine.file))) ||
				(routine.instructionsTruncated !== undefined && routine.instructionsTruncated !== true) ||
				routine.cursor !== routine.routineId
			)
				invalid();
			return {
				routineKey: routine.routineKey,
				routineId: uuid(routine.routineId),
				status: routine.status as CloudCompanyFolderRoutine["status"],
				pauseReason: routine.pauseReason as string | null,
				nextRunAt: routine.nextRunAt as string | null,
				occurrences: counter(routine.occurrences),
				path: routine.path,
				folderVersion: uuid(routine.folderVersion),
				file: routine.file as Readonly<Record<string, unknown>> | null,
				...(routine.instructionsTruncated ? { instructionsTruncated: true as const } : {}),
				cursor: uuid(routine.cursor),
			};
		});
		const moreRoutines = counter(input.moreRoutines);
		const nextCursor = input.nextCursor === null ? null : uuid(input.nextCursor);
		if (moreRoutines > 0 !== (nextCursor !== null) || (nextCursor !== null && nextCursor !== routines.at(-1)?.cursor))
			invalid();
		return { routines, moreRoutines, nextCursor };
	}

	/** The login that pays this run's routine save (`qorpera_prepare_routine_login`, a run effect): the requester's
	 * login for unattended work, now pinned for routines, or null when none pays. Called last before a save that starts
	 * or extends work; the consent it records is the requester's standing consent, so a later refusal leaves it. A
	 * deadlock is asked again. The wake's refusals of work come back as `refused`. */
	async prepareRoutineLogin(signal: AbortSignal): Promise<CloudCompanyFolderRoutineLogin> {
		let value: unknown;
		try {
			value = await this.#retried(
				"qorpera_prepare_routine_login",
				{ p_binding: this.#binding },
				RECORD_RETRY,
				signal,
				(error) => error.code === "55000" && WAKE_REFUSALS.has(error.detail),
			);
		} catch (error) {
			const refused = error instanceof CloudCompanyFolderRpcError ? WAKE_REFUSALS.get(error.detail) : undefined;
			if (refused) return { refused };
			throw error;
		}
		const input = record(value, ["schema", "runId", "login"]);
		if (input.schema !== "qorpera.routine-login/v1" || input.runId !== this.#binding.runId) invalid();
		if (input.login === null) return { login: null };
		const login = record(input.login, ["bindingId", "version"]);
		return { login: { bindingId: uuid(login.bindingId), version: counter(login.version) } };
	}

	/** A page of the open proposals of the run's agent for the run's member (P40a, `qorpera_folder_agent_proposals`):
	 * oldest first, 4 at most, each with its first 50 units. SQL lists them only to a run that can raise a card, and
	 * only while the run may read every path one names. */
	async agentProposals(request: { cursor?: string }, signal: AbortSignal): Promise<CloudCompanyFolderProposalPage> {
		const input = record(await this.#once("qorpera_folder_agent_proposals", { p_request: request }, signal), [
			"schema",
			"proposals",
			"moreProposals",
			"nextCursor",
		]);
		if (
			input.schema !== "qorpera.folder-agent-proposals/v1" ||
			!Array.isArray(input.proposals) ||
			input.proposals.length > 4
		)
			invalid();
		const proposals = input.proposals.map((value): CloudCompanyFolderProposal => {
			const proposal = record(value, [
				"proposalId",
				"createdAt",
				"viewKind",
				"effect",
				"createsAgent",
				"unitCount",
				"units",
				"moreUnits",
				"reads",
			]);
			if (
				!Array.isArray(proposal.reads) ||
				proposal.reads.length < 1 ||
				typeof proposal.createdAt !== "string" ||
				typeof proposal.viewKind !== "string" ||
				(proposal.effect !== "delegation" && proposal.effect !== "destructive") ||
				typeof proposal.createsAgent !== "boolean" ||
				!Array.isArray(proposal.units) ||
				proposal.units.length < 1 ||
				proposal.units.length > 50
			)
				invalid();
			const units = proposal.units.map((item, index): CloudCompanyFolderProposalUnit => {
				const unit = record(item, ["unit", "op", "path"], ["to", "items", "contains", "structured"]);
				if (
					unit.unit !== index + 1 ||
					!OPS.includes(unit.op as CloudCompanyFolderOp) ||
					typeof unit.path !== "string" ||
					(unit.to !== undefined && typeof unit.to !== "string") ||
					(unit.contains !== undefined && (unit.op !== "new_folder" || !Array.isArray(unit.contains))) ||
					(unit.structured !== undefined && !Array.isArray(unit.structured))
				)
					invalid();
				return {
					unit: index + 1,
					op: unit.op as CloudCompanyFolderOp,
					path: unit.path,
					to: (unit.to as string | undefined) ?? null,
					items: unit.items === undefined ? null : counter(unit.items),
					contains: ((unit.contains as unknown[] | undefined) ?? []).map((entry) => {
						const contained = record(entry, ["path", "kind"], ["target"]);
						if (
							typeof contained.path !== "string" ||
							!contained.path ||
							(contained.kind !== "file" && contained.kind !== "folder" && contained.kind !== "symlink") ||
							(contained.kind === "symlink") !== (contained.target !== undefined) ||
							(contained.target !== undefined && !linkTarget(contained.target))
						)
							invalid();
						return contained.kind === "symlink"
							? { path: contained.path, kind: "symlink", target: contained.target as string }
							: { path: contained.path, kind: contained.kind };
					}),
					structured: ((unit.structured as unknown[] | undefined) ?? []).map((file) => {
						const entry = record(file, ["path", "kind", "parse"]);
						if (
							typeof entry.path !== "string" ||
							typeof entry.kind !== "string" ||
							!entry.parse ||
							typeof entry.parse !== "object" ||
							Array.isArray(entry.parse)
						)
							invalid();
						return {
							path: entry.path,
							kind: entry.kind,
							parse: entry.parse as Readonly<Record<string, unknown>>,
						};
					}),
				};
			});
			const moreUnits = counter(proposal.moreUnits);
			const unitCount = counter(proposal.unitCount);
			if (unitCount !== units.length + moreUnits) invalid();
			// Each path it names, with the authority the list was decided on: no file was read, so no version.
			const reads = (proposal.reads as unknown[]).map((item): CloudCompanyFolderRelease => {
				const read = record(item, ["path", "authority"]);
				if (typeof read.path !== "string" || !read.path) invalid();
				return { path: read.path, version: null, authority: authority(read.authority) };
			});
			return {
				proposalId: uuid(proposal.proposalId),
				createdAt: proposal.createdAt,
				viewKind: proposal.viewKind,
				effect: proposal.effect,
				createsAgent: proposal.createsAgent,
				unitCount,
				units,
				moreUnits,
				reads,
			};
		});
		const moreProposals = counter(input.moreProposals);
		const nextCursor = input.nextCursor === null ? null : uuid(input.nextCursor);
		if (
			moreProposals > 0 !== (nextCursor !== null) ||
			(nextCursor !== null && nextCursor !== proposals.at(-1)?.proposalId)
		)
			invalid();
		return { proposals, moreProposals, nextCursor };
	}

	/** Records the automatic review's approval of an `apply_proposal` call as the review of that proposal's own units
	 * (P40a, `qorpera_folder_record_review` with `proposalId`), and returns the id the apply sends: null when the
	 * proposal is no longer open for this run (applied, declined, discarded or erased since the list). A replay returns
	 * the same record, so a lost answer is asked again. */
	async recordProposalReview(
		approval: { readonly actionReviewId: string; readonly argumentSha256: string },
		proposal: Pick<CloudCompanyFolderProposal, "proposalId" | "unitCount">,
		signal: AbortSignal,
	): Promise<string | null> {
		if (!UUID.test(approval.actionReviewId) || !SHA.test(approval.argumentSha256) || !UUID.test(proposal.proposalId))
			throw new Error("Invalid action review");
		const notOpen = (error: unknown) =>
			error instanceof CloudCompanyFolderRpcError && error.code === "42501" && error.detail === PROPOSAL_NOT_OPEN;
		let value: unknown;
		try {
			value = await this.#retried(
				"qorpera_folder_record_review",
				{
					p_binding: this.#binding,
					p_request: {
						actionReviewId: approval.actionReviewId,
						tool: "apply_proposal",
						argumentSha256: approval.argumentSha256,
						proposalId: proposal.proposalId,
					},
				},
				RECORD_RETRY,
				signal,
				notOpen,
			);
		} catch (error) {
			if (notOpen(error)) return null;
			throw error;
		}
		const input = record(value, ["schema", "reviewId", "approvedBy", "units"]);
		if (
			input.schema !== "qorpera.folder-review/v1" ||
			input.units !== proposal.unitCount ||
			(input.approvedBy !== null && (typeof input.approvedBy !== "string" || !UUID.test(input.approvedBy)))
		)
			invalid();
		return uuid(input.reviewId);
	}

	/** Applies an open proposal's units as the run, with the review `recordProposalReview` made of them (P40a,
	 * `qorpera_folder_apply_proposal`): one commit decides each unit (a moved base is a conflict, kept as a copy where a
	 * file's bytes differ) and closes the proposal, applied when a unit saved, else not applied. A proposal decided before
	 * the apply reached it applies nothing: the kernel cancels the call's receipt and answers with the proposal's status
	 * (P40b). One decided while the apply waited for it commits nothing under the receipt, each unit denied as
	 * `review_required`. A retry with the same key, review and receipt replays any of these; this call retries a lost
	 * answer as `commit` does. */
	async applyProposal(
		operationKey: string,
		proposal: Pick<CloudCompanyFolderProposal, "proposalId" | "unitCount" | "units">,
		options: { readonly reviewId: string; readonly receiptId: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult | CloudCompanyFolderProposalUnapplied> {
		checkCommit(operationKey, options);
		if (!UUID.test(proposal.proposalId)) throw new Error("Invalid Company folder proposal");
		const answer = await this.#retried(
			"qorpera_folder_apply_proposal",
			{
				p_operation_key: operationKey,
				p_proposal_id: proposal.proposalId,
				p_review_id: options.reviewId,
				p_receipt_id: options.receiptId,
			},
			COMMIT_RETRY,
			signal,
		);
		if ((answer as { schema?: unknown } | null)?.schema === "qorpera.folder-proposal-unapplied/v1") {
			const unapplied = record(answer, ["schema", "proposalId", "status", "receiptId"]);
			const status = unapplied.status as CloudCompanyFolderProposalUnapplied["unapplied"];
			if (
				unapplied.proposalId !== proposal.proposalId ||
				unapplied.receiptId !== options.receiptId ||
				!(status === "erased" || (PROPOSAL_STATUSES as readonly unknown[]).includes(status))
			)
				invalid();
			return { unapplied: status };
		}
		const input = record(answer, ["schema", "commitId", "seq", "replay", "units"]);
		if (
			input.schema !== "qorpera.folder-commit/v1" ||
			typeof input.replay !== "boolean" ||
			!Array.isArray(input.units) ||
			input.units.length !== proposal.unitCount
		)
			invalid();
		const results = input.units.map((value, index) => unitResult(value, index, proposal.units[index]?.op));
		const seq = input.seq === null ? null : counter(input.seq);
		if ((seq === null) !== results.every((unit) => unit.outcome !== "saved")) invalid();
		return { commitId: uuid(input.commitId), seq, replay: input.replay, units: results };
	}

	/** Closes an open proposal of the run's agent for its member (P40a, `qorpera_folder_close_proposal`, a run effect):
	 * declined with `actionReviewId`, the denial of its `apply_proposal` call, else discarded. A decided proposal answers
	 * with its status as it stands; null when it is not this run's to close (erased, or another agent's or member's). */
	async closeProposal(
		proposalId: string,
		actionReviewId: string | undefined,
		signal: AbortSignal,
	): Promise<(typeof PROPOSAL_STATUSES)[number] | null> {
		if (!UUID.test(proposalId) || (actionReviewId !== undefined && !UUID.test(actionReviewId)))
			throw new Error("Invalid Company folder proposal");
		const unavailable = (error: unknown) => error instanceof CloudCompanyFolderRpcError && error.code === "P0002";
		let value: unknown;
		try {
			value = await this.#retried(
				"qorpera_folder_close_proposal",
				{
					p_binding: this.#binding,
					p_request: { proposalId, ...(actionReviewId === undefined ? {} : { actionReviewId }) },
				},
				RECORD_RETRY,
				signal,
				unavailable,
			);
		} catch (error) {
			if (unavailable(error)) return null;
			throw error;
		}
		const input = record(value, ["schema", "proposalId", "status"]);
		if (
			input.schema !== "qorpera.folder-proposal/v1" ||
			input.proposalId !== proposalId ||
			!PROPOSAL_STATUSES.includes(input.status as (typeof PROPOSAL_STATUSES)[number])
		)
			invalid();
		return input.status as (typeof PROPOSAL_STATUSES)[number];
	}

	/** Notes the run's changes under interfaces/ and tables/ in its conversation (I10,
	 * `qorpera_folder_note_interface_changes`, a run effect): each of the run's commits there that has no note gets one,
	 * which the web draws with Undo, whatever tool or machine saved it. Answers how many it made: 0 when the run has no
	 * open conversation, or every such commit has its note. */
	async noteInterfaceChanges(signal: AbortSignal): Promise<number> {
		const value = await this.#retried(
			"qorpera_folder_note_interface_changes",
			{ p_binding: this.#binding, p_request: {} },
			RECORD_RETRY,
			signal,
		);
		const input = record(value, ["schema", "noted"]);
		if (
			input.schema !== "qorpera.interface-change-notes/v1" ||
			!Number.isSafeInteger(input.noted) ||
			(input.noted as number) < 0
		)
			invalid();
		return input.noted as number;
	}

	/** A file's text, checked against its entry, or null when nothing is at the path. A folder, a link (not followed),
	 * a file larger than `maxBytes`, or bytes that are not UTF-8 text are not text here. */
	async readText(
		path: string,
		maxBytes: number,
		signal: AbortSignal,
	): Promise<{ entry: CloudCompanyFolderFileEntry; text: string } | null> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid Company folder text bound");
		const { entry: found } = await this.read(path, signal);
		if (!found) return null;
		if (found.kind === "symlink") throw new CloudCompanyPathNotText("Company folder path is a link");
		if (found.kind !== "file") throw new CloudCompanyPathNotText("Company folder path is a folder");
		if (found.file.bytes > maxBytes)
			throw new CloudCompanyPathNotText("Company folder file is larger than text here");
		const bytes = await this.#bytes.get(found.file, signal);
		if (bytes.byteLength !== found.file.bytes || sha256(bytes) !== found.file.fileSha256)
			throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes do not match their entry");
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new CloudCompanyPathNotText("Company folder file is not UTF-8 text");
		}
		return { entry: found, text };
	}

	/** Bytes `offset` to `offset + length` of a file entry this client read (fewer at its end), for a model read of one
	 * window of a file: only the chunks the window falls in are fetched. */
	async readRange(
		file: CloudCompanyFolderFileEntry,
		offset: number,
		length: number,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
			throw new Error("Invalid Company folder byte range");
		const expected = Math.max(0, Math.min(file.file.bytes, offset + length) - offset);
		const bytes = await this.#bytes.range(file.file, offset, length, signal);
		if (bytes.byteLength !== expected)
			throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes do not match their entry");
		return bytes;
	}

	/** One page of a folder's entries (or, with `recursive`, of its whole subtree), in key order. */
	async list(
		parent: string,
		options: { after?: string; limit?: number; recursive?: boolean },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderPage> {
		const limit = options.limit ?? LIST_PAGE;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_PAGE)
			throw new Error("Invalid Company folder page");
		const input = record(
			await this.#once(
				"qorpera_folder_list",
				{
					p_parent: parseCloudCompanyPath(parent, true),
					p_after: options.after === undefined ? null : parseCloudCompanyPath(options.after),
					p_limit: limit,
					p_recursive: options.recursive ?? false,
				},
				signal,
			),
			["schema", "asOfSeq", "entries", "next"],
		);
		if (
			input.schema !== "qorpera.folder-list/v1" ||
			!Array.isArray(input.entries) ||
			input.entries.length > limit ||
			(input.next !== null && typeof input.next !== "string") ||
			(input.next !== null && input.entries.length !== limit)
		)
			invalid();
		return {
			asOfSeq: counter(input.asOfSeq),
			entries: input.entries.map(entry),
			next: input.next as string | null,
		};
	}

	/** Every entry under a folder, page by page, up to the caller's bound (the client keeps them all in memory, so a
	 * caller that may meet a large folder pages with `list`). `asOfSeq` is the first page's. A subtree delete or move
	 * sends it, so a change after it, even one a later page shows, makes that unit a conflict rather than going unseen
	 * (core §3, §4). */
	async listAll(
		parent: string,
		options: { recursive?: boolean; maxEntries: number },
		signal: AbortSignal,
	): Promise<{ asOfSeq: number; entries: CloudCompanyFolderEntry[] }> {
		if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 1)
			throw new Error("Invalid Company folder listing bound");
		const entries: CloudCompanyFolderEntry[] = [];
		let asOfSeq: number | null = null;
		let after: string | undefined;
		for (;;) {
			const page = await this.list(parent, { after, recursive: options.recursive }, signal);
			asOfSeq ??= page.asOfSeq;
			entries.push(...page.entries);
			if (entries.length > options.maxEntries)
				throw new Error("Company folder listing has more entries than its bound");
			if (page.next === null) return { asOfSeq, entries };
			after = page.next;
		}
	}

	/** Stages one file's bytes once per commit (per content, media type and bit) and returns its reference, checked
	 * against the bytes. */
	async #stage(
		file: PlannedFile,
		staged: Map<string, CloudFileReference>,
		signal: AbortSignal,
	): Promise<CloudCompanyFolderFile> {
		const hash = sha256(file.bytes);
		const key = `${hash}:${file.mediaType}:${file.executable}`;
		let reference = staged.get(key);
		if (!reference) {
			reference = await this.#bytes.put(file.bytes, file.mediaType, file.executable, signal);
			if (
				!SHA.test(reference.manifestSha256) ||
				reference.fileSha256 !== hash ||
				reference.bytes !== file.bytes.byteLength ||
				reference.mediaType !== file.mediaType
			)
				throw new CloudRuntimeDiagnosticError("invalid_response", "Company folder bytes were stored differently");
			staged.set(key, reference);
		}
		return {
			manifestSha256: reference.manifestSha256,
			fileSha256: reference.fileSha256,
			bytes: reference.bytes,
			mediaType: file.mediaType,
			executable: file.executable,
		};
	}

	/** Commits one change set as the run (core §3): it stages the units (see `stage`), then commits them as
	 * `commitStaged` does. SQL decides each unit.
	 *
	 * The operation key comes from the caller's tool call. A retry with the same key, the same units and the same
	 * receipt replays the stored outcome; this call already retries a lost answer, and reports `unknown` when a try
	 * was lost and none answered after it. `receiptId` is the tool call's folder receipt (core C1c-2b), which a
	 * model-facing write carries once that exists; it is part of the change set, so a retry must send the same one. */
	async commit(
		operationKey: string,
		units: readonly CloudCompanyFolderUnit[],
		options: { reviewId?: string; receiptId?: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult> {
		checkCommit(operationKey, options);
		return this.commitStaged(operationKey, await this.stage(units, signal), options, signal);
	}

	/** Commits a change set `stage` returned, which a review may have been recorded for (`recordReview`). */
	async commitStaged(
		operationKey: string,
		changeSet: CloudCompanyFolderStagedChangeSet,
		options: { reviewId?: string; receiptId?: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult> {
		return this.#commitStaged("qorpera_folder_commit", {}, operationKey, changeSet, options, signal);
	}

	/** Commits a worker's files under the worker tool's request (F2-5b, `qorpera_folder_worker_commit`): a dispatch,
	 * follow-up, report or decision, which the hook checks against exactly the units it names. Otherwise as
	 * `commitStaged`. */
	async workerCommitStaged(
		operationKey: string,
		changeSet: CloudCompanyFolderStagedChangeSet,
		request: CloudCompanyFolderWorkerRequest,
		options: { reviewId?: string; receiptId?: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult> {
		return this.#commitStaged(
			"qorpera_folder_worker_commit",
			{ p_request: request },
			operationKey,
			changeSet,
			options,
			signal,
		);
	}

	/** The platform's own run-log or run-tree batch (memory W1c-3). Staging and the structured parser are the ordinary
	 * folder path; this entry point adds the log's current location and, for derived tree blocks, their generations.
	 * It carries no model-call receipt or review. SQL decides the run's own-log exception and all file rules. */
	async memoryCommitStaged(
		operationKey: string,
		changeSet: CloudCompanyFolderStagedChangeSet,
		preconditions: {
			readonly runLog: { readonly run: string; readonly path: string };
			readonly runGenerations?: readonly { readonly runId: string; readonly generation: number }[];
		},
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult> {
		if (preconditions.runLog.run !== this.#actor.runId) throw new Error("Run log belongs to another run");
		const runLog = { run: preconditions.runLog.run, path: parseCloudCompanyPath(preconditions.runLog.path) };
		const runGenerations = preconditions.runGenerations?.map(({ runId, generation }) => {
			if (!UUID.test(runId) || !Number.isSafeInteger(generation) || generation < 0)
				throw new Error("Invalid run log generation");
			return { runId, generation };
		});
		return this.#commitStaged(
			"qorpera_folder_memory_commit",
			{ p_preconditions: { runLog, ...(runGenerations === undefined ? {} : { runGenerations }) } },
			operationKey,
			changeSet,
			{},
			signal,
		);
	}

	async #commitStaged(
		method: "qorpera_folder_commit" | "qorpera_folder_worker_commit" | "qorpera_folder_memory_commit",
		extra: Record<string, unknown>,
		operationKey: string,
		changeSet: CloudCompanyFolderStagedChangeSet,
		options: { reviewId?: string; receiptId?: string },
		signal: AbortSignal,
	): Promise<CloudCompanyFolderCommitResult> {
		checkCommit(operationKey, options);
		const { units, sent } = this.#staged(changeSet);
		const input = record(
			await this.#retried(
				method,
				{
					p_operation_key: operationKey,
					p_units: sent,
					...extra,
					...(options.reviewId === undefined ? {} : { p_review_id: options.reviewId }),
					...(options.receiptId === undefined ? {} : { p_receipt_id: options.receiptId }),
				},
				COMMIT_RETRY,
				signal,
			),
			["schema", "commitId", "seq", "replay", "units"],
		);
		if (
			input.schema !== "qorpera.folder-commit/v1" ||
			typeof input.replay !== "boolean" ||
			!Array.isArray(input.units) ||
			input.units.length !== units.length
		)
			invalid();
		const results = input.units.map((value, index) => unitResult(value, index, units[index]!.op));
		const seq = input.seq === null ? null : counter(input.seq);
		if ((seq === null) !== results.every((unit) => unit.outcome !== "saved")) invalid();
		return { commitId: uuid(input.commitId), seq, replay: input.replay, units: results };
	}

	/** Stages a change set's bytes for one commit (core §3): every unit is checked before any bytes are staged, each
	 * file is staged once, and every structured file in a write or a new folder carries its parse from the shared
	 * parser, made from the same bytes, or its problems (RUNTIME-COMPANY-STATE-FILES.md §8). A writer whose change
	 * needs a review stages first, records the review of exactly these units, then commits them. */
	async stage(
		units: readonly CloudCompanyFolderUnit[],
		signal: AbortSignal,
	): Promise<CloudCompanyFolderStagedChangeSet> {
		if (!Array.isArray(units) || units.length < 1 || units.length > MAX_UNITS)
			throw new Error("Invalid Company folder change set");
		const plans = units.map(plan);
		const staged = new Map<string, CloudFileReference>();
		const sent: Record<string, unknown>[] = [];
		for (const unit of plans) {
			if (unit.op === "write") {
				const file = await this.#stage(unit.file, staged, signal);
				const entry = structured(unit.file.path, unit.file.bytes);
				sent.push({ ...unit.sql, file, ...(entry ? { structured: [entry] } : {}) });
			} else if (unit.op === "new_folder") {
				const contents: Record<string, unknown>[] = [];
				const entries: Record<string, unknown>[] = [];
				for (const item of unit.contents) {
					if (!("file" in item)) {
						contents.push({ path: item.path, kind: "folder" });
						continue;
					}
					contents.push({ path: item.path, kind: "file", file: await this.#stage(item.file, staged, signal) });
					const entry = structured(item.file.path, item.file.bytes);
					if (entry) entries.push(entry);
				}
				sent.push({ ...unit.sql, contents, ...(entries.length ? { structured: entries } : {}) });
			} else sent.push(unit.sql);
		}
		const changeSet: CloudCompanyFolderStagedChangeSet = Object.freeze({ unitCount: units.length });
		STAGED.set(changeSet, { client: this, units: [...units], sent });
		return changeSet;
	}

	#staged(changeSet: CloudCompanyFolderStagedChangeSet): {
		units: readonly CloudCompanyFolderUnit[];
		sent: unknown[];
	} {
		const staged = STAGED.get(changeSet);
		if (staged?.client !== this) throw new Error("Company folder change set was not staged by this client");
		return staged;
	}

	/** Records the automatic review's approval of this call as the review of exactly this staged change set (C2 R1,
	 * `qorpera_folder_record_review`), and returns the id the commit sends. The approval is the tool context's
	 * `actionReviewId`, of the call named by its tool and `argumentSha256`. SQL accepts only an approval this run may act
	 * on, and one approval stands for one change set: a replay of the same units returns the same record, so a lost
	 * answer is asked again. A writer records inside its receipt, so a completed call replays from it first. */
	async recordReview(
		approval: { readonly actionReviewId: string; readonly tool: string; readonly argumentSha256: string },
		changeSet: CloudCompanyFolderStagedChangeSet,
		signal: AbortSignal,
	): Promise<string> {
		if (
			!UUID.test(approval.actionReviewId) ||
			!/^[a-z][a-z0-9_]{0,63}$/.test(approval.tool) ||
			!SHA.test(approval.argumentSha256)
		)
			throw new Error("Invalid action review");
		const { sent } = this.#staged(changeSet);
		const input = record(
			await this.#retried(
				"qorpera_folder_record_review",
				{
					p_binding: this.#binding,
					p_request: {
						actionReviewId: approval.actionReviewId,
						tool: approval.tool,
						argumentSha256: approval.argumentSha256,
						units: sent,
					},
				},
				RECORD_RETRY,
				signal,
			),
			["schema", "reviewId", "approvedBy", "units"],
		);
		if (
			input.schema !== "qorpera.folder-review/v1" ||
			input.units !== sent.length ||
			(input.approvedBy !== null && (typeof input.approvedBy !== "string" || !UUID.test(input.approvedBy)))
		)
			invalid();
		return uuid(input.reviewId);
	}

	/** Records the reads a tool result shows the model, before the result leaves the tool (C1B §C1b-2 3; one release
	 * per tool result, F1 on #533):
	 * - a listing's entries are reads too: names are content;
	 * - a release id is used once: the same reads and output hash replay, anything else is refused, so the caller keeps
	 *   the id and the output hash with its tool call (this call retries a lost answer, and reports `unknown` when a try
	 *   was lost and none answered after it);
	 * - context composition (memory, skills) releases once, before the first model request that uses it;
	 * - a result that shows more than 10,000 entries is released in parts, each with its own id and the same output
	 *   hash.
	 */
	async release(
		releaseId: string,
		reads: readonly CloudCompanyFolderRelease[],
		outputSha256: string,
		signal: AbortSignal,
	): Promise<CloudCompanyFolderReleaseResult> {
		if (!UUID.test(releaseId) || !SHA.test(outputSha256) || reads.length > MAX_RELEASED)
			throw new Error("Invalid Company folder release");
		const sent = reads.map((read) => {
			if (
				(read.version !== null && !UUID.test(read.version)) ||
				(read.fileSha256 !== undefined && !SHA.test(read.fileSha256))
			)
				throw new Error("Invalid Company folder release");
			return {
				path: parseCloudCompanyPath(read.path),
				version: read.version,
				authority: {
					resourceId: read.authority.resourceId,
					resourceRevision: read.authority.resourceRevision,
					grantId: read.authority.grantId,
					grantRevision: read.authority.grantRevision,
				},
				...(read.fileSha256 === undefined ? {} : { fileSha256: read.fileSha256 }),
			};
		});
		const input = record(
			await this.#retried(
				"qorpera_folder_record_release",
				{ p_release_id: releaseId, p_reads: sent, p_output_sha256: outputSha256 },
				RELEASE_RETRY,
				signal,
			),
			["schema", "releaseId", "reads", "replay"],
		);
		if (
			input.schema !== "qorpera.folder-release/v1" ||
			input.releaseId !== releaseId ||
			input.reads !== reads.length ||
			typeof input.replay !== "boolean"
		)
			invalid();
		// The run's work log keeps every release id of the step that made it (RUNTIME-AGENT-MEMORY-TREE.md §4.5).
		recordCloudRunLogRelease(releaseId, reads);
		return { releaseId, reads: reads.length, replay: input.replay };
	}
}

/** A structured file's entry for the commit's hook: its parse from the shared parser, made from the bytes being
 * stored, or its problems without the text (RUNTIME-COMPANY-STATE-FILES.md §8). Null for any other path. */
function structured(path: string, bytes: Uint8Array): Record<string, unknown> | null {
	const where = companyStatePath(path);
	if (!where) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return {
			path,
			kind: where.kind,
			problems: [{ line: null, key: null, code: "encoding", message: "the file is not UTF-8 text" }],
		};
	}
	const parsed = parseCompanyStateFile(path, text);
	if (!parsed) return null;
	return parsed.ok
		? { path, kind: where.kind, text, parse: parsed.file, parserVersion: COMPANY_STATE_PARSER_VERSION }
		: { path, kind: where.kind, problems: parsed.problems };
}
