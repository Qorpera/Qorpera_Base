// The machine side of an agent's home (lanes/agent-box-20261113, slice 1): the bytes between the executor and
// `codex exec-server --listen stdio` inside the machine, as lines.
//
// LXD's exec gives a command's stdin as one stream to write and its stdout as chunks as they come. A channel needs
// both of them to stay open for as long as the run's turn, with neither side waiting for the other, so each direction
// is a small pipe of its own: what has not been read yet waits in memory, bounded, and a side that fills up ends the
// channel rather than the machine's command.

/** A command's own output can be large (P1 saw 2.4 MB from one `seq`), and its lines are bounded again at both ends. */
export const EXEC_SERVER_OUTPUT_BYTES = 64 * 1024 * 1024;
/** What may wait unread in one direction before the channel is ended. */
const PIPE_BYTES = 16 * 1024 * 1024;

/**
 * One direction of the channel: bytes pushed in, read out as an async iterable (for LXD's stdin) or as complete lines
 * (for its stdout). Ending it ends both its reads.
 */
export class LinePipe {
	readonly #chunks: Buffer[] = [];
	#bytes = 0;
	#ended = false;
	#failed = false;
	#wake: (() => void) | undefined;

	push(chunk: Buffer): void {
		if (this.#ended) return;
		this.#bytes += chunk.byteLength;
		if (this.#bytes > PIPE_BYTES) {
			this.#failed = true;
			this.end();
			return;
		}
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
			const chunk = this.#chunks.shift();
			if (chunk) {
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

	/** The same bytes as complete lines, without their newline. */
	async *lines(): AsyncGenerator<string> {
		let rest = "";
		for await (const chunk of this.read()) {
			rest += Buffer.from(chunk).toString("utf8");
			let end = rest.indexOf("\n");
			while (end >= 0) {
				yield rest.slice(0, end);
				rest = rest.slice(end + 1);
				end = rest.indexOf("\n");
			}
			if (Buffer.byteLength(rest) > PIPE_BYTES) return;
		}
	}
}
