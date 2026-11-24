// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import type { CompanyBrandOptions } from "../src/app/views/settings-brand.ts";
import { fixture, profileA, session, settle } from "./fixtures.ts";
import "./register-lazy.ts";

const brands = vi.hoisted(() => [] as CompanyBrandOptions[]);

vi.mock("../src/app/views/settings-brand.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/app/views/settings-brand.ts")>();
	class RecordedBrandView extends original.CompanyBrandView {
		constructor(options: CompanyBrandOptions) {
			super(options);
			brands.push(options);
		}
	}
	return { ...original, CompanyBrandView: RecordedBrandView };
});

let dispose: (() => void) | undefined;
beforeEach(() => {
	brands.length = 0;
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function draw() {
	await settle();
	await vi.advanceTimersByTimeAsync(60);
}

function click(root: Element, selector: string) {
	root.querySelector<HTMLElement>(selector)!.click();
}

it("a saved rename shows in Brand and the sidebar at once", async () => {
	const f = fixture();
	const root = document.createElement("div");
	document.body.append(root);
	dispose = mountApplication(root, f.cloud, f.api);
	await draw();
	click(root, ".account-trigger");
	click(root, '[data-account-action="settings"]');
	click(root, "#settings-tab-company");
	await draw();
	expect(brands).toHaveLength(1);
	const brand = brands[0]!;
	expect(brand.name()).toBe(profileA.profileName);
	brand.renamed("Nordlys Studio");
	await draw();
	expect(brand.name()).toBe("Nordlys Studio");
	expect(root.querySelector(".settings-brand-name strong")?.textContent).toBe("Nordlys Studio");
	expect(root.querySelector(".rail-company-name")?.textContent).toBe("Nordlys Studio");
});
