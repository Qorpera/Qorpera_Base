// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ComputerBillingClient,
	parseComputerPlanCatalog,
	parseComputerUsage,
	stripeRedirect,
} from "../src/cloud/computer-billing.ts";
import { catalogResponse, usageResponse } from "./computer-billing-fixtures.ts";
import { deferred, fixture, userA, userB } from "./fixtures.ts";

afterEach(() => {
	sessionStorage.clear();
	vi.restoreAllMocks();
});
function setup() {
	const env = fixture(),
		abort = new AbortController(),
		catalog = catalogResponse();
	catalog.plans[0]!.activeForCheckout = true;
	vi.mocked(env.cloud.rpc).mockImplementation(
		async (name) => (name === "qorpera_computer_plan_catalog" ? catalog : usageResponse()) as never,
	);
	const fetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValue(
			Response.json({ url: "https://checkout.stripe.com/c/pay/cs_fixture", expiresAt: "2099-10-01T00:00:00Z" }),
		);
	let current = userA.id;
	const client = () =>
		new ComputerBillingClient(
			env.cloud,
			userA.id,
			abort.signal,
			() => {
				if (current !== userA.id) throw new Error("Account changed");
			},
			{ fetch: fetcher, storage: sessionStorage },
		);
	return {
		...env,
		abort,
		catalog,
		fetcher,
		client,
		switchMember() {
			current = userB.id;
			env.auth(userB);
		},
	};
}
describe("computer billing authority", () => {
	it("validates authoritative catalog and paid-balance schemas", () => {
		expect(parseComputerPlanCatalog(catalogResponse()).plans[0]!.monthlyPriceMinor).toBe(18500);
		expect(parseComputerUsage(usageResponse()).balance.availableUs).toBe("255600000000");
		expect(() =>
			parseComputerUsage({ ...usageResponse(), balance: { ...usageResponse().balance, availableUs: -1 } }),
		).toThrow();
		expect(() =>
			parseComputerPlanCatalog({
				...catalogResponse(),
				plans: [...catalogResponse().plans, ...catalogResponse().plans],
			}),
		).toThrow();
		expect(() =>
			parseComputerPlanCatalog({
				...catalogResponse(),
				plans: [{ ...catalogResponse().plans[0], monthlyPriceMinor: 0.5 }],
			}),
		).toThrow();
	});
	it("rejects stale or disabled offers before any external payment call", async () => {
		const env = setup(),
			offer = { ...env.catalog.plans[0]! };
		env.catalog.plans[0]!.activeForCheckout = false;
		await expect(env.client().checkout(offer)).rejects.toThrow("not open");
		env.catalog.plans[0]!.activeForCheckout = true;
		env.catalog.plans[0]!.monthlyPriceMinor++;
		await expect(env.client().checkout(offer)).rejects.toThrow("not open");
		expect(env.fetcher).not.toHaveBeenCalled();
	});
	it("uses member bearer credentials and reuses the same purchase identity after a lost response and reload", async () => {
		const env = setup(),
			offer = env.catalog.plans[0]!;
		env.fetcher.mockRejectedValueOnce(new TypeError("connection lost"));
		await expect(env.client().checkout(offer)).rejects.toThrow("connection lost");
		expect(await env.client().checkout(offer)).toMatch(/^https:\/\/checkout.stripe.com\//);
		const first = env.fetcher.mock.calls[0]!,
			second = env.fetcher.mock.calls[1]!;
		expect(first[0]).toBe("https://fixture.invalid/functions/v1/computer-billing/checkout");
		expect(JSON.parse(first[1]!.body as string).requestId).toBe(JSON.parse(second[1]!.body as string).requestId);
		expect(first[1]!.headers).toMatchObject({ authorization: "Bearer fixture-token", apikey: "fixture-publishable" });
		expect(first[1]).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
	});
	it("rotates an attempt only after the server confirmed its expiry", async () => {
		const env = setup(),
			offer = env.catalog.plans[0]!;
		env.fetcher.mockResolvedValueOnce(
			Response.json({ url: "https://checkout.stripe.com/c/pay/expired", expiresAt: "2000-01-01T00:00:00Z" }),
		);
		await expect(env.client().checkout(offer)).rejects.toThrow("expired");
		await env.client().checkout(offer);
		expect(JSON.parse(env.fetcher.mock.calls[0]![1]!.body as string).requestId).not.toBe(
			JSON.parse(env.fetcher.mock.calls[1]![1]!.body as string).requestId,
		);
	});
	it("refreshes an expiring member token before an explicit portal request", async () => {
		const env = setup();
		const { data } = await env.cloud.supabase.auth.getSession();
		const session = { ...data.session!, expires_at: Math.floor(Date.now() / 1000) + 5 };
		vi.mocked(env.cloud.supabase.auth.getSession).mockResolvedValue({ data: { session }, error: null });
		env.cloud.supabase.auth.refreshSession = vi.fn().mockResolvedValue({
			data: { session: { ...session, access_token: "refreshed-member-token" }, user: userA },
			error: null,
		});
		env.fetcher.mockResolvedValueOnce(Response.json({ url: "https://billing.stripe.com/p/session/fixture" }));
		expect(await env.client().portal()).toBe("https://billing.stripe.com/p/session/fixture");
		expect(env.cloud.supabase.auth.refreshSession).toHaveBeenCalledOnce();
		expect(env.fetcher.mock.calls[0]![1]!.headers).toMatchObject({ authorization: "Bearer refreshed-member-token" });
		expect(env.fetcher.mock.calls[0]![1]!.body).toBe("{}");
	});
	it("retires only an exact reconciled terminal checkout and waits for an explicit retry", async () => {
		const env = setup(),
			offer = env.catalog.plans[0]!;
		env.fetcher.mockImplementationOnce(async (_url, init) =>
			Response.json(
				{
					code: "checkout_reconciled_terminal",
					requestId: JSON.parse(init!.body as string).requestId,
					sessionId: "cs_closed",
					expiresAt: "2000-01-01T00:00:00Z",
				},
				{ status: 409 },
			),
		);
		await expect(env.client().checkout(offer)).rejects.toThrow("previous checkout is closed");
		expect(env.fetcher).toHaveBeenCalledOnce();
		await env.client().checkout(offer);
		expect(JSON.parse(env.fetcher.mock.calls[0]![1]!.body as string).requestId).not.toBe(
			JSON.parse(env.fetcher.mock.calls[1]![1]!.body as string).requestId,
		);
	});
	it("retains uncertain purchase identity for generic or mismatched terminal conflicts", async () => {
		for (const reply of [
			{ error: "Busy" },
			{
				code: "checkout_reconciled_terminal",
				requestId: "wrong",
				sessionId: "cs_closed",
				expiresAt: "2000-01-01T00:00:00Z",
			},
		]) {
			const env = setup(),
				offer = env.catalog.plans[0]!;
			env.fetcher.mockResolvedValueOnce(Response.json(reply, { status: 409 }));
			await expect(env.client().checkout(offer)).rejects.toThrow("unavailable");
			await env.client().checkout(offer);
			expect(JSON.parse(env.fetcher.mock.calls[0]![1]!.body as string).requestId).toBe(
				JSON.parse(env.fetcher.mock.calls[1]![1]!.body as string).requestId,
			);
			sessionStorage.clear();
		}
	});
	it("does not send payment commands after an account change during token refresh", async () => {
		const env = setup();
		const { data } = await env.cloud.supabase.auth.getSession();
		const session = { ...data.session!, expires_at: 1 };
		vi.mocked(env.cloud.supabase.auth.getSession).mockResolvedValue({ data: { session }, error: null });
		env.cloud.supabase.auth.refreshSession = vi.fn().mockImplementation(async () => {
			env.switchMember();
			return { data: { session: { ...session, user: userB }, user: userB }, error: null };
		});
		await expect(env.client().portal()).rejects.toThrow("Account changed");
		expect(env.fetcher).not.toHaveBeenCalled();
	});
	it("fails closed if persistent checkout identity cannot be stored", async () => {
		const env = setup();
		const client = new ComputerBillingClient(env.cloud, userA.id, env.abort.signal, () => {}, {
			fetch: env.fetcher,
			storage: {
				getItem: () => null,
				setItem: () => {
					throw new Error("Storage blocked");
				},
			},
		});
		await expect(client.checkout(env.catalog.plans[0]!)).rejects.toThrow("Storage blocked");
		expect(env.fetcher).not.toHaveBeenCalled();
	});
	it("rejects account changes both before payment and while its response is pending", async () => {
		const env = setup();
		env.auth(userB);
		await expect(env.client().portal()).rejects.toThrow("Sign in");
		expect(env.fetcher).not.toHaveBeenCalled();
		env.auth(userA);
		const reply = deferred<Response>();
		env.fetcher.mockReturnValueOnce(reply.promise);
		const pending = env.client().portal();
		await vi.waitFor(() => expect(env.fetcher).toHaveBeenCalledOnce());
		env.switchMember();
		reply.resolve(Response.json({ url: "https://billing.stripe.com/p/session/fixture" }));
		await expect(pending).rejects.toThrow("Account changed");
	});
	it("drops late catalog and payment results after view disposal", async () => {
		const env = setup(),
			reply = deferred<never>();
		vi.mocked(env.cloud.rpc).mockReturnValueOnce(reply.promise);
		const pending = env.client().catalog();
		env.abort.abort();
		reply.resolve(catalogResponse() as never);
		await expect(pending).rejects.toThrow();
		await expect(env.client().portal()).rejects.toThrow();
		expect(env.fetcher).not.toHaveBeenCalled();
	});
	it("opens only the action's exact Stripe host, without embedded credentials", () => {
		for (const url of [
			"https://checkout.stripe.com.evil.invalid/pay",
			"http://checkout.stripe.com/pay",
			"https://a@checkout.stripe.com/pay",
			"https://checkout.stripe.com:444/pay",
			"javascript:alert(1)",
			"https://billing.stripe.com/pay",
		]) {
			expect(() => stripeRedirect({ url }, "checkout")).toThrow();
		}
		expect(stripeRedirect({ url: "https://billing.stripe.com/p/session/fixture" }, "portal")).toBe(
			"https://billing.stripe.com/p/session/fixture",
		);
	});
});
