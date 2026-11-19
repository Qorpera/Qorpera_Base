const FIRST_WAIT_MS = 1_000;
const LAST_WAIT_MS = 15_000;

export class Reconnect {
	readonly #attempt: () => Promise<boolean>;
	readonly #signal: AbortSignal;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#waits = 0;
	#trying = false;
	#lost = false;
	#listening = false;

	constructor(attempt: () => Promise<boolean>, signal: AbortSignal) {
		this.#attempt = attempt;
		this.#signal = signal;
		signal.addEventListener("abort", () => clearTimeout(this.#timer), { once: true });
	}

	lost(): void {
		if (this.#signal.aborted) return;
		this.#lost = true;
		this.#listen();
		if (!this.#trying) this.#later();
	}

	async now(): Promise<void> {
		if (this.#signal.aborted || this.#trying || !this.#lost) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#trying = true;
		let back = false;
		try {
			back = await this.#attempt();
		} finally {
			this.#trying = false;
		}
		if (this.#signal.aborted) return;
		if (!back) return this.#later();
		this.#lost = false;
		this.#waits = 0;
	}

	#later(): void {
		if (this.#signal.aborted || this.#timer) return;
		const wait = Math.min(LAST_WAIT_MS, FIRST_WAIT_MS * 2 ** this.#waits);
		this.#waits += 1;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.now();
		}, wait);
	}

	#listen(): void {
		if (this.#listening || typeof window === "undefined") return;
		this.#listening = true;
		for (const event of ["online", "focus"])
			window.addEventListener(event, () => void this.now(), { signal: this.#signal });
	}
}
