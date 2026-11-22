import { getEventListeners } from "node:events";
import { CloudRequestTimeoutError } from "@qorpera/cloud-client/cloud-request";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAbortScope, withAbortScopes, withScopedCloudDeadline } from "../src/cloud/abort-scope.ts";
import type { Cloud } from "../src/cloud/client.ts";
import { GoodWillCardError, startGoodWillCard } from "../src/cloud/good-will.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("web cloud abort scopes", () => {
	it("detaches all parent abort listeners and timers after settlement or rejection", async () => {
		const company = new AbortController();
		const view = new AbortController();
		const value = await withAbortScopes(
			[company.signal, undefined, view.signal],
			async (scoped) => {
				expect(scoped.aborted).toBe(false);
				expect(getEventListeners(company.signal, "abort")).toHaveLength(1);
				expect(getEventListeners(view.signal, "abort")).toHaveLength(1);
				return "ok";
			},
			10_000,
		);
		expect(value).toBe("ok");
		expect(getEventListeners(company.signal, "abort")).toHaveLength(0);
		expect(getEventListeners(view.signal, "abort")).toHaveLength(0);

		await expect(
			withAbortScopes(
				[company.signal, view.signal],
				async () => {
					throw new Error("boom");
				},
				10_000,
			),
		).rejects.toThrow("boom");
		expect(getEventListeners(company.signal, "abort")).toHaveLength(0);
		expect(getEventListeners(view.signal, "abort")).toHaveLength(0);
	});

	it("aborts with parent reason immediately and supports TimeoutError and CloudRequestTimeoutError", async () => {
		const parent = new AbortController();
		parent.abort(new Error("company-closed"));
		let observedReason: unknown;
		await withAbortScopes([parent.signal], async (scoped) => {
			expect(scoped.aborted).toBe(true);
			observedReason = scoped.reason;
		});
		expect(observedReason).toBeInstanceOf(Error);
		expect((observedReason as Error).message).toBe("company-closed");

		vi.useFakeTimers();
		let timedReason: unknown;
		const timed = withAbortScopes(
			[],
			(scoped) =>
				new Promise<void>((resolve) => {
					scoped.addEventListener("abort", () => {
						timedReason = scoped.reason;
						resolve();
					});
				}),
			500,
		);
		await vi.advanceTimersByTimeAsync(500);
		await timed;
		expect((timedReason as DOMException).name).toBe("TimeoutError");

		const liveCompany = new AbortController();
		const deadlinePromise = withScopedCloudDeadline(
			[liveCompany.signal],
			() => new Promise<never>(() => undefined),
			250,
		);
		const caught = deadlinePromise.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(250);
		expect(await caught).toBeInstanceOf(CloudRequestTimeoutError);
		expect(getEventListeners(liveCompany.signal, "abort")).toHaveLength(0);
	});

	it("aborts startGoodWillCard promptly on caller abort and detaches listeners", async () => {
		const caller = new AbortController();
		let observedSignal: AbortSignal | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			observedSignal = init?.signal ?? undefined;
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), {
					once: true,
				});
			});
		});
		const cloud = {
			config: { projectUrl: "https://example.supabase.co", publishableKey: "pub" },
			supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "tok" } }, error: null }) } },
		} as unknown as Cloud;
		const pending = startGoodWillCard(cloud, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", caller.signal);
		await vi.waitFor(() => expect(observedSignal).toBeDefined());
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(1);
		caller.abort(new Error("gone"));
		await expect(pending).rejects.toBeInstanceOf(GoodWillCardError);
		expect(observedSignal?.aborted).toBe(true);
		expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
	});

	it("supports manual createAbortScope with idempotent dispose and zero timers on pre-aborted parents", () => {
		vi.useFakeTimers();
		const live = new AbortController();
		const scope = createAbortScope([live.signal], 1_000);
		expect(getEventListeners(live.signal, "abort")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(1);
		scope.dispose();
		scope.dispose();
		expect(getEventListeners(live.signal, "abort")).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(scope.signal.aborted).toBe(false);

		const aborted = new AbortController();
		aborted.abort(new Error("gone"));
		const preAborted = createAbortScope([live.signal, aborted.signal], 1_000);
		expect(preAborted.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		preAborted.dispose();
		expect(getEventListeners(live.signal, "abort")).toHaveLength(0);
	});
});
