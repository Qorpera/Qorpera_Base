import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LxdOperationState, LxdTrackedClient } from "./lxd-client.ts";
import { LOGIN_UUID, type LxdLoginBinding, loginSha256, lxdLoginPlan } from "./lxd-login-plan.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";

type Action = "create" | "start" | "stop" | "delete";
type Client = Pick<LxdTrackedClient, "submitInstanceOperation" | "inspectInstanceOperation">;
type Result = { state: LxdOperationState | "unknown" | "not_dispatched"; operationId?: string };
interface Entry {
	kind: "dispatch" | "accepted" | "settled" | "closing" | "released" | "placement";
	action: Action | null;
	operationId: string | null;
	state: "succeeded" | "failed" | null;
	nodeId: string | null;
	releasedAt: string | null;
}
interface Event extends Entry {
	schema: "qorpera.lxd-login-event/v1";
	sequence: number;
	previousSha256: string;
}
export interface LxdLoginJournalState {
	closing: boolean;
	releasedAt: string | null;
	nodeId: string | null;
	operations: Partial<
		Record<
			Action,
			{ kind: "dispatch" | "accepted" | "settled"; operationId: string | null; state: "succeeded" | "failed" | null }
		>
	>;
}
interface ReadState {
	state: LxdLoginJournalState;
	sequence: number;
	previousSha256: string;
}
const actions: Action[] = ["create", "start", "stop", "delete"];
const MAX_EVENTS = 15; // Four physical operations, placement, closure, release.
const encode = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`);
function entry(kind: Entry["kind"], fields: Partial<Omit<Entry, "kind">> = {}): Entry {
	return { kind, action: null, operationId: null, state: null, nodeId: null, releasedAt: null, ...fields };
}
function pending(state: LxdLoginJournalState): Action | undefined {
	return actions.find((action) => state.operations[action] && state.operations[action]?.kind !== "settled");
}
function transition(state: LxdLoginJournalState, event: Entry): void {
	if (state.releasedAt) throw new Error("closed history");
	if (event.kind === "placement") {
		if (
			state.nodeId ||
			state.closing ||
			Object.keys(state.operations).length ||
			typeof event.nodeId !== "string" ||
			!LOGIN_UUID.test(event.nodeId ?? "") ||
			!isDeepStrictEqual(event, entry("placement", { nodeId: event.nodeId }))
		)
			throw new Error("invalid placement");
		state.nodeId = event.nodeId;
	} else if (event.kind === "closing") {
		if (state.closing || pending(state) || !isDeepStrictEqual(event, entry("closing")))
			throw new Error("unsettled closure");
		state.closing = true;
	} else if (event.kind === "released") {
		if (
			!state.closing ||
			pending(state) ||
			typeof event.releasedAt !== "string" ||
			!Number.isFinite(Date.parse(event.releasedAt)) ||
			!isDeepStrictEqual(event, entry("released", { releasedAt: event.releasedAt }))
		)
			throw new Error("invalid release");
		state.releasedAt = event.releasedAt;
	} else {
		const action = event.action;
		if (!action || !actions.includes(action) || event.nodeId !== null || event.releasedAt !== null)
			throw new Error("invalid operation");
		const previous = state.operations[action];
		if (event.kind === "dispatch") {
			if (
				previous ||
				pending(state) ||
				event.operationId !== null ||
				event.state !== null ||
				((action === "create" || action === "start") && (state.closing || !state.nodeId)) ||
				(action === "create" && Object.keys(state.operations).length !== 0) ||
				(action === "start" && state.operations.create?.state !== "succeeded") ||
				((action === "stop" || action === "delete") && !state.closing) ||
				(action === "stop" && state.operations.delete)
			)
				throw new Error("invalid dispatch order");
		} else if (event.kind === "accepted") {
			if (
				previous?.kind !== "dispatch" ||
				typeof event.operationId !== "string" ||
				!LOGIN_UUID.test(event.operationId ?? "") ||
				event.state !== null ||
				Object.values(state.operations).some((op) => op.operationId === event.operationId)
			)
				throw new Error("invalid acceptance");
		} else if (event.kind === "settled") {
			if (
				previous?.kind !== "accepted" ||
				event.operationId !== previous.operationId ||
				!["succeeded", "failed"].includes(event.state ?? "")
			)
				throw new Error("invalid settlement");
		} else throw new Error("invalid event kind");
		state.operations[action] = { kind: event.kind, operationId: event.operationId, state: event.state };
	}
}

/** One physical VM per login allocation. An atomic, immutable event sequence
 * fences competing processes: only the dispatch winner may send LXD IO.
 * Closure competes on that same sequence and cannot pass unsettled IO.
 * Unknown submission is permanent uncertainty, never inferred from absence.
 * This journal does not itself prove cloud authority or physical deletion. */
export class LxdLoginJournal {
	readonly #root: string;
	readonly #binding: LxdLoginBinding;
	readonly #client: Client;
	private constructor(root: string, binding: LxdLoginBinding, client: Client) {
		this.#root = root;
		this.#binding = lxdLoginPlan(binding).binding;
		this.#client = client;
	}
	get binding(): LxdLoginBinding {
		return structuredClone(this.#binding);
	}
	static async open(
		stateRoot: string,
		loginId: string,
		client: Client,
		initial?: LxdLoginBinding,
	): Promise<LxdLoginJournal> {
		if (resolve(stateRoot) !== stateRoot || !LOGIN_UUID.test(loginId)) throw new Error("INVALID_LOGIN_JOURNAL");
		await checkDirectory(stateRoot);
		const root = join(stateRoot, loginId);
		if (initial) {
			const binding = lxdLoginPlan(initial).binding;
			if (binding.loginId !== loginId) throw new Error("INVALID_LOGIN_JOURNAL");
			try {
				await mkdir(root, { mode: 0o700 });
				await syncDirectory(stateRoot);
			} catch (error) {
				if (!code(error, "EEXIST")) throw error;
			}
			await checkDirectory(root);
			await publish(root, "authority.json", encode(binding));
		}
		await checkDirectory(root);
		const { value } = await readRecord(join(root, "authority.json"));
		const binding = lxdLoginPlan(value as LxdLoginBinding).binding;
		if (binding.loginId !== loginId) throw new Error("LOGIN_JOURNAL_BINDING_CONFLICT");
		if (initial && !isDeepStrictEqual(binding, { ...initial, allocationId: binding.allocationId }))
			throw new Error("LOGIN_JOURNAL_BINDING_CONFLICT");
		const journal = new LxdLoginJournal(root, binding, client);
		await journal.#read();
		return journal;
	}
	async #read(): Promise<ReadState> {
		try {
			await checkDirectory(this.#root);
			const authority = await readRecord(join(this.#root, "authority.json"));
			if (!isDeepStrictEqual(authority.value, this.#binding)) throw new Error("binding changed");
			const names = (await readdir(this.#root))
				.filter(
					(name) => name !== "authority.json" && name !== "bridge.json" && !/^\.write-[0-9a-f-]{36}$/.test(name),
				)
				.sort();
			if (names.length > MAX_EVENTS) throw new Error("history full");
			let previousSha256 = loginSha256(authority.bytes);
			const state: LxdLoginJournalState = { closing: false, releasedAt: null, nodeId: null, operations: {} };
			for (const [sequence, name] of names.entries()) {
				if (name !== `${String(sequence).padStart(6, "0")}.json`) throw new Error("missing history");
				const { value, bytes } = await readRecord(join(this.#root, name));
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid event");
				const event = value as Event;
				if (
					Object.keys(event).sort().join() !==
						"action,kind,nodeId,operationId,previousSha256,releasedAt,schema,sequence,state" ||
					event.schema !== "qorpera.lxd-login-event/v1" ||
					event.sequence !== sequence ||
					event.previousSha256 !== previousSha256
				)
					throw new Error("broken history");
				const { schema: _schema, sequence: _sequence, previousSha256: _hash, ...fields } = event;
				transition(state, fields);
				previousSha256 = loginSha256(bytes);
			}
			return { state, sequence: names.length, previousSha256 };
		} catch {
			throw new Error("LOGIN_JOURNAL_UNCONFIRMED");
		}
	}
	async state(): Promise<LxdLoginJournalState> {
		return (await this.#read()).state;
	}
	async #append(current: ReadState, fields: Entry): Promise<boolean> {
		if (current.sequence >= MAX_EVENTS) throw new Error("LOGIN_JOURNAL_FULL");
		transition(structuredClone(current.state), fields);
		return publish(
			this.#root,
			`${String(current.sequence).padStart(6, "0")}.json`,
			encode({
				schema: "qorpera.lxd-login-event/v1",
				sequence: current.sequence,
				previousSha256: current.previousSha256,
				...fields,
			}),
		);
	}
	async place(nodeId: string): Promise<void> {
		const current = await this.#read();
		if (!current.state.nodeId) await this.#append(current, entry("placement", { nodeId }));
		if ((await this.state()).nodeId !== nodeId) throw new Error("LOGIN_NODE_PLACEMENT_CONFLICT");
	}
	async close(signal: AbortSignal): Promise<boolean> {
		let current = await this.#read();
		if (current.state.closing) return true;
		const action = pending(current.state);
		if (action) {
			await this.observe(action, signal);
			current = await this.#read();
			if (pending(current.state)) return false;
		}
		signal.throwIfAborted();
		await this.#append(current, entry("closing"));
		return (await this.state()).closing;
	}
	async release(releasedAt: string): Promise<void> {
		const current = await this.#read();
		if (!current.state.releasedAt) await this.#append(current, entry("released", { releasedAt }));
		if ((await this.state()).releasedAt !== releasedAt) throw new Error("LOGIN_RELEASE_CONFLICT");
	}
	async run(action: Action, signal: AbortSignal, authorize?: () => Promise<AbortSignal>): Promise<Result> {
		signal.throwIfAborted();
		let current = await this.#read();
		if (!current.state.operations[action]) {
			if ((action === "create" || action === "start") && !authorize) throw new Error("LOGIN_ADMISSION_REQUIRED");
			const dispatchSignal = authorize ? await authorize() : signal;
			dispatchSignal.throwIfAborted();
			// Authorization may have persisted the first immutable placement.
			current = await this.#read();
			if (current.state.operations[action]) return this.observe(action, signal);
			if (!(await this.#append(current, entry("dispatch", { action })))) return this.observe(action, signal);
			const { request, binding } = lxdLoginPlan(this.#binding);
			let operationId: string;
			try {
				dispatchSignal.throwIfAborted();
				const reference = await this.#client.submitInstanceOperation(
					binding.policy.project,
					action === "create" ? { action, request } : { action, name: request.name },
					dispatchSignal,
				);
				if (
					reference.project !== binding.policy.project ||
					reference.instanceName !== request.name ||
					!LOGIN_UUID.test(reference.operationId)
				)
					throw new Error("unbound operation");
				operationId = reference.operationId;
			} catch {
				return { state: "unknown" };
			}
			current = await this.#read();
			await this.#append(current, entry("accepted", { action, operationId }));
		}
		return this.observe(action, signal);
	}
	async observe(action: Action, signal: AbortSignal): Promise<Result> {
		const current = await this.#read(),
			operation = current.state.operations[action];
		if (!operation) return { state: "not_dispatched" };
		if (operation.kind === "dispatch") return { state: "unknown" };
		const operationId = operation.operationId as string;
		if (operation.kind === "settled") return { state: operation.state as "succeeded" | "failed", operationId };
		let state: LxdOperationState;
		try {
			signal.throwIfAborted();
			const plan = lxdLoginPlan(this.#binding);
			state = await this.#client.inspectInstanceOperation(
				{ project: plan.binding.policy.project, instanceName: plan.request.name, operationId },
				signal,
			);
			if (!["pending", "succeeded", "failed"].includes(state)) throw new Error("invalid observation");
		} catch {
			return { state: "unknown", operationId };
		}
		if (state === "pending") return { state, operationId };
		if (!(await this.#append(current, entry("settled", { action, operationId, state })))) {
			const winner = (await this.state()).operations[action];
			if (winner?.kind !== "settled" || winner.state !== state || winner.operationId !== operationId)
				throw new Error("LOGIN_OPERATION_CONFLICT");
		}
		return { state, operationId };
	}
}
