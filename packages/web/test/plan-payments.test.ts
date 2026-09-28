// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanPayments } from "../src/app/plan-payments.ts";
import type { CloudApi } from "../src/cloud/api.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { ComputerBillingError, type ComputerHourOffer, type MyComputerPlan } from "../src/cloud/computer-billing.ts";

const OFFERS: ComputerHourOffer[] = [
	{ itemKey: "basis", kind: "plan", name: "Basis", priceMinor: 18_500, currency: "dkk", hours: 74, available: true },
];
const PLAN: MyComputerPlan = { mode: "dry_run", plan: null, hours: null };

function mocks() {
	return {
		listComputerHourOffers: vi.fn(async (): Promise<ComputerHourOffer[]> => OFFERS),
		getMyComputerPlan: vi.fn(async (): Promise<MyComputerPlan> => PLAN),
		startComputerCheckout: vi.fn(
			async (_itemKey: string, _profileId?: string): Promise<string> =>
				"https://checkout.stripe.com/c/pay/cs_test_1",
		),
		openComputerBillingPortal: vi.fn(async (): Promise<string> => "https://billing.stripe.com/p/session/x"),
	};
}

function api(overrides: Partial<ReturnType<typeof mocks>> = {}) {
	const fake = { ...mocks(), ...overrides };
	return fake as typeof fake & CloudApi;
}

const assign = vi.fn();
beforeEach(() => {
	vi.useFakeTimers();
	assign.mockClear();
	vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Plan & usage payments state", () => {
	it("loads once, and a cloud without payments shows nothing to buy", async () => {
		const cloud = api();
		const changed = vi.fn();
		const payments = new PlanPayments(cloud, changed);
		payments.load();
		payments.load();
		await vi.runAllTimersAsync();
		expect(cloud.listComputerHourOffers).toHaveBeenCalledTimes(1);
		expect(payments.state).toMatchObject({ offers: OFFERS, plan: PLAN, loaded: true });
		expect(changed).toHaveBeenCalled();
		const missing = new CloudRpcError("qorpera_list_computer_hour_offers", { message: "missing", code: "PGRST202" });
		const older = new PlanPayments(
			api({
				listComputerHourOffers: vi.fn(async () => Promise.reject(missing)),
				getMyComputerPlan: vi.fn(async () => Promise.reject(missing)),
			}),
			() => {},
		);
		older.load();
		await vi.runAllTimersAsync();
		expect(older.state).toMatchObject({ offers: [], loaded: true });
		expect(older.state.plan).toBeUndefined();
	});

	it("reads the plan again once after the return from Stripe, keeping what it showed if that fails", async () => {
		const cloud = api();
		const payments = new PlanPayments(cloud, () => {}, "done");
		payments.load();
		await vi.advanceTimersByTimeAsync(10);
		expect(payments.state.returned).toBe("done");
		cloud.getMyComputerPlan.mockRejectedValueOnce(new Error("offline"));
		await vi.advanceTimersByTimeAsync(5000);
		expect(cloud.getMyComputerPlan).toHaveBeenCalledTimes(2);
		expect(payments.state).toMatchObject({ offers: OFFERS, plan: PLAN, loaded: true });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(cloud.getMyComputerPlan).toHaveBeenCalledTimes(2);
		// Disposed before its refresh: nothing more is read or drawn.
		const early = api();
		const changed = vi.fn();
		new PlanPayments(early, changed, "done").dispose();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(early.getMyComputerPlan).not.toHaveBeenCalled();
		expect(changed).not.toHaveBeenCalled();
	});

	it("opens Stripe's page once, and frees the buttons if the page never opens", async () => {
		const cloud = api();
		const payments = new PlanPayments(cloud, () => {});
		payments.checkout("basis");
		payments.checkout("standard");
		expect(payments.state.opening).toBe("basis");
		await vi.advanceTimersByTimeAsync(0);
		expect(cloud.startComputerCheckout).toHaveBeenCalledTimes(1);
		expect(assign).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1");
		// The member stayed (the browser asked about unsaved work): the buttons come back.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(payments.state.opening).toBeUndefined();
		// Back from Stripe with the Back button: ready at once.
		payments.portal();
		await vi.advanceTimersByTimeAsync(0);
		expect(payments.state.opening).toBe("portal");
		window.dispatchEvent(new Event("pageshow"));
		expect(payments.state.opening).toBeUndefined();
		// A disposed state holder leaves no listener or timer behind.
		const changed = vi.fn();
		const added = vi.spyOn(window, "addEventListener");
		const removed = vi.spyOn(window, "removeEventListener");
		const closed = new PlanPayments(api(), changed);
		closed.portal();
		await vi.advanceTimersByTimeAsync(0);
		const listener = added.mock.calls.find(([type]) => type === "pageshow")?.[1];
		expect(listener).toBeDefined();
		changed.mockClear();
		expect(vi.getTimerCount()).toBe(1);
		closed.dispose();
		expect(removed).toHaveBeenCalledWith("pageshow", listener);
		expect(vi.getTimerCount()).toBe(0);
		window.dispatchEvent(new Event("pageshow"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(changed).not.toHaveBeenCalled();
	});

	it("names a refusal, says calmly that there are no payments yet, and catches a call that throws at once", async () => {
		const refused = new PlanPayments(
			api({ startComputerCheckout: vi.fn(async () => Promise.reject(new ComputerBillingError("not_a_founder"))) }),
			() => {},
		);
		refused.checkout("hours_20", "00000000-0000-4000-8000-000000000001");
		await vi.advanceTimersByTimeAsync(0);
		expect(refused.state).toMatchObject({ error: "Only the company's founders can buy computer hours." });
		expect(refused.state.opening).toBeUndefined();
		const none = new PlanPayments(
			api({ openComputerBillingPortal: vi.fn(async () => Promise.reject(new ComputerBillingError("no_customer"))) }),
			() => {},
		);
		none.portal();
		await vi.advanceTimersByTimeAsync(0);
		expect(none.state).toMatchObject({ info: "No payments yet." });
		expect(none.state.error).toBeUndefined();
		const broken = new PlanPayments(
			api({
				startComputerCheckout: vi.fn(() => {
					throw new Error("Profile id is not a UUID");
				}),
			}),
			() => {},
		);
		broken.checkout("hours_20", "not-a-uuid");
		await vi.advanceTimersByTimeAsync(0);
		expect(broken.state.opening).toBeUndefined();
		expect(broken.state.error).toBe("Payments are unavailable right now. Try again in a moment.");
		expect(assign).not.toHaveBeenCalled();
	});
});
