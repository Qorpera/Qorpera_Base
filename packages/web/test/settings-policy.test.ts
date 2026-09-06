// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyView } from "../src/app/views/settings-policy.ts";

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe("policy shell", () => {
	it("allows a local preview without presenting or saving it as active company policy", () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const view = new PolicyView();
		document.body.append(view.el);
		const spending = view.el.querySelector<HTMLSelectElement>('select[aria-label="Spending"]')!;
		spending.value = "auto";
		spending.dispatchEvent(new Event("change"));
		expect(spending.value).toBe("auto");
		expect(view.el.textContent).toContain("not your company's active policy and are not saved");
		const save = view.el.querySelector("button")!;
		expect(save.disabled).toBe(true);
		save.click();
		expect(fetch).not.toHaveBeenCalled();
		view.dispose();
		const reopened = new PolicyView();
		expect(reopened.el.querySelector<HTMLSelectElement>('select[aria-label="Spending"]')!.value).toBe("ask");
		reopened.dispose();
	});
});
