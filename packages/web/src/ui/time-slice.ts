interface SchedulerLike {
	readonly yield?: () => Promise<void>;
}

export function hasBrowserCompositor(): boolean {
	return (
		typeof requestAnimationFrame === "function" &&
		!(typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent))
	);
}

export function yieldToMain(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.resolve();
	const sched = (globalThis as { readonly scheduler?: SchedulerLike }).scheduler;
	if (typeof sched?.yield === "function") return sched.yield();
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, 0);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface FrameBudget {
	shouldYield(): boolean;
	yieldIfNeeded(signal?: AbortSignal): Promise<boolean>;
	reset(): void;
}

export function createFrameBudget(budgetMs = 6): FrameBudget {
	let sliceStart = performance.now();
	return {
		shouldYield: () => performance.now() - sliceStart >= budgetMs,
		reset: () => {
			sliceStart = performance.now();
		},
		yieldIfNeeded: async (signal?: AbortSignal) => {
			if (signal?.aborted) return false;
			if (performance.now() - sliceStart < budgetMs) return true;
			await yieldToMain(signal);
			sliceStart = performance.now();
			return !(signal?.aborted ?? false);
		},
	};
}

export function afterPaint(run: () => void, signal?: AbortSignal): () => void {
	let frame: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelled = false;
	const cancel = () => {
		if (cancelled) return;
		cancelled = true;
		signal?.removeEventListener("abort", cancel);
		if (frame !== undefined) {
			cancelAnimationFrame(frame);
			frame = undefined;
		}
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	const invoke = () => {
		frame = undefined;
		timer = undefined;
		if (cancelled || signal?.aborted) return;
		cancelled = true;
		signal?.removeEventListener("abort", cancel);
		run();
	};
	signal?.addEventListener("abort", cancel, { once: true });
	// WHY: Let the browser paint Frame 0 before mounting heavy work; jsdom has no paint loop and runs rAF on a 16ms timer.
	if (hasBrowserCompositor()) {
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (cancelled || signal?.aborted) return;
			timer = setTimeout(invoke, 0);
		});
	} else {
		timer = setTimeout(invoke, 0);
	}
	return cancel;
}

export function deferOffFrame(run: () => void): () => void {
	if (!hasBrowserCompositor()) {
		run();
		return () => undefined;
	}
	let done = false;
	let idle: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const invoke = () => {
		if (done) return;
		done = true;
		idle = undefined;
		timer = undefined;
		run();
	};
	const idleApi = globalThis as {
		readonly requestIdleCallback?: (cb: () => void, options?: { readonly timeout?: number }) => number;
		readonly cancelIdleCallback?: (handle: number) => void;
	};
	if (typeof idleApi.requestIdleCallback === "function") {
		idle = idleApi.requestIdleCallback(invoke, { timeout: 250 });
	} else {
		timer = setTimeout(invoke, 32);
	}
	return () => {
		if (done) return;
		done = true;
		if (idle !== undefined) idleApi.cancelIdleCallback?.(idle);
		if (timer !== undefined) clearTimeout(timer);
	};
}
