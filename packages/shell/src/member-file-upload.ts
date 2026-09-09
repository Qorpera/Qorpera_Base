import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type {
	CloudMemberCompanyFileClient,
	CloudMemberCompanyUpload,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";

const MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface SelectedMemberUpload {
	id: string;
	name: string;
	bytes: number;
	sha256: string;
}
interface UploadOptions {
	signal: AbortSignal;
	current(): boolean;
	chooseFile(): Promise<string | null>;
	upload: CloudMemberCompanyFileClient["upload"];
}

/** One native member selection per window. The renderer receives metadata only;
 * uncertain submissions retain exactly the selected bytes and destination. */
export class MemberFileUploadSession {
	readonly #options: UploadOptions;
	#selected:
		| { metadata: SelectedMemberUpload; bytes: Uint8Array; intent?: CloudMemberCompanyUpload; settled: boolean }
		| undefined;
	#busy = false;
	constructor(options: UploadOptions) {
		this.#options = options;
	}
	#current(): void {
		this.#options.signal.throwIfAborted();
		if (!this.#options.current()) throw new Error("This Company File window is no longer authorized");
	}
	clear(): void {
		this.#selected = undefined;
	}
	async choose(): Promise<SelectedMemberUpload | null> {
		this.#current();
		if (this.#busy) throw new Error("Finish the current upload before selecting another file");
		if (this.#selected?.intent && !this.#selected.settled)
			throw new Error("Retry the exact pending upload before selecting another file");
		this.#busy = true;
		try {
			const selectedPath = await this.#options.chooseFile();
			this.#current();
			if (selectedPath === null) return null;
			if (!isAbsolute(selectedPath) || selectedPath.includes("\0")) throw new Error("Invalid selected file");
			const name = basename(selectedPath);
			if (!name || Buffer.byteLength(name) > 255 || /[\\/\x00-\x1f\x7f]/.test(name))
				throw new Error("Invalid selected filename");
			let bytes: Uint8Array;
			try {
				const file = await open(selectedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const before = await file.stat({ bigint: true });
					if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw new Error("Unsupported file");
					const buffer = new Uint8Array(Number(before.size) + 1);
					let length = 0;
					while (length < buffer.length) {
						this.#current();
						const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
						if (!bytesRead) break;
						length += bytesRead;
					}
					const after = await file.stat({ bigint: true });
					if (
						BigInt(length) !== before.size ||
						after.size !== before.size ||
						after.ino !== before.ino ||
						after.dev !== before.dev ||
						after.mtimeNs !== before.mtimeNs ||
						after.ctimeNs !== before.ctimeNs
					)
						throw new Error("Selected file changed");
					bytes = buffer.slice(0, length);
				} finally {
					await file.close();
				}
			} catch {
				this.#current();
				throw new Error("Choose a regular file of at most 8 MiB that is not changing.");
			}
			this.#current();
			const metadata = {
				id: randomUUID(),
				name,
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			this.#selected = { metadata, bytes, settled: false };
			return { ...metadata };
		} finally {
			this.#busy = false;
		}
	}
	async submit(value: unknown): ReturnType<CloudMemberCompanyFileClient["upload"]> {
		this.#current();
		if (this.#busy) throw new Error("Finish the current upload before submitting again");
		if (
			!value ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			Object.keys(value).sort().join() !== "expectedVersion,id,path"
		)
			throw new Error("Invalid selected upload");
		const input = value as Record<string, unknown>,
			selected = this.#selected;
		if (
			!selected ||
			input.id !== selected.metadata.id ||
			(input.expectedVersion !== null &&
				(typeof input.expectedVersion !== "string" || !UUID.test(input.expectedVersion)))
		)
			throw new Error("Choose the upload file again");
		const path = parseCloudCompanyPath(input.path),
			expectedVersion = input.expectedVersion as string | null;
		if (selected.intent && (selected.intent.path !== path || selected.intent.expectedVersion !== expectedVersion))
			throw new Error("Retry the exact pending upload destination and version");
		selected.intent ??= {
			operationKey: selected.metadata.id,
			path,
			expectedVersion,
			name: selected.metadata.name,
			mediaType: "application/octet-stream",
			bytes: selected.bytes,
		};
		this.#busy = true;
		try {
			const result = await this.#options.upload(
				{ ...selected.intent, bytes: Uint8Array.from(selected.bytes) },
				this.#options.signal,
			);
			this.#current();
			if (
				result.source.name !== selected.metadata.name ||
				result.source.bytes !== selected.metadata.bytes ||
				result.source.sha256 !== selected.metadata.sha256
			)
				throw new Error("Selected upload identity changed");
			selected.settled = true;
			return result;
		} finally {
			this.#busy = false;
		}
	}
}
