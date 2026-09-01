export class ObjectDependencyError extends Error {
	readonly status: number;
	readonly unavailable: boolean;

	constructor(status: number) {
		super(status === 503 ? "Object dependency is unavailable" : "Object authority rejected the operation");
		this.name = "ObjectDependencyError";
		this.status = status;
		this.unavailable = status === 429 || status >= 500;
	}
}

export interface ObjectDependencyHealth {
	status: "unknown" | "healthy" | "unavailable";
	checkedAt?: string;
}

/** Finite cloud responses are byte-bounded before buffering. The enclosing
 * dependency deadline also bounds transports and stream cleanup that stall. */
export async function readBoundedObjectResponse(
	response: Response,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 8 * 1024 * 1024) {
		throw new Error("Object response bound is invalid");
	}
	const declared = response.headers.get("content-length");
	if (signal.aborted || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes))) {
		void response.body?.cancel().catch(() => undefined);
		signal.throwIfAborted();
		throw new ObjectDependencyError(503);
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const cancel = (): void => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maximumBytes) throw new ObjectDependencyError(503);
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks, bytes);
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}

export async function boundedObjectOperation<T>(operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new Error("Object operation deadline is invalid");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new ObjectDependencyError(503)), timeoutMs);
	});
	try {
		return await Promise.race([Promise.resolve().then(operation), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A bounded circuit, not an authorization cache. Only an explicit lease can serve a read while open. */
export class ObjectDependency {
	readonly #timeoutMs: number;
	readonly #cooldownMs: number;
	readonly #now: () => number;
	#retryAt = 0;
	#probing = false;
	#health: ObjectDependencyHealth = { status: "unknown" };

	constructor(timeoutMs = 5_000, cooldownMs = 5_000, now: () => number = Date.now) {
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > 30_000 ||
			!Number.isSafeInteger(cooldownMs) ||
			cooldownMs < 0 ||
			cooldownMs > 30_000
		) {
			throw new Error("Object dependency deadlines are invalid");
		}
		this.#timeoutMs = timeoutMs;
		this.#cooldownMs = cooldownMs;
		this.#now = now;
	}

	health(): ObjectDependencyHealth {
		return { ...this.#health };
	}

	async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#retryAt > this.#now() || (this.#retryAt > 0 && this.#probing)) {
			throw new ObjectDependencyError(503);
		}
		const probe = this.#retryAt > 0;
		if (probe) this.#probing = true;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new ObjectDependencyError(503);
				controller.abort(error);
				reject(error);
			}, this.#timeoutMs);
		});
		try {
			const result = await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
			this.#retryAt = 0;
			this.#health = { status: "healthy", checkedAt: new Date(this.#now()).toISOString() };
			return result;
		} catch (error) {
			const failure = error instanceof ObjectDependencyError ? error : new ObjectDependencyError(503);
			controller.abort(failure);
			this.#health = {
				status: failure.unavailable ? "unavailable" : "healthy",
				checkedAt: new Date(this.#now()).toISOString(),
			};
			this.#retryAt = failure.unavailable ? this.#now() + this.#cooldownMs : 0;
			throw failure;
		} finally {
			if (timer) clearTimeout(timer);
			if (probe) this.#probing = false;
		}
	}
}
