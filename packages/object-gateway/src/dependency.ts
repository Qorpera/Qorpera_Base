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

/** The database ran one statement past its timeout (57014). Its caller gets 503, as for any unavailable
 * dependency. The circuit opens for it only when no other call succeeded while it ran (`ObjectDependency.run`). */
export class ObjectStatementTimeout extends ObjectDependencyError {
	constructor() {
		super(503);
		this.name = "ObjectStatementTimeout";
	}
}

/** PostgREST answers SQLSTATE classes 40 and 55, and 57014, with HTTP 500. From an RPC that acts for one company,
 * those describe that company's state, not the database's health, so they must not open the dependency circuit
 * for every company:
 * - 55000, the company's stop or another state that refuses the call now: 423.
 * - 40001, 40P01 and 55P03, a serialization failure, deadlock or lock timeout: 409. The transaction rolled back,
 *   so nothing was committed and the caller may retry.
 * - 57014, a statement timeout: `ObjectStatementTimeout`.
 * Any other 500, including one without a readable code, stays a dependency failure. The same codes as the folder
 * core's RPCs (#560). */
export function companyStateFailure(code: unknown): ObjectDependencyError {
	if (code === "55000") return new ObjectDependencyError(423);
	if (code === "40001" || code === "40P01" || code === "55P03") return new ObjectDependencyError(409);
	if (code === "57014") return new ObjectStatementTimeout();
	return new ObjectDependencyError(500);
}

/** PostgREST's error `code`, read from at most 16 KiB of body within 250 ms; undefined when it has none. */
export async function postgrestErrorCode(response: Response, signal: AbortSignal): Promise<unknown> {
	const errorBody = new AbortController();
	try {
		const body: unknown = JSON.parse(
			new TextDecoder().decode(
				await boundedObjectOperation(
					() => readBoundedObjectResponse(response, 16 * 1024, AbortSignal.any([signal, errorBody.signal])),
					250,
				),
			),
		);
		return body && typeof body === "object" && "code" in body ? body.code : undefined;
	} catch {
		return undefined;
	} finally {
		errorBody.abort();
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
	#successes = 0;
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

	/** `caller` is the caller's own signal. A call that fails after the caller gave up (its own deadline, or its
	 * client disconnecting) before this dependency's deadline says nothing about the dependency: the circuit and
	 * health stay as they are. Only this deadline and the dependency's own failures count. */
	async run<T>(operation: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
		if (this.#retryAt > this.#now() || (this.#retryAt > 0 && this.#probing)) {
			throw new ObjectDependencyError(503);
		}
		const probe = this.#retryAt > 0;
		if (probe) this.#probing = true;
		const successes = this.#successes;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let expired = false;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				expired = true;
				const error = new ObjectDependencyError(503);
				controller.abort(error);
				reject(error);
			}, this.#timeoutMs);
		});
		try {
			const result = await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
			this.#successes++;
			this.#retryAt = 0;
			this.#health = { status: "healthy", checkedAt: new Date(this.#now()).toISOString() };
			return result;
		} catch (error) {
			const failure = error instanceof ObjectDependencyError ? error : new ObjectDependencyError(503);
			controller.abort(failure);
			if (caller?.aborted && !expired) throw failure;
			// Another call succeeded while this statement ran: the database is serving, and one company's slow
			// statement leaves the circuit as it is. With no success meanwhile, it counts like any 5xx.
			if (failure instanceof ObjectStatementTimeout && this.#successes !== successes) throw failure;
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
