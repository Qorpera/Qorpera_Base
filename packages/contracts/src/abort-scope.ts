export interface AbortScope {
	readonly signal: AbortSignal;
	dispose(): void;
}

interface UnrefTimer {
	unref?: () => void;
}

export function createAbortScope(parents: readonly (AbortSignal | undefined)[], timeoutMs?: number): AbortScope {
	const scope = new AbortController();
	const listeners: Array<readonly [AbortSignal, () => void]> = [];
	for (const parent of parents) {
		if (!parent) continue;
		if (parent.aborted) {
			scope.abort(parent.reason);
			break;
		}
		const forward = (): void => scope.abort(parent.reason);
		parent.addEventListener("abort", forward, { once: true });
		listeners.push([parent, forward]);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	if (!scope.signal.aborted && timeoutMs !== undefined) {
		timer = setTimeout(
			() => scope.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
			timeoutMs,
		);
		(timer as UnrefTimer).unref?.();
	}
	return {
		signal: scope.signal,
		dispose: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			for (const [parent, forward] of listeners) parent.removeEventListener("abort", forward);
			listeners.length = 0;
		},
	};
}

export async function withAbortScope<T>(parent: AbortSignal, use: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const scope = createAbortScope([parent]);
	try {
		return await use(scope.signal);
	} finally {
		scope.dispose();
	}
}

export async function withAbortScopes<T>(
	parents: readonly (AbortSignal | undefined)[],
	use: (signal: AbortSignal) => Promise<T>,
	timeoutMs?: number,
): Promise<T> {
	const scope = createAbortScope(parents, timeoutMs);
	try {
		return await use(scope.signal);
	} finally {
		scope.dispose();
	}
}

export async function withTimeoutScope<T>(
	parent: AbortSignal | undefined,
	timeoutMs: number,
	use: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const scope = createAbortScope([parent], timeoutMs);
	try {
		return await use(scope.signal);
	} finally {
		scope.dispose();
	}
}

export function withDefaultTimeout<T>(
	signal: AbortSignal | undefined,
	defaultMs: number,
	use: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	return signal ? use(signal) : withAbortScopes([], use, defaultMs);
}
