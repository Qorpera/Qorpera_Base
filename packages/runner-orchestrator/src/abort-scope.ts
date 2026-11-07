/** Work under a signal of its own, ended when `parent` is, for as long as the work runs.
 *
 * Node 22's `AbortSignal.any` keeps a weak reference to each signal it makes on every plain signal it was given, and each
 * time one of those is collected it walks all of them. Over a signal that lives as long as the process (the one SIGTERM
 * aborts), that walk grew until a coding executor froze whole, for 330 s about every 25 minutes after 4 days (perf sprint
 * A5, 7 Nov 2026: `AbortSignal.any` in Node 24 no longer walks). A plain signal per pass or per call takes those references
 * instead, and they go with it. So a long-lived signal is only ever handed to `withAbortScope`, never to `AbortSignal.any`. */
export async function withAbortScope<T>(parent: AbortSignal, use: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const scope = new AbortController();
	const forward = (): void => scope.abort(parent.reason);
	if (parent.aborted) forward();
	else parent.addEventListener("abort", forward, { once: true });
	try {
		return await use(scope.signal);
	} finally {
		parent.removeEventListener("abort", forward);
	}
}
