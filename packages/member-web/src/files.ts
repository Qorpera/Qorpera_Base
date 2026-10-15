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
