export async function withTimeoutScope<T>(
	timeoutMs: number,
	use: (signal: AbortSignal) => Promise<T>,
	parent?: AbortSignal,
): Promise<T> {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	const timer = controller.signal.aborted
		? undefined
		: setTimeout(
				() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
				timeoutMs,
			);
	(timer as { unref?: () => void } | undefined)?.unref?.();
	try {
		return await use(controller.signal);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		parent?.removeEventListener("abort", onAbort);
	}
}
