import { vi } from "vitest";

/** Runs `body` with every `AbortSignal.timeout(ms)` asked for meanwhile ending after `shortMs` instead, and returns how
 * many were asked for. A test of a stalled reply so still proves the call ends on the code's own `ms` deadline (the code
 * asks for exactly that deadline, and nothing else ends the stall) without waiting `ms` of real time: a deadline that
 * changes, or goes, fails the test (none asked for, or no end within the test's timeout). Other deadlines are untouched. */
export async function withShortDeadline(ms: number, body: () => Promise<unknown>, shortMs = 25): Promise<number> {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	let asked = 0;
	const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay: number) => {
		if (delay !== ms) return timeout(delay);
		asked++;
		return timeout(shortMs);
	});
	try {
		await body();
	} finally {
		spy.mockRestore();
	}
	return asked;
}
