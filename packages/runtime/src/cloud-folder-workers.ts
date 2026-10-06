import { createHash } from "node:crypto";
import {
	appendWorkerFollowUp,
	COMPANY_STATE_FILE_MAX_BYTES,
	parseCompanyStateFile,
	type TodoFile,
	type WorkerResultsFile,
	workerKeyProblem,
	workerStandingTexts,
	workerTextNormal,
	writeWorkerBriefFile,
	writeWorkerResultsFile,
} from "@qorpera/cloud-client/company-state-files";
import type { CloudCodingRepository, JsonValue } from "@qorpera/contracts";
import {
	type CloudCompanyFolderClient,
	type CloudCompanyFolderCommitResult,
	type CloudCompanyFolderUnit,
	type CloudCompanyFolderWorker,
	type CloudCompanyFolderWorkerPage,
	type CloudCompanyFolderWorkerRequest,
	CODING_ARCHIVE_REFUSALS,
	sha256,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyFolderRpcError } from "./cloud-company-path-refusal.ts";
import { hashedId } from "./cloud-folder-hiring.ts";
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
 * `manage_worker` and `report_work` as thin writers of a folder-v2 agent's worker files (deploy/first-node/
 * RUNTIME-COMPANY-STATE-FILES.md §8 "Plan (F2-5b)" §7): each worker is a folder `agents/<handle>/todos/<todo>/<worker>`
 * holding `brief.md` (what it was asked) and `results.md` (what it reported, and the agent's decision). The platform's
 * worker tool writes them as the run, through `qorpera_folder_worker_commit`, which carries the tool's request so the
 * folder core's hook checks the files against it and indexes the worker in the same transaction (F2-5b-2). The commit
 * starts nothing: the worker drain (F2-5b-3) dispatches and revives.
 *
 * - dispatch: the todo's folder when it is missing, and the worker's folder with its brief; delegation, so the save
 *   carries the automatic review's approval of this call (C2 R1).
 * - followup: the brief with one more follow-up, and its earlier results removed; delegation too.
 * - decide: the results with the agent's decision; plain.
 * - report (the worker's own run): its results; plain.
 * - cancel: a run effect under its own receipt (`qorpera_folder_cancel_agent_worker`); no file.
 * - archive: a coding session's, a run effect too (`qorpera_folder_archive_coding_worker`, C3b); no file.
 *
 * A coding session is a worker whose brief names its harness and repository (C3a): the database checks it as the legacy
 * dispatch did and queues its session, and the executor's claim starts it.
 * - status: one todo's workers from the worker index, and one worker's whole results, read from its file.
 *
 * As the todo writer does, a call refuses before its receipt only what can never succeed, and every such check still
 * passes once the call's own change is saved, so a replay of the same call reaches its receipt and its stored result.
 */

const TOOL_VERSION = "folder-v2/1";
/** A todo's file name is its key (§1 "Names"), as manage_todo's. */
const TODO_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TODO_NAME_BYTES = 64;
/** A worker's folder, as the worker wake names it (its outputFolder). */
const WORKER_FOLDER =
	/^agents\/([a-z0-9]+(?:-[a-z0-9]+)*)\/todos\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface CloudFolderWorkerChange {
	readonly action: "dispatch" | "followup" | "decide" | "cancel" | "archive";
	readonly operationKey: string;
	readonly todoKey: string;
	readonly workerKey: string;
	readonly title?: string;
	readonly goal?: string;
	readonly definitionOfDone?: string;
	readonly context?: string;
	readonly sources?: readonly string[];
	readonly access?: "read" | "write";
	readonly revival?: "batch" | "each";
	readonly species?: "in-house" | "coding";
	readonly harness?: "codex" | "claude-code";
	readonly repository?: CloudCodingRepository;
	readonly owner?: string;
	readonly text?: string;
	readonly decision?: "accept" | "reject";
	readonly note?: string;
}

export interface CloudFolderWorkerStatus {
	readonly todoKey?: string;
	readonly workerKey?: string;
	readonly state?: string;
	readonly search?: string;
	readonly cursor?: string;
}

export interface CloudFolderWorkerReport {
	readonly operationKey: string;
	readonly outcome: "succeeded" | "blocked" | "failed";
	readonly summary: string;
	readonly needs?: string;
	readonly outputs?: readonly string[];
}

/** One release id per tool call and output, as the todo writer's (a replay showing the same read reuses it). */
function releaseIdFor(runId: string, callId: string, outputSha256: string): string {
	const hex = createHash("sha256")
		.update(`qorpera.worker-release/v1:${runId}:${callId}:${outputSha256}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A writer's refusal of model text (a line that would start a section, a path the file cannot hold), in its words. */
function written<T>(write: () => T): T {
	try {
		return write();
	} catch (error) {
		if (error instanceof Error && !(error instanceof CloudToolRefusal)) throw new CloudToolRefusal(error.message);
		throw error;
	}
}

const NO_WORKER = "You have no worker with that workerKey in that todo";
const NO_TODO = "You have no todo with that todoKey: create it with manage_todo first";

/** The run agent's workers as folders of its todos. `handle` is the agent's folder name from the run context; a worker
 * run's `outputFolder` is its own folder, from its wake. */
export class CloudFolderWorkers {
	readonly #folder: CloudCompanyFolderClient;
	readonly #operations: CloudNativeToolOperations;
	readonly #identity: CloudNativeToolIdentity;
	readonly #todos: string;
	readonly #outputFolder: string | undefined;

	constructor(options: {
		folder: CloudCompanyFolderClient;
		operations: CloudNativeToolOperations;
		identity: CloudNativeToolIdentity;
		handle: string;
		outputFolder?: string;
	}) {
		this.#folder = options.folder;
		this.#operations = options.operations;
		this.#identity = options.identity;
		this.#todos = `agents/${options.handle}/todos`;
		this.#outputFolder = options.outputFolder;
	}

	/** A todo's folder and a worker's in it, or a refusal the model can act on. */
	#where(todoKey: string, workerKey?: string): { todo: string; todoFolder: string; folder: string } {
		if (!TODO_NAME.test(todoKey) || Buffer.byteLength(todoKey) > TODO_NAME_BYTES)
			throw new CloudToolRefusal(
				"In this company a todoKey is the todo's file name: lowercase letters, digits and single hyphens, at most 64 characters",
			);
		const problem = workerKey === undefined ? null : workerKeyProblem(workerKey);
		if (problem) throw new CloudToolRefusal(`In this company a workerKey names the worker's folder: ${problem}`);
		const todoFolder = `${this.#todos}/${todoKey}`;
		return { todo: `${todoFolder}.md`, todoFolder, folder: `${todoFolder}/${workerKey ?? ""}` };
	}

	async change(request: CloudFolderWorkerChange, context: CloudToolContext): Promise<CloudToolContent> {
		const where = this.#where(request.todoKey, request.workerKey);
		if (request.action === "cancel") return this.#cancel(request, where.folder, context);
		if (request.action === "archive") return this.#archive(request, where.folder, context);
		// A commit no one can complete would fence this run's later operations: refuse before writing anything.
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const signal = context.signal;
		const now = new Date().toISOString();
		if (request.action === "dispatch") {
			const actionReviewId = this.#approval(context);
			const found = await this.#folder.readText(where.todo, COMPANY_STATE_FILE_MAX_BYTES, signal);
			const parsed = found ? parseCompanyStateFile(where.todo, found.text) : null;
			const todo: TodoFile | null = parsed?.ok && parsed.file.kind === "todo" ? parsed.file : null;
			if (!todo) throw new CloudToolRefusal(NO_TODO);
			if (todo.status !== "open" && todo.status !== "blocked")
				throw new CloudToolRefusal("That todo is closed: a worker belongs to an open or blocked todo");
			const species = request.species ?? "in-house";
			// A coding session's brief names its harness and repository: without them it can never be written.
			if (species === "coding" && (request.harness === undefined || request.repository === undefined))
				throw new CloudToolRefusal("A coding session needs a harness, a repository and read access");
			const coding =
				species === "coding" && request.harness !== undefined && request.repository !== undefined
					? { harness: request.harness, repository: request.repository }
					: undefined;
			const id = hashedId("qorpera.folder-worker/v1", this.#identity.runId, request.operationKey);
			const access = request.access ?? "read";
			const revival = request.revival ?? "batch";
			const goal = workerTextNormal(request.goal ?? "");
			const doneWhen = workerTextNormal(request.definitionOfDone ?? "");
			const briefContext = request.context === undefined ? "" : workerTextNormal(request.context);
			const sources = [...(request.sources ?? [])];
			const brief = written(() =>
				writeWorkerBriefFile({
					id,
					title: request.title ?? "",
					species,
					...coding,
					access,
					revival,
					dispatchedAt: now,
					followUps: 0,
					followedUpAt: null,
					goal,
					doneWhen,
					context: briefContext || null,
					sources,
					...workerStandingTexts({ species, access, revival }),
					followUp: null,
				}),
			);
			const units: CloudCompanyFolderUnit[] = [];
			// The folder core never invents a parent folder.
			if (!(await this.#folder.read(where.todoFolder, signal)).entry)
				units.push({ op: "mkdir", path: where.todoFolder });
			units.push({
				op: "new_folder",
				path: where.folder,
				contents: [{ path: "brief.md", kind: "file", content: { text: brief, mediaType: "text/markdown" } }],
			});
			return this.#commit(
				request,
				context,
				units,
				{
					action: "dispatch",
					folder: where.folder,
					title: request.title ?? "",
					access,
					revival,
					goal,
					doneWhen,
					context: briefContext || null,
					sources,
					// The database checks a coding session's fields, and refuses them on an in-house worker.
					...(request.species === undefined ? {} : { species: request.species }),
					...(request.harness === undefined ? {} : { harness: request.harness }),
					...(request.repository === undefined ? {} : { repository: request.repository }),
					...(request.owner === undefined ? {} : { owner: request.owner }),
				},
				{
					action: "dispatch",
					todoKey: request.todoKey,
					workerKey: request.workerKey,
					title: request.title ?? "",
					goal,
					definitionOfDone: doneWhen,
					context: briefContext,
					sources,
					access,
					revival,
					...(request.species === undefined ? {} : { species: request.species }),
					...(request.harness === undefined ? {} : { harness: request.harness }),
					...(request.repository === undefined ? {} : { repository: { ...request.repository } }),
					...(request.owner === undefined ? {} : { owner: request.owner }),
				},
				`${where.folder}/brief.md`,
				actionReviewId,
				coding ? { harness: coding.harness, branch: `qorpera/coding/${id}` } : undefined,
			);
		}
		if (request.action === "followup") {
			const actionReviewId = this.#approval(context);
			const briefPath = `${where.folder}/brief.md`;
			const brief = await this.#folder.readText(briefPath, COMPANY_STATE_FILE_MAX_BYTES, signal);
			if (!brief) throw new CloudToolRefusal(NO_WORKER);
			const results = (await this.#folder.read(`${where.folder}/results.md`, signal)).entry;
			const text = workerTextNormal(request.text ?? "");
			const next = written(() => appendWorkerFollowUp(briefPath, brief.text, text, now));
			const units: CloudCompanyFolderUnit[] = [
				{
					op: "write",
					path: briefPath,
					content: { text: next, mediaType: "text/markdown" },
					expectedVersion: brief.entry.version,
				},
			];
			// The earlier report goes with the follow-up: the worker reports again.
			if (results)
				units.push({ op: "delete", path: `${where.folder}/results.md`, expectedVersion: results.version });
			return this.#commit(
				request,
				context,
				units,
				{ action: "followup", folder: where.folder, text, resultsVersion: results?.version ?? null },
				{ action: "followup", todoKey: request.todoKey, workerKey: request.workerKey, text },
				briefPath,
				actionReviewId,
			);
		}
		// decide
		const resultsPath = `${where.folder}/results.md`;
		const found = await this.#folder.readText(resultsPath, COMPANY_STATE_FILE_MAX_BYTES, signal);
		const parsed = found ? parseCompanyStateFile(resultsPath, found.text) : null;
		const results: WorkerResultsFile | null =
			parsed?.ok && parsed.file.kind === "worker-results" ? parsed.file : null;
		if (!found || !results)
			throw new CloudToolRefusal(
				"That worker has no report to decide on: a worker that failed or was cancelled without reporting is not decided",
			);
		const decision = request.decision === "accept" ? "accepted" : "rejected";
		if (decision === "accepted" && results.outcome !== "succeeded")
			throw new CloudToolRefusal("Only a succeeded worker's result is accepted: reject it, or follow it up");
		const note = request.note === undefined ? null : workerTextNormal(request.note) || null;
		const { kind: _kind, ...file } = results;
		const next = written(() => writeWorkerResultsFile({ ...file, decision, note }));
		return this.#commit(
			request,
			context,
			[
				{
					op: "write",
					path: resultsPath,
					content: { text: next, mediaType: "text/markdown" },
					expectedVersion: found.entry.version,
				},
			],
			{ action: "decide", folder: where.folder, decision, note },
			{ action: "decide", todoKey: request.todoKey, workerKey: request.workerKey, decision, note },
			resultsPath,
			undefined,
		);
	}

	/** The worker run's report: its results file, in the folder its wake names. */
	async report(request: CloudFolderWorkerReport, context: CloudToolContext): Promise<CloudToolContent> {
		const folder = this.#outputFolder;
		const match = folder === undefined ? null : WORKER_FOLDER.exec(folder);
		if (!folder || !match || `agents/${match[1]}/todos` !== this.#todos)
			throw new Error("This worker's folder is not known");
		if (!this.#operations.completesFolderCommits) throw new Error("This run cannot complete folder writes");
		const signal = context.signal;
		const resultsPath = `${folder}/results.md`;
		const text = written(() =>
			writeWorkerResultsFile({
				outcome: request.outcome,
				reportedAt: new Date().toISOString(),
				decision: null,
				note: null,
				summary: workerTextNormal(request.summary),
				needs: request.needs === undefined ? null : workerTextNormal(request.needs),
				files: [...(request.outputs ?? [])],
			}),
		);
		const current = (await this.#folder.read(resultsPath, signal)).entry;
		const units: CloudCompanyFolderUnit[] = [
			{
				op: "write",
				path: resultsPath,
				content: { text, mediaType: "text/markdown" },
				...(current ? { expectedVersion: current.version } : {}),
			},
		];
		return this.#operations.execute({
			operation: {
				tool: "report_work",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `worker-report:${request.operationKey}`,
				arguments: {
					outcome: request.outcome,
					summary: workerTextNormal(request.summary),
					...(request.needs === undefined ? {} : { needs: workerTextNormal(request.needs) }),
					outputs: [...(request.outputs ?? [])],
				},
				target: { path: resultsPath },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const staged = await this.#folder.stage(units, performSignal);
				const committed = await this.#folder.workerCommitStaged(
					`worker-report:${request.operationKey}`,
					staged,
					{ action: "report", folder },
					{ receiptId },
					performSignal,
				);
				const saved = this.#unit(committed, "first");
				const output = cloudToolJsonText({
					schema: "qorpera.worker-report-receipt/v1",
					runId: this.#identity.runId,
					receiptId,
					outcome: saved.outcome,
					...(saved.reason ? { reason: saved.reason } : {}),
					...(saved.problems.length ? { problems: saved.problems } : {}),
					report: { outcome: request.outcome, path: resultsPath },
					next:
						saved.outcome === "saved"
							? "Your report is saved and your parent has it: stop now."
							: "The report was not saved: correct what the problems name and report again with a new operationKey.",
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}

	/** One todo's workers, newest first, as many as fit one result (`fits`); `workerKey` shows one worker with its whole
	 * results, read from its file and released with the result. */
	async status(
		request: CloudFolderWorkerStatus,
		context: CloudToolContext,
		fits: (text: string) => boolean,
	): Promise<CloudToolContent> {
		if (request.todoKey === undefined)
			throw new CloudToolArgumentRefusal(
				"In this company status lists the workers of one todo: name its todoKey (manage_todo list shows your todos)",
			);
		const signal = context.signal;
		const where = this.#where(request.todoKey, request.workerKey);
		let page: CloudCompanyFolderWorkerPage;
		try {
			// The index filters and pages (16 at most, newest first): only what one result can show crosses the wire.
			page = await this.#folder.agentWorkers(
				{
					todoKey: request.todoKey,
					...(request.workerKey === undefined ? {} : { workerKey: request.workerKey }),
					...(request.state === undefined ? {} : { state: request.state }),
					...(request.search === undefined ? {} : { search: request.search }),
					...(request.cursor === undefined ? {} : { cursor: request.cursor }),
				},
				signal,
			);
		} catch (error) {
			if (error instanceof CloudCompanyFolderRpcError && error.code === "P0002")
				throw request.cursor === undefined
					? new CloudToolRefusal(NO_TODO)
					: new CloudToolArgumentRefusal(
							"cursor must be a nextCursor from an earlier page of this todo, unchanged; if it is refused, start again without it",
						);
			throw error;
		}
		const shown = page.workers;
		const frame = { schema: "qorpera.agent-workers/v1", runId: this.#identity.runId, todoKey: request.todoKey };
		const view = ({ folder, cursor: _cursor, ...worker }: CloudCompanyFolderWorker & { cursor?: string }) => ({
			...worker,
			path: folder,
		});
		if (request.workerKey !== undefined) {
			const one = shown[0];
			const resultsPath = `${where.folder}/results.md`;
			const found = one ? await this.#folder.readText(resultsPath, COMPANY_STATE_FILE_MAX_BYTES, signal) : null;
			const parsed = found ? parseCompanyStateFile(resultsPath, found.text) : null;
			const results = parsed?.ok && parsed.file.kind === "worker-results" ? parsed.file : null;
			const output = cloudToolJsonText({
				...frame,
				workers: one
					? [
							{
								...view(one),
								...(results
									? {
											summary: results.summary,
											needs: results.needs,
											outputs: results.files,
											results: resultsPath,
										}
									: {}),
							},
						]
					: [],
				moreWorkers: 0,
				nextCursor: null,
			});
			if (found && results) {
				const outputSha256 = sha256(new TextEncoder().encode(output));
				await this.#folder.release(
					releaseIdFor(this.#identity.runId, context.callId, outputSha256),
					[
						{
							path: found.entry.path,
							version: found.entry.version,
							authority: found.entry.authority,
							fileSha256: found.entry.file.fileSha256,
						},
					],
					outputSha256,
					signal,
				);
			}
			return { kind: "text", value: output };
		}
		const render = (count: number) => {
			const left = page.moreWorkers + shown.length - count;
			return cloudToolJsonText({
				...frame,
				workers: shown.slice(0, count).map(view),
				moreWorkers: left,
				nextCursor: left === 0 ? null : (shown[count - 1]?.cursor ?? null),
			});
		};
		// Grown from one worker, so a wide page is never rendered whole.
		let count = Math.min(shown.length, 1);
		while (count < shown.length && fits(render(count + 1))) count++;
		return { kind: "text", value: render(count) };
	}

	/** The automatic review's approval of this call, which a dispatch or follow-up (delegation) carries. */
	#approval(context: CloudToolContext): string {
		if (!context.actionReviewId)
			throw new CloudToolRefusal(
				"Starting or steering a worker needs the automatic review's approval of this call, and it has none: call again, and if this repeats tell the member",
			);
		return context.actionReviewId;
	}

	/** The unit that says how the change set went: a dispatch's worker folder (its last unit; a todo folder another
	 * dispatch made first is no failure), a follow-up's brief (its first), and the one file of a decision or a report. */
	#unit(committed: CloudCompanyFolderCommitResult, decisive: "first" | "last") {
		const unit = decisive === "first" ? committed.units[0] : committed.units.at(-1);
		if (!unit) throw new Error("Company folder commit answered no unit");
		return unit;
	}

	async #commit(
		request: CloudFolderWorkerChange,
		context: CloudToolContext,
		units: readonly CloudCompanyFolderUnit[],
		workerRequest: CloudCompanyFolderWorkerRequest,
		args: JsonValue,
		path: string,
		actionReviewId: string | undefined,
		coding?: { readonly harness: string; readonly branch: string },
	): Promise<CloudToolContent> {
		const folder = workerRequest.folder;
		return this.#operations.execute({
			operation: {
				tool: "manage_worker",
				toolVersion: TOOL_VERSION,
				logicalOperationKey: `worker-file:${request.operationKey}`,
				arguments: args,
				target: { path: folder },
				requiresCompanyRevision: true,
			},
			// The folder core decides at the commit, under this call's receipt.
			authorize: async () => {},
			perform: async (_operation, { receiptId, signal: performSignal }) => {
				const staged = await this.#folder.stage(units, performSignal);
				const reviewId =
					actionReviewId === undefined
						? undefined
						: await this.#folder.recordReview(
								{ actionReviewId, tool: "manage_worker", argumentSha256: context.argumentSha256 },
								staged,
								performSignal,
							);
				const committed = await this.#folder.workerCommitStaged(
					`worker-file:${request.operationKey}`,
					staged,
					workerRequest,
					{ ...(reviewId === undefined ? {} : { reviewId }), receiptId },
					performSignal,
				);
				const saved = this.#unit(committed, request.action === "dispatch" ? "last" : "first");
				const output = cloudToolJsonText({
					schema: "qorpera.agent-worker-receipt/v1",
					runId: this.#identity.runId,
					receiptId,
					action: request.action,
					outcome: saved.outcome,
					...(saved.reason ? { reason: saved.reason } : {}),
					...(saved.problems.length ? { problems: saved.problems } : {}),
					todoKey: request.todoKey,
					worker: { workerKey: request.workerKey, path: folder, file: path },
					// A coding session waits for its machine: the executor's claim starts it (C3a).
					...(coding && saved.outcome === "saved" ? { coding: { phase: "queued", ...coding } } : {}),
					next:
						saved.outcome === "saved"
							? request.action === "decide"
								? "Your decision is recorded."
								: coding
									? "The coding session is queued for its machine and starts by itself; its result comes back to you by itself: tell the member in one sentence what is running and end your turn; do not wait or poll."
									: "The worker starts shortly and its result comes back to you by itself: tell the member in one sentence what is running and end your turn; do not wait or poll."
							: saved.outcome === "conflict"
								? "The worker's files changed since they were read: call again with a new operationKey."
								: "Nothing was changed: say why to the member, or correct the arguments and call again with a new operationKey.",
				});
				return { content: { kind: "text", value: output }, folderCommitId: committed.commitId };
			},
			signal: context.signal,
			...(context.observation ? { observation: context.observation } : {}),
		});
	}

	/** A coding session's archive (C3b): SQL's refusal (not a coding session, or a new turn since the agent was asked)
	 * is the tool's answer, in SQL's words. */
	async #archive(
		request: CloudFolderWorkerChange,
		folder: string,
		context: CloudToolContext,
	): Promise<CloudToolContent> {
		let archived: Awaited<ReturnType<CloudCompanyFolderClient["archiveCodingWorker"]>>;
		try {
			archived = await this.#folder.archiveCodingWorker(
				{ folder, operationKey: request.operationKey },
				context.signal,
			);
		} catch (error) {
			if (error instanceof CloudCompanyFolderRpcError && error.code === "P0002")
				throw new CloudToolRefusal(NO_WORKER);
			if (error instanceof CloudCompanyFolderRpcError && CODING_ARCHIVE_REFUSALS.has(error.detail))
				throw new CloudToolRefusal(
					error.code === "22023"
						? "Only a coding session can be archived: cancel an in-house worker instead"
						: "The session has a new turn since you were asked; leave it",
				);
			throw error;
		}
		const { folder: path, ...worker } = archived.worker;
		return {
			kind: "text",
			value: cloudToolJsonText({
				schema: "qorpera.agent-worker-receipt/v1",
				runId: this.#identity.runId,
				receiptId: archived.receiptId,
				action: "archive",
				todoKey: request.todoKey,
				worker: { ...worker, path },
				coding: { phase: archived.phase, archived: archived.archived },
			}),
		};
	}

	async #cancel(
		request: CloudFolderWorkerChange,
		folder: string,
		context: CloudToolContext,
	): Promise<CloudToolContent> {
		let cancelled: Awaited<ReturnType<CloudCompanyFolderClient["cancelWorker"]>>;
		try {
			cancelled = await this.#folder.cancelWorker({ folder, operationKey: request.operationKey }, context.signal);
		} catch (error) {
			if (error instanceof CloudCompanyFolderRpcError && error.code === "P0002")
				throw new CloudToolRefusal(NO_WORKER);
			throw error;
		}
		const { folder: path, ...worker } = cancelled.worker;
		return {
			kind: "text",
			value: cloudToolJsonText({
				schema: "qorpera.agent-worker-receipt/v1",
				runId: this.#identity.runId,
				receiptId: cancelled.receiptId,
				action: "cancel",
				todoKey: request.todoKey,
				worker: { ...worker, path },
			}),
		};
	}
}
