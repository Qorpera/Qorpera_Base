export async function withTimeoutSignal<T>(
	parent: AbortSignal,
	timeoutMs: number,
	use: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const scope = new AbortController();
	const forward = (): void => scope.abort(parent.reason);
	if (parent.aborted) {
		forward();
		return await use(scope.signal);
	}
	parent.addEventListener("abort", forward, { once: true });
	const timer = setTimeout(() => scope.abort(new Error("Operation timed out")), timeoutMs);
	try {
		return await use(scope.signal);
	} finally {
		clearTimeout(timer);
		parent.removeEventListener("abort", forward);
	}
}
