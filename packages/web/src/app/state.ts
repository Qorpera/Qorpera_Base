/* Minimal observable store. Views read `get()` and the app re-renders on
 * `subscribe`. Updates are coalesced into one notification per microtask. */

export class Store<T extends object> {
	#value: T;
	readonly #listeners = new Set<(value: T) => void>();
	#scheduled = false;
	#disposed = false;

	constructor(initial: T) {
		this.#value = initial;
	}

	get(): T {
		return this.#value;
	}

	set(patch: Partial<T> | ((current: T) => Partial<T>)): void {
		if (this.#disposed) return;
		const next = typeof patch === "function" ? patch(this.#value) : patch;
		this.#value = { ...this.#value, ...next };
		this.#notify();
	}

	subscribe(listener: (value: T) => void): () => void {
		if (this.#disposed) return () => {};
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): void {
		this.#disposed = true;
		this.#listeners.clear();
	}

	#notify(): void {
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			for (const listener of this.#listeners) listener(this.#value);
		});
	}
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (...args) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => fn(...args), waitMs);
	};
}

/** Runs at once, then at most once every `intervalMs`: calls in between run together at the end
 * of the interval. */
export function throttle(fn: () => void, intervalMs: number): () => void {
	let last = Number.NEGATIVE_INFINITY;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		timer = undefined;
		last = Date.now();
		fn();
	};
	return () => {
		if (timer) return;
		const wait = last + intervalMs - Date.now();
		if (wait <= 0) run();
		else timer = setTimeout(run, wait);
	};
}
