export function linkedAbortScope(parents: readonly (AbortSignal | null | undefined)[]): {
	signal: AbortSignal;
	dispose(): void;
} {
	const scope = new AbortController();
	const listeners: Array<readonly [AbortSignal, () => void]> = [];
	const detach = (): void => {
		for (const [parent, forward] of listeners.splice(0)) parent.removeEventListener("abort", forward);
	};
	for (const parent of parents) {
		if (!parent) continue;
		if (parent.aborted) {
			detach();
			scope.abort(parent.reason);
			break;
		}
		const forward = (): void => {
			detach();
			scope.abort(parent.reason);
		};
		parent.addEventListener("abort", forward, { once: true });
		listeners.push([parent, forward]);
	}
	return {
		signal: scope.signal,
		dispose(): void {
			detach();
			if (!scope.signal.aborted) scope.abort();
		},
	};
}

export async function withAbortScopes<T>(
	parents: readonly (AbortSignal | null | undefined)[],
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
	}
	try {
		return await use(scope.signal);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		for (const [parent, forward] of listeners) parent.removeEventListener("abort", forward);
	}
}
