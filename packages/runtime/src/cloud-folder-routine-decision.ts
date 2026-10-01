import {
	COMPANY_STATE_FILE_MAX_BYTES,
	type CompanyStateSetting,
	canonicalCompanyStateInstant,
	parseCompanyStateFile,
	type RoutineFile,
	setCompanyStateSettings,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudCompanyFolderClient } from "./cloud-company-folder-client.ts";
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

export class CloudFolderRoutineDecision {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	readonly #path: string;
	readonly #routineKey: string;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		handle: string;
		/** The woken routine's key: its file's name. */
		routineKey: string;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#routineKey = options.routineKey;
		this.#path = `agents/${options.handle}/routines/${options.routineKey}.md`;
	}

	/** The decision's result, and whether the decision is now made (the run owes nothing more). */
	async decide(
		request: CloudFolderRoutineDecisionRequest,
		context: CloudToolContext,
	): Promise<{ content: CloudToolContent; decided: boolean }> {
		const signal = context.signal;
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const found = await this.#folder.readText(this.#path, COMPANY_STATE_FILE_MAX_BYTES, signal);
		// Removed or moved elsewhere: the routine moved on.
		if (!found) return this.#settled(null);
		const parsed = parseCompanyStateFile(this.#path, found.text);
		if (!parsed?.ok || parsed.file.kind !== "routine")
			throw new CloudToolRefusal("This run's routine file does not read as a routine; a member must correct it");
		const routine = parsed.file as RoutineFile;
		// Paused, concluded or rescheduled by a member since this run started: nothing is owed, as today.
		if (routine.status !== "active" || routine.trigger.when !== "once") return this.#settled(routine);
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
				target: { path: this.#path },
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
							path: this.#path,
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
									routineKey: this.#routineKey,
									path: this.#path,
									version: written.version,
									status: request.action === "next" ? "active" : "concluded",
									...(request.action === "next"
										? { at: canonicalCompanyStateInstant(request.at ?? "") ?? request.at }
										: { conclusion: (request.summary ?? "").replace(/\s+/g, " ").trim() }),
								},
							}
						: // A plain decision the core calls delegation: nothing is owed any more (F2-6's review class).
							written.outcome === "denied" && written.reason === "review_required"
							? this.#settledValue(routine)
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
	#settledValue(routine: RoutineFile | null) {
		return {
			schema: "qorpera.agent-routine-decision/v1",
			runId: this.#identity.runId,
			state: "settled",
			routine:
				routine === null
					? { routineKey: this.#routineKey, status: "retired" }
					: { routineKey: this.#routineKey, path: this.#path, title: routine.title, status: routine.status },
		};
	}

	#settled(routine: RoutineFile | null): { content: CloudToolContent; decided: boolean } {
		return { content: { kind: "text", value: cloudToolJsonText(this.#settledValue(routine)) }, decided: true };
	}
}
