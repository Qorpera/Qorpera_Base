import type { Duplex } from "node:stream";
import type { ConnectOverCDPTransport } from "playwright-core";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Broker-owned Chromium DevTools pipe, never a socket in a browser/desktop
 * namespace or a member-facing protocol. Frames contain private working bytes;
 * malformed frames and errors must never be included in diagnostics. */
export class CompanyComputerBrowserPipe implements ConnectOverCDPTransport {
	onmessage?: (message: object) => void;
	onclose?: (reason?: string) => void;
	readonly #input: Duplex;
	readonly #output: Duplex;
	readonly #stop: () => void;
	#closed = false;
	#chunks: Buffer[] = [];
	#bufferedBytes = 0;

	constructor(input: Duplex, output: Duplex, stop: () => void) {
		this.#input = input;
		this.#output = output;
		this.#stop = stop;
		output.pause();
		input.on("error", () => this.close());
		output.on("error", () => this.close());
		output.once("end", () => this.close());
		output.once("close", () => this.close());
		output.on("data", (bytes: Buffer) => this.#receive(bytes));
	}

	open(): void {
		if (this.#closed) throw new Error("OFFICE_BROWSER_CHANNEL_CLOSED");
		this.#output.resume();
	}

	send(message: object): void {
		if (this.#closed) throw new Error("OFFICE_BROWSER_CHANNEL_CLOSED");
		// Chromium's CDP connector installs onmessage and sends its first query
		// without calling the optional open hook used by other transports.
		this.#output.resume();
		const bytes = Buffer.from(`${JSON.stringify(message)}\0`);
		if (bytes.length > 16 * 1024 * 1024 || this.#input.writableLength + bytes.length > 16 * 1024 * 1024) {
			this.close();
			throw new Error("OFFICE_BROWSER_CHANNEL_LIMIT");
		}
		this.#input.write(bytes);
	}

	#receive(bytes: Buffer): void {
		if (this.#closed) return;
		try {
			if (this.#bufferedBytes + bytes.length > 16 * 1024 * 1024) throw new Error("limit");
			let offset = 0;
			let frames = 0;
			while (!this.#closed) {
				const end = bytes.indexOf(0, offset);
				if (end < 0) {
					if (offset < bytes.length) {
						// WHY: copy only the trailing partial slice so a multi-MB incoming chunk slab is not pinned across frames.
						const tail = offset === 0 ? bytes : Buffer.from(bytes.subarray(offset));
						this.#chunks.push(tail);
						this.#bufferedBytes += tail.length;
					}
					break;
				}
				if (++frames > 4096) throw new Error("limit");
				const slice = bytes.subarray(offset, end);
				let frame: Buffer;
				if (this.#chunks.length === 0) {
					frame = slice;
				} else {
					if (slice.length > 0) this.#chunks.push(slice);
					frame = Buffer.concat(this.#chunks, this.#bufferedBytes + slice.length);
					this.#chunks = [];
					this.#bufferedBytes = 0;
				}
				offset = end + 1;
				const message: unknown = JSON.parse(UTF8.decode(frame));
				if (!message || typeof message !== "object" || Array.isArray(message) || !this.onmessage)
					throw new Error("invalid");
				this.onmessage(message);
			}
		} catch {
			this.close();
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#chunks = [];
		this.#bufferedBytes = 0;
		this.#input.destroy();
		this.#output.destroy();
		this.#stop();
		this.onclose?.("OFFICE_BROWSER_CHANNEL_CLOSED");
	}
}
