import type { Duplex } from "node:stream";
import type { ConnectOverCDPTransport } from "playwright-core";

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
	#buffer = Buffer.alloc(0);

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
			if (this.#buffer.length + bytes.length > 16 * 1024 * 1024) throw new Error("limit");
			this.#buffer = Buffer.concat([this.#buffer, bytes]);
			let frames = 0;
			while (!this.#closed) {
				const end = this.#buffer.indexOf(0);
				if (end < 0) break;
				if (++frames > 4096) throw new Error("limit");
				const frame = this.#buffer.subarray(0, end);
				this.#buffer = this.#buffer.subarray(end + 1);
				const message: unknown = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(frame));
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
		this.#buffer = Buffer.alloc(0);
		this.#input.destroy();
		this.#output.destroy();
		this.#stop();
		this.onclose?.("OFFICE_BROWSER_CHANNEL_CLOSED");
	}
}
