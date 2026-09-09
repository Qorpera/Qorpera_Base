import { cloudFileBytesSha256 } from "@qorpera/cloud-client/cloud-file-bytes";
import type {
	CloudMemberCompanyFileClient,
	CloudMemberCompanyUpload,
	CloudMemberCompanyUploadSource,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { presenceUuid } from "@qorpera/cloud-client/company-path-presence";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";

/** Owns only bytes selected through the browser's file chooser. An uncertain
 * upload retains exactly the original bytes, destination and operation key. */
export class WebFileUpload {
	readonly #client: Pick<CloudMemberCompanyFileClient, "upload">;
	readonly #signal: AbortSignal;
	readonly #current: () => void;
	#file?: { name: string; mediaType: string; bytes: Uint8Array<ArrayBuffer>; sha256: string };
	#intent?: CloudMemberCompanyUpload;
	#busy = false;
	constructor(options: {
		client: Pick<CloudMemberCompanyFileClient, "upload">;
		signal: AbortSignal;
		current(): void;
	}) {
		this.#client = options.client;
		this.#signal = options.signal;
		this.#current = options.current;
		options.signal.addEventListener(
			"abort",
			() => {
				this.#file = undefined;
				this.#intent = undefined;
			},
			{ once: true },
		);
	}
	get uncertain(): boolean {
		return Boolean(this.#intent);
	}
	get selected(): boolean {
		return Boolean(this.#file);
	}
	clearSelection(): void {
		if (this.#busy || this.#intent) throw new Error("Recover the pending upload first");
		this.#file = undefined;
	}
	async select(file: File): Promise<CloudMemberCompanyUploadSource> {
		this.#current();
		this.#signal.throwIfAborted();
		if (this.#busy || this.#intent) throw new Error("Recover the pending upload before choosing another file");
		this.#file = undefined;
		if (
			!(file instanceof File) ||
			file.size > 8 * 1024 * 1024 ||
			file.name.length < 1 ||
			/[\u0000-\u001f\u007f/\\]/u.test(file.name) ||
			[".", ".."].includes(file.name) ||
			new TextEncoder().encode(file.name).length > 255
		)
			throw new Error("Choose a file of at most 8 MiB");
		this.#busy = true;
		this.#file = undefined;
		try {
			const bytes = await withCloudDeadline(
				async (signal) => {
					const bytes = new Uint8Array(await file.arrayBuffer());
					signal.throwIfAborted();
					if (bytes.length !== file.size) throw new Error("The selected file changed");
					return bytes;
				},
				5000,
				this.#signal,
			);
			const sha256 = await cloudFileBytesSha256(bytes);
			this.#current();
			this.#signal.throwIfAborted();
			const mediaType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(file.type)
				? file.type
				: "application/octet-stream";
			this.#file = { name: file.name, mediaType, bytes, sha256 };
			return { realm: "member_file", name: file.name, bytes: bytes.length, sha256, mediaType };
		} finally {
			this.#busy = false;
		}
	}
	async submit(path: string, expectedVersion: string | null): ReturnType<CloudMemberCompanyFileClient["upload"]> {
		this.#current();
		this.#signal.throwIfAborted();
		parseCloudCompanyPath(path);
		if (expectedVersion !== null) presenceUuid(expectedVersion);
		if (this.#busy || !this.#file) throw new Error("Choose a file first");
		if (this.#intent && (this.#intent.path !== path || this.#intent.expectedVersion !== expectedVersion))
			throw new Error("Retry the exact pending upload");
		if (!this.#intent)
			this.#intent = {
				operationKey: crypto.randomUUID(),
				path,
				expectedVersion,
				name: this.#file.name,
				mediaType: this.#file.mediaType,
				bytes: this.#file.bytes,
			};
		this.#busy = true;
		try {
			const result = await this.#client.upload(
				{ ...this.#intent, bytes: Uint8Array.from(this.#intent.bytes) },
				this.#signal,
			);
			this.#current();
			this.#signal.throwIfAborted();
			this.#intent = undefined;
			this.#file = undefined;
			return result;
		} finally {
			this.#busy = false;
		}
	}
}

/** A browser download offers already verified bytes to the browser. It cannot
 * attest that the user saved them or choose a member filesystem path. */
export class WebFileDownloads {
	readonly #urls = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #current: () => void;
	readonly #signal: AbortSignal;
	constructor(options: { current(): void; signal: AbortSignal }) {
		this.#current = options.current;
		this.#signal = options.signal;
		options.signal.addEventListener("abort", () => this.close(), { once: true });
	}
	offer(name: string, bytes: Uint8Array): void {
		this.#current();
		this.#signal.throwIfAborted();
		const filename = name.split("/").at(-1);
		if (!filename || /[\u0000-\u001f\u007f\\]/u.test(filename) || bytes.length > 8 * 1024 * 1024)
			throw new Error("Invalid browser download");
		const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "application/octet-stream" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.hidden = true;
		try {
			document.body.append(anchor);
			this.#current();
			this.#signal.throwIfAborted();
			anchor.click();
		} catch (error) {
			URL.revokeObjectURL(url);
			throw error;
		} finally {
			anchor.remove();
		}
		this.#urls.set(
			url,
			setTimeout(() => this.#release(url), 60000),
		);
		if (this.#urls.size > 8) this.#release(this.#urls.keys().next().value!);
	}
	#release(url: string): void {
		clearTimeout(this.#urls.get(url));
		this.#urls.delete(url);
		URL.revokeObjectURL(url);
	}
	close(): void {
		for (const url of this.#urls.keys()) this.#release(url);
	}
}
