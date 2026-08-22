import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const STATE_SCHEMA = "qorpera.runner-orchestrator-control/v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_STATE_BYTES = 1024;

export interface RunnerOrchestratorControlTokenState {
	current: string;
	pending?: string;
}

function secureOpenFlags(flags: number): number {
	return process.platform === "linux" ? flags | constants.O_NOFOLLOW : flags;
}

function assertPrivateOwner(mode: number, uid: number, label: string): void {
	if (process.platform !== "linux") return;
	const currentUid = process.getuid?.();
	if (currentUid === undefined || uid !== currentUid || (mode & 0o077) !== 0) {
		throw new Error(`${label} is not private to the orchestrator service account`);
	}
}

function parseState(value: unknown): RunnerOrchestratorControlTokenState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Orchestrator control state is invalid");
	}
	const state = value as Record<string, unknown>;
	if (
		state.schema !== STATE_SCHEMA ||
		typeof state.current !== "string" ||
		!TOKEN_PATTERN.test(state.current) ||
		(state.pending !== undefined && (typeof state.pending !== "string" || !TOKEN_PATTERN.test(state.pending))) ||
		Object.keys(state).some((key) => !["schema", "current", "pending"].includes(key))
	) {
		throw new Error("Orchestrator control state is invalid");
	}
	return { current: state.current, ...(typeof state.pending === "string" ? { pending: state.pending } : {}) };
}

export class FileRunnerOrchestratorControlTokenStore {
	readonly #path: string;
	readonly #parent: string;
	#saveTail: Promise<void> = Promise.resolve();

	constructor(path: string) {
		if (!isAbsolute(path) || basename(path).length < 1 || /[\0\r\n]/.test(path)) {
			throw new Error("Orchestrator control state path is invalid");
		}
		this.#path = resolve(path);
		this.#parent = dirname(this.#path);
	}

	async load(bootstrapToken: string): Promise<RunnerOrchestratorControlTokenState> {
		if (!TOKEN_PATTERN.test(bootstrapToken)) throw new Error("Orchestrator bootstrap control token is invalid");
		let handle: FileHandle;
		try {
			handle = await open(this.#path, secureOpenFlags(constants.O_RDONLY));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const state = { current: bootstrapToken };
			await this.save(state);
			return state;
		}
		try {
			const metadata = await handle.stat();
			if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) {
				throw new Error("Orchestrator control state file is invalid");
			}
			assertPrivateOwner(metadata.mode, metadata.uid, "Orchestrator control state file");
			const encoded = await handle.readFile({ encoding: "utf-8" });
			if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) {
				throw new Error("Orchestrator control state file exceeds its byte limit");
			}
			try {
				return parseState(JSON.parse(encoded) as unknown);
			} catch (error) {
				throw new Error("Orchestrator control state file contains invalid JSON", { cause: error });
			}
		} finally {
			await handle.close();
		}
	}

	save(state: RunnerOrchestratorControlTokenState): Promise<void> {
		const parsed = parseState({ schema: STATE_SCHEMA, ...state });
		const pending = this.#saveTail.then(() => this.#save(parsed));
		this.#saveTail = pending.catch(() => undefined);
		return pending;
	}

	async #save(state: RunnerOrchestratorControlTokenState): Promise<void> {
		const encoded = `${JSON.stringify({ schema: STATE_SCHEMA, ...state })}\n`;
		await mkdir(this.#parent, { recursive: true, mode: 0o700 });
		const physicalParent = await realpath(this.#parent);
		if (resolve(physicalParent) !== this.#parent) {
			throw new Error("Orchestrator control state directory cannot be a symbolic link");
		}
		const parentMetadata = await lstat(this.#parent);
		if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
			throw new Error("Orchestrator control state directory is invalid");
		}
		assertPrivateOwner(parentMetadata.mode, parentMetadata.uid, "Orchestrator control state directory");
		try {
			const current = await lstat(this.#path);
			if (!current.isFile() || current.isSymbolicLink()) {
				throw new Error("Orchestrator control state target is invalid");
			}
			assertPrivateOwner(current.mode, current.uid, "Orchestrator control state file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const temporary = resolve(this.#parent, `.${basename(this.#path)}.${randomUUID()}.tmp`);
		let handle: FileHandle | undefined;
		try {
			handle = await open(
				temporary,
				secureOpenFlags(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL),
				0o600,
			);
			await handle.writeFile(encoded, { encoding: "utf-8" });
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporary, this.#path);
			if (process.platform === "linux") await chmod(this.#path, 0o600);
			if (process.platform === "linux") {
				const directory = await open(this.#parent, constants.O_RDONLY | constants.O_DIRECTORY);
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		} finally {
			if (handle) await handle.close();
			await rm(temporary, { force: true });
		}
	}
}
