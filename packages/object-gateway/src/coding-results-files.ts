import {
	COMPANY_STATE_PARSER_VERSION,
	isCompanyStateName,
	osRelative,
	parseCompanyStateFile,
	WORKER_TEXT_MAX_BYTES,
	type WorkerResultsFile,
	workerTextHeading,
	workerTextNormal,
	writeWorkerResultsFile,
} from "@qorpera/cloud-client/company-state-files";
import type { MemberCompanyAuthority } from "./member-company-authority.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import {
	commitUnitOutcome,
	drainPlatformClaims,
	PlatformFolderProblem,
	PlatformFolderWriter,
	platformFolderProblem,
	platformFolderProblemCode,
	record,
} from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * A coding turn's results.md writer (C3d, migration 20260930108000; deploy/first-node/RUNTIME-COMPANY-STATE-FILES.md §8
 * "Plan (C3)"). A coding turn reports through its executor, never through a run's report_work, so the platform writes its
 * results.md, as it writes a connection's file (P22b, connection-files.ts): the turn's report marks the coding worker due
 * in the report's own transaction; this writer claims one due worker at a time, renders results.md from the claim (the
 * turn's outcome, its report's time, its summary with its pull request, and what a blocked turn needs with its options),
 * commits it as the platform under the claim's operation key at the version the claim read, and finishes the claim. The
 * database checks the outcome and the time against the worker and allows no decision, note or files; the agent decides on
 * the file once it is written, and its revival waits for it (at most a minute, and not after a problem).
 *
 * The turn's texts are the model's: a line the parser would read as a section heading is demoted one level, a text cut to
 * fit its section, and a report the parser still refuses is written with a standing text in its place. Problems are
 * reported as codes, never with a message. Built switched off: the gateway runs it only with
 * QORPERA_CODING_RESULTS_WRITER=1.
 */

/** Every field a claim carries; any other refuses it. */
const CLAIM_KEYS = [
	"schema",
	"codingWorkerId",
	"environmentId",
	"sequence",
	"generation",
	"attempt",
	"operationKey",
	"path",
	"currentVersion",
	"outcome",
	"reportedAt",
	"summary",
	"needs",
	"pullRequest",
	"options",
	"leaseUntil",
] as const;
const OUTCOMES = new Set(["succeeded", "blocked", "failed"]);
/** The pull request link the claim gives, as the database checks it. */
const PULL_REQUEST = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]{0,9}$/;
const MEDIA_TYPE = "text/markdown";
/** A turn's options, as qorpera_complete_coding_turn bounds them. */
const MAX_OPTIONS = 6;
/** The standing texts: a turn without a summary, and a report (or a blocked turn's question) the parser refuses. */
export const CODING_RESULTS_NO_SUMMARY = "The coding session reported no summary.";
export const CODING_RESULTS_UNSHOWN_SUMMARY = "This coding session's report could not be shown here.";
export const CODING_RESULTS_UNSHOWN_NEEDS = "This coding session's question could not be shown here.";
/** A claim and a finish get their own short deadline, so a drain that ran out of time still takes and closes a claim
 * whole. */
const FINISH_MS = 15_000;

export interface CodingResultsClaim {
	readonly codingWorkerId: string;
	readonly environmentId: string;
	readonly sequence: number;
	readonly generation: number;
	readonly operationKey: string;
	/** QorperaOS/agents/<agent>/todos/<todo>/<worker>/results.md */
	readonly path: string;
	/** The file's version now, which the commit expects; null when there is none. */
	readonly currentVersion: string | null;
	readonly outcome: "succeeded" | "blocked" | "failed";
	readonly reportedAt: string;
	readonly summary: string | null;
	/** What a blocked turn needs; null for any other outcome. */
	readonly needs: string | null;
	readonly pullRequest: string | null;
	readonly options: readonly string[] | null;
}

const problem = platformFolderProblem;
const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/** A commit's reason as a problem code the finish accepts; anything else is `refused`. */
const reasonCode = (reason: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "refused");

/** The operation key the database gives a claim. */
export function codingResultsOperationKey(codingWorkerId: string, sequence: number, generation: number): string {
	return `coding-results:${codingWorkerId}:${sequence}:${generation}`;
}

/** A worker's results path: QorperaOS/agents/<agent>/todos/<todo>/<worker>/results.md, each name by the naming rule. */
function resultsPath(value: unknown): string {
	const parts = typeof value === "string" ? (osRelative(value)?.split("/") ?? []) : [];
	return parts.length === 6 &&
		parts[0] === "agents" &&
		parts[2] === "todos" &&
		parts[5] === "results.md" &&
		[parts[1], parts[3], parts[4]].every((name) => name !== undefined && isCompanyStateName(name))
		? (value as string)
		: problem("claim_invalid");
}

/** A claim answer (`qorpera.coding-results-claim/v1`), checked field by field; null when nothing is due. */
export function parseCodingResultsClaim(value: unknown): CodingResultsClaim | null {
	if (value === null) return null;
	const input = record(value, CLAIM_KEYS, "claim_invalid");
	const whole = (field: unknown, min: number) =>
		Number.isSafeInteger(field) && (field as number) >= min ? (field as number) : problem("claim_invalid");
	const text = (field: unknown) => (typeof field === "string" ? field : problem("claim_invalid"));
	if (
		input.schema !== "qorpera.coding-results-claim/v1" ||
		typeof input.codingWorkerId !== "string" ||
		!UUID.test(input.codingWorkerId) ||
		typeof input.environmentId !== "string" ||
		!UUID.test(input.environmentId) ||
		(input.currentVersion !== null && !(typeof input.currentVersion === "string" && UUID.test(input.currentVersion)))
	)
		problem("claim_invalid");
	const sequence = whole(input.sequence, 0);
	const generation = whole(input.generation, 1);
	whole(input.attempt, 1);
	text(input.leaseUntil);
	if (input.operationKey !== codingResultsOperationKey(input.codingWorkerId as string, sequence, generation))
		problem("claim_invalid");
	const outcome = text(input.outcome);
	if (!OUTCOMES.has(outcome)) problem("claim_invalid");
	const reportedAt = text(input.reportedAt);
	if (reportedAt.length > 40) problem("claim_invalid");
	if (input.summary !== null) text(input.summary);
	// A blocked turn always says what it needs, and only a blocked turn does (qorpera_complete_coding_turn).
	if ((outcome === "blocked") !== (typeof input.needs === "string" && input.needs.trim() !== ""))
		problem("claim_invalid");
	if (input.needs !== null) text(input.needs);
	if (input.pullRequest !== null && !(typeof input.pullRequest === "string" && PULL_REQUEST.test(input.pullRequest)))
		problem("claim_invalid");
	const options = input.options;
	if (
		options !== null &&
		(!Array.isArray(options) ||
			options.length > MAX_OPTIONS ||
			options.some((option) => typeof option !== "string" || option.trim() === ""))
	)
		problem("claim_invalid");
	return {
		codingWorkerId: input.codingWorkerId as string,
		environmentId: input.environmentId as string,
		sequence,
		generation,
		operationKey: input.operationKey as string,
		path: resultsPath(input.path),
		currentVersion: input.currentVersion as string | null,
		outcome: outcome as CodingResultsClaim["outcome"],
		reportedAt,
		summary: input.summary as string | null,
		needs: input.needs as string | null,
		pullRequest: input.pullRequest as string | null,
		options: options as string[] | null,
	};
}

/** Model text as a results section holds it: line breaks as \n, trimmed, and every line the parser would read as one of
 * the file's section headings demoted one level, so the text stays in its section. */
export function codingResultsText(text: string): string {
	return workerTextNormal(text)
		.split("\n")
		.map((line) => (workerTextHeading(line, "worker-results") === null ? line : `#${line}`))
		.join("\n");
}

/** `text` cut to at most `max` bytes, at a character, with an ellipsis when it was cut. */
function within(text: string, max: number): string {
	if (byteLength(text) <= max) return text;
	let kept = "";
	let bytes = byteLength("…");
	for (const character of text) {
		bytes += byteLength(character);
		if (bytes > max) break;
		kept += character;
	}
	return `${kept.trimEnd()}…`;
}

/** The summary: the turn's, with its pull request on a line of its own below it, within the summary's bound. */
function summaryOf(summary: string | null, pullRequest: string | null): string {
	const suffix = pullRequest === null ? "" : `\n\nPull request: ${pullRequest}`;
	const text = codingResultsText(summary ?? "");
	return `${within(text || CODING_RESULTS_NO_SUMMARY, WORKER_TEXT_MAX_BYTES.summary - byteLength(suffix))}${suffix}`;
}

/** What a blocked turn needs, then its options as a list when they fit the section's bound with it. */
function needsOf(needs: string, options: readonly string[] | null): string {
	const text = codingResultsText(needs);
	const list = options?.length
		? `\n\nOptions:\n${options.map((option) => `- ${workerTextNormal(option).replace(/\s*\n\s*/g, " ")}`).join("\n")}`
		: "";
	return byteLength(`${text}${list}`) <= WORKER_TEXT_MAX_BYTES.needs
		? `${text}${list}`
		: within(text, WORKER_TEXT_MAX_BYTES.needs);
}

/** A results file's text and its parse, or null when the parser refuses it. */
function written(
	file: Omit<WorkerResultsFile, "kind">,
	path: string,
): { text: string; parse: WorkerResultsFile } | null {
	let text: string;
	try {
		text = writeWorkerResultsFile(file);
	} catch {
		return null;
	}
	const parsed = parseCompanyStateFile(path, text);
	return parsed?.ok && parsed.file.kind === "worker-results" ? { text, parse: parsed.file } : null;
}

/**
 * results.md for a claim, and its parse: the turn's outcome and time, no decision, note or files, the summary and (when
 * blocked) what the turn needs. A report the parser refuses is written with the standing texts in its place (its pull
 * request kept); `file_invalid` when even that is refused.
 */
export function codingResultsFile(claim: CodingResultsClaim): { text: string; parse: WorkerResultsFile } {
	const fields = { outcome: claim.outcome, reportedAt: claim.reportedAt, decision: null, note: null, files: [] };
	return (
		written(
			{
				...fields,
				summary: summaryOf(claim.summary, claim.pullRequest),
				needs: claim.needs === null ? null : needsOf(claim.needs, claim.options),
			},
			claim.path,
		) ??
		written(
			{
				...fields,
				summary: summaryOf(CODING_RESULTS_UNSHOWN_SUMMARY, claim.pullRequest),
				needs: claim.needs === null ? null : CODING_RESULTS_UNSHOWN_NEEDS,
			},
			claim.path,
		) ??
		problem("file_invalid")
	);
}

export interface CodingResultsWriterOptions {
	readonly workerId: string;
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
	readonly leaseSeconds?: number;
}

export class CodingResultsWriter {
	readonly #options: CodingResultsWriterOptions;
	readonly #folder: PlatformFolderWriter;
	readonly #leaseSeconds: number;

	constructor(options: CodingResultsWriterOptions) {
		if (!UUID.test(options.workerId)) throw new Error("Coding results writer identity is invalid");
		this.#options = options;
		this.#folder = new PlatformFolderWriter(options);
		this.#leaseSeconds = options.leaseSeconds ?? 60;
		if (!Number.isSafeInteger(this.#leaseSeconds) || this.#leaseSeconds < 30 || this.#leaseSeconds > 900)
			throw new Error("Coding results writer lease is invalid");
	}

	/** Writes due results until none is due or `max` were handled. Returns how many were handled. */
	writeDue(max = 20, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<number> {
		return drainPlatformClaims(max, () => this.writeOne(signal), signal);
	}

	/** Claims one due coding worker and writes its results.md; false when nothing is due. */
	async writeOne(signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<boolean> {
		// The claim gets its own short deadline, as the finish does: a drain whose budget ends during the call would
		// otherwise reject a claim the database may already have committed.
		const answer = await this.#options.authority.publisher(
			"qorpera_claim_coding_results_file",
			{ p_worker: this.#options.workerId, p_lease_seconds: this.#leaseSeconds },
			AbortSignal.timeout(FINISH_MS),
		);
		let claim: CodingResultsClaim | null;
		try {
			claim = parseCodingResultsClaim(answer);
		} catch (error) {
			// A claim that names its worker and generation is finished with the problem; anything else is left to its lease.
			const input = answer as { codingWorkerId?: unknown; generation?: unknown } | null;
			if (
				error instanceof PlatformFolderProblem &&
				typeof input?.codingWorkerId === "string" &&
				UUID.test(input.codingWorkerId) &&
				Number.isSafeInteger(input.generation)
			)
				await this.#finish(input.codingWorkerId, input.generation as number, error.code);
			throw error;
		}
		if (!claim) return false;
		let code: string | null = null;
		try {
			await this.#write(claim, signal);
		} catch (error) {
			code = platformFolderProblemCode(error);
		}
		await this.#finish(claim.codingWorkerId, claim.generation, code);
		return true;
	}

	async #write(claim: CodingResultsClaim, signal: AbortSignal): Promise<void> {
		const { text, parse } = codingResultsFile(claim);
		const file = await this.#folder.stage(
			claim.environmentId,
			encoder.encode(text),
			{ mediaType: MEDIA_TYPE, executable: false },
			signal,
		);
		const unit = commitUnitOutcome(
			await this.#folder.commit(
				claim.environmentId,
				claim.operationKey,
				[
					{
						op: "write",
						path: claim.path,
						file,
						structured: [
							{
								path: claim.path,
								kind: "worker-results",
								text,
								parse,
								parserVersion: COMPANY_STATE_PARSER_VERSION,
							},
						],
						...(claim.currentVersion ? { expectedVersion: claim.currentVersion } : {}),
					},
				],
				signal,
			),
		);
		// Not saved (the worker moved on to its next turn, or its file changed meanwhile): back off with the reason; a newer
		// report has a claim of its own.
		if (unit.outcome !== "saved") problem(reasonCode(unit.reason ?? unit.outcome));
	}

	/** Closes a claim on its own short deadline. `finished: false` is the usual answer after a save (the commit removed
	 * the due row), or means a newer claim holds the worker: its write is the one that counts. */
	async #finish(codingWorkerId: string, generation: number, code: string | null): Promise<void> {
		const answer = (await this.#options.authority.publisher(
			"qorpera_finish_coding_results_file",
			{
				p_worker: this.#options.workerId,
				p_coding_worker_id: codingWorkerId,
				p_generation: generation,
				p_problem: code,
			},
			AbortSignal.timeout(FINISH_MS),
		)) as { schema?: unknown; finished?: unknown } | null;
		if (answer?.schema !== "qorpera.coding-results-finish/v1" || typeof answer.finished !== "boolean")
			problem("finish_invalid");
	}
}
