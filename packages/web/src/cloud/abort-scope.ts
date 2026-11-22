import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";

export interface AbortScope {
	readonly signal: AbortSignal;
	dispose(): void;
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

export function withScopedCloudDeadline<T>(
	parents: readonly (AbortSignal | undefined)[],
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return withAbortScopes(parents, (scoped) => withCloudDeadline(operation, timeoutMs, scoped));
}
