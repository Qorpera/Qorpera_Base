import { createHash } from "node:crypto";
import {
	COMPANY_STATE_FILE_MAX_BYTES,
	type CompanyStateSetting,
	canonicalCompanyStateInstant,
	osPath,
	parseCompanyStateFile,
	type RoutineFile,
	setCompanyStateSettings,
	writeRoutineFile,
} from "@qorpera/cloud-client/company-state-files";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderFileEntry,
	sha256,
} from "./cloud-company-folder-client.ts";
import { invalidMessage } from "./cloud-folder-hiring.ts";
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
 * `decide_routine` as a thin writer of a folder-v2 dynamic routine's own file (deploy/first-node/
 * RUNTIME-COMPANY-STATE-FILES.md §2 "routines", §5): `QorperaOS/agents/<handle>/routines/<routineKey>.md`, whose name
 * is the routine's key. The run woken by the routine's `once` occurrence owes its end-of-run decision: a new `at` (with,
 * if needed, a new effort or reply), or `status: concluded` with a `conclusion`. F2-6's hook takes that save as the
 * decision while it is owed, without review. A next run that also rewrites the title or the instructions is
 * delegation (later runs read them as their request): it is written with the decision (`writeRoutineFile` from the
 * file's parse, every other key kept) and saved with the automatic review's approval of this call, recorded for
 * exactly that change set (C2 R1; thin writers W4c-2). The gate never raises a card for `decide_routine`, so only a
 * reviewer's allow reaches a rewrite.
 *
 * A new title or instructions are checked as a routine file with the arguments, before the review (`check`). The file
 * is read first, outside the receipt, and what can never be saved is refused there, binding no key: a rewritten file
 * that does not parse, a rewrite without the review's approval, a conclusion with a new title or instructions, or a
 * next run at or after the routine's end. A routine that already moved on (its file gone, no longer active, no longer a dynamic routine's
 * `once`, or past its end) is settled, as today: nothing is owed. The receipt binds the model's request, and the commit
 * carries the version read, so a file changed in between is a conflict the model decides again under a new operation
 * key. A plain decision the folder core calls delegation is one nothing is owed for any more (F2-6's review class), so
 * it is settled too. After a recorded review the core does not answer so; if it ever did, the rewrite is reported as not
 * saved, and the run decides again without it. A routine that expired while active is kept from revival by the past-end
 * settle alone (a paused routine's run cannot decide at all).
 *
 * The routine is the one this run was woken for: the file at its key must carry its id (the routine row is keyed by
 * the file's id). A member may rename the file while the run works; then the agent's routines folder is listed and the
 * file carrying that id is found. Only when no file holds this routine has it moved on. (The wake is not read again:
 * that read also claims the run's held coworker messages.)
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

/** One release id per tool call and output, as `manage_todo`'s. */
function releaseIdFor(runId: string, callId: string, outputSha256: string): string {
	const hex = createHash("sha256")
		.update(`qorpera.routine-release/v1:${runId}:${callId}:${outputSha256}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface Located {
	readonly path: string;
	readonly routineKey: string;
	readonly found: { entry: CloudCompanyFolderFileEntry; text: string };
	readonly routine: RoutineFile;
}

const INVALID = "This decision cannot be saved as the routine's file";
/** A dynamic routine to check a new title or instructions against before the review. */
const PLACEHOLDER: Omit<RoutineFile, "kind"> = {
	id: "00000000-0000-4000-8000-000000000000",
	title: "Routine",
	status: "active",
	trigger: { when: "once", at: "2030-01-01T00:00:00Z" },
	timezone: "Europe/Copenhagen",
	ends: null,
	runs: null,
	quiet: null,
	effort: "medium",
	reply: "optional",
	conclusion: null,
	instructions: "Routine.",
};

/** The parser's problems with a routine file's text. */
function problemsOf(path: string, text: string): readonly { message: string }[] {
	const parsed = parseCompanyStateFile(path, text);
	if (!parsed) return [{ message: `${path} is not a company state file` }];
	return parsed.ok ? [] : parsed.problems;
}

export class CloudFolderRoutineDecision {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	readonly #routines: string;
	readonly #routineKey: string;
	readonly #routineId: string;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		handle: string;
		/** The woken routine's key when the run started: its file's name. */
		routineKey: string;
		/** The woken routine's id, which its file carries. */
		routineId: string;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#routineKey = options.routineKey;
		this.#routineId = options.routineId;
		this.#routines = osPath(`agents/${options.handle}/routines`);
	}

	/** A new title or instructions, checked with the arguments before the automatic review: the routine file they make
	 * over a placeholder dynamic routine must read as one (a title is one line, without tabs or other controls). */
	check(request: CloudFolderRoutineDecisionRequest): void {
		if (request.action !== "next" || (request.title === undefined && request.intent === undefined)) return;
		const problems = problemsOf(
			`${this.#routines}/routine.md`,
			writeRoutineFile({
				...PLACEHOLDER,
				title: request.title ?? PLACEHOLDER.title,
				instructions: request.intent?.trim() ?? PLACEHOLDER.instructions,
			}),
		);
		if (problems.length) throw new CloudToolArgumentRefusal(invalidMessage(problems, INVALID));
	}

	/** This run's routine file: at its key, or, after a rename, the file in the routines folder that carries its id.
	 * Null when no file does. The file at its own key must read as a routine; another that doesn't is passed over. */
	async #locate(signal: AbortSignal): Promise<Located | null> {
		const at = async (routineKey: string, own: boolean): Promise<Located | null> => {
			const path = `${this.#routines}/${routineKey}.md`;
			const found = await this.#folder.readText(path, COMPANY_STATE_FILE_MAX_BYTES, signal);
			if (!found) return null;
			const parsed = parseCompanyStateFile(path, found.text);
			if (!parsed?.ok || parsed.file.kind !== "routine") {
				if (own) throw new CloudToolRefusal(UNREADABLE);
				return null;
			}
			return { path, routineKey, found, routine: parsed.file as RoutineFile };
		};
		const first = await at(this.#routineKey, true);
		if (first?.routine.id === this.#routineId) return first;
		// Renamed while this run worked: the routines folder, page by page.
		let after: string | undefined;
		for (;;) {
			const page = await this.#folder.list(this.#routines, after === undefined ? {} : { after }, signal);
			for (const entry of page.entries) {
				const name = entry.path.slice(this.#routines.length + 1);
				if (entry.kind !== "file" || !name.endsWith(".md") || name === `${this.#routineKey}.md`) continue;
				const moved = await at(name.slice(0, -3), false);
				if (moved?.routine.id === this.#routineId) return moved;
			}
			if (page.next === null) return null;
			after = page.next;
		}
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
		// Paused, concluded or rescheduled by a member since this run started, or past its end: nothing is owed, as today
		// (a rewrite would revive it). The answer shows the routine as read, released with it.
		if (
			routine.status !== "active" ||
			routine.trigger.when !== "once" ||
			(routine.ends !== null && Date.parse(routine.ends) <= Date.now())
		) {
			const settled = this.#settled(located);
			const output = String(settled.content.value);
			const outputSha256 = sha256(new TextEncoder().encode(output));
			await this.#folder.release(
				releaseIdFor(this.#identity.runId, context.callId, outputSha256),
				[
					{
						path,
						version: found.entry.version,
						authority: found.entry.authority,
						fileSha256: found.entry.file.fileSha256,
					},
				],
				outputSha256,
				signal,
			);
			return settled;
		}
		// A title or instructions equal to the file's change nothing, so they are not written.
		const title = request.title !== undefined && request.title !== routine.title ? request.title : undefined;
		const instructions =
			request.intent !== undefined && request.intent.trim() !== routine.instructions
				? request.intent.trim()
				: undefined;
		const rewrite = title !== undefined || instructions !== undefined;
		if (rewrite && request.action === "conclude")
			throw new CloudToolRefusal("A conclusion keeps the routine's title and instructions: conclude without them");
		const actionReviewId = context.actionReviewId;
		if (rewrite && !actionReviewId)
			throw new CloudToolRefusal(
				"New instructions or a new title need the automatic review's approval of this call, and it has none: decide next without intent or title, or call again",
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
			if (rewrite) {
				// The whole routine from the file's parse, with the decision and the new title or instructions.
				const { kind: _kind, ...kept } = routine;
				text = writeRoutineFile({
					...kept,
					title: title ?? routine.title,
					instructions: instructions ?? routine.instructions,
					trigger: { when: "once", at },
					effort: (request.effort as RoutineFile["effort"] | undefined) ?? routine.effort,
					reply: request.report ?? routine.reply,
				});
				// Checked again with the file it rewrites, before any receipt.
				const problems = problemsOf(path, text);
				if (problems.length) throw new CloudToolRefusal(invalidMessage(problems, INVALID));
			} else {
				const changes: Record<string, CompanyStateSetting> = { at };
				if (request.effort !== undefined) changes.effort = request.effort;
				if (request.report !== undefined) changes.reply = request.report;
				text = setCompanyStateSettings(found.text, changes);
			}
		}
		const units = [
			{
				op: "write" as const,
				path,
				content: { text, mediaType: "text/markdown" },
				expectedVersion: found.entry.version,
			},
		];
		const content = await this.#operations.execute({
			operation: {
				tool: "decide_routine",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `decide:${request.operationKey}`,
				arguments: { ...request },
				// The woken routine's path, whatever it is called now, so a retry after a rename is the same call.
				target: { path: `${this.#routines}/${this.#routineKey}.md` },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				let committed: Awaited<ReturnType<CloudCompanyFolderClient["commit"]>>;
				if (rewrite && actionReviewId) {
					// A rewrite is delegation: the review of exactly this change set goes with it.
					const staged = await this.#folder.stage(units, performSignal);
					const reviewId = await this.#folder.recordReview(
						{ actionReviewId, tool: "decide_routine", argumentSha256: context.argumentSha256 },
						staged,
						performSignal,
					);
					committed = await this.#folder.commitStaged(
						`decide-file:${request.operationKey}`,
						staged,
						{ reviewId, receiptId },
						performSignal,
					);
				} else
					committed = await this.#folder.commit(
						`decide-file:${request.operationKey}`,
						units,
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
									...(title !== undefined ? { title } : {}),
									...(instructions !== undefined ? { instructionsChanged: true } : {}),
								},
							}
						: // A plain decision the core calls delegation: nothing is owed any more (F2-6's review class).
							!rewrite && written.outcome === "denied" && written.reason === "review_required"
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
													: rewrite && written.reason === "review_required"
														? "The new title or instructions were not saved, and neither was the decision: decide again with a new operationKey, without intent or title"
														: written.reason === "review_denied"
															? `A member declined this change: ${AGAIN}`
															: written.outcome === "denied"
																? "This run may not change its routine's file; tell the member"
																: `Not saved (${written.reason ?? written.outcome}): ${AGAIN}`,
								};
				const output = cloudToolJsonText(value);
				// A settled answer shows the routine as read, and a saved one after a rename shows the name the file was
				// found under: release that read with it.
				if (value.state === "settled" || routineKey !== this.#routineKey)
					await this.#folder.release(
						receiptId,
						[
							{
								path,
								version: found.entry.version,
								authority: found.entry.authority,
								fileSha256: found.entry.file.fileSha256,
							},
						],
						sha256(new TextEncoder().encode(output)),
						performSignal,
					);
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
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
