/** The largest file handed out in one piece, and the largest handed out as the pieces it was read in (a folder file
 * is at most 256 MiB: 64 pieces of 4 MiB). */
const MAX_WHOLE_BYTES = 8 * 1024 * 1024;
const MAX_PIECES_BYTES = 256 * 1024 * 1024;

/** A browser download offers already verified bytes to the browser. It cannot
 * attest that the user saved them or choose a member filesystem path. */
export class WebFileDownloads {
	readonly #urls = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #current: () => void;
	readonly #signal: AbortSignal;
	readonly #onAbort = () => this.close();
	constructor(options: { current(): void; signal: AbortSignal }) {
		this.#current = options.current;
		this.#signal = options.signal;
		options.signal.addEventListener("abort", this.#onAbort, { once: true });
	}
	offer(name: string, bytes: Uint8Array): void {
		this.#hand(
			name,
			bytes.length <= MAX_WHOLE_BYTES,
			() => new Blob([bytes.slice()], { type: "application/octet-stream" }),
		);
	}
	/** A large file, as the pieces it was read in, in order: one `Blob` of them, which copies none. `bytes` is the
	 * file's size, and the pieces must add up to it. */
	offerPieces(name: string, pieces: readonly Blob[], bytes: number): void {
		this.#hand(
			name,
			Number.isSafeInteger(bytes) &&
				bytes >= 0 &&
				bytes <= MAX_PIECES_BYTES &&
				pieces.reduce((total, piece) => total + piece.size, 0) === bytes,
			() => new Blob([...pieces], { type: "application/octet-stream" }),
		);
	}
	/** Hands the browser a file through a hidden link, under the name's last part; `sized`: it is within its limit. */
	#hand(name: string, sized: boolean, file: () => Blob): void {
		this.#current();
		this.#signal.throwIfAborted();
		const filename = name.split("/").at(-1);
		if (!filename || /[\u0000-\u001f\u007f\\]/u.test(filename) || !sized) throw new Error("Invalid browser download");
		const url = URL.createObjectURL(file());
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
		this.#signal.removeEventListener("abort", this.#onAbort);
		for (const url of this.#urls.keys()) this.#release(url);
	}
}
