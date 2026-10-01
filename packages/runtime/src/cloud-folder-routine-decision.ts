import {
	COMPANY_STATE_FILE_MAX_BYTES,
	type CompanyStateSetting,
	parseCompanyStateFile,
	setCompanyStateSettings,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudCompanyFolderClient } from "./cloud-company-folder-client.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
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
 * The file is read first, outside the receipt; the receipt binds the model's request, and the commit carries the
 * version read, so a file changed in between is a conflict the model decides again.
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

/** The text with its body (after the settings block) replaced. */
function withBody(text: string, body: string): string {
	const lines = text.split("\n");
	const close = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, "") === "---");
	if (close < 0) throw new Error("The file has no settings block");
	return `${lines.slice(0, close + 1).join("\n")}\n${body.trim()}\n`;
}

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
		const parsed = found ? parseCompanyStateFile(this.#path, found.text) : null;
		if (!found || !parsed?.ok || parsed.file.kind !== "routine")
			throw new CloudToolArgumentRefusal(
				"This run's routine file is missing or does not read as a routine; a member must correct it",
			);
		let text: string;
		if (request.action === "conclude") {
			text = setCompanyStateSettings(found.text, { status: "concluded", conclusion: request.summary ?? "" });
		} else {
			const changes: Record<string, CompanyStateSetting> = { at: request.at ?? "" };
			if (request.effort !== undefined) changes.effort = request.effort;
			if (request.report !== undefined) changes.reply = request.report;
			if (request.title !== undefined) changes.title = request.title;
			text = setCompanyStateSettings(found.text, changes);
			if (request.intent !== undefined) text = withBody(text, request.intent);
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
									...(request.action === "next" ? { at: request.at } : { conclusion: request.summary }),
								},
							}
						: {
								schema: "qorpera.agent-routine-decision/v1",
								runId: this.#identity.runId,
								state: "refused",
								reason:
									written.outcome === "conflict"
										? "The routine's file changed since it was read: decide again"
										: written.outcome === "denied" || written.outcome === "waiting_for_review"
											? "A decision that changes the routine's title or instructions needs a member's review, which this company cannot record yet: decide only the next time, effort or reply, or conclude"
											: written.problems.length
												? written.problems.map((problem) => problem.message).join("; ")
												: `Not saved (${written.reason ?? written.outcome})`,
							};
				return {
					content: { kind: "text", value: cloudToolJsonText(value) },
					folderCommitId: committed.commitId,
				};
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
		const value = JSON.parse(content.kind === "text" ? content.value : "{}") as { schema?: unknown };
		return { content, decided: value.schema === "qorpera.agent-routine-receipt/v1" };
	}
}
