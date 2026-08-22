import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { JsonValue } from "@qorpera/contracts";
import type { CloudRunnerAuthorityStore } from "./cloud-runner-control.ts";

const MAX_AUTHORITY_STATE_BYTES = 256 * 1024;

function secureOpenFlags(flags: number): number {
	return process.platform === "linux" ? flags | constants.O_NOFOLLOW : flags;
}

function assertPrivateOwner(mode: number, uid: number, label: string): void {
	if (process.platform !== "linux") return;
	const currentUid = process.getuid?.();
	if (currentUid === undefined || uid !== currentUid || (mode & 0o077) !== 0) {
		throw new Error(`${label} is not private to the runner service account`);
	}
}

export class FileCloudRunnerAuthorityStore implements CloudRunnerAuthorityStore {
	readonly #path: string;
	readonly #parent: string;
	#saveTail: Promise<void> = Promise.resolve();

	constructor(path: string) {
		if (!isAbsolute(path) || basename(path).length < 1 || /[\0\r\n]/.test(path)) {
			throw new Error("Runner authority state path is invalid");
		}
		this.#path = resolve(path);
		this.#parent = dirname(this.#path);
	}

	async load(): Promise<unknown | undefined> {
		let handle: FileHandle;
		try {
			handle = await open(this.#path, secureOpenFlags(constants.O_RDONLY));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			const metadata = await handle.stat();
			if (!metadata.isFile() || metadata.size > MAX_AUTHORITY_STATE_BYTES) {
				throw new Error("Runner authority state file is invalid");
			}
			assertPrivateOwner(metadata.mode, metadata.uid, "Runner authority state file");
			const encoded = await handle.readFile({ encoding: "utf-8" });
			if (Buffer.byteLength(encoded) > MAX_AUTHORITY_STATE_BYTES) {
				throw new Error("Runner authority state file exceeds its byte limit");
			}
			try {
				return JSON.parse(encoded) as unknown;
			} catch (error) {
				throw new Error("Runner authority state file contains invalid JSON", { cause: error });
			}
		} finally {
			await handle.close();
		}
	}

	save(value: JsonValue): Promise<void> {
		const pending = this.#saveTail.then(() => this.#save(value));
		this.#saveTail = pending.catch(() => undefined);
		return pending;
	}

	async #save(value: JsonValue): Promise<void> {
		const encoded = `${JSON.stringify(value)}\n`;
		if (Buffer.byteLength(encoded) > MAX_AUTHORITY_STATE_BYTES) {
			throw new Error("Runner authority state exceeds its byte limit");
		}
		await mkdir(this.#parent, { recursive: true, mode: 0o700 });
		const physicalParent = await realpath(this.#parent);
		if (resolve(physicalParent) !== this.#parent) {
			throw new Error("Runner authority state directory cannot be a symbolic link");
		}
		const parentMetadata = await lstat(this.#parent);
		if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
			throw new Error("Runner authority state directory is invalid");
		}
		assertPrivateOwner(parentMetadata.mode, parentMetadata.uid, "Runner authority state directory");
		try {
			const current = await lstat(this.#path);
			if (!current.isFile() || current.isSymbolicLink()) {
				throw new Error("Runner authority state target is invalid");
			}
			assertPrivateOwner(current.mode, current.uid, "Runner authority state file");
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
