import { readNativeProviderAccountUsage } from "@qorpera/runtime/native-provider-usage";
import { afterEach, describe, expect, it, vi } from "vitest";

const credentials = JSON.stringify({
	tokens: { access_token: "private-access", account_id: "account-a", refresh_token: "private-refresh" },
});
const available = {
	rate_limit: {
		primary_window: { used_percent: 91, limit_window_seconds: 18_000, reset_at: 1_789_849_200 },
		secondary_window: { used_percent: 50.5, limit_window_seconds: 604_800, reset_at: 1_790_467_200 },
	},
};
const respond = (body: unknown) => vi.fn<typeof fetch>(async () => Response.json(body));

afterEach(() => vi.useRealTimers());

describe("native provider account usage", () => {
	it("reads the exact account and projects only primary and weekly quota metadata", async () => {
		const fetcher = respond({
			...available,
			access_token: "private-response",
			credits: { balance: "private-credit" },
		});
		const usage = await readNativeProviderAccountUsage(credentials, undefined, fetcher);
		expect(usage).toEqual({
			observedAt: expect.any(String),
			windows: [
				{
					id: "primary",
					label: "5 hours",
					usedPercent: 91,
					windowSeconds: 18_000,
					resetAt: new Date(1_789_849_200_000).toISOString(),
				},
				{
					id: "secondary",
					label: "Weekly",
					usedPercent: 50.5,
					windowSeconds: 604_800,
					resetAt: new Date(1_790_467_200_000).toISOString(),
				},
			],
		});
		expect(Number.isFinite(Date.parse(usage!.observedAt))).toBe(true);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]).toEqual([
			"https://chatgpt.com/backend-api/wham/usage",
			{
				headers: {
					Accept: "application/json",
					Authorization: "Bearer private-access",
					"ChatGPT-Account-Id": "account-a",
				},
				redirect: "error",
				signal: expect.any(AbortSignal),
			},
		]);
		expect(JSON.stringify(usage)).not.toMatch(/private|token|account-a/);
	});

	it("preserves provider-reported 0% and 100%, and supports legacy window field names", async () => {
		const usage = await readNativeProviderAccountUsage(
			credentials,
			undefined,
			respond({
				rate_limits: {
					primary: { used_percent: 0, window_minutes: 300, reset_at: "2026-09-20T12:00:00Z" },
					secondary: { used_percent: 100, window_minutes: 10080 },
				},
			}),
		);
		expect(usage?.windows).toEqual([
			{
				id: "primary",
				label: "5 hours",
				usedPercent: 0,
				windowSeconds: 18_000,
				resetAt: "2026-09-20T12:00:00.000Z",
			},
			{ id: "secondary", label: "Weekly", usedPercent: 100, windowSeconds: 604_800 },
		]);
	});

	it.each([null, undefined, "0", {}, -1, 101])("does not fabricate percentages from %j", async (used_percent) => {
		expect(
			await readNativeProviderAccountUsage(
				credentials,
				undefined,
				respond({ rate_limit: { primary_window: { used_percent } } }),
			),
		).toBeUndefined();
	});

	it("keeps valid usage while omitting invalid optional reset and duration metadata", async () => {
		const usage = await readNativeProviderAccountUsage(
			credentials,
			undefined,
			respond({
				rate_limit: {
					primary_window: { used_percent: 12, reset_at: 1e100, limit_window_seconds: -5 },
					secondary_window: { used_percent: 45, reset_at: "not-a-date", window_minutes: "10080" },
				},
			}),
		);
		expect(usage?.windows).toEqual([
			{ id: "primary", label: "Current window", usedPercent: 12 },
			{ id: "secondary", label: "Weekly", usedPercent: 45 },
		]);
	});

	it.each([
		"not-json",
		"null",
		"{}",
		JSON.stringify({ tokens: { access_token: "private-access" } }),
		JSON.stringify({ tokens: { access_token: "private\nheader", account_id: "account-a" } }),
		JSON.stringify({ tokens: { access_token: "private-access", account_id: "account\rheader" } }),
	])("does not fetch with incomplete or unsafe credential metadata", async (metadata) => {
		const fetcher = respond(available);
		expect(await readNativeProviderAccountUsage(metadata, undefined, fetcher)).toBeUndefined();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it.each([401, 403, 429, 500, 302])(
		"returns unknown on provider status %s without exposing errors",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>(
				async () =>
					new Response("private-token-error", { status, headers: { location: "https://wrong.example/usage" } }),
			);
			expect(await readNativeProviderAccountUsage(credentials, undefined, fetcher)).toBeUndefined();
			expect(fetcher).toHaveBeenCalledOnce();
			expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
		},
	);

	it("rejects a transport response from another destination", async () => {
		const response = Response.json(available);
		Object.defineProperty(response, "url", { value: "https://wrong.example/usage" });
		expect(await readNativeProviderAccountUsage(credentials, undefined, async () => response)).toBeUndefined();
	});

	it("rejects oversized declared and streamed bodies before projecting any data", async () => {
		for (const response of [
			new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }),
			new Response(" ".repeat(256 * 1024 + 1) + JSON.stringify(available)),
		]) {
			expect(await readNativeProviderAccountUsage(credentials, undefined, async () => response)).toBeUndefined();
		}
	});

	it("does not fetch after cancellation, and cancels a pending request", async () => {
		const alreadyAborted = new AbortController();
		alreadyAborted.abort(new Error("private-reason"));
		const fetcher = respond(available);
		expect(await readNativeProviderAccountUsage(credentials, alreadyAborted.signal, fetcher)).toBeUndefined();
		expect(fetcher).not.toHaveBeenCalled();
		const pending = new AbortController();
		const stalled = vi.fn<typeof fetch>(() => new Promise(() => {}));
		const result = readNativeProviderAccountUsage(credentials, pending.signal, stalled);
		await Promise.resolve();
		pending.abort(new Error("private-reason"));
		expect(await result).toBeUndefined();
		expect(stalled.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it("bounds a stalled response body to ten seconds and cancels the stream", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const response = new Response(new ReadableStream({ cancel }));
		const result = readNativeProviderAccountUsage(credentials, undefined, async () => response);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await result).toBeUndefined();
		expect(cancel).toHaveBeenCalledOnce();
	});
});
