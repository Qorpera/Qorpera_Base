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
const paused = {
	schema: "qorpera.member-notification/v1",
	notification_id: id(90),
	profile_id: profileA.profileId,
	kind: "company_execution_paused",
	created_at: timestamp,
	acknowledged_at: null,
	subject: {
		schema: "qorpera.member-notification.company-execution-stop/v1",
		paused: true,
		byUserId: userA.id,
		reason: "Review work",
		at: timestamp,
	},
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
	it("binds notification lists to the member/company and acknowledges only an observed exact id", async () => {
		const f = setup();
		await expect(f.client.acknowledgeNotification(id(90))).rejects.toThrow("Refresh notifications");
		expect(f.fetch).not.toHaveBeenCalled();
		f.fetch.mockResolvedValueOnce(Response.json([paused]));
		expect(await f.client.listNotifications()).toMatchObject([
			{ notificationId: id(90), profileId: profileA.profileId, acknowledgedAt: null },
		]);
		expect(JSON.parse(f.fetch.mock.calls[0]![1]!.body as string)).toEqual({
			p_profile_id: profileA.profileId,
			p_limit: 50,
		});
		f.fetch.mockResolvedValueOnce(Response.json({ ...paused, acknowledged_at: timestamp }));
		expect(await f.client.acknowledgeNotification(id(90))).toMatchObject({
			notificationId: id(90),
			acknowledgedAt: timestamp,
		});
		expect(JSON.parse(f.fetch.mock.calls[1]![1]!.body as string)).toEqual({ p_notification_id: id(90) });
		f.fetch.mockResolvedValueOnce(Response.json([]));
		await f.client.listNotifications();
		await expect(f.client.acknowledgeNotification(id(90))).rejects.toThrow("Refresh notifications");
	});
	it("projects every published notification subject including machine capacity without exposing extra fields", async () => {
		const f = setup();
		const subjects = [
			{
				kind: "provider_usage_limit",
				subject: {
					schema: "qorpera.member-notification.provider-usage-limit/v1",
					provider: "openai",
					resetsAt: timestamp,
					runId: id(11),
					connectionId: id(12),
					private: "hidden",
				},
			},
			{
				kind: "company_ceiling_tripped",
				subject: {
					schema: "qorpera.member-notification.company-ceiling-tripped/v1",
					dimension: "spend",
					ceiling: 100,
					periodStart: timestamp,
				},
			},
			{
				kind: "company_ceiling_tripped",
				subject: {
					schema: "qorpera.member-notification.company-ceiling-tripped/v1",
					dimension: "wakes",
					ceiling: 20,
					periodStart: timestamp,
					used: 20,
				},
			},
			{
				kind: "company_ceiling_tripped",
				subject: {
					schema: "qorpera.member-notification.machine-capacity/v1",
					dimension: "machines",
					ceiling: 2,
					used: 2,
					allocationId: id(13),
				},
			},
			{
				kind: "sponsor_handoff",
				subject: {
					schema: "qorpera.member-notification.sponsor-handoff/v1",
					runId: id(11),
					fromConnectionId: id(12),
					toConnectionId: id(14),
					reason: "usage_limit",
					at: timestamp,
				},
			},
			{ kind: "company_execution_resumed", subject: { ...paused.subject, paused: false } },
		];
		f.fetch.mockResolvedValueOnce(
			Response.json(subjects.map((v, i) => ({ ...paused, ...v, notification_id: id(100 + i) }))),
		);
		const result = await f.client.listNotifications();
		expect(result).toHaveLength(6);
		expect(result[0]!.subject).not.toHaveProperty("private");
		expect(result[3]!.subject).toMatchObject({ dimension: "machines", used: 2, ceiling: 2 });
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
	it("rejects cross-profile notifications, duplicate identities and mismatched acknowledgment receipts", async () => {
		const f = setup();
		f.fetch.mockResolvedValueOnce(Response.json([{ ...paused, profile_id: id(99) }]));
		await expect(f.client.listNotifications()).rejects.toThrow("invalid response");
		f.fetch.mockResolvedValueOnce(Response.json([paused, paused]));
		await expect(f.client.listNotifications()).rejects.toThrow("invalid response");
		f.fetch.mockResolvedValueOnce(Response.json([paused]));
		await f.client.listNotifications();
		f.fetch.mockResolvedValueOnce(Response.json({ ...paused, notification_id: id(91), acknowledged_at: timestamp }));
		await expect(f.client.acknowledgeNotification(id(90))).rejects.toThrow("invalid response");
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
