// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { type MeetState, renderMeet } from "../src/app/views/meet.ts";
import { fixture, profileA, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function setup() {
	stubFigureMotion();
	const company = new CompanyController(fixture().api, profileA, userA.id);
	company.store.set({ team, staff: [{ ...staff, templateId: "co-founder" }], loading: false });
	cleanup.push(() => company.stop());
	const container = document.createElement("div");
	document.body.append(container);
	location.hash = `#/c/${profileA.profileId}/meet`;
	let reject!: (error: Error) => void;
	const save = vi.fn(
		() =>
			new Promise<void>((_resolve, fail) => {
				reject = fail;
			}),
	);
	let state: MeetState = { figure: "rocket" };
	const render = () =>
		renderMeet(company, save, container, state, (next) => {
			state = next;
			render();
		});
	render();
	return { company, container, save, reject: (error: Error) => reject(error) };
}

describe("appearance save recovery", () => {
	it("keeps the choice and offers a read-only escape after an uncertain response", async () => {
		const f = setup();
		f.container.querySelector<HTMLButtonElement>(".meet-start")!.click();
		f.reject(new TypeError("Failed to fetch: private gateway details"));
		await vi.waitFor(() => expect(f.container.textContent).toContain("could not be confirmed"));
		expect(f.save).toHaveBeenCalledTimes(1);
		expect(f.container.textContent).not.toContain("private gateway");
		expect(f.container.querySelector('[aria-label="rocket"]')?.getAttribute("aria-checked")).toBe("true");
		const link = f.container.querySelector("a")!;
		expect(link.textContent).toBe("Open the company");
		expect(link.getAttribute("href")).toBe(`#/c/${profileA.profileId}`);
		expect(location.hash).toBe(`#/c/${profileA.profileId}/meet`);
	});

	it.each(["navigation", "disposal"])("ignores a late save failure after %s", async (leave) => {
		const f = setup();
		f.container.querySelector<HTMLButtonElement>(".meet-start")!.click();
		if (leave === "navigation") location.hash = "#/";
		else f.company.stop();
		f.reject(new TypeError("Failed to fetch"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(f.container.textContent).not.toContain("could not be confirmed");
		expect(f.save).toHaveBeenCalledTimes(1);
	});
});
