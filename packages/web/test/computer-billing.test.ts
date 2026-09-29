// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { takeCheckoutReturn } from "../src/app/plan-payments.ts";
import type { Cloud } from "../src/cloud/client.ts";
import {
	ComputerBillingError,
	openComputerBillingPortal,
	parseComputerHourOffers,
	parseMyComputerPlan,
	startComputerCheckout,
} from "../src/cloud/computer-billing.ts";

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const offers = (items: unknown[]) => ({ schema: "qorpera.computer-hour-offers/v1", items });
const basis = {
	itemKey: "basis",
	kind: "plan",
	name: "Basis",
	priceMinor: 18_500,
	currency: "dkk",
	hours: 74,
	available: true,
};
const plan = (overrides: Record<string, unknown> = {}) => ({
	schema: "qorpera.my-computer-plan/v1",
	mode: "dry_run",
	plan: {
		itemKey: "basis",
		status: "active",
		periodStart: "2026-09-01T00:00:00+00:00",
		periodEnd: "2026-10-01T00:00:00+00:00",
		cancelAtPeriodEnd: false,
	},
	hours: { grantedSeconds: 266_400, companies: [{ profileId: P, seconds: 7_200 }] },
	...overrides,
});

function cloud(token: string | null = "member-token"): Cloud {
	return {
		config: { projectUrl: "https://project.supabase.co", publishableKey: "sb_publishable_x" },
		supabase: {
			auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) },
		},
		rpc: async () => undefined,
	} as unknown as Cloud;
}

afterEach(() => {
	vi.unstubAllGlobals();
	history.replaceState(null, "", "#/");
});

describe("computer hour offers and plan", () => {
	it("reads what can be bought, and whether this member can buy it now", () => {
		expect(
			parseComputerHourOffers(offers([basis, { ...basis, itemKey: "hours_20", kind: "credits", available: false }])),
		).toEqual([
			{ ...basis, kind: "plan", available: true },
			{ ...basis, itemKey: "hours_20", kind: "credits", available: false },
		]);
		// A reply without the flag is not for sale.
		const { available: _, ...older } = basis;
		expect(parseComputerHourOffers(offers([older]))[0]?.available).toBe(false);
		expect(() => parseComputerHourOffers({ schema: "qorpera.computer-hour-offers/v2", items: [] })).toThrow();
		expect(() => parseComputerHourOffers(offers([{ ...basis, currency: "eur" }]))).toThrow("currency");
		expect(() => parseComputerHourOffers(offers([{ ...basis, kind: "gift" }]))).toThrow("kind");
		expect(() => parseComputerHourOffers(offers([{ ...basis, priceMinor: 0 }]))).toThrow("price");
	});

	it("reads the member's own plan, or none", () => {
		expect(parseMyComputerPlan(plan())).toEqual({
			mode: "dry_run",
			plan: {
				itemKey: "basis",
				status: "active",
				periodStart: "2026-09-01T00:00:00+00:00",
				periodEnd: "2026-10-01T00:00:00+00:00",
				cancelAtPeriodEnd: false,
			},
			hours: { grantedSeconds: 266_400, companies: [{ profileId: P, seconds: 7_200 }] },
		});
		expect(parseMyComputerPlan(plan({ plan: null, hours: { grantedSeconds: 0, companies: [] } })).plan).toBeNull();
		// Before live payments the plan's hours are left out.
		expect(parseMyComputerPlan(plan({ hours: null })).hours).toBeNull();
		expect(() => parseMyComputerPlan(plan({ mode: "maybe" }))).toThrow("mode");
		expect(() =>
			parseMyComputerPlan(plan({ hours: { grantedSeconds: 1, companies: [{ profileId: "x", seconds: 1 }] } })),
		).toThrow("company");
	});
});

describe("Stripe's pages", () => {
	it("posts the member's token and opens only Stripe's own checkout page", async () => {
		const fetch = vi.fn(async () => Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
		vi.stubGlobal("fetch", fetch);
		await expect(startComputerCheckout(cloud(), "hours_20", P)).resolves.toBe(
			"https://checkout.stripe.com/c/pay/cs_test_1",
		);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://project.supabase.co/functions/v1/computer-billing/checkout");
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("omit");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer member-token");
		expect(JSON.parse(init.body as string)).toEqual({ itemKey: "hours_20", profileId: P });

		fetch.mockImplementationOnce(async () => Response.json({ url: "https://evil.example/c/pay" }));
		await expect(startComputerCheckout(cloud(), "basis")).rejects.toMatchObject({ refusal: "unavailable" });
		fetch.mockImplementationOnce(async () => Response.json({ url: "http://checkout.stripe.com/c/pay" }));
		await expect(startComputerCheckout(cloud(), "basis")).rejects.toMatchObject({ refusal: "unavailable" });
		// The billing page must come from billing.stripe.com, not checkout.
		fetch.mockImplementationOnce(async () => Response.json({ url: "https://checkout.stripe.com/p/session" }));
		await expect(openComputerBillingPortal(cloud())).rejects.toMatchObject({ refusal: "unavailable" });
		fetch.mockImplementationOnce(async () => Response.json({ url: "https://billing.stripe.com/p/session/x" }));
		await expect(openComputerBillingPortal(cloud())).resolves.toBe("https://billing.stripe.com/p/session/x");
	});

	it("names a refusal and treats anything else as unavailable", async () => {
		const fetch = vi.fn(async () => Response.json({ refused: "not_a_founder" }, { status: 409 }));
		vi.stubGlobal("fetch", fetch);
		await expect(startComputerCheckout(cloud(), "hours_20", P)).rejects.toMatchObject({ refusal: "not_a_founder" });
		fetch.mockImplementationOnce(async () => Response.json({ refused: "something_new" }, { status: 409 }));
		await expect(startComputerCheckout(cloud(), "basis")).rejects.toMatchObject({ refusal: "unavailable" });
		fetch.mockImplementationOnce(async () => new Response("boot error", { status: 503 }));
		await expect(startComputerCheckout(cloud(), "basis")).rejects.toMatchObject({ refusal: "unavailable" });
		fetch.mockImplementationOnce(async () => {
			throw new TypeError("Failed to fetch");
		});
		await expect(openComputerBillingPortal(cloud())).rejects.toBeInstanceOf(ComputerBillingError);
		// Signed out: nothing is sent.
		fetch.mockClear();
		await expect(openComputerBillingPortal(cloud(null))).rejects.toMatchObject({ refusal: "unavailable" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reads the return from Stripe once and removes it from the address", () => {
		history.replaceState(null, "", "#/account?checkout=done&session_id=cs_test_1");
		expect(takeCheckoutReturn()).toBe("done");
		expect(location.hash).toBe("#/account");
		expect(takeCheckoutReturn()).toBeUndefined();
		history.replaceState(null, "", "#/account?checkout=cancelled");
		expect(takeCheckoutReturn()).toBe("cancelled");
		expect(location.hash).toBe("#/account");
		// Someone else's return (a connector's) is left alone.
		history.replaceState(null, "", "#/c/x?connector=gmail&connection=failed");
		expect(takeCheckoutReturn()).toBeUndefined();
		expect(location.hash).toBe("#/c/x?connector=gmail&connection=failed");
	});
});
