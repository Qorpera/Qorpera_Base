import {
	parseWorkerParent,
	parseWorkerTodo,
	parseWorkerTodoIdentity,
	WORKER_TODO_MAX_BYTES,
	WorkerContractError,
	type WorkerParentIdentity,
	type WorkerTodo,
	type WorkerTodoIdentity,
	workerCanonicalJson,
	workerDigest,
	workerRecord,
	workerSame,
	workerUuid,
} from "./cloud-worker-contract.ts";
import type { WorkerCompanyFilePort, WorkerEffectGuard } from "./cloud-worker-ports.ts";

/** Only a positively classified stale-object CAS can retry a pure transition. */
export class WorkerTodoConflict extends Error {
	constructor() {
		super("Worker todo version changed");
	}
}

export class WorkerTodoProposalPending extends Error {
	readonly proposalId: string;
	constructor(proposalId: string) {
		super("Worker todo mutation awaits Company File approval");
		this.proposalId = workerUuid(proposalId);
	}
}

export interface WorkerTodoSnapshot {
	version: string;
	value: WorkerTodo;
}

/** No local cache is authoritative. Reads and CAS writes use the live Company File. */
export class CompanyFileWorkerTodoStore {
	readonly identity: WorkerTodoIdentity;
	readonly parent: WorkerParentIdentity;
	readonly #file: WorkerCompanyFilePort;

	constructor(identity: WorkerTodoIdentity, parent: WorkerParentIdentity, file: WorkerCompanyFilePort) {
		this.identity = Object.freeze(parseWorkerTodoIdentity(identity));
		this.parent = Object.freeze(parseWorkerParent(parent));
		if (!file || typeof file.read !== "function" || typeof file.commit !== "function")
			throw new WorkerContractError("Guarded Company File adapter is required");
		this.#file = file;
	}

	async read(signal: AbortSignal): Promise<WorkerTodoSnapshot | null> {
		for (let attempt = 0; attempt < 8; attempt++) {
			try {
				return await this.#readCurrent(signal);
			} catch (error) {
				if (!(error instanceof WorkerTodoConflict)) throw error;
			}
		}
		throw new WorkerTodoConflict();
	}

	async #readCurrent(signal: AbortSignal): Promise<WorkerTodoSnapshot | null> {
		let offset = 0;
		let version: string | undefined;
		let totalBytes: number | undefined;
		const chunks: string[] = [];
		for (let page = 0; page < 10; page++) {
			signal.throwIfAborted();
			const value = await this.#file.read(this.identity.path, offset, 4096, signal);
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				(value as Record<string, unknown>).kind === "absent"
			) {
				const absent = workerRecord(value, ["path", "version", "kind"]);
				if (offset !== 0 || absent.path !== this.identity.path || absent.version !== null)
					throw new WorkerContractError("A deleted worker todo cannot be recreated implicitly");
				return null;
			}
			const input = workerRecord(value, [
				"path",
				"version",
				"kind",
				"offset",
				"bytesRead",
				"totalBytes",
				"text",
				"nextOffset",
			]);
			const currentVersion = workerUuid(input.version);
			if (
				input.path !== this.identity.path ||
				input.kind !== "file" ||
				input.offset !== offset ||
				typeof input.text !== "string" ||
				!Number.isSafeInteger(input.bytesRead) ||
				(input.bytesRead as number) < 1 ||
				(input.bytesRead as number) > 4096 ||
				Buffer.byteLength(input.text) !== input.bytesRead ||
				!Number.isSafeInteger(input.totalBytes) ||
				(input.totalBytes as number) < 1 ||
				(input.totalBytes as number) > WORKER_TODO_MAX_BYTES
			)
				throw new WorkerContractError("Worker todo changed or exceeded its read budget");
			if (version !== undefined && version !== currentVersion) throw new WorkerTodoConflict();
			if (totalBytes !== undefined && totalBytes !== input.totalBytes)
				throw new WorkerContractError("Worker todo bytes changed without a version");
			version = currentVersion;
			totalBytes = input.totalBytes as number;
			chunks.push(input.text);
			offset += input.bytesRead as number;
			if (offset > totalBytes || input.nextOffset !== (offset === totalBytes ? null : offset))
				throw new WorkerContractError("Invalid worker todo pagination");
			if (input.nextOffset === null) {
				signal.throwIfAborted();
				const document = parseWorkerTodo(JSON.parse(chunks.join("")));
				this.#assertIdentity(document);
				return { version, value: document };
			}
		}
		throw new WorkerContractError("Worker todo read budget exhausted");
	}

	async write(
		previous: WorkerTodoSnapshot | null,
		value: WorkerTodo,
		logicalKey: string,
		guard: Omit<WorkerEffectGuard, "todo" | "parent" | "expectedVersion">,
		signal: AbortSignal,
	): Promise<WorkerTodoSnapshot> {
		signal.throwIfAborted();
		const next = parseWorkerTodo(value);
		this.#assertIdentity(next);
		if (next.revision !== (previous?.value.revision ?? 0) + 1)
			throw new WorkerContractError("Worker todo transition skipped a revision");
		const expectedVersion = previous?.version ?? null;
		const encoded = workerCanonicalJson(next);
		// A stale CAS can rebase only this pure state transition. External command
		// identity is separately persisted and never derived from this revision.
		const operationKey = `worker-todo:${workerDigest([this.identity, logicalKey, expectedVersion, next])}`;
		const response = workerRecord(
			await this.#file.commit(
				{ ...guard, todo: this.identity, parent: this.parent, expectedVersion },
				{ path: this.identity.path, operationKey, expectedVersion, text: encoded },
				signal,
			),
			["schema", "state", "operationKey", "path", "version", "snapshotId", "receiptId", "proposalId"],
		);
		if (
			response.schema !== "qorpera.company-path-result/v1" ||
			response.operationKey !== operationKey ||
			response.path !== this.identity.path
		)
			throw new WorkerContractError("Worker todo receipt binding differs");
		workerUuid(response.receiptId);
		if (response.state === "proposed" && response.version === expectedVersion && response.snapshotId === null) {
			throw new WorkerTodoProposalPending(workerUuid(response.proposalId));
		}
		if (response.state !== "applied" || response.proposalId !== null)
			throw new WorkerContractError("Worker todo was not applied");
		const version = workerUuid(response.version);
		workerUuid(response.snapshotId);
		if (version === expectedVersion) throw new WorkerContractError("Worker todo receipt did not advance its version");
		signal.throwIfAborted();
		return { version, value: next };
	}

	#assertIdentity(value: WorkerTodo): void {
		if (!workerSame(value.identity, this.identity) || !workerSame(value.parent, this.parent))
			throw new WorkerContractError("Worker todo belongs to another parent or Company File");
	}
}
