import { createHash } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	CloudCompanyFolderError,
	type CloudCompanyFolderRelease,
	type CloudCompanyFolderUnit,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import {
	type CloudCompanyPathGateway,
	CloudCompanyPathNotText,
	type CloudCompanyPathResult,
} from "./cloud-company-path-gateway.ts";
import {
	CloudCompanyPathParentMissing,
	CloudCompanyPathToolRefusal,
	CloudCompanyPathVersionChanged,
} from "./cloud-company-path-refusal.ts";
import {
	type CloudNativeTool,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import { CloudRuntimeDiagnosticError } from "./cloud-runtime-observability.ts";

/*
 * Memory and skills on folder-v2 (folder core slice P20, core C3): the trusted reads and writes the notebook and skill
 * tools make (the legacy gateway's readTrusted, listTrusted and mutate), through the folder core as the run, so the
 * same tools and the same composition serve a folder-v2 run.
 * - Every entry read is recorded. A tool call's reads are released with the run actor under the hash of exactly the text
 *   the call answers, before the answer leaves the tool. The reads that compose the run's context (the notebook and the
 *   skill catalog in the prompt) are released once, under the hash of the composed context, before the first model
 *   request (the folder client's rule for context composition).
 * - A change is a one-unit change set under the tool call's receipt. The folder core decides it: a stale version is the
 *   gateway's version change (the tools read again and redo under a new key), a missing folder its parent-missing, a
 *   denial its access refusal. A deletion is reviewed: update_skill's deletion of a skill in the agent's own library
 *   records the automatic review's approval of the call, as company_delete's does (20260930001200); any other is
 *   refused before anything is written.
 */

export type CloudFolderNotebookGateway = Pick<CloudCompanyPathGateway, "readTrusted" | "listTrusted" | "mutate">;

/** As the legacy trusted read: a notebook or skill file is at most 32 KiB of text. */
const MAX_TEXT_BYTES = 32 * 1024;
/** A notebook's months and a skill library list whole; this bounds one listing. */
const MAX_LISTED = 10_000;
/** What the core records in one release; more reads go in several, all with the answer's hash. */
const MAX_RELEASED = 10_000;
const TOOL_VERSION = "folder-v2/1";
/** As the legacy trusted read: a leading byte order mark is not part of the text. */
const TEXT = new TextDecoder("utf-8", { fatal: true });

/** One release id per run, purpose and output (and part): the same text released again replays under the same id. */
function releaseId(runId: string, purpose: string, outputSha256: string, part: number): string {
	const hex = createHash("sha256")
		.update(`qorpera.folder-notebook-release/v1:${runId}:${purpose}:${outputSha256}:${part}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The reads one answer drew on, by path and version. */
type Reads = Map<string, CloudCompanyFolderRelease>;

async function release(
	folder: CloudCompanyFolderClient,
	runId: string,
	purpose: string,
	reads: Reads,
	outputSha256: string,
	signal: AbortSignal,
): Promise<void> {
	const all = [...reads.values()];
	for (let part = 0; part * MAX_RELEASED < all.length; part++)
		await folder.release(
			releaseId(runId, purpose, outputSha256, part),
			all.slice(part * MAX_RELEASED, (part + 1) * MAX_RELEASED),
			outputSha256,
			signal,
		);
}

/** A tool call's change: the tool that makes it, its context and receipts, and the run agent's folder. */
interface Changes {
	readonly tool: string;
	readonly context: CloudToolContext;
	readonly operations: CloudNativeToolOperations;
	readonly agentFolder: string;
	changed: boolean;
}

function gateway(folder: CloudCompanyFolderClient, reads: Reads, changes: Changes | null): CloudFolderNotebookGateway {
	const remember = (entry: CloudCompanyFolderEntry) =>
		reads.set(`${entry.path}\n${entry.version}`, cloudCompanyFolderRelease(entry));
	return {
		async readTrusted(pathValue, signal) {
			const path = parseCloudCompanyPath(pathValue);
			const { entry } = await folder.read(path, signal);
			if (!entry) return { path, version: null, kind: "absent", text: "", fileSha256: null };
			remember(entry);
			if (entry.kind === "folder")
				return { path, version: entry.version, kind: "directory", text: "", fileSha256: null };
			if (entry.file.bytes > MAX_TEXT_BYTES)
				throw new CloudCompanyPathNotText("Company folder file exceeds its bound", entry.file.bytes);
			const bytes = await folder.readRange(entry, 0, entry.file.bytes, signal);
			let text: string;
			try {
				text = TEXT.decode(bytes);
			} catch {
				throw new CloudCompanyPathNotText(undefined, entry.file.bytes);
			}
			return { path, version: entry.version, kind: "file", text, fileSha256: entry.file.fileSha256 };
		},
		async listTrusted(pathValue, signal) {
			const path = parseCloudCompanyPath(pathValue, true);
			const { entries } = await folder.listAll(path, { maxEntries: MAX_LISTED }, signal);
			for (const entry of entries) remember(entry);
			return entries.map((entry) => ({
				path: entry.path,
				version: entry.version,
				kind: entry.kind === "file" ? ("file" as const) : ("directory" as const),
				bytes: entry.kind === "file" ? entry.file.bytes : null,
			}));
		},
		async mutate(operation, input, signal): Promise<CloudCompanyPathResult> {
			if (!changes) throw new Error("A folder change runs inside a tool call");
			// A commit no one can complete would fence this run's later operations: refuse before writing anything.
			if (!changes.operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
			if (input.source !== undefined) throw new Error("A notebook or skill change writes text only");
			const path = parseCloudCompanyPath(input.path);
			let unit: CloudCompanyFolderUnit;
			if (operation === "write") {
				if (typeof input.text !== "string") throw new Error("Invalid Company folder text write");
				unit = {
					op: "write",
					path,
					content: { text: input.text },
					...(input.expectedVersion === null ? {} : { expectedVersion: input.expectedVersion }),
				};
			} else if (operation === "mkdir") unit = { op: "mkdir", path };
			else {
				if (input.expectedVersion === null) throw new Error("A deletion names the version it deletes");
				unit = { op: "delete", path, expectedVersion: input.expectedVersion };
			}
			// A deletion is reviewed (C1B §6). update_skill's of the agent's own skill records the automatic review's
			// approval of the call, as company_delete's (P20, 20260930001200); the recorder takes no other.
			let review: string | undefined;
			if (operation === "delete" && changes.tool === "update_skill") {
				const own = `${changes.agentFolder}/skills/`.toLowerCase();
				review = changes.context.actionReviewId;
				// Refused before any receipt: another library, or no approval to record.
				if (!path.toLowerCase().startsWith(own) || path.length <= own.length || !review)
					throw new CloudCompanyPathToolRefusal();
			}
			// The tools key a change by the version it replaces. An absent path has none on folder-v2 (the legacy gateway
			// kept the version a deletion left), so creating it again later in the run, after a deletion, would replay the
			// first creation's receipt: such a change is keyed to its tool call too, which a replay of that call repeats.
			const operationKey =
				input.expectedVersion === null
					? `${input.operationKey}:${createHash("sha256").update(changes.context.callId).digest("hex").slice(0, 16)}`
					: input.operationKey;
			changes.changed = true;
			const content = await changes.operations.execute({
				operation: {
					tool: changes.tool,
					toolVersion: TOOL_VERSION,
					logicalOperationKey: operationKey,
					arguments: {
						op: operation,
						path,
						expectedVersion: input.expectedVersion,
						...(typeof input.text === "string"
							? { textSha256: createHash("sha256").update(input.text, "utf8").digest("hex") }
							: {}),
					},
					target: { path },
					requiresCompanyRevision: true,
				},
				// The folder core decides at the commit, under this call's receipt.
				authorize: async () => {},
				perform: async (_operation, { receiptId, signal: performSignal }) => {
					// The commit's operation key for the tool's: fixed length, and distinct per tool.
					const key = `${changes.tool}:${createHash("sha256").update(operationKey).digest("hex")}`;
					let committed: Awaited<ReturnType<CloudCompanyFolderClient["commit"]>>;
					if (review === undefined) committed = await folder.commit(key, [unit], { receiptId }, performSignal);
					else {
						const staged = await folder.stage([unit], performSignal);
						const reviewId = await folder.recordReview(
							{ actionReviewId: review, tool: changes.tool, argumentSha256: changes.context.argumentSha256 },
							staged,
							performSignal,
						);
						committed = await folder.commitStaged(key, staged, { reviewId, receiptId }, performSignal);
					}
					const result = committed.units[0];
					if (!result) throw new Error("Company folder commit answered no unit");
					return {
						content: {
							kind: "text",
							value: cloudToolJsonText({
								schema: "qorpera.folder-notebook-change/v1",
								receiptId,
								outcome: result.outcome,
								reason: result.reason,
								version: result.version,
							}),
						},
						folderCommitId: committed.commitId,
					};
				},
				signal,
			});
			const answer = JSON.parse(String(content.value)) as {
				receiptId: string;
				outcome: string;
				reason: string | null;
				version: string | null;
			};
			const result = {
				schema: "qorpera.company-path-result/v1" as const,
				operationKey: input.operationKey,
				path,
				snapshotId: null,
				receiptId: answer.receiptId,
				proposalId: null,
			};
			if (answer.outcome === "saved") return { ...result, state: "applied", version: answer.version };
			if (answer.outcome === "waiting_for_review") return { ...result, state: "proposed", version: null };
			if (answer.outcome === "conflict") throw new CloudCompanyPathVersionChanged();
			if (answer.reason === "parent_missing") throw new CloudCompanyPathParentMissing();
			if (answer.outcome === "denied") throw new CloudCompanyPathToolRefusal();
			throw new CloudRuntimeDiagnosticError(
				"invalid_arguments",
				`Company folder refused the change (${answer.reason ?? "refused"})`,
			);
		},
	};
}

/** A folder-v2 run's notebook and skill files: the gateway its context composes through, and its tools' gateways. */
export class CloudFolderNotebooks {
	readonly #folder: CloudCompanyFolderClient;
	readonly #runId: string;
	readonly #agentFolder: string;
	readonly #composed: Reads = new Map();
	/** The gateway context composition reads through; it changes nothing. */
	readonly composition: CloudFolderNotebookGateway;

	constructor(options: { folder: CloudCompanyFolderClient; runId: string; agentFolder: string }) {
		this.#folder = options.folder;
		this.#runId = options.runId;
		this.#agentFolder = options.agentFolder;
		this.composition = gateway(this.#folder, this.#composed, null);
	}

	/** Releases what composition read under the hash of the composed context, once, before the first model request, with
	 * the paths the context names besides (`named`: the listed proposals' reads, P40b). */
	async releaseComposition(
		contextSha256: string,
		signal: AbortSignal,
		named: readonly CloudCompanyFolderRelease[] = [],
	): Promise<void> {
		for (const read of named) this.#composed.set(`${read.path}\n${read.version ?? ""}`, read);
		if (this.#composed.size === 0) return;
		await release(this.#folder, this.#runId, "context", this.#composed, contextSha256, signal);
		this.#composed.clear();
	}

	/** The tools `make` builds, each call through a gateway of its own: what it read is released under its answer, and
	 * each change is made under a receipt of `operations`. */
	tools(
		make: (gateway: CloudFolderNotebookGateway) => readonly CloudNativeTool[],
		operations: CloudNativeToolOperations,
	): CloudNativeTool[] {
		return make(gateway(this.#folder, new Map(), null)).map((tool) => ({
			...tool,
			execute: async (value, context: CloudToolContext): Promise<CloudToolContent> => {
				const reads: Reads = new Map();
				const changes: Changes = {
					tool: tool.name,
					context,
					operations,
					agentFolder: this.#agentFolder,
					changed: false,
				};
				const own = make(gateway(this.#folder, reads, changes)).find((candidate) => candidate.name === tool.name);
				if (!own) throw new Error("Notebook tool is missing");
				const content = await own.execute(value, context);
				if (reads.size === 0) return content;
				const text = content.kind === "text" ? content.value : cloudToolJsonText(content.value);
				try {
					await release(
						this.#folder,
						this.#runId,
						context.callId,
						reads,
						createHash("sha256").update(text, "utf8").digest("hex"),
						context.signal,
					);
				} catch (error) {
					// Before any change, nothing happened and the model is told why; after one, the outcome is unknown.
					if (!changes.changed && error instanceof CloudCompanyFolderError)
						throw new CloudToolRefusal(
							error.failure === "read_revoked"
								? "READ_REVOKED: something this answer drew on may no longer be read by you, so it is not shown; try again"
								: error.failure === "stopped"
									? "COMPANY_WORK_STOPPED: the company's work is stopped, so this answer is not shown"
									: `COMPANY_FOLDER_UNAVAILABLE: what this answer read could not be recorded (${error.failure}), so it is not shown; try again`,
						);
					throw error;
				}
				return content;
			},
		}));
	}
}
