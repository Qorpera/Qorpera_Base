import {
	COMPANY_STATE_FILE_MAX_BYTES,
	type CompanyStateSetting,
	canonicalCompanyStateInstant,
	parseCompanyStateFile,
	type RoutineFile,
	setCompanyStateSettings,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudCompanyFolderClient, CloudCompanyFolderFileEntry } from "./cloud-company-folder-client.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";

/*
 * `decide_routine` as a thin writer of a folder-v2 dynamic routine's own file (deploy/first-node/
 * RUNTIME-COMPANY-STATE-FILES.md §2 "routines", §5): `agents/<handle>/routines/<routineKey>.md`, whose name is the
 * routine's key. The run woken by the routine's `once` occurrence owes its end-of-run decision: a new `at` (with,
 * if needed, a new effort or reply), or `status: concluded` with a `conclusion`. F2-6's hook takes that save as the
 * decision while it is owed, without review; a decision that also changes the title or the instructions is
 * delegation, which the folder core cannot record before core C2, so it is not saved.
 *
 * The file is read first, outside the receipt, and what can never be saved is refused there, binding no key: a title
 * or instructions that differ from the file (delegation, before C2), or a next run at or after the routine's end. A
 * routine that already moved on (its file gone, no longer active, or no longer a dynamic routine's `once`) is settled,
 * as today: nothing is owed. The receipt binds the model's request, and the commit carries the version read, so a file
 * changed in between is a conflict the model decides again under a new operation key. A plain decision the folder core
 * calls delegation is one nothing is owed for any more (F2-6's review class), so it is settled too.
 *
 * The routine is the one this run was woken for: the file at its key must carry its id (the routine row is keyed by
 * the file's id). A member may rename the file while the run works; then the kernel's current key, read again from
 * the wake, finds it. Only when neither place holds this routine has it moved on.
 */

const TOOL_VERSION = "folder-v2/1";

export interface CloudFolderRoutineDecisionRequest {
	readonly action: "next" | "conclude";
	readonly operationKey: string;
	readonly at?: string;
	readonly intent?: string;
	readonly title?: string;
	readonly effort?: string;
	readonly report?: "optional" | "required" | "silent";
	readonly summary?: string;
}

const AGAIN = "decide again with a new operationKey";
const UNREADABLE = "This run's routine file does not read as a routine; a member must correct it";

interface Located {
	readonly path: string;
	readonly routineKey: string;
	readonly found: { entry: CloudCompanyFolderFileEntry; text: string };
	readonly routine: RoutineFile;
}

export class CloudFolderRoutineDecision {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	readonly #routines: string;
	readonly #routineKey: string;
	readonly #routineId: string;
	readonly #currentRoutineKey: (signal: AbortSignal) => Promise<string | null>;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		handle: string;
		/** The woken routine's key when the run started: its file's name. */
		routineKey: string;
		/** The woken routine's id, which its file carries. */
		routineId: string;
		/** The routine's key now, read again from the kernel (the wake), or null when it has none. */
		currentRoutineKey: (signal: AbortSignal) => Promise<string | null>;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#routineKey = options.routineKey;
		this.#routineId = options.routineId;
		this.#currentRoutineKey = options.currentRoutineKey;
		this.#routines = `agents/${options.handle}/routines`;
	}

	/** This run's routine file: at its key, or, after a rename, at the key the kernel has now. Null when it is gone. */
	async #locate(signal: AbortSignal): Promise<Located | null> {
		const at = async (routineKey: string): Promise<Located | null> => {
			const path = `${this.#routines}/${routineKey}.md`;
			const found = await this.#folder.readText(path, COMPANY_STATE_FILE_MAX_BYTES, signal);
			if (!found) return null;
			const parsed = parseCompanyStateFile(path, found.text);
			if (!parsed?.ok || parsed.file.kind !== "routine") throw new CloudToolRefusal(UNREADABLE);
			return { path, routineKey, found, routine: parsed.file as RoutineFile };
		};
		const first = await at(this.#routineKey);
		if (first?.routine.id === this.#routineId) return first;
		const now = await this.#currentRoutineKey(signal);
		if (now === null || now === this.#routineKey) return null;
		const moved = await at(now);
		return moved?.routine.id === this.#routineId ? moved : null;
	}

	/** The decision's result, and whether the decision is now made (the run owes nothing more). */
	async decide(
		request: CloudFolderRoutineDecisionRequest,
		context: CloudToolContext,
	): Promise<{ content: CloudToolContent; decided: boolean }> {
		const signal = context.signal;
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const located = await this.#locate(signal);
		// Removed, or replaced by another routine: it moved on.
		if (!located) return this.#settled(null);
		const { found, routine, path, routineKey } = located;
		// Paused, concluded or rescheduled by a member since this run started: nothing is owed, as today.
		if (routine.status !== "active" || routine.trigger.when !== "once") return this.#settled(located);
		if (
			(request.title !== undefined && request.title !== routine.title) ||
			(request.intent !== undefined && request.intent.trim() !== routine.instructions)
		)
			throw new CloudToolRefusal(
				"In this company a routine's own run cannot change its title or instructions yet (that needs a member's review): decide next without intent or title, or conclude",
			);
		let text: string;
		if (request.action === "conclude") {
			// The file's conclusion is one line: line breaks and tabs in the summary become spaces.
			const conclusion = (request.summary ?? "").replace(/\s+/g, " ").trim();
			text = setCompanyStateSettings(found.text, { status: "concluded", conclusion });
		} else {
			const at = canonicalCompanyStateInstant(request.at ?? "") ?? request.at ?? "";
			if (routine.ends && Date.parse(at) >= Date.parse(routine.ends))
				throw new CloudToolRefusal(`The routine ends at ${routine.ends}. Choose an earlier time or conclude it.`);
			// A title or instructions equal to the file's change nothing, so they are not written.
			const changes: Record<string, CompanyStateSetting> = { at };
			if (request.effort !== undefined) changes.effort = request.effort;
			if (request.report !== undefined) changes.reply = request.report;
			text = setCompanyStateSettings(found.text, changes);
		}
		const content = await this.#operations.execute({
			operation: {
				tool: "decide_routine",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `decide:${request.operationKey}`,
				arguments: { ...request },
				target: { path },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const committed = await this.#folder.commit(
					`decide-file:${request.operationKey}`,
					[
						{
							op: "write",
							path,
							content: { text, mediaType: "text/markdown" },
							expectedVersion: found.entry.version,
						},
					],
					{ receiptId },
					performSignal,
				);
				const written = committed.units[0];
				if (!written) throw new Error("Company folder commit answered no unit");
				const value =
					written.outcome === "saved"
						? {
								schema: "qorpera.agent-routine-receipt/v1",
								runId: this.#identity.runId,
								receiptId,
								action: request.action === "next" ? "upsert" : "conclude",
								routine: {
									routineKey,
									path,
									version: written.version,
									status: request.action === "next" ? "active" : "concluded",
									...(request.action === "next"
										? { at: canonicalCompanyStateInstant(request.at ?? "") ?? request.at }
										: { conclusion: (request.summary ?? "").replace(/\s+/g, " ").trim() }),
								},
							}
						: // A plain decision the core calls delegation: nothing is owed any more (F2-6's review class).
							written.outcome === "denied" && written.reason === "review_required"
							? this.#settledValue(located)
							: {
									schema: "qorpera.agent-routine-decision/v1",
									runId: this.#identity.runId,
									state: "refused",
									reason:
										written.outcome === "conflict"
											? `The routine's file changed since it was read: ${AGAIN}`
											: written.problems.length
												? `${written.problems.map((problem) => problem.message).join("; ")}: ${AGAIN}`
												: written.outcome === "waiting_for_review"
													? `The change waits for a member's review and is not the decision: ${AGAIN}`
													: written.reason === "review_denied"
														? `A member declined this change: ${AGAIN}`
														: written.outcome === "denied"
															? "This run may not change its routine's file; tell the member"
															: `Not saved (${written.reason ?? written.outcome}): ${AGAIN}`,
								};
				return {
					content: { kind: "text", value: cloudToolJsonText(value) },
					folderCommitId: committed.commitId,
				};
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
		const value = JSON.parse(content.kind === "text" ? content.value : "{}") as { schema?: unknown; state?: unknown };
		return {
			content,
			decided: value.schema === "qorpera.agent-routine-receipt/v1" || value.state === "settled",
		};
	}

	/** Nothing is owed: the routine moved on elsewhere. As today's answer, with the routine as read. */
	#settledValue(located: Located | null) {
		return {
			schema: "qorpera.agent-routine-decision/v1",
			runId: this.#identity.runId,
			state: "settled",
			routine:
				located === null
					? { routineKey: this.#routineKey, status: "retired" }
					: {
							routineKey: located.routineKey,
							path: located.path,
							title: located.routine.title,
							status: located.routine.status,
						},
		};
	}

	#settled(located: Located | null): { content: CloudToolContent; decided: boolean } {
		return { content: { kind: "text", value: cloudToolJsonText(this.#settledValue(located)) }, decided: true };
	}
}
