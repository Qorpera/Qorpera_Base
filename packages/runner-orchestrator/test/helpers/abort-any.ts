import { vi } from "vitest";

/** Watches `AbortSignal.any` for a test, on any Node version: for each signal it makes, the plain signals it hangs off (a
 * signal it made counts as the plain ones under it, as Node flattens it). On Node 22 a plain signal keeps every one of
 * those, and walks them all each time one is collected (abort-scope.ts); Node 24 does not, so the tests count instead of
 * looking inside Node. */
export function watchAbortSignalAny() {
	const any = AbortSignal.any.bind(AbortSignal);
	const under = new WeakMap<AbortSignal, readonly AbortSignal[]>();
	const hanging = new Map<AbortSignal, number>();
	const spy = vi.spyOn(AbortSignal, "any").mockImplementation((signals: Iterable<AbortSignal>) => {
		const given = [...signals];
		const made = any(given);
		const plain = [...new Set(given.flatMap((signal) => under.get(signal) ?? [signal]))];
		under.set(made, plain);
		for (const signal of plain) hanging.set(signal, (hanging.get(signal) ?? 0) + 1);
		return made;
	});
	return {
		/** How many of the signals `AbortSignal.any` made hang off `signal`. */
		on: (signal: AbortSignal): number => hanging.get(signal) ?? 0,
		/** The most that hang off any one plain signal. */
		most: (): number => Math.max(0, ...hanging.values()),
		/** How many signals `AbortSignal.any` made. */
		made: (): number => spy.mock.calls.length,
		restore: (): void => spy.mockRestore(),
	};
}
