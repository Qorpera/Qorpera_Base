export async function withAbortScopes<T>(
	parents: readonly (AbortSignal | undefined)[],
	use: (signal: AbortSignal) => Promise<T>,
	timeoutMs?: number,
): Promise<T> {
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
		timer.unref?.();
	}
	try {
		return await use(scope.signal);
	} finally {
		clearTimeout(timer);
		for (const [parent, forward] of listeners) parent.removeEventListener("abort", forward);
	}
}

export function withDefaultTimeout<T>(
	signal: AbortSignal | undefined,
	defaultMs: number,
	use: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	return signal ? use(signal) : withAbortScopes([], use, defaultMs);
}
