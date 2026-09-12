// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { CompanyExecutionView } from "../src/app/views/company-execution.ts";
import { SettingsView } from "../src/app/views/settings.ts";
import type { CompanyExecutionState, WebCompanyExecution } from "../src/cloud/company-execution.ts";
import { deferred, fixture, profileA, profileB, settle, team, timestamp, userA } from "./fixtures.ts";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function state(paused = false, version = 3): CompanyExecutionState {
	return {
		profileId: profileA.profileId,
		paused,
		version,
		configured: true,
		period: "month",
		periodStart: timestamp,
		spendMicrousdPerPeriod: 250_000_000,
		tokensPerPeriod: 100_000_000,
		wakesPerHour: 240,
		spendMicrousdUsed: 125_000,
		tokensUsed: 400,
		wakesLastHour: 5,
		trips: 0,
	};
}
function setup(manage = true) {
	const read = vi.fn<WebCompanyExecution["read"]>().mockResolvedValue(state());
	const setPause = vi
		.fn<WebCompanyExecution["setPause"]>()
		.mockResolvedValue({ profileId: profileA.profileId, paused: true, changed: true });
	const setCeiling = vi.fn<WebCompanyExecution["setCeiling"]>().mockResolvedValue(state(false, 4));
	const lifetime = new AbortController();
	const authority = { manage };
	const view = new CompanyExecutionView({ read, setPause, setCeiling }, lifetime.signal, () => authority.manage);
	document.body.append(view.el);
	dispose = () => view.dispose();
	return { read, setPause, setCeiling, lifetime, authority, view };
}
function click(label: string): void {
	const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
	if (!target) throw new Error(`Missing button: ${label}`);
	target.click();
}
function input(label: string, value: string): void {
	const target = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
	target.value = value;
	target.dispatchEvent(new Event("input"));
}

describe("company execution controls", () => {
	it("reads authoritative status and labels reserved usage without claiming actual metering", async () => {
		const f = setup();
		await settle();
		expect(f.read).toHaveBeenCalledTimes(1);
		expect(f.view.el.textContent).toContain("Company execution is enabled");
		expect(f.view.el.textContent).toContain(
			"$0.125 accounted spend (including reservations), 400 reserved token budget",
		);
		expect(f.setPause).not.toHaveBeenCalled();
		expect(f.setCeiling).not.toHaveBeenCalled();
	});

	it("submits explicit company pause and resume, then refreshes the result", async () => {
		const f = setup();
		await settle();
		f.read.mockResolvedValue(state(true));
		input("Company pause or resume reason", "Review company work");
		click("Pause company execution");
		click("Pause company execution");
		await settle();
		expect(f.setPause).toHaveBeenCalledExactlyOnceWith(true, "Review company work", expect.any(AbortSignal));
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.view.el.textContent).toContain("Company execution is paused");
		f.read.mockResolvedValue(state(false));
		click("Resume company execution");
		await settle();
		expect(f.setPause).toHaveBeenLastCalledWith(false, "Review company work", expect.any(AbortSignal));
		expect(f.setCeiling).not.toHaveBeenCalled();
	});

	it("preserves decimal USD exactly and submits the observed ceiling version", async () => {
		const f = setup();
		await settle();
		input("Monthly spend ceiling (USD)", "12.345678");
		input("Monthly token ceiling", "9000");
		input("Autonomous wakes per hour", "15");
		click("Save execution ceilings");
		await settle();
		expect(f.setCeiling).toHaveBeenCalledExactlyOnceWith(
			{ expectedVersion: 3, spendMicrousdPerPeriod: 12_345_678, tokensPerPeriod: 9000, wakesPerHour: 15 },
			expect.any(AbortSignal),
		);
	});

	it("accepts the SQL Unicode character limit without truncating emoji or dispatching oversized reasons", async () => {
		const f = setup();
		await settle();
		const reason = "😀".repeat(1024);
		expect(document.querySelector<HTMLInputElement>('[aria-label="Company pause or resume reason"]')!.maxLength).toBe(
			2048,
		);
		input("Company pause or resume reason", reason + "x");
		click("Pause company execution");
		await settle();
		expect(f.setPause).not.toHaveBeenCalled();
		input("Company pause or resume reason", reason);
		click("Pause company execution");
		await settle();
		expect(f.setPause).toHaveBeenCalledExactlyOnceWith(true, reason, expect.any(AbortSignal));
	});

	it("blocks uncertain mutation replay until an explicit refresh observes a new version", async () => {
		const f = setup();
		await settle();
		f.setCeiling.mockRejectedValueOnce(new Error("Version conflict or response lost"));
		click("Save execution ceilings");
		await settle();
		expect(f.view.el.textContent).toContain("The change could not be confirmed");
		click("Save execution ceilings");
		click("Pause company execution");
		await settle();
		expect(f.setCeiling).toHaveBeenCalledTimes(1);
		expect(f.setPause).not.toHaveBeenCalled();
		expect(f.read).toHaveBeenCalledTimes(1);
		f.read.mockResolvedValue(state(false, 9));
		click("Refresh company execution");
		await settle();
		click("Save execution ceilings");
		await settle();
		expect(f.setCeiling).toHaveBeenLastCalledWith(
			expect.objectContaining({ expectedVersion: 9 }),
			expect.any(AbortSignal),
		);
	});

	it("does not infer a confirmed pause after a lost response", async () => {
		const f = setup();
		await settle();
		f.setPause.mockRejectedValueOnce(new Error("Lost"));
		click("Pause company execution");
		await settle();
		expect(f.view.el.textContent).toContain("Company execution status is unavailable");
		expect(f.view.el.textContent).not.toContain("Company execution is paused.");
		f.read.mockResolvedValue(state(true));
		click("Refresh company execution");
		await settle();
		expect(f.view.el.textContent).toContain("Company execution is paused.");
		expect(f.setPause).toHaveBeenCalledTimes(1);
	});

	it("keeps read-only members from changing execution and reacts to authority loss", async () => {
		const f = setup(false);
		await settle();
		click("Pause company execution");
		click("Save execution ceilings");
		expect(f.setPause).not.toHaveBeenCalled();
		expect(f.setCeiling).not.toHaveBeenCalled();
		f.authority.manage = true;
		f.view.update();
		const pending = deferred<{ profileId: string; paused: boolean; changed: boolean }>();
		f.setPause.mockReturnValueOnce(pending.promise);
		click("Pause company execution");
		f.authority.manage = false;
		f.view.update();
		expect(f.setPause.mock.calls[0]?.[2]?.aborted).toBe(true);
		pending.resolve({ profileId: profileA.profileId, paused: true, changed: true });
		await settle();
		expect(f.read).toHaveBeenCalledTimes(1);
		expect(f.view.el.textContent).toContain("Your permissions changed");
	});

	it("rejects invalid limits without dispatch and retains drafts on unrelated updates", async () => {
		const f = setup();
		await settle();
		input("Monthly spend ceiling (USD)", "2.0000001");
		click("Save execution ceilings");
		expect(f.setCeiling).not.toHaveBeenCalled();
		input("Monthly spend ceiling (USD)", "1");
		input("Autonomous wakes per hour", "1000001");
		click("Save execution ceilings");
		expect(f.setCeiling).not.toHaveBeenCalled();
		f.view.update();
		expect(document.querySelector<HTMLInputElement>('[aria-label="Autonomous wakes per hour"]')!.value).toBe(
			"1000001",
		);
	});

	it("aborts company/account work on disposal without a pause or resume mutation", async () => {
		const f = setup();
		await settle();
		const pending = deferred<CompanyExecutionState>();
		f.read.mockReturnValueOnce(pending.promise);
		click("Refresh company execution");
		f.lifetime.abort();
		expect(f.read.mock.calls[1]?.[0]?.aborted).toBe(true);
		pending.resolve(state(true));
		await settle();
		expect(f.view.el.textContent).toBe("");
		expect(f.setPause).not.toHaveBeenCalled();
		expect(f.setCeiling).not.toHaveBeenCalled();
	});

	it("mounts under Settings Company and clears an in-flight result when the selected company changes", async () => {
		const f = fixture();
		const auth = new AuthController(f.cloud);
		await auth.start();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, loading: false });
		const pending = deferred<Response>();
		const network = vi.fn(async () => pending.promise);
		vi.stubGlobal("fetch", network);
		const settings = new SettingsView(
			f.api,
			auth,
			[profileA, profileB],
			company,
			() => {},
			() => {},
		);
		document.body.append(settings.el);
		dispose = () => {
			settings.dispose();
			company.stop();
			auth.dispose();
		};
		document.querySelector<HTMLButtonElement>("#settings-tab-company")!.click();
		await settle();
		expect(settings.el.querySelector(".company-execution")).not.toBeNull();
		const picker = settings.el.querySelector<HTMLSelectElement>(".settings-company-picker")!;
		picker.value = "";
		picker.dispatchEvent(new Event("change"));
		pending.resolve(Response.json({}));
		await settle();
		expect(settings.el.querySelector(".company-execution")).toBeNull();
		expect(settings.el.textContent).toContain("Choose a company");
		expect(network).toHaveBeenCalledTimes(1);
	});
});
