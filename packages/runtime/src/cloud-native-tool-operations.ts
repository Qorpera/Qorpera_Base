import { createHash, randomUUID } from "node:crypto";
import { type JsonValue, parseUuid } from "@qorpera/contracts";
import {
	type CloudNativeToolBinding,
	type CloudNativeToolIdentity,
	type CloudNativeToolRun,
	cloudToolRequest,
} from "./cloud-native-tool-authority.ts";
import {
	CloudToolAuthorizeRefusal,
	type CloudToolContent,
	CloudToolOutcomeUnknown,
	type CloudToolRefusal,
	cloudToolJsonText,
} from "./cloud-native-tool-boundary.ts";
import type { BeginCloudRunnerOperationInput } from "./cloud-runner-broker.ts";
import {
	CloudRuntimeDiagnosticError,
	type CloudRuntimeErrorCategory,
	type CloudRuntimeObservationSpan,
	cloudRuntimeErrorCategory,
} from "./cloud-runtime-observability.ts";

/** The registry's refusal at the authorize before the receipt, kept apart from the same refusal anywhere later. */
class RefusedBeforeReceipt extends Error {
	readonly refusal: CloudToolAuthorizeRefusal;
	constructor(refusal: CloudToolAuthorizeRefusal) {
		super("Cloud tool operation refused before its receipt");
		this.refusal = refusal;
	}
}

/** The kernel's answer for a key whose receipt a resume settled as outcome_unknown (W5), kept apart from any error the
 * effect could throw. */
class SettledOutcomeUnknown extends Error {
	readonly receiptId: string;
	constructor(receiptId: string) {
		super("Cloud tool receipt outcome is unknown");
		this.receiptId = receiptId;
	}
}

/** Thrown by `perform` when the kernel settled the call's own receipt without an effect, under the receipt's lock (it
 * cancelled it): a definite outcome, so the call ends refused with the refusal's words, not unconfirmed. */
export class CloudToolOperationSettled extends Error {
	readonly receiptId: string;
	readonly refusal: CloudToolRefusal;
	constructor(receiptId: string, refusal: CloudToolRefusal) {
		super("Cloud tool operation settled without an effect");
		this.receiptId = receiptId;
		this.refusal = refusal;
	}
}

/** A permission check as its own child observation of the tool call, so a
 * refusal or a timeout there is told apart from the receipt, the effect and
 * the completion (each capped separately). */
export async function observedCloudToolAuthority(
	observation: CloudRuntimeObservationSpan | undefined,
	check: () => Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	const span = observation?.child("context_authority");
	try {
		await check();
		span?.finish("succeeded");
	} catch (error) {
		// A request that ran out of time is named as such; any other failure
		// (a refusal, a revoked run) is a denied authority, as before.
		if (authorityTimedOut(error, signal)) span?.finish("unconfirmed", { errorCategory: "timeout" });
		else span?.finish("denied", { errorCategory: "authority_unavailable" });
		throw error;
	}
}
/** A deadline anywhere under the failure: a request's own (a TimeoutError from
 * AbortSignal.timeout), the bounded authority request's, or the caller's. */
function authorityTimedOut(error: unknown, signal: AbortSignal): boolean {
	let current = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		if (current.name === "TimeoutError") return true;
		if (current instanceof CloudRuntimeDiagnosticError && current.category === "timeout") return true;
		current = current.cause;
	}
	return signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";
}

const OPERATION_SCHEMA = "qorpera.cloud-tool-operation/v2";
const RESULT_SCHEMA = "qorpera.cloud-tool-operation-result/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Operations remembered for in-process replay; the oldest are forgotten, never refused. */
export const CLOUD_NATIVE_TOOL_REMEMBERED_OPERATIONS = 65_536;

/** Exact bytes used by receipt admission and independently checked effect gateways. */
export function cloudNativeToolOperationEnvelope(
	identity: CloudNativeToolIdentity,
	operation: CloudNativeToolOperation,
): string {
	const principals = Object.fromEntries(
		Object.entries(identity).filter(
			([key]) =>
				![
					"assignmentId",
					"runnerId",
					"leaseId",
					"sponsorVersion",
					"providerConnectionId",
					"providerConnectionVersion",
				].includes(key),
		),
	);
	return cloudToolJsonText({ schema: OPERATION_SCHEMA, principals, operation });
}

export interface CloudNativeToolOperationControlPlane {
	beginToolOperation(
		binding: CloudNativeToolBinding,
		input: BeginCloudRunnerOperationInput,
		signal: AbortSignal,
	): Promise<unknown>;
	completeToolOperation(
		binding: CloudNativeToolBinding,
		input: CompleteToolOperationInput,
		signal: AbortSignal,
	): Promise<unknown>;
	/** A folder-v2 writer's completion, naming the folder commit that carried its receipt
	 * (`qorpera_folder_complete_run_receipt`, core C1c-2b): the legacy completion names no commit. Only the company
	 * runtime's control plane has it; an operation whose effect returns a folder commit needs it. */
	completeFolderToolOperation?(
		binding: CloudNativeToolBinding,
		input: CompleteFolderToolOperationInput,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** A completion that names no folder commit: folder-v2 refuses a snapshot or a proposal there. */
export interface CompleteToolOperationInput {
	receiptId: string;
	inputSha256: string;
	result: JsonValue;
}

export interface CompleteFolderToolOperationInput {
	receiptId: string;
	inputSha256: string;
	result: JsonValue;
	folderCommitId: string;
}

export interface CloudNativeToolOperation {
	readonly tool: string;
	readonly toolVersion: string;
	readonly logicalOperationKey: string;
	/** All effective arguments, including exact bytes or immutable byte hashes. Never a call ordinal. */
	readonly arguments: JsonValue;
	/** Resolved target, audience, expected versions and policy; the target gateway checks these independently. */
	readonly target: { [key: string]: JsonValue };
	readonly requiresCompanyRevision: boolean;
}

export interface CloudNativeToolOperationOutput {
	content: CloudToolContent;
	/** The folder commit that carried this operation's receipt (a folder-v2 writer), whatever its units' outcomes. */
	folderCommitId?: string;
	/** That commit parked the change for a member's review instead of saving it. */
	proposed?: true;
}

interface ConfirmedOperationResult {
	content: CloudToolContent;
	receiptId: string;
	outcome: "succeeded" | "proposed" | "replayed";
	/** A folder-v2 change parked for review: a protected path, as the path gateway reports it. */
	parked?: true;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tool operation receipt");
	return value as Record<string, unknown>;
}

function freeze(value: JsonValue): void {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
}

/**
 * Uses the deployed run-operation ledger, not an in-memory exactly-once claim.
 * A fresh receipt admits one attempt; an existing executing/ambiguous/cancelled
 * receipt never authorizes another effect. Target authorization remains mandatory.
 */
export class CloudNativeToolOperations {
	readonly #run: CloudNativeToolRun;
	readonly #control: CloudNativeToolOperationControlPlane;
	readonly #operations = new Map<
		string,
		{ digest: string; result: Promise<ConfirmedOperationResult>; receipt: { id: string | null } }
	>();
	readonly #remembered: number;
	#pending: Promise<void> = Promise.resolve();

	/** `rememberedOperations` exists for tests, which cannot afford 65,536 real operations; it can only
	 * lower the bound, never switch forgetting off. */
	constructor(
		run: CloudNativeToolRun,
		control: CloudNativeToolOperationControlPlane,
		options: { rememberedOperations?: number } = {},
	) {
		const remembered = options.rememberedOperations ?? CLOUD_NATIVE_TOOL_REMEMBERED_OPERATIONS;
		if (!Number.isSafeInteger(remembered) || remembered < 1 || remembered > CLOUD_NATIVE_TOOL_REMEMBERED_OPERATIONS)
			throw new Error("Invalid remembered operation count");
		this.#run = run;
		this.#control = control;
		this.#remembered = remembered;
	}

	/** Whether an operation's effect may return a folder commit: this control plane completes folder receipts. A
	 * folder writer asks before it commits, since a commit no one can complete fences the run's later operations. */
	get completesFolderCommits(): boolean {
		return this.#control.completeFolderToolOperation !== undefined;
	}

	async execute(options: {
		operation: CloudNativeToolOperation;
		/** Check live path/destination authority. This does not replace the effect gateway's atomic check. */
		authorize: (
			operation: CloudNativeToolOperation,
			identity: CloudNativeToolIdentity,
			signal: AbortSignal,
		) => Promise<void>;
		/** Must honor cancellation and pass the supplied idempotency key to the effect gateway. */
		perform: (
			operation: CloudNativeToolOperation,
			context: {
				identity: CloudNativeToolIdentity;
				receiptId: string;
				inputSha256: string;
				idempotencyKey: string;
				signal: AbortSignal;
			},
		) => Promise<CloudNativeToolOperationOutput>;
		/** Why a confirmed answer changed nothing, when the effect gateway refuses with an answer rather than a throw (a
		 * folder-v2 change that was not saved): the call is observed as denied with this category, a replay too, never
		 * as succeeded. Read from the answer, which is all a replay has. */
		refused?: (content: CloudToolContent) => CloudRuntimeErrorCategory | undefined;
		signal: AbortSignal;
		observation?: CloudRuntimeObservationSpan;
	}): Promise<CloudToolContent> {
		const signal = AbortSignal.any([options.signal, this.#run.signal]);
		const { authorize, perform } = options;
		const serialized = cloudToolJsonText(options.operation);
		const operation = record(JSON.parse(serialized)) as unknown as CloudNativeToolOperation;
		if (
			Object.keys(operation).sort().join() !==
				"arguments,logicalOperationKey,requiresCompanyRevision,target,tool,toolVersion" ||
			typeof operation.tool !== "string" ||
			!/^[a-z][a-z0-9_]{0,63}$/.test(operation.tool) ||
			typeof operation.toolVersion !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(operation.toolVersion) ||
			typeof operation.logicalOperationKey !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(operation.logicalOperationKey) ||
			typeof operation.requiresCompanyRevision !== "boolean" ||
			Object.keys(record(operation.target)).length === 0
		)
			throw new Error("Invalid cloud tool operation");
		freeze(operation as unknown as JsonValue);
		// A handoff changes execution funding and attempt identity, not the
		// logical work. Live authority still validates all fields on every call.
		const digest = createHash("sha256")
			.update(cloudNativeToolOperationEnvelope(this.#run.identity, operation))
			.digest("hex");
		const key = `${operation.tool}:${operation.logicalOperationKey}`;
		if (key.length > 256) throw new Error("Invalid cloud tool operation key");
		const previous = this.#operations.get(key);
		if (previous && previous.digest !== digest) throw new Error("Cloud tool operation key is bound to other work");
		// Remembered for a replay within this run; the kernel receipt stays the idempotency
		// authority, so a forgotten key replays through it. Oldest first, never a refusal.
		if (!previous && this.#operations.size >= this.#remembered) {
			const oldest = this.#operations.keys().next().value;
			if (oldest !== undefined) this.#operations.delete(oldest);
		}
		// Private canonical metadata survives an absent/failed exporter and does not admit work.
		const receipt = previous?.receipt ?? { id: null };
		const result =
			previous?.result ??
			this.#pending.then(async (): Promise<ConfirmedOperationResult> => {
				await observedCloudToolAuthority(
					options.observation,
					async () => {
						await this.#run.assertActive(signal);
						await cloudToolRequest(
							(requestSignal) => authorize(operation, this.#run.identity, requestSignal),
							signal,
						).catch((error: unknown) => {
							throw error instanceof CloudToolAuthorizeRefusal ? new RefusedBeforeReceipt(error) : error;
						});
					},
					signal,
				);
				const receiptId = randomUUID();
				const idempotencyKey = createHash("sha256")
					.update(JSON.stringify([OPERATION_SCHEMA, this.#run.identity.runId, key]))
					.digest("hex");
				const begun = record(
					await cloudToolRequest(
						(requestSignal) =>
							this.#control.beginToolOperation(
								this.#run.binding,
								{
									receiptId,
									logicalOperationKey: key,
									operationKind: "cloud_tool",
									inputSha256: digest,
									downstreamIdempotencyKey: idempotencyKey,
									requiresCompanyRevision: operation.requiresCompanyRevision,
								},
								requestSignal,
							),
						signal,
					),
				);
				if (
					begun.run_id !== this.#run.identity.runId ||
					typeof begun.receipt_id !== "string" ||
					!UUID.test(begun.receipt_id) ||
					Object.keys(begun).some(
						(key) =>
							![
								"run_id",
								"receipt_id",
								"state",
								"result",
								"output_snapshot_id",
								"proposal_id",
								"folder_commit_id",
							].includes(key),
					)
				)
					throw new Error("Cloud tool receipt names another run");
				if (begun.state === "completed") {
					const revisions = [begun.output_snapshot_id, begun.proposal_id, begun.folder_commit_id].filter(
						(value) => value != null,
					);
					if (
						revisions.some((value) => typeof value !== "string" || !UUID.test(value)) ||
						revisions.length > 1 ||
						(operation.requiresCompanyRevision && revisions.length === 0)
					)
						throw new Error("Cloud tool receipt revision differs");
					const stored = record(begun.result);
					if (
						stored.schema !== RESULT_SCHEMA ||
						stored.inputSha256 !== digest ||
						Object.keys(stored).sort().join() !== "content,inputSha256,schema"
					)
						throw new Error("Cloud tool receipt result differs");
					const content = record(stored.content);
					if (
						Object.keys(content).sort().join() !== "kind,value" ||
						(content.kind !== "text" && content.kind !== "json") ||
						(content.kind === "text" && typeof content.value !== "string")
					)
						throw new Error("Invalid cloud tool receipt content");
					cloudToolJsonText(content, 48 * 1024);
					receipt.id = begun.receipt_id;
					return {
						content: structuredClone(content) as unknown as CloudToolContent,
						receiptId: begun.receipt_id,
						outcome: begun.proposal_id ? "proposed" : "replayed",
					};
				}
				if (
					["executing", "ambiguous", "cancelled", "outcome_unknown"].includes(begun.state as string) &&
					begun.result == null &&
					begun.output_snapshot_id == null &&
					begun.proposal_id == null &&
					begun.folder_commit_id == null
				) {
					// Retain a validated fence even when it forbids another effect. Never use a broker payload ID.
					receipt.id = begun.receipt_id;
					options.observation?.update({ receiptId: receipt.id });
					// The run was cut off while this call ran, and its resume settled the receipt (W5): never run again.
					if (begun.state === "outcome_unknown") throw new SettledOutcomeUnknown(begun.receipt_id);
				}
				if (
					begun.state !== "executing" ||
					begun.receipt_id !== receiptId ||
					begun.result != null ||
					begun.output_snapshot_id != null ||
					begun.proposal_id != null ||
					begun.folder_commit_id != null
				)
					throw new Error("Cloud tool operation requires recovery review");
				await this.#run.assertActive(signal);
				await cloudToolRequest((requestSignal) => authorize(operation, this.#run.identity, requestSignal), signal);
				signal.throwIfAborted();
				const output = await cloudToolRequest(
					(requestSignal) =>
						perform(operation, {
							identity: this.#run.identity,
							receiptId,
							inputSha256: digest,
							idempotencyKey,
							signal: requestSignal,
						}),
					signal,
					30_000,
				);
				// An effect may have happened even if this or completion fails. Its executing receipt remains a fence.
				signal.throwIfAborted();
				const content = record(output.content);
				if (
					Object.keys(content).sort().join() !== "kind,value" ||
					(content.kind !== "text" && content.kind !== "json") ||
					(content.kind === "text" && typeof content.value !== "string") ||
					(output.folderCommitId !== undefined &&
						(typeof output.folderCommitId !== "string" || !UUID.test(output.folderCommitId))) ||
					(operation.requiresCompanyRevision && output.folderCommitId === undefined) ||
					(output.folderCommitId !== undefined &&
						(!operation.requiresCompanyRevision || !this.#control.completeFolderToolOperation)) ||
					(output.proposed !== undefined && (output.proposed !== true || output.folderCommitId === undefined))
				)
					throw new Error("Invalid cloud tool operation output");
				const storedResult = JSON.parse(
					cloudToolJsonText({ schema: RESULT_SCHEMA, inputSha256: digest, content }, 48 * 1024),
				) as JsonValue;
				// SQL echoes the commit id in lower case; send and compare it that way.
				const folderCommitId =
					output.folderCommitId === undefined ? undefined : parseUuid(output.folderCommitId, "Folder commit id");
				await this.#run.assertActive(signal);
				const completed = record(
					await cloudToolRequest(
						(requestSignal) =>
							folderCommitId !== undefined && this.#control.completeFolderToolOperation
								? this.#control.completeFolderToolOperation(
										this.#run.binding,
										{ receiptId, inputSha256: digest, result: storedResult, folderCommitId },
										requestSignal,
									)
								: this.#control.completeToolOperation(
										this.#run.binding,
										{ receiptId, inputSha256: digest, result: storedResult },
										requestSignal,
									),
						signal,
					),
				);
				// A folder-v2 completion also names its commit (null for a receipt that needed none).
				const keys = Object.keys(completed).sort().join();
				if (
					completed.run_id !== this.#run.identity.runId ||
					completed.receipt_id !== receiptId ||
					completed.state !== "completed" ||
					(keys !== "receipt_id,result,run_id,state" &&
						!(
							keys === "folder_commit_id,receipt_id,result,run_id,state" &&
							completed.folder_commit_id === (folderCommitId ?? null)
						)) ||
					(folderCommitId !== undefined && completed.folder_commit_id !== folderCommitId) ||
					cloudToolJsonText(completed.result) !== cloudToolJsonText(storedResult)
				)
					throw new Error("Cloud tool completion was not confirmed");
				return {
					content: structuredClone(record(storedResult).content) as CloudToolContent,
					receiptId: completed.receipt_id,
					// The canonical completion confirms the submitted, run-owned revision/proposal link.
					outcome: output.proposed ? "proposed" : "succeeded",
					...(output.proposed ? { parked: true as const } : {}),
				};
			});
		if (!previous) {
			this.#operations.set(key, { digest, result, receipt });
			this.#pending = result.then(
				() => undefined,
				() => undefined,
			);
		}
		try {
			const confirmed = await result;
			const refused = options.refused?.(confirmed.content);
			options.observation?.finish(
				refused ? "denied" : previous && confirmed.outcome === "succeeded" ? "replayed" : confirmed.outcome,
				{
					receiptId: confirmed.receiptId,
					outputBytes: Buffer.byteLength(
						confirmed.content.kind === "text"
							? confirmed.content.value
							: cloudToolJsonText(confirmed.content.value),
					),
					...(refused
						? { errorCategory: refused }
						: confirmed.parked
							? { errorCategory: "protected_path" as const }
							: {}),
				},
			);
			// A denied release cannot undo a confirmed effect or turn a replay into another successful effect.
			await observedCloudToolAuthority(
				options.observation,
				async () => {
					await this.#run.assertActive(signal);
					await cloudToolRequest(
						(requestSignal) => authorize(operation, this.#run.identity, requestSignal),
						signal,
					);
				},
				signal,
			);
			return structuredClone(confirmed.content);
		} catch (error) {
			// Refused at the authorize before the receipt: nothing began, so the registry's words are the answer.
			if (error instanceof RefusedBeforeReceipt && receipt.id === null && !signal.aborted) {
				options.observation?.finish("denied", { errorCategory: "authority_unavailable" });
				throw error.refusal;
			}
			// Settled by the kernel without an effect, on this call's own receipt: nothing happened either.
			if (
				error instanceof CloudToolOperationSettled &&
				receipt.id !== null &&
				error.receiptId === receipt.id &&
				!signal.aborted
			) {
				options.observation?.finish("failed", { receiptId: receipt.id, errorCategory: "stale_version" });
				throw error.refusal;
			}
			// Settled as outcome unknown by a resume: the effect may have happened, so the model checks before repeating it.
			if (
				error instanceof SettledOutcomeUnknown &&
				receipt.id !== null &&
				error.receiptId === receipt.id &&
				!signal.aborted
			) {
				options.observation?.finish("unconfirmed", { receiptId: receipt.id, errorCategory: "ambiguous_effect" });
				throw new CloudToolOutcomeUnknown();
			}
			options.observation?.finish("unconfirmed", {
				receiptId: receipt.id,
				errorCategory: receipt.id ? "ambiguous_effect" : cloudRuntimeErrorCategory(error, signal),
			});
			throw new Error("Cloud tool operation outcome unconfirmed");
		}
	}
}
