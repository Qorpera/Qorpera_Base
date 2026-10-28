// W5b-2: a resumed attempt opens its existing log and composes its own earlier work (§12–13).
// This is a dormant component. Production must wire it together with W1c-3 and the closing/erasure gates.
// A run in Agent notebooks keeps no log: its resumed attempt starts from the run's own receipts instead
// (`openCloudRunReceiptsResume`, 20260930539000).
import { parseMemoryRunFile } from "@qorpera/cloud-client/memory-run-files";
import { POSTGRES_UUID_PATTERN, parseClosedRecord, parseInteger, WireValueError } from "@qorpera/contracts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import { CLOUD_NATIVE_WORK_MESSAGE_BYTES } from "./cloud-native-context-composition.ts";
import { type CloudNativeToolRun, parseCloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import { CloudRunLog, type CloudRunLogFolder, CloudRunLogUnavailable } from "./cloud-run-log.ts";
import { cloudRunResumeComposer, cloudRunWorkComposer, cloudRunWorkMessage } from "./memory-tree/run-work.ts";
import {
	CloudRunStepLines,
	type CloudRunStepLinesOptions,
	RUN_STEP_OUTCOME_UNKNOWN,
} from "./memory-tree/step-lines.ts";

export type CloudRunResumeReason = "restart" | "limit_reset";
export interface CloudRunResumeContext {
	readonly why: CloudRunResumeReason;
	readonly unknownReceipts: readonly { readonly receiptId: string; readonly logicalOperationKey: string }[];
}
export type CloudRunResumeUnknown =
	| { readonly call: string; readonly step: number; readonly receiptId: null }
	| { readonly call: null; readonly step: null; readonly receiptId: string };
export interface CloudRunResumeRequest {
	readonly stepsRead: number;
	readonly unknownCalls: readonly CloudRunResumeUnknown[];
}
export type CloudRunResumeRecordedUnknown = CloudRunResumeUnknown & {
	readonly logicalOperationKey: string | null;
};
export interface CloudRunResumeRecord {
	readonly why: CloudRunResumeReason;
	readonly stepsRead: number;
	readonly unknownCalls: readonly CloudRunResumeRecordedUnknown[];
}
/** One of the run's receipts from its earlier attempts, by its key and status. Never its stored result: the run may
 * not have seen it. */
export interface CloudRunResumeReceipt {
	readonly receiptId: string;
	readonly logicalOperationKey: string;
	readonly status: "completed" | "outcome_unknown";
}
export interface CloudRunResumeReceipts {
	readonly why: CloudRunResumeReason;
	/** Oldest first: every outcome_unknown receipt, and the newest completed ones. */
	readonly receipts: readonly CloudRunResumeReceipt[];
	/** The older completed receipts left out. */
	readonly completedOmitted: number;
}
export interface CloudRunResumePort {
	readonly runId: string;
	context(signal: AbortSignal): Promise<CloudRunResumeContext | null>;
	/** A resumed attempt of a run that keeps no log (Agent notebooks), from its receipts; null for any other attempt. */
	receipts(signal: AbortSignal): Promise<CloudRunResumeReceipts | null>;
	record(request: CloudRunResumeRequest, signal: AbortSignal): Promise<CloudRunResumeRecord>;
}

function invalid(): never {
	throw new CloudRunLogUnavailable("resume_response_invalid");
}
function reason(value: unknown): CloudRunResumeReason {
	if (value !== "restart" && value !== "limit_reset") invalid();
	return value;
}
function receipt(value: unknown): string {
	if (typeof value !== "string" || value.length !== 36 || !POSTGRES_UUID_PATTERN.test(value)) invalid();
	return value;
}
function operationKey(value: unknown): string {
	if (typeof value !== "string" || !value.length) invalid();
	return value;
}

/** Uses the run's live authority for retries. A lost record reply repeats the same request, never a rediscovered
 * list; SQL's per-assignment row replays it even after new steps have committed. A different request for that row is
 * refused (23505, `CloudControlRpcRefused`) and never asked again. No model argument chooses a binding. */
export class CloudRunResumeRpc implements CloudRunResumePort {
	readonly #run: Pick<CloudNativeToolRun, "binding" | "retry">;
	readonly #control: CloudCompanyPathControl;
	readonly #binding: ReturnType<typeof parseCloudNativeToolBinding>;
	constructor(options: { run: Pick<CloudNativeToolRun, "binding" | "retry">; control: CloudCompanyPathControl }) {
		this.#run = options.run;
		this.#control = options.control;
		this.#binding = parseCloudNativeToolBinding(options.run.binding);
	}
	get runId(): string {
		return this.#binding.runId;
	}

	async context(signal: AbortSignal): Promise<CloudRunResumeContext | null> {
		const { value } = await this.#run.retry(
			(requestSignal) =>
				this.#control.call("qorpera_memory_run_resume", { p_binding: this.#binding }, requestSignal),
			signal,
		);
		if (value === null) return null;
		try {
			const row = parseClosedRecord(value, "Run resume context", ["schema", "why", "unknownReceipts"]);
			if (row.schema !== "qorpera.memory-run-resume/v1" || !Array.isArray(row.unknownReceipts)) invalid();
			const seen = new Set<string>();
			const unknownReceipts = row.unknownReceipts.map((value) => {
				const item = parseClosedRecord(value, "Run resume receipt", ["receiptId", "logicalOperationKey"]);
				const receiptId = receipt(item.receiptId);
				if (seen.has(receiptId)) invalid();
				seen.add(receiptId);
				return Object.freeze({ receiptId, logicalOperationKey: operationKey(item.logicalOperationKey) });
			});
			return Object.freeze({ why: reason(row.why), unknownReceipts: Object.freeze(unknownReceipts) });
		} catch (error) {
			if (error instanceof WireValueError) invalid();
			throw error;
		}
	}

	async receipts(signal: AbortSignal): Promise<CloudRunResumeReceipts | null> {
		const { value } = await this.#run.retry(
			(requestSignal) =>
				this.#control.call("qorpera_memory_run_resume_receipts", { p_binding: this.#binding }, requestSignal),
			signal,
		);
		if (value === null) return null;
		try {
			const row = parseClosedRecord(value, "Run resume receipts", ["schema", "why", "receipts", "completedOmitted"]);
			if (row.schema !== "qorpera.memory-run-resume-receipts/v1" || !Array.isArray(row.receipts)) invalid();
			const seen = new Set<string>();
			const receipts = row.receipts.map((value) => {
				const item = parseClosedRecord(value, "Run resume receipt", ["receiptId", "logicalOperationKey", "status"]);
				const receiptId = receipt(item.receiptId);
				if (seen.has(receiptId)) invalid();
				seen.add(receiptId);
				if (item.status !== "completed" && item.status !== "outcome_unknown") invalid();
				return Object.freeze({
					receiptId,
					logicalOperationKey: operationKey(item.logicalOperationKey),
					status: item.status,
				});
			});
			return Object.freeze({
				why: reason(row.why),
				receipts: Object.freeze(receipts),
				completedOmitted: parseInteger(row.completedOmitted, "Omitted receipts", 0, 2147483647),
			});
		} catch (error) {
			if (error instanceof WireValueError) invalid();
			throw error;
		}
	}

	async record(request: CloudRunResumeRequest, signal: AbortSignal): Promise<CloudRunResumeRecord> {
		// Snapshot before the first await: a caller cannot change a retry's request underneath the authority loop.
		const sent = structuredClone(request);
		const { value } = await this.#run.retry(
			(requestSignal) =>
				this.#control.call(
					"qorpera_memory_run_resume_record",
					{ p_binding: this.#binding, p_request: sent },
					requestSignal,
				),
			signal,
		);
		try {
			const row = parseClosedRecord(value, "Run resume record", ["schema", "why", "stepsRead", "unknownCalls"]);
			if (
				row.schema !== "qorpera.memory-run-resume-record/v1" ||
				parseInteger(row.stepsRead, "Resume step count", 0, 2147483647) !== sent.stepsRead ||
				!Array.isArray(row.unknownCalls) ||
				row.unknownCalls.length !== sent.unknownCalls.length
			)
				invalid();
			const unknownCalls = row.unknownCalls.map((value, index) => {
				const item = parseClosedRecord(value, "Run resume unknown call", [
					"call",
					"step",
					"receiptId",
					"logicalOperationKey",
				]);
				const expected = sent.unknownCalls[index]!;
				if (item.call !== expected.call || item.step !== expected.step || item.receiptId !== expected.receiptId)
					invalid();
				if (expected.receiptId === null && item.logicalOperationKey !== null) invalid();
				return Object.freeze({
					...expected,
					logicalOperationKey: expected.receiptId === null ? null : operationKey(item.logicalOperationKey),
				});
			});
			return Object.freeze({
				why: reason(row.why),
				stepsRead: sent.stepsRead,
				unknownCalls: Object.freeze(unknownCalls),
			});
		} catch (error) {
			if (error instanceof WireValueError) invalid();
			throw error;
		}
	}
}

/** Opens only a resumed attempt. Null means SQL positively identified an original attempt; a missing log on a
 * resume is an error, never a fresh writer. A caller must await this before issuing any provider request or step.
 * The record RPC is the final authoritative gate: it refuses a gone/narrow/erasing log, changed count or omitted
 * unknown outcome. A read crossing a move refuses safely and may be opened afresh before any work is exposed.
 * The resumed run's work messages come from the returned `composeContext`, never `lines.composeContext()`: that
 * composer has no `unfolded` warnings, so it would drop every outcome-unknown warning (§12). */
export async function openCloudRunResume(options: {
	readonly resume: CloudRunResumePort;
	readonly folder: CloudRunLogFolder;
	readonly log: Omit<
		ConstructorParameters<typeof CloudRunLog>[0],
		"folder" | "conversationId" | "parent" | "continues" | "narrow" | "firstStep"
	>;
	readonly lines: Omit<CloudRunStepLinesOptions, "log" | "firstStep" | "signal">;
}) {
	const { resume, folder } = options;
	const { runId, signal } = options.log;
	if (resume.runId !== runId) throw new CloudRunLogUnavailable("resume_run_mismatch");
	signal.throwIfAborted();
	const context = await resume.context(signal);
	if (context === null) return null;
	const place = await folder.locate(runId, signal);
	if (!place.exists) throw new CloudRunLogUnavailable("no_log");
	if (!place.origin) throw new CloudRunLogUnavailable("origin_unavailable");
	if (place.origin.narrow) throw new CloudRunLogUnavailable("resume_narrow");
	let opening = true;
	// Every historical block goes through W1b's shared parser, including the block used to discover the next step.
	const checkedFolder: CloudRunLogFolder = {
		locate: (run, io) => folder.locate(run, io),
		commit: (key, units, preconditions, io) => folder.commit(key, units, preconditions, io),
		read: async (path, io) => {
			const file = await folder.read(path, io);
			if (opening && file && path.includes("/log/")) {
				if (!parseMemoryRunFile("memory-steps", path, file.text).ok)
					throw new CloudRunLogUnavailable("resume_block_invalid");
				for (const line of file.text.trimEnd().split("\n"))
					if ((JSON.parse(line) as { narrow?: true }).narrow) throw new CloudRunLogUnavailable("resume_narrow");
			}
			return file;
		},
	};
	let firstStep = 0;
	if (place.last !== null) {
		const last = parseInteger(place.last, "Resume last block", 0, 99_999_999);
		const file = await checkedFolder.read(`${place.path}/log/${String(last).padStart(8, "0")}.jsonl`, signal);
		if (!file) throw new CloudRunLogUnavailable("log_short");
		firstStep = parseInteger(last + file.text.trimEnd().split("\n").length, "Resume step count", 1, 2147483647);
	}
	const origin = place.origin;
	const log = new CloudRunLog({
		...options.log,
		folder: checkedFolder,
		conversationId: origin.conversation,
		...(origin.parent === null ? {} : { parent: { runId: origin.parent, step: origin.step! } }),
		...(origin.continues === null ? {} : { continues: origin.continues }),
		firstStep,
	});
	const earlier = await log.earlier(signal);
	const latest = await folder.locate(runId, signal);
	if (
		!latest.exists ||
		latest.path !== place.path ||
		latest.generation !== place.generation ||
		latest.last !== place.last
	)
		throw new CloudRunLogUnavailable("resume_log_changed");
	if (latest.origin?.narrow) throw new CloudRunLogUnavailable("resume_narrow");
	// A pending call, and an erased step: its result is gone, so its outcome is unknown too (§12). Its line stays
	// `(erased)`, as zoom shows it; the warning names its call.
	const unknownCalls: CloudRunResumeUnknown[] = [
		...earlier
			.filter((step) => step.erased || step.result === null)
			.map((step) => ({ call: step.call, step: step.j, receiptId: null })),
		...context.unknownReceipts.map(({ receiptId }) => ({ call: null, step: null, receiptId })),
	];
	const receiptKeys = new Map(
		context.unknownReceipts.map(({ receiptId, logicalOperationKey }) => [receiptId, logicalOperationKey]),
	);
	// Keep identifiers as labelled JSON data. In particular, a ledger key is not evidence of a provider call id.
	const warnings = Object.freeze(
		unknownCalls.map((item) => {
			const key = item.receiptId === null ? null : receiptKeys.get(item.receiptId)!;
			return `${RUN_STEP_OUTCOME_UNKNOWN}: ${JSON.stringify({ ...item, logicalOperationKey: key })}`;
		}),
	);
	if (Buffer.byteLength(cloudRunWorkMessage(warnings)) > CLOUD_NATIVE_WORK_MESSAGE_BYTES)
		throw new CloudRunLogUnavailable("resume_warnings_too_large");
	const recorded = await resume.record({ stepsRead: firstStep, unknownCalls }, signal);
	if (
		recorded.why !== context.why ||
		recorded.stepsRead !== firstStep ||
		recorded.unknownCalls.length !== unknownCalls.length
	)
		invalid();
	for (const [index, item] of recorded.unknownCalls.entries()) {
		const expected = unknownCalls[index]!;
		const key = expected.receiptId === null ? null : receiptKeys.get(expected.receiptId)!;
		if (
			item.call !== expected.call ||
			item.step !== expected.step ||
			item.receiptId !== expected.receiptId ||
			item.logicalOperationKey !== key
		)
			invalid();
	}
	signal.throwIfAborted();
	opening = false;
	const lines = new CloudRunStepLines({ ...options.lines, log, firstStep, signal });
	const composeContext = cloudRunWorkComposer({
		firstStep,
		steps: (io) => lines.steps(io),
		lines: (r, budget, io) => lines.lines(r, budget, io),
		unfolded: warnings,
	});
	return { log, lines, firstStep, earlier, recorded, warnings, composeContext };
}

/** The first line of a resumed attempt's work message when its run keeps no log: what the lines after it are. */
export const RUN_RESUME_RECEIPTS =
	"resumed: this run was cut off, and this attempt goes on with the same task. The effects its earlier attempts " +
	"recorded follow, oldest first, each by its receipt's key; their results are not shown. A completed one ran: do " +
	"not do it again; read the current state where you need what it did. An effect whose outcome is unknown may " +
	"have run: check it first; its key never runs again. A receipt's key is not always the key a call passed: most " +
	"begin with the tool's name and a colon, many tools put a prefix of their own before the call's key (as in " +
	"hire_agent:hire:<operationKey> or coworker:<operationKey>), and some come from no argument. The same tool called " +
	"again with the call's own key and the same arguments returns the stored result and runs nothing; other " +
	"arguments under that key are refused.";

/** Opens a resumed attempt of a run that keeps no log (Agent notebooks, 20260930539000) from the run's receipts, which
 * `resume.receipts` read: its work message lists each completed effect and each effect whose outcome is unknown, each by
 * its receipt key. It shows no result. A stored result may be one the run never saw: the check of the call's authority
 * before its release refused it, or the run was cut off first. Only a replay, which checks that authority again,
 * returns it. Nothing is written but the resume record, which lists every unknown receipt as for a log; SQL refuses the
 * attempt's first receipt until it is stored. A caller must await this before any provider request or step. */
export async function openCloudRunReceiptsResume(options: {
	readonly resume: CloudRunResumePort;
	readonly receipts: CloudRunResumeReceipts;
	readonly signal: AbortSignal;
}) {
	const { resume, receipts: earlier, signal } = options;
	signal.throwIfAborted();
	const lines = Object.freeze([
		RUN_RESUME_RECEIPTS,
		...(earlier.completedOmitted > 0
			? [`earlier: ${earlier.completedOmitted} older completed effects are not listed`]
			: []),
		...earlier.receipts.map(({ receiptId, logicalOperationKey, status }) =>
			status === "outcome_unknown"
				? `${RUN_STEP_OUTCOME_UNKNOWN}: ${JSON.stringify({ call: null, step: null, receiptId, logicalOperationKey })}`
				: `completed: ${JSON.stringify({ receiptId, logicalOperationKey })}`,
		),
	]);
	if (Buffer.byteLength(cloudRunWorkMessage(lines)) > CLOUD_NATIVE_WORK_MESSAGE_BYTES)
		throw new CloudRunLogUnavailable("resume_warnings_too_large");
	const unknown = earlier.receipts.filter(({ status }) => status === "outcome_unknown");
	const unknownCalls: CloudRunResumeUnknown[] = unknown.map(({ receiptId }) => ({
		call: null,
		step: null,
		receiptId,
	}));
	const recorded = await resume.record({ stepsRead: 0, unknownCalls }, signal);
	if (
		recorded.why !== earlier.why ||
		recorded.stepsRead !== 0 ||
		recorded.unknownCalls.length !== unknown.length ||
		recorded.unknownCalls.some(
			(item, index) =>
				item.call !== null ||
				item.step !== null ||
				item.receiptId !== unknown[index]!.receiptId ||
				item.logicalOperationKey !== unknown[index]!.logicalOperationKey,
		)
	)
		invalid();
	signal.throwIfAborted();
	return { recorded, lines, composeContext: cloudRunResumeComposer(lines) };
}
