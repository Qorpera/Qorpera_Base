import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, open, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
	readBoundedCloudResponse,
	supabaseServiceHeaders,
	withCloudDeadline,
} from "@qorpera/cloud-client/cloud-request";
import type { RecoveryObjectStore } from "./cloud-identity-recovery.ts";
import { recoverySha256, recoveryUuid } from "./cloud-identity-recovery-crypto.ts";

async function recoveryStorageError(
	response: Response,
	signal: AbortSignal,
): Promise<"missing" | "exists" | undefined> {
	if (response.status !== 400) {
		void response.body?.cancel().catch(() => undefined);
		return response.status === 404 ? "missing" : response.status === 409 ? "exists" : undefined;
	}
	// Storage can use HTTP 400 with a typed object error. Never infer success
	// from its message, or reinterpret an explicit authorization denial.
	try {
		const value: unknown = JSON.parse(
			new TextDecoder("utf8", { fatal: true }).decode(await readBoundedCloudResponse(response, 4096, signal)),
		);
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const error = value as Record<string, unknown>;
		const missing = error.code === "NoSuchKey";
		const exists = error.code === "ResourceAlreadyExists" || error.code === "KeyAlreadyExists";
		const status = missing ? 404 : exists ? 409 : undefined;
		if (status === undefined) return undefined;
		for (const field of ["statusCode", "httpStatusCode"]) {
			if (error[field] !== undefined && String(error[field]) !== String(status)) return undefined;
		}
		if (error.error !== undefined && error.error !== (missing ? "not_found" : "Duplicate")) return undefined;
		return missing ? "missing" : "exists";
	} catch {
		return undefined;
	}
}

/** Private operator-provisioned directory, not a Company File path. One
 * outstanding operation remains counted after timeout until the OS settles. */
export class FileRecoveryObjectStore implements RecoveryObjectStore {
	readonly #root: string;
	readonly #timeoutMs: number;
	readonly #guard: ((directory: FileHandle) => Promise<void>) | undefined;
	#busy = false;

	constructor(root: string, timeoutMs = 5_000, guard?: (directory: FileHandle) => Promise<void>) {
		if (!isAbsolute(root) || resolve(root) === "/") throw new Error("Recovery storage root is invalid");
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
			throw new Error("Recovery storage timeout is invalid");
		this.#root = resolve(root);
		this.#timeoutMs = timeoutMs;
		this.#guard = guard;
	}

	async #io<T>(operation: (root: string, directory: FileHandle) => Promise<T>, signal: AbortSignal): Promise<T> {
		signal.throwIfAborted();
		if (this.#busy) throw new Error("Recovery storage has an outstanding operation");
		this.#busy = true;
		const pending = (async () => {
			const directory = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				await this.#guard?.(directory);
				const info = await directory.stat();
				if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.geteuid?.())
					throw new Error("Recovery storage must be private and service-owned");
				const root = process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : this.#root;
				return await operation(root, directory);
			} finally {
				await directory.close();
			}
		})();
		void pending.then(
			() => {
				this.#busy = false;
			},
			() => {
				this.#busy = false;
			},
		);
		return withCloudDeadline(() => pending, this.#timeoutMs, signal);
	}

	verify(signal: AbortSignal): Promise<void> {
		return this.#io(async () => undefined, signal);
	}

	async #read(path: string): Promise<Uint8Array | undefined> {
		let handle: FileHandle;
		try {
			handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			const info = await handle.stat();
			if (
				!info.isFile() ||
				info.size < 1 ||
				info.size > 16_384 ||
				(info.mode & 0o077) !== 0 ||
				info.uid !== process.geteuid?.()
			)
				throw new Error("Recovery storage object is invalid");
			const buffer = Buffer.alloc(16_385);
			let length = 0;
			while (length < buffer.byteLength) {
				const read = await handle.read(buffer, length, buffer.byteLength - length, length);
				if (!read.bytesRead) break;
				length += read.bytesRead;
			}
			if (length !== info.size || length > 16_384) throw new Error("Recovery storage object changed during read");
			return buffer.subarray(0, length);
		} finally {
			await handle.close();
		}
	}

	get(address: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
		recoverySha256(address);
		return this.#io((root) => this.#read(join(root, address)), signal);
	}

	put(address: string, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
		recoverySha256(address);
		if (bytes.byteLength < 1 || bytes.byteLength > 16_384) throw new Error("Recovery object exceeds its bound");
		const snapshot = Buffer.from(bytes);
		return this.#io(async (root, directory) => {
			const path = join(root, address);
			let existing = await this.#read(path);
			if (!existing) {
				const temporary = join(root, `.pending-${randomUUID()}`);
				const handle = await open(
					temporary,
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
					0o600,
				);
				try {
					await handle.writeFile(snapshot);
					await handle.sync();
					await handle.close();
					try {
						await link(temporary, path);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					}
				} finally {
					await handle.close();
					await unlink(temporary);
				}
				existing = await this.#read(path);
			}
			if (!existing) throw new Error("Recovery journal publication was lost");
			await directory.sync();
			return existing;
		}, signal);
	}
}

export class SupabaseRecoveryObjectStore implements RecoveryObjectStore {
	readonly #base: URL;
	readonly #serviceKey: string;
	readonly #companyId: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(baseUrl: string, serviceKey: string, companyId: string, fetcher = fetch, timeoutMs = 10_000) {
		this.#base = new URL(baseUrl);
		if (
			this.#base.protocol !== "https:" ||
			this.#base.pathname !== "/" ||
			this.#base.username ||
			this.#base.password ||
			this.#base.search ||
			this.#base.hash
		)
			throw new Error("Recovery object storage requires an HTTPS origin");
		if (!serviceKey.trim()) throw new Error("Recovery storage credential is missing");
		this.#serviceKey = serviceKey;
		this.#companyId = recoveryUuid(companyId);
		this.#fetch = fetcher;
		this.#timeoutMs = timeoutMs;
	}

	get(address: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
		recoverySha256(address);
		return withCloudDeadline(
			async (deadline) => {
				const response = await this.#fetch(
					new URL(`/storage/v1/object/qorpera-identity-recovery/${this.#companyId}/${address}`, this.#base),
					{
						redirect: "error",
						signal: deadline,
						headers: supabaseServiceHeaders(this.#serviceKey),
					},
				);
				if (!response.ok) {
					if ((await recoveryStorageError(response, deadline)) === "missing") return undefined;
					throw new Error(`Recovery object read rejected (${response.status})`);
				}
				return readBoundedCloudResponse(response, 16_384, deadline);
			},
			this.#timeoutMs,
			signal,
		);
	}

	put(address: string, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
		recoverySha256(address);
		if (bytes.byteLength < 1 || bytes.byteLength > 16_384) throw new Error("Recovery object exceeds its bound");
		return withCloudDeadline(
			async (deadline) => {
				const existing = await this.get(address, deadline);
				if (existing) return existing;
				const response = await this.#fetch(
					new URL(`/storage/v1/object/qorpera-identity-recovery/${this.#companyId}/${address}`, this.#base),
					{
						method: "POST",
						redirect: "error",
						signal: deadline,
						headers: {
							...supabaseServiceHeaders(this.#serviceKey),
							"content-type": "application/json",
							"x-upsert": "false",
						},
						body: Buffer.from(bytes),
					},
				);
				// No overwrite, including on a lost response. A conflict is accepted
				// only after the caller verifies the stored bytes against its receipt.
				if (!response.ok && (await recoveryStorageError(response, deadline)) !== "exists")
					throw new Error(`Recovery object write rejected (${response.status})`);
				if (response.ok) void response.body?.cancel().catch(() => undefined);
				const stored = await this.get(address, deadline);
				if (!stored) throw new Error("Recovery object write has no durable read receipt");
				return stored;
			},
			this.#timeoutMs,
			signal,
		);
	}
}
