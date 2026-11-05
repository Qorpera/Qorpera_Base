// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoodWillView, kroner, MyGoodWillView, takeGoodWillReturn } from "../src/app/views/settings-good-will.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import {
	type CompanyGoodWill,
	GoodWillCardError,
	parseCompanyGoodWill,
	parseMyGoodWill,
	startGoodWillCard,
} from "../src/cloud/good-will.ts";

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const month = (overrides: Record<string, unknown> = {}) => ({
	month: "2026-11",
	status: "charged",
	salesOre: 5_125_000,
	momsOre: 25_000,
	netOre: 5_100_000,
	feeOre: 510_000,
	steps: [],
	carriedInOre: 0,
	dueOre: 510_000,
	carriedOutOre: 0,
	unsorted: 0,
	finalAt: "2026-12-05T08:00:00Z",
	chargedAt: "2026-12-05T09:00:00Z",
	invoiceUrl: "https://invoice.stripe.com/i/1",
	...overrides,
});
const company = (overrides: Record<string, unknown> = {}) => ({
	schema: "qorpera.company-good-will/v1",
	profileId: P,
	companyName: "The shop",
	canAddCard: true,
	card: null,
	months: [month()],
	steps: [
		{ fromOre: 0, toOre: 10_000_000, rateBp: 1000, baseOre: 0, feeOre: 0 },
		{ fromOre: 100_000_000, toOre: null, rateBp: 20, baseOre: 0, feeOre: 0 },
	],
	minChargeOre: 10_000,
	...overrides,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.unstubAllGlobals();
	history.replaceState(null, "", "#/");
});

describe("good will from the cloud", () => {
	it("reads the Company tab's good will and the account's, and links only Stripe's invoice pages", () => {
		const read = parseCompanyGoodWill(company(), P.toUpperCase());
		expect(read.months[0]).toEqual({
			month: "2026-11",
			status: "charged",
			netOre: 5_100_000,
			feeOre: 510_000,
			dueOre: 510_000,
			chargedAt: "2026-12-05T09:00:00Z",
			invoiceUrl: "https://invoice.stripe.com/i/1",
		});
		expect(read.steps).toEqual([
			{ fromOre: 0, toOre: 10_000_000, rateBp: 1000 },
			{ fromOre: 100_000_000, toOre: null, rateBp: 20 },
		]);
		expect(
			parseCompanyGoodWill(company({ months: [month({ invoiceUrl: "https://evil.example/i" })] }), P).months[0]
				?.invoiceUrl,
		).toBeNull();
		expect(() => parseCompanyGoodWill(company({ profileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }), P)).toThrow();
		expect(() => parseCompanyGoodWill(company({ months: [month({ status: "late" })] }), P)).toThrow("status");
		expect(() => parseCompanyGoodWill(company({ months: [month({ dueOre: -1 })] }), P)).toThrow("due");
		expect(() => parseCompanyGoodWill(company({ schema: "qorpera.company-good-will/v2" }), P)).toThrow();
		const mine = parseMyGoodWill({
			schema: "qorpera.my-good-will/v1",
			year: 2026,
			paidByMeOre: 510_000,
			companies: [
				{
					profileId: P,
					name: "The shop",
					netOre: 5_100_000,
					feeOre: 510_000,
					rateBp: 1000,
					payer: "me",
					brand: "visa",
					last4: "4242",
				},
			],
		});
		expect(mine.companies[0]?.payer).toBe("me");
		expect(() =>
			parseMyGoodWill({ schema: "qorpera.my-good-will/v1", year: 2026, paidByMeOre: 0, companies: [{}] }),
		).toThrow();
	});

	it("opens only Stripe's checkout page for the card, and passes on a refusal", async () => {
		const cloud = {
			config: { projectUrl: "https://project.supabase.co", publishableKey: "sb_publishable_x" },
			supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "member-token" } } }) } },
		} as unknown as Cloud;
		const fetch = vi.fn(async () => Response.json({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
		vi.stubGlobal("fetch", fetch);
		await expect(startGoodWillCard(cloud, P)).resolves.toBe("https://checkout.stripe.com/c/pay/cs_1");
		expect(fetch).toHaveBeenCalledWith(
			"https://project.supabase.co/functions/v1/computer-billing/good-will-card",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ profileId: P }) }),
		);
		fetch.mockResolvedValueOnce(Response.json({ url: "https://evil.example/pay" }));
		await expect(startGoodWillCard(cloud, P)).rejects.toMatchObject({ refusal: "unavailable" });
		fetch.mockResolvedValueOnce(Response.json({ refused: "not_a_founder" }, { status: 409 }));
		await expect(startGoodWillCard(cloud, P)).rejects.toMatchObject({ refusal: "not_a_founder" });
	});

	it("takes Stripe's return from the address once", () => {
		history.replaceState(null, "", "#/account?good-will=card-saved");
		expect(takeGoodWillReturn()).toBe("card-saved");
		expect(location.hash).toBe("#/account");
		expect(takeGoodWillReturn()).toBeUndefined();
	});
});

describe("the good will views", () => {
	it("draws kroner from øre", () => {
		expect(kroner(510_000)).toBe("5,100 kr");
		expect(kroner(4_050)).toBe("40.5 kr");
	});

	it("shows each month's line, opens Stripe's card page for a founder and says why it could not", async () => {
		const open = vi.fn();
		const read = vi.fn(
			async (): Promise<CompanyGoodWill> =>
				parseCompanyGoodWill(
					company({
						months: [
							month({ month: "2027-01", status: "carried", dueOre: 4_000, chargedAt: null, invoiceUrl: null }),
							month({ month: "2026-12", status: "closed", chargedAt: null, invoiceUrl: null }),
							month({ month: "2026-10", status: "zero", dueOre: 0, chargedAt: null, invoiceUrl: null }),
							month(),
						],
					}),
					P,
				),
		);
		const cardPage = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("https://checkout.stripe.com/c/pay/cs_1")
			.mockRejectedValueOnce(new GoodWillCardError("not_a_founder"));
		const view = new GoodWillView({ read, cardPage, open }, new AbortController().signal, () => "The shop");
		expect(view.el.textContent).toContain("Loading Good will…");
		await flush();
		const lines = [...view.el.querySelectorAll(".good-will-months li")].map((line) => line.textContent);
		expect(lines).toEqual([
			"January 202740 kr moves to next month (under 100 kr)",
			"December 20265,100 kr, waiting for a card",
			expect.stringMatching(/^November 20265,100 kr charged .*Open$/),
		]);
		expect(view.el.querySelector(".good-will-card")?.textContent).toContain("No card needed until there are sales");
		expect(view.el.querySelector(".settings-rule-note")?.textContent).toContain(
			"10 % of each month's first 100,000 kr",
		);
		const add = () => [...view.el.querySelectorAll("button")].find((button) => button.textContent === "Add card");
		add()!.click();
		await flush();
		expect(open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_1");
		view.dispose();
		const again = new GoodWillView({ read, cardPage, open }, new AbortController().signal, () => "The shop");
		await flush();
		[...again.el.querySelectorAll("button")].find((button) => button.textContent === "Add card")!.click();
		await flush();
		expect(again.el.querySelector(".notice-danger")?.textContent).toBe("Only the company's founders add its card.");
	});

	it("stays hidden on a cloud without good will, and offers Retry on another failure", async () => {
		const missing = new CloudRpcError("qorpera_company_good_will", { message: "missing", code: "PGRST202" }, 404);
		const hidden = new GoodWillView(
			{ read: async () => Promise.reject(missing), cardPage: vi.fn(), open: vi.fn() },
			new AbortController().signal,
			() => "The shop",
		);
		await flush();
		expect(hidden.el.hidden).toBe(true);
		const read = vi.fn<() => Promise<CompanyGoodWill>>().mockRejectedValueOnce(new Error("offline"));
		read.mockResolvedValue(parseCompanyGoodWill(company(), P));
		const failed = new GoodWillView(
			{ read, cardPage: vi.fn(), open: vi.fn() },
			new AbortController().signal,
			() => "Shop",
		);
		await flush();
		expect(failed.el.hidden).toBe(false);
		[...failed.el.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click();
		await flush();
		expect(read).toHaveBeenCalledTimes(2);
		expect(failed.el.querySelector(".good-will-months")).not.toBeNull();
	});

	it("lists the member's companies and hides itself with none", async () => {
		const none = new MyGoodWillView(
			async () => ({ year: 2026, paidByMeOre: 0, companies: [] }),
			new AbortController().signal,
		);
		await flush();
		expect(none.el.hidden).toBe(true);
		const view = new MyGoodWillView(
			async () => ({
				year: 2026,
				paidByMeOre: 0,
				companies: [
					{
						profileId: P,
						name: "Learn anything",
						netOre: 3_180_000,
						feeOre: 318_000,
						rateBp: 1000,
						payer: "other",
						brand: null,
						last4: null,
					},
				],
			}),
			new AbortController().signal,
		);
		await flush();
		const row = view.el.querySelector(".good-will-companies li")!;
		expect(row.textContent).toBe("Learn anything31,800 kr from customersPaid by another founder3,180 kr");
	});
});
