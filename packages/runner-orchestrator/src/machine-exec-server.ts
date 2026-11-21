// The machine side of an agent's home (lanes/agent-box-20261113, slice 1): the bytes between the executor and
// `codex exec-server --listen stdio` inside the machine, as lines.
//
// LXD's exec gives a command's stdin as one stream to write and its stdout as chunks as they come. A channel needs
// both of them to stay open for as long as the run's turn, with neither side waiting for the other, so each direction
// is a small pipe of its own: what has not been read yet waits in memory, bounded, and a side that fills up ends the
// channel rather than the machine's command.

export const LINE_PIPE_BYTES = 16 * 1024 * 1024;

export class LinePipe {
	#chunks: Buffer[] = [];
	#head = 0;
	#bytes = 0;
	#ended = false;
	#failed = false;
	#wake: (() => void) | undefined;

	push(chunk: Buffer): void {
		if (this.#ended) return;
		this.#bytes += chunk.byteLength;
		if (this.#bytes > LINE_PIPE_BYTES) {
			this.#failed = true;
			this.end();
			return;
		}
		if (chunk.byteLength === 0) return;
		this.#chunks.push(chunk);
		this.#wake?.();
		this.#wake = undefined;
	}

	end(): void {
		this.#ended = true;
		this.#wake?.();
		this.#wake = undefined;
	}

	get failed(): boolean {
		return this.#failed;
	}

	/** The bytes, as LXD's streamed stdin takes them. */
	async *read(): AsyncGenerator<Uint8Array> {
		for (;;) {
			if (this.#head < this.#chunks.length) {
				const chunk = this.#chunks[this.#head]!;
				this.#head += 1;
				if (this.#head === this.#chunks.length) {
					this.#chunks.length = 0;
					this.#head = 0;
				} else if (this.#head >= 64 && this.#head * 2 >= this.#chunks.length) {
					this.#chunks = this.#chunks.slice(this.#head);
					this.#head = 0;
				}
				this.#bytes -= chunk.byteLength;
				yield chunk;
				continue;
			}
			if (this.#ended) return;
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
		}
	}

	async *lines(): AsyncGenerator<string> {
		let parts: Buffer[] = [];
		let lineBytes = 0;
		for await (const chunk of this.read()) {
			const view = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			let start = 0;
			while (start < view.byteLength) {
				const nl = view.indexOf(0x0a, start);
				if (nl < 0) {
					const tailLength = view.byteLength - start;
					if (lineBytes + tailLength > LINE_PIPE_BYTES) return;
					parts.push(Buffer.from(view.subarray(start)));
					lineBytes += tailLength;
					break;
				}
				const pieceLength = nl - start;
				if (lineBytes + pieceLength > LINE_PIPE_BYTES) return;
				if (parts.length === 0) {
					yield view.toString("utf8", start, nl);
				} else {
					if (pieceLength > 0) parts.push(view.subarray(start, nl));
					const line = Buffer.concat(parts, lineBytes + pieceLength).toString("utf8");
					parts = [];
					lineBytes = 0;
					yield line;
				}
				start = nl + 1;
			}
		}
	}
}

/** The most of the file channel's stream one line carries, before base64 (slice C1; the runtime's
 * CLOUD_HOME_SFTP_PIECE_BYTES, which this package cannot import). */
export const SFTP_PIECE_BYTES = 768 * 1024;
/** Standard base64 with its padding, checked with the length (a multiple of 4) and without a backtracking group. */
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

/** The file channel's bytes from the machine as its lines: each chunk, in order, cut at SFTP_PIECE_BYTES, as standard
 * base64 (the runtime's cloudHomeSftpLines). */
export async function* sftpLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
	for await (const chunk of chunks) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		for (let at = 0; at < bytes.byteLength; at += SFTP_PIECE_BYTES)
			yield bytes.subarray(at, at + SFTP_PIECE_BYTES).toString("base64");
	}
}

/** One line of the file channel as its bytes, or undefined for anything but nonempty standard base64, which is not the
 * stream: Node's own decoder would skip what it cannot read and hand sftp-server the rest. */
export function sftpBytes(line: string): Buffer | undefined {
	if (line.length % 4 !== 0 || line.length > LINE_PIPE_BYTES || !BASE64_LINE.test(line)) return undefined;
	return Buffer.from(line, "base64");
}
