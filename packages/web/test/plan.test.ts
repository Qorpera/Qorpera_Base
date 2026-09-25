// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPlan } from "../src/app/views/plan.ts";
import { computerCatalog, computerUsage } from "./computer-billing-fixtures.ts";
import { file } from "./fixtures.ts";

let container: HTMLElement;
beforeEach(() => {
	localStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
});
afterEach(() => {
	document.body.replaceChildren();
	localStorage.clear();
});
const text = () => container.textContent ?? "";
const findButton = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;

describe("Plan & usage", () => {
	it("does not mistake legacy storage entitlement for a paid computer plan", () => {
		renderPlan(
			container,
			{
				loaded: true,
				entitlement: {
					planKey: "freemium",
					billingMode: "fixture",
					featureSet: "fixture",
					storageAllocation: "fixture",
					source: "fixture",
				},
			},
			undefined,
		);
		expect(container.querySelector(".settings-plan strong")?.textContent).toBe("Plan unavailable");
		expect(text()).toContain("Usage unavailable");
		expect(text()).not.toMatch(/Free trial|No card on file|No invoices yet/);
		expect(findButton("View computer plans").disabled).toBe(true);
		expect(findButton("Manage payments").disabled).toBe(true);
	});
	it("renders catalog prices and standard capacity without offering disabled checkout", () => {
		const checkout = vi.fn();
		renderPlan(container, {}, undefined, { catalog: computerCatalog, usage: computerUsage, checkout });
		expect(text()).toContain("185.00");
		expect(text()).toContain("74 standard computer hours per month");
		expect(text()).toContain("4 vCPU and 8 GiB RAM");
		expect(text()).toContain("ChatGPT and Claude model accounts stay separate");
		expect(text()).not.toMatch(/free trial|priority access|% off/i);
		expect(findButton("Checkout unavailable").disabled).toBe(true);
		findButton("Checkout unavailable").click();
		expect(checkout).not.toHaveBeenCalled();
		expect(container.querySelector(".settings-hours progress")).toBeNull();
		expect(text()).toContain("Usage accounting is not active yet.");
	});
	it("enables only a current available offer and opens payments only for a mapped customer", () => {
		const offer = { ...computerCatalog.plans[0]!, activeForCheckout: true },
			checkout = vi.fn(),
			portal = vi.fn();
		renderPlan(container, {}, undefined, {
			catalog: { ...computerCatalog, plans: [offer] },
			usage: { ...computerUsage, checkoutAvailable: true, portalAvailable: true },
			checkout,
			portal,
		});
		findButton("Choose plan").click();
		findButton("Manage payments").click();
		expect(checkout).toHaveBeenCalledExactlyOnceWith(offer);
		expect(portal).toHaveBeenCalledOnce();
		renderPlan(container, {}, undefined, {
			catalog: { ...computerCatalog, plans: [offer] },
			usage: {
				...computerUsage,
				checkoutAvailable: true,
				subscriptions: [
					{
						planKey: "basis",
						planVersion: 1,
						status: "active",
						periodStart: "2026-09-01T00:00:00Z",
						periodEnd: "2026-10-01T00:00:00Z",
					},
				],
			},
			checkout,
			portal,
		});
		expect(findButton("Current plan").disabled).toBe(true);
		expect(findButton("Manage payments").disabled).toBe(true);
		expect(text()).toContain("Period ends 1 Oct 2026");
	});
	it("keeps paid allowance separate from company storage and exposes explicit refresh", () => {
		const refresh = vi.fn();
		renderPlan(
			container,
			{},
			{ companyName: "Company A", file: { ...file, storageUsedBytes: 1024 ** 3 }, loading: false, retry() {} },
			{ catalog: computerCatalog, usage: { ...computerUsage, runtimeAccountingReady: true }, refresh },
		);
		expect(container.querySelector(".settings-hours strong")?.textContent).toBe("71 standard hours available");
		expect(container.querySelector(".settings-hours progress")?.getAttribute("value")).toBe("7200000000");
		expect(container.querySelector(".settings-usage:not(.settings-hours)")?.textContent).toContain("Company A");
		findButton("Refresh plan status").click();
		expect(refresh).toHaveBeenCalledOnce();
	});
	it("retains expanded plans and keyboard focus across status refresh with unique panel ids", () => {
		const billing = { catalog: computerCatalog, usage: computerUsage };
		renderPlan(container, {}, undefined, billing);
		findButton("View computer plans").click();
		findButton("View computer plans").focus();
		renderPlan(container, {}, undefined, billing);
		expect(container.querySelector<HTMLElement>(".settings-plan-grid")!.hidden).toBe(false);
		expect(document.activeElement?.textContent).toBe("View computer plans");
		const other = document.createElement("div");
		renderPlan(other, {}, undefined, billing);
		expect(other.querySelector(".settings-plan-grid")!.id).not.toBe(
			container.querySelector(".settings-plan-grid")!.id,
		);
	});
	it("localizes prices and paid allowance in Danish", () => {
		localStorage.setItem("qorpera.web.language", "da");
		renderPlan(container, {}, undefined, { catalog: computerCatalog, usage: computerUsage });
		expect(text()).toContain("185,00");
		expect(text()).toContain("71 standardtimer til rådighed");
		expect(text()).toContain("Intet aktivt computerabonnement");
	});
});
