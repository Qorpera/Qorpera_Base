import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebCompanyExecution } from "../src/cloud/company-execution.ts";
import { deferred, fixture, id, profileA, settle, timestamp, userA, userB } from "./fixtures.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
const ceiling = {
	schema: "qorpera.company-execution-ceiling/v1",
	profile_id: profileA.profileId,
	period: "month",
	period_start: timestamp,
	configured: true,
	version: 8,
	spend_microusd_per_period: 12000000,
	tokens_per_period: 25000,
	wakes_per_hour: 12,
	wakes_last_hour: 3,
	paused: false,
	spend_microusd_used: 1000000,
	tokens_used: 600,
	trips: 2,
};
function setup() {
	const f = fixture(),
		company = new AbortController(),
		view = new AbortController(),
		current = vi.fn();
	const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(ceiling));
	vi.stubGlobal("fetch", fetch);
	return {
		...f,
		company,
		view,
		current,
		fetch,
		client: createWebCompanyExecution(f.cloud, profileA.profileId, userA.id, company.signal, current),
	};
}
describe("company execution public member control", () => {
	it("reads server values without inferring defaults and submits the observed ceiling version unchanged", async () => {
		const f = setup();
		expect(await f.client.read()).toEqual({
			profileId: profileA.profileId,
			period: "month",
			periodStart: timestamp,
			configured: true,
			version: 8,
			spendMicrousdPerPeriod: 12000000,
			tokensPerPeriod: 25000,
			wakesPerHour: 12,
			wakesLastHour: 3,
			paused: false,
			spendMicrousdUsed: 1000000,
			tokensUsed: 600,
			trips: 2,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ ...ceiling, version: 9 }));
		const input = {
			expectedVersion: 8,
			spendMicrousdPerPeriod: 12000000,
			tokensPerPeriod: 25000,
			wakesPerHour: 12,
			profileId: id(99),
		};
		const pending = f.client.setCeiling(input, f.view.signal);
		input.expectedVersion = 10;
		expect(await pending).toMatchObject({ version: 9 });
		const [url, request] = f.fetch.mock.calls[1]!;
		expect(url).toBe("https://fixture.invalid/rest/v1/rpc/qorpera_set_company_execution_ceiling");
		expect(JSON.parse(request!.body as string)).toEqual({
			p_profile_id: profileA.profileId,
			p_expected_version: 8,
			p_spend_microusd_per_period: 12000000,
			p_tokens_per_period: 25000,
			p_wakes_per_hour: 12,
		});
		expect(request).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", credentials: "omit" });
		expect(new Headers(request!.headers).get("authorization")).toBe("Bearer fixture-token");
	});
	it("sends the explicit pause state and never performs a mutation during teardown", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.company-execution-stop/v1",
				profileId: profileA.profileId,
				paused: true,
				changed: true,
			}),
		);
		expect(await f.client.setPause(true, "Review work")).toEqual({
			profileId: profileA.profileId,
			paused: true,
			changed: true,
		});
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({
			p_profile_id: profileA.profileId,
			p_paused: true,
			p_reason: "Review work",
		});
		f.company.abort();
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it("matches SQL character limits for Unicode pause reasons", async () => {
		const f = setup();
		const reason = "😀".repeat(600) + "a".repeat(424);
		f.fetch.mockResolvedValueOnce(
			Response.json({
				schema: "qorpera.company-execution-stop/v1",
				profileId: profileA.profileId,
				paused: true,
				changed: true,
			}),
		);
		await expect(f.client.setPause(true, reason)).resolves.toMatchObject({ paused: true });
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string).p_reason).toBe(reason);
		await expect(f.client.setPause(true, `${reason}a`)).rejects.toThrow("invalid response");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ ...ceiling, profile_id: id(99) },
		{ ...ceiling, version: 1.5 },
		{ ...ceiling, tokens_used: Number.MAX_SAFE_INTEGER + 1 },
		{ ...ceiling, paused: "false" },
	])("rejects foreign or malformed status", async (value) => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json(value));
		await expect(f.client.read()).rejects.toThrow("invalid response");
	});
	it("refuses a refreshed account before dispatch and fences a company change after auth", async () => {
		const f = setup();
		f.auth(userB);
		await expect(f.client.read()).rejects.toThrow("Refresh its status");
		expect(f.fetch).not.toHaveBeenCalled();
		f.auth(userA);
		f.current
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error("Company changed");
			});
		await expect(f.client.setPause(true)).rejects.toThrow("Refresh its status");
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it.each(["company", "view"] as const)("aborts %s during authentication without dispatch", async (scope) => {
		const f = setup(),
			original = await f.cloud.supabase.auth.getSession(),
			token = deferred<typeof original>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.client.setPause(true, undefined, f.view.signal)).rejects.toThrow();
		await settle();
		f[scope].abort();
		await rejected;
		token.resolve(original);
		await settle();
		expect(f.fetch).not.toHaveBeenCalled();
	});
	it("discards a late response after route authority changes", async () => {
		const f = setup(),
			response = deferred<Response>();
		f.fetch.mockReturnValueOnce(response.promise);
		const reading = f.client.read();
		await settle();
		f.current.mockImplementation(() => {
			throw new Error("Company changed");
		});
		response.resolve(Response.json(ceiling));
		await expect(reading).rejects.toThrow("Refresh its status");
	});
	it("checks authority after parsing before returning a successful record", async () => {
		const f = setup();
		let checks = 0;
		f.current.mockImplementation(() => {
			if (++checks === 5) throw new Error("Company changed after response");
		});
		await expect(f.client.read()).rejects.toThrow("Refresh its status");
		expect(checks).toBe(5);
	});
	it("rejects oversized responses and invalid numeric writes before dispatch", async () => {
		const f = setup();
		await expect(
			f.client.setCeiling({
				expectedVersion: 8,
				spendMicrousdPerPeriod: NaN,
				tokensPerPeriod: 100,
				wakesPerHour: 1,
			}),
		).rejects.toThrow();
		expect(f.fetch).not.toHaveBeenCalled();
		f.fetch.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
		await expect(f.client.read()).rejects.toThrow("Refresh its status");
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
	it.each([401, 403, 412])(
		"preserves safe status %s without leaking internal diagnostics or retrying",
		async (status) => {
			const f = setup();
			f.fetch.mockResolvedValueOnce(new Response("sensitive detail", { status }));
			await expect(f.client.setPause(true)).rejects.toMatchObject({
				status,
				code: status === 412 ? "PT412" : "42501",
			});
			expect(f.fetch).toHaveBeenCalledTimes(1);
		},
	);
	it("does not retry an uncertain mutation and bounds authentication time", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(new Response("sensitive detail", { status: 500 }));
		await expect(f.client.setPause(true)).rejects.toThrow(
			"Company execution could not be confirmed. Refresh its status before trying again.",
		);
		expect(f.fetch).toHaveBeenCalledTimes(1);
		vi.useFakeTimers();
		const token = deferred<Awaited<ReturnType<typeof f.cloud.supabase.auth.getSession>>>();
		vi.mocked(f.cloud.supabase.auth.getSession).mockReturnValueOnce(token.promise);
		const rejected = expect(f.client.read()).rejects.toThrow("Refresh its status");
		await vi.advanceTimersByTimeAsync(10000);
		await rejected;
		expect(f.fetch).toHaveBeenCalledTimes(1);
	});
});
