import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAbortScopes, withDefaultTimeout } from "../src/abort-scope.ts";
import { SupabaseMemberCompanyAuthority } from "../src/member-company-authority.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("object-gateway abort scopes", () => {
	it("detaches parent abort listeners and clears timers on settlement and error", async () => {
		const a = new AbortController();
		const b = new AbortController();
		const result = await withAbortScopes(
			[a.signal, undefined, b.signal],
			async (signal) => {
				expect(signal.aborted).toBe(false);
				expect(getEventListeners(a.signal, "abort")).toHaveLength(1);
				expect(getEventListeners(b.signal, "abort")).toHaveLength(1);
				return 42;
			},
			10_000,
		);
		expect(result).toBe(42);
		expect(getEventListeners(a.signal, "abort")).toHaveLength(0);
		expect(getEventListeners(b.signal, "abort")).toHaveLength(0);

		await expect(
			withAbortScopes(
				[a.signal, b.signal],
				async () => {
					throw new Error("failed");
				},
				10_000,
			),
		).rejects.toThrow("failed");
		expect(getEventListeners(a.signal, "abort")).toHaveLength(0);
		expect(getEventListeners(b.signal, "abort")).toHaveLength(0);
	});

	it("passes caller signal directly in withDefaultTimeout and bounds omitted signal with TimeoutError", async () => {
		const caller = new AbortController();
		const same = await withDefaultTimeout(caller.signal, 5_000, async (signal) => signal === caller.signal);
		expect(same).toBe(true);

		vi.useFakeTimers();
		let reason: unknown;
		const timed = withDefaultTimeout(undefined, 250, (signal) => {
			return new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					reason = signal.reason;
					resolve();
				});
			});
		});
		await vi.advanceTimersByTimeAsync(250);
		await timed;
		expect((reason as DOMException).name).toBe("TimeoutError");
	});

	it("detaches caller AbortSignal listeners after MemberCompanyAuthority RPCs and cancels 204 bodies", async () => {
		let cancelled = false;
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			const response = new Response(null, { status: 204 });
			Object.defineProperty(response, "body", {
				value: {
					cancel: async () => {
						cancelled = true;
					},
				},
			});
			return response;
		});
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://example.supabase.co",
			secretKey: "service-key",
			publishableKey: "publishable-key",
			fetch: fetchImpl,
		});
		const caller = new AbortController();
		await expect(authority.publisher("qorpera_claim_bank_summary_file", {}, caller.signal)).resolves.toBeNull();
		expect(cancelled).toBe(true);
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
	});
});
