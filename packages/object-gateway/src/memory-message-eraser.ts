import { ObjectDependencyError } from "./dependency.ts";
import type { MemberCompanyAuthority, MemberCompanyPublisherRpc } from "./member-company-authority.ts";
import { UUID } from "./native-objects.ts";
import type { FileSystemObjectStore } from "./object-store.ts";
import {
	type PlatformFileReference,
	PlatformFolderWriter,
	platformFolderProblem,
	platformFolderProblemCode,
	record,
} from "./platform-folder-writer.ts";
import type { ObjectGatewayReplication } from "./replication.ts";

/*
 * The memory message eraser (M3, migration 20260930441000; deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §10). An
 * owner's or admin's request writes an erase's row; this worker carries each row that is not done through its four
 * steps, each a database function that takes the row, checks its state and moves it on: step 1 (`_open`, pending to
 * open) blanks the message and deletes the blocks built from it, step 2 (`_plan`, then `_rewrite`, open to rewritten)
 * writes each block again with its kept lines, step 3 (`_ask`, rewritten to requested) asks P18's block-history erasure
 * for one block per call, and step 4 (`_scrub`, requested to done) scrubs the read receipts of the runs that read the
 * message. Only step 2 needs the gateway: the database plans each block's text, the eraser stages it as the platform,
 * and the rewrite commits the staged files in the plan's order under the plan's hash, which the eraser takes as given.
 *
 * Each pass reads the queue (`_due`, the longest waiting first) and steps each erase on until a step leaves it where it
 * was (it waits on a lock, a run, P18 or its next block) or it is done or refused. A step that rolled back leaves the
 * row as it was, so the next pass carries on from the state the row holds. Before an erase's first step, a pass takes
 * it (`_take`, migration 20260930443000), which moves it behind every other erase due: the queue lists first the ones
 * no pass took since, those a pass listed but never reached included, so passes go round it. An erase whose step
 * failed also rests a minute, which the queue passes over: ones that keep failing or waiting never hold its head.
 * Problems are reported as codes, never with a message.
 * Built switched off: the gateway runs it only with QORPERA_MEMORY_MESSAGE_ERASER=1.
 */

/** An erase's states, as its row checks them; the queue lists the four before done and refused. */
type EraseState = "pending" | "open" | "rewritten" | "requested" | "done" | "refused";
type DueState = Exclude<EraseState, "done" | "refused">;

const STATES = new Set<string>(["pending", "open", "rewritten", "requested", "done", "refused"]);
const DUE_STATES = new Set<string>(["pending", "open", "rewritten", "requested"]);
/** Every field a queue row, a step's answer, a plan and a plan's block carry; any other refuses it. */
const DUE_KEYS = ["environment_id", "erase_id", "state"] as const;
const REPLY_KEYS = ["schema", "eraseId", "state", "sessionId", "eventId", "blocks", "runsPending"] as const;
const PLAN_KEYS = ["schema", "eraseId", "planSha256", "blocks"] as const;
const BLOCK_KEYS = ["path", "text", "fileSha256", "bytes", "expectedVersion"] as const;
const SHA256 = /^[0-9a-f]{64}$/;
/** A block's lines, staged as a run log's blocks are. */
const MEDIA_TYPE = "application/jsonl";
/** The queue's own bound, on the erases it lists and on the resting ones it passes over. */
const MAX_DUE = 1000;
/** A step moves an erase on by one state at most, and its states only move forward: four steps take one from pending
 * to done. */
const STEPS_PER_ERASE = 4;
/** How long an erase whose step failed rests: the queue passes over it meanwhile. */
const REST_MS = 60_000;

type EraseRpc = Extract<
	MemberCompanyPublisherRpc,
	| "qorpera_memory_message_erase_open"
	| "qorpera_memory_message_erase_plan"
	| "qorpera_memory_message_erase_rewrite"
	| "qorpera_memory_message_erase_ask"
	| "qorpera_memory_message_erase_scrub"
>;
/** The step for each state but open, whose step stages the plan first. */
const STEP_RPCS = {
	pending: "qorpera_memory_message_erase_open",
	rewritten: "qorpera_memory_message_erase_ask",
	requested: "qorpera_memory_message_erase_scrub",
} as const;

/** An erase the queue names, with the state its next step starts from. */
interface DueErase {
	readonly environmentId: string;
	readonly eraseId: string;
	readonly state: DueState;
}

/** A block step 2 writes again: its text, with the hash and length of the text's UTF-8. */
interface PlanBlock {
	readonly path: string;
	readonly text: string;
	readonly fileSha256: string;
	readonly bytes: number;
}

const problem = platformFolderProblem;
const encoder = new TextEncoder();

/** The queue's answer (`qorpera_memory_message_erase_due`), checked row by row. */
function dueErases(value: unknown): DueErase[] {
	if (!Array.isArray(value)) return problem("due_invalid");
	return value.map((item) => {
		const row = record(item, DUE_KEYS, "due_invalid");
		if (
			typeof row.environment_id !== "string" ||
			!UUID.test(row.environment_id) ||
			typeof row.erase_id !== "string" ||
			!UUID.test(row.erase_id) ||
			typeof row.state !== "string" ||
			!DUE_STATES.has(row.state)
		)
			problem("due_invalid");
		return {
			environmentId: row.environment_id as string,
			eraseId: row.erase_id as string,
			state: row.state as DueState,
		};
	});
}

/** A step's answer (`qorpera.memory-message-erase/v1`) for `eraseId`: the state the step left the erase in. */
function stepState(value: unknown, eraseId: string): EraseState {
	const reply = record(value, REPLY_KEYS, "reply_invalid");
	if (
		reply.schema !== "qorpera.memory-message-erase/v1" ||
		reply.eraseId !== eraseId ||
		typeof reply.state !== "string" ||
		!STATES.has(reply.state) ||
		typeof reply.sessionId !== "string" ||
		!UUID.test(reply.sessionId) ||
		typeof reply.eventId !== "string" ||
		!UUID.test(reply.eventId) ||
		!Number.isSafeInteger(reply.blocks) ||
		!Number.isSafeInteger(reply.runsPending)
	)
		problem("reply_invalid");
	return reply.state as EraseState;
}

/** Step 2's plan (`qorpera.memory-message-erase-plan/v1`) for `eraseId`, checked block by block. */
function erasePlan(value: unknown, eraseId: string): { planSha256: string; blocks: PlanBlock[] } {
	const plan = record(value, PLAN_KEYS, "plan_invalid");
	if (
		plan.schema !== "qorpera.memory-message-erase-plan/v1" ||
		plan.eraseId !== eraseId ||
		typeof plan.planSha256 !== "string" ||
		!SHA256.test(plan.planSha256) ||
		!Array.isArray(plan.blocks)
	)
		problem("plan_invalid");
	const blocks = (plan.blocks as unknown[]).map((item) => {
		const block = record(item, BLOCK_KEYS, "plan_invalid");
		if (
			typeof block.path !== "string" ||
			typeof block.text !== "string" ||
			typeof block.fileSha256 !== "string" ||
			!SHA256.test(block.fileSha256) ||
			!Number.isSafeInteger(block.bytes) ||
			(block.bytes as number) < 0 ||
			(block.expectedVersion !== null &&
				!(typeof block.expectedVersion === "string" && UUID.test(block.expectedVersion)))
		)
			problem("plan_invalid");
		return {
			path: block.path as string,
			text: block.text as string,
			fileSha256: block.fileSha256 as string,
			bytes: block.bytes as number,
		};
	});
	return { planSha256: plan.planSha256 as string, blocks };
}

export interface MemoryMessageEraserOptions {
	readonly authority: Pick<MemberCompanyAuthority, "publisher">;
	readonly store: Pick<FileSystemObjectStore, "get">;
	readonly replication: Pick<ObjectGatewayReplication, "uploadWithAuthority">;
}

export class MemoryMessageEraser {
	readonly #options: MemoryMessageEraserOptions;
	readonly #folder: PlatformFolderWriter;
	/** Each erase whose step failed, and until when it rests: the oldest rest first, `MAX_DUE` at most. */
	readonly #rests = new Map<string, number>();

	constructor(options: MemoryMessageEraserOptions) {
		this.#options = options;
		this.#folder = new PlatformFolderWriter(options);
	}

	/**
	 * Steps the due erases on, at most `max` of them, until `signal` ends (no new step is taken then); returns how many
	 * were taken. Each pass names the resting ones for the queue to pass over and takes the longest waiting erases it
	 * lists, one at a time: taking one moves it behind every other erase due, before its first step. One a step holds
	 * now, or done or refused meanwhile, is not taken. An erase whose step failed rests (`REST_MS`).
	 * - A lock conflict or a state that refuses the call now (423) only rests it.
	 * - An outage rests it and ends the pass: the database client's circuit may have opened on it, and would refuse
	 *   the next erase's step without asking the database.
	 * - Any other failure rests it too, and once the pass's other erases had their turn, the pass rejects with the
	 *   first such failure's code.
	 */
	async eraseDue(max = 20, signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<number> {
		if (signal.aborted || !Number.isSafeInteger(max) || max < 1) return 0;
		const now = Date.now();
		for (const [eraseId, until] of this.#rests) if (until <= now) this.#rests.delete(eraseId);
		const queue = dueErases(
			await this.#options.authority.publisher(
				"qorpera_memory_message_erase_due",
				{ p_limit: Math.min(max, MAX_DUE), p_resting: [...this.#rests.keys()] },
				signal,
			),
		);
		let taken = 0;
		let failed: string | null = null;
		for (const erase of queue) {
			if (signal.aborted || taken >= max) break;
			try {
				if (!(await this.#take(erase, signal))) continue;
				taken++;
				await this.#carry(erase, signal);
			} catch (error) {
				// A call the pass's deadline cut off says nothing about its erase: its step lands once, in that call or
				// in a later pass.
				if (signal.aborted) break;
				this.#rest(erase.eraseId);
				const code = platformFolderProblemCode(error);
				if (code === "unavailable") break;
				const notNow = error instanceof ObjectDependencyError && error.status === 423;
				if (code !== "lock_conflict" && !notNow) failed ??= code;
			}
		}
		if (failed !== null) problem(failed);
		return taken;
	}

	/** Takes an erase for this pass, in a call of its own; false when a step holds it now, or it is done or refused. */
	async #take(erase: DueErase, signal: AbortSignal): Promise<boolean> {
		const answer = await this.#options.authority.publisher(
			"qorpera_memory_message_erase_take",
			{ p_erase_id: erase.eraseId },
			signal,
		);
		return typeof answer === "boolean" ? answer : problem("take_invalid");
	}

	/** Rests an erase for `REST_MS`; when `MAX_DUE` already rest, the oldest rest ends early. */
	#rest(eraseId: string): void {
		this.#rests.delete(eraseId);
		this.#rests.set(eraseId, Date.now() + REST_MS);
		if (this.#rests.size > MAX_DUE) this.#rests.delete(this.#rests.keys().next().value as string);
	}

	/** Steps one erase on from the state the queue named, until a step leaves it where it was, or it is done or
	 * refused. */
	async #carry(erase: DueErase, signal: AbortSignal): Promise<void> {
		let state: EraseState = erase.state;
		for (let steps = 0; steps < STEPS_PER_ERASE && !signal.aborted; steps++) {
			if (state === "done" || state === "refused") return;
			const next: EraseState =
				state === "open"
					? await this.#rewrite(erase, signal)
					: stepState(await this.#call(STEP_RPCS[state], erase, {}, signal), erase.eraseId);
			// Nothing moved on yet (a try that rolled back, a run still live, a block P18 takes later, or the erase's next
			// block): the next pass asks again.
			if (next === state) return;
			state = next;
		}
	}

	/** Step 2: the plan, each block's text staged as the platform, and the rewrite with the plan's hash. A plan that
	 * moved before the rewrite took it (a run wrote one of its blocks meanwhile: 55000, so 423) is planned once more. */
	async #rewrite(erase: DueErase, signal: AbortSignal): Promise<EraseState> {
		for (let attempt = 1; ; attempt++) {
			const plan = erasePlan(
				await this.#call("qorpera_memory_message_erase_plan", erase, {}, signal),
				erase.eraseId,
			);
			const files: { path: string; file: PlatformFileReference }[] = [];
			for (const block of plan.blocks) {
				const file = await this.#folder.stage(
					erase.environmentId,
					encoder.encode(block.text),
					{ mediaType: MEDIA_TYPE, executable: false },
					signal,
				);
				// The plan's hash and length are of the text's UTF-8, as the staged file's are.
				if (file.fileSha256 !== block.fileSha256 || file.bytes !== block.bytes) problem("plan_invalid");
				files.push({ path: block.path, file });
			}
			try {
				return stepState(
					await this.#call(
						"qorpera_memory_message_erase_rewrite",
						erase,
						{ p_plan_sha256: plan.planSha256, p_files: files },
						signal,
					),
					erase.eraseId,
				);
			} catch (error) {
				if (attempt > 1 || !(error instanceof ObjectDependencyError) || error.status !== 423) throw error;
			}
		}
	}

	#call(method: EraseRpc, erase: DueErase, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		return this.#options.authority.publisher(
			method,
			{ p_environment_id: erase.environmentId, p_erase_id: erase.eraseId, ...args },
			signal,
		);
	}
}
