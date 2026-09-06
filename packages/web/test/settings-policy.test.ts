// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { PolicyView } from "../src/app/views/settings-policy.ts";
import { DEFAULT_COMPANY_POLICY } from "../src/cloud/company-policy.ts";
import { PolicyApi, type PolicyCommand, type PolicyDocument } from "../src/cloud/policy-api.ts";
import { deferred, fixture, id, profileA, settle, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const initial: PolicyDocument = { source: "", version: null, policy: { ...DEFAULT_COMPANY_POLICY } };
const saved: PolicyDocument = {
	source: '[policy]\nspending = "auto"\n',
	version: id(45),
	policy: { ...DEFAULT_COMPANY_POLICY, spending: "auto" },
};
const command: PolicyCommand = {
	id: id(44),
	digest: "a".repeat(64),
	state: "review_required",
	plan: { path: "authority.toml", operationKey: "original-save", expectedVersion: null },
	expiresAt: "2099-01-01T00:00:00Z",
};

function action(view: PolicyView, text: string): HTMLButtonElement | undefined {
	return [...view.el.querySelectorAll("button")].find((button) => button.textContent === text);
}

async function setup(state: PolicyCommand["state"] = "review_required") {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team });
	const read = vi.spyOn(PolicyApi.prototype, "read").mockResolvedValue(initial);
	const save = vi.spyOn(PolicyApi.prototype, "save").mockResolvedValue({ ...command, state });
	const review = vi.spyOn(PolicyApi.prototype, "review").mockResolvedValue({ ...command, state: "applied" });
	const status = vi.spyOn(PolicyApi.prototype, "status");
	const view = new PolicyView(f.cloud, company, company.signal);
	cleanup.push(
		() => view.dispose(),
		() => company.stop(),
	);
	document.body.append(view.el);
	await settle();
	const select = view.el.querySelector<HTMLSelectElement>('select[aria-label="Spending"]')!;
	select.value = "auto";
	select.dispatchEvent(new Event("change"));
	action(view, "Save policy")!.click();
	await settle();
	return { ...f, company, view, read, save, review, status };
}

describe("policy command recovery", () => {
	it("resumes the exact approved command after an interrupted apply and status refresh", async () => {
		const f = await setup();
		f.review.mockRejectedValueOnce(new Error("Apply interrupted after approval"));
		action(f.view, "Apply policy")!.click();
		await settle();
		expect(f.view.el.textContent).toContain("Apply interrupted after approval");
		const approved: PolicyCommand = { ...command, state: "approved" };
		f.status.mockResolvedValue(approved);
		action(f.view, "Check status")!.click();
		await settle();
		expect(action(f.view, "Retry apply")?.disabled).toBe(false);
		expect(f.view.el.textContent).not.toContain("The cloud is processing");
		f.read.mockResolvedValue(saved);
		action(f.view, "Retry apply")!.click();
		await settle();
		expect(f.review).toHaveBeenNthCalledWith(2, approved, "approve");
		expect(f.save).toHaveBeenCalledTimes(1);
		expect(f.view.el.textContent).toContain("Policy saved.");
		const select = f.view.el.querySelector<HTMLSelectElement>('select[aria-label="Spending"]')!;
		expect(select.disabled).toBe(false);
		expect(select.value).toBe("auto");
		expect(action(f.view, "Retry apply")).toBeUndefined();
	});
	it.each(["ready", "approved"] as const)(
		"resumes a %s save receipt without creating a second edit",
		async (state) => {
			const f = await setup(state);
			const applying = deferred<PolicyCommand>();
			f.review.mockReturnValue(applying.promise);
			f.read.mockResolvedValue(saved);
			action(f.view, "Retry apply")!.click();
			expect(action(f.view, "Retry apply")?.disabled).toBe(true);
			expect(f.view.el.querySelector("select")!.disabled).toBe(true);
			applying.resolve({ ...command, state: "applied" });
			await settle();
			expect(f.review).toHaveBeenCalledExactlyOnceWith({ ...command, state }, "approve");
			expect(f.save).toHaveBeenCalledTimes(1);
			expect(f.view.el.textContent).toContain("Policy saved.");
		},
	);
	it("retries a failed readback without applying an already-applied command again", async () => {
		const f = await setup();
		f.read.mockRejectedValueOnce(new Error("Readback unavailable")).mockResolvedValue(saved);
		action(f.view, "Apply policy")!.click();
		await settle();
		expect(f.view.el.textContent).toContain("Readback unavailable");
		expect(action(f.view, "Retry apply")).toBeUndefined();
		f.status.mockResolvedValue({ ...command, state: "applied" });
		action(f.view, "Check status")!.click();
		await settle();
		expect(f.view.el.textContent).toContain("Policy saved.");
		expect(f.review).toHaveBeenCalledTimes(1);
	});
	it("removes the retry action when authorization is lost", async () => {
		const f = await setup("approved");
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(action(f.view, "Retry apply")).toBeUndefined();
		expect(f.view.el.querySelector("select")!.disabled).toBe(true);
		expect(f.review).not.toHaveBeenCalled();
	});
});
