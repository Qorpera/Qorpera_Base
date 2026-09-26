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

function setup(redraw = true) {
	stubFigureMotion();
	const company = new CompanyController(fixture().api, profileA, userA.id);
	company.store.set({ team, staff: [{ ...staff, templateId: "co-founder" }], loading: false });
	cleanup.push(() => company.stop());
	const container = document.createElement("div");
	document.body.append(container);
	location.hash = `#/c/${profileA.profileId}/meet`;
	let reject!: (error: Error) => void;
	let resolve!: () => void;
	let current = true;
	const save = vi.fn(
		() =>
			new Promise<void>((done, fail) => {
				resolve = done;
				reject = fail;
			}),
	);
	let state: MeetState = { figure: "rocket" };
	const render = () =>
		renderMeet(
			company,
			save,
			container,
			state,
			(next) => {
				state = next;
				if (redraw) render();
			},
			() => current,
		);
	render();
	return {
		company,
		container,
		save,
		reject: (error: Error) => reject(error),
		resolve: () => resolve(),
		leave: () => {
			current = false;
		},
	};
}

describe("appearance save recovery", () => {
	it("submits once before the debounced application redraw disables the button", async () => {
		const f = setup(false);
		const button = f.container.querySelector<HTMLButtonElement>(".meet-start")!;
		button.click();
		button.click();
		expect(f.save).toHaveBeenCalledTimes(1);
		f.reject(new TypeError("Failed to fetch"));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	it("does not navigate away from a later visit to the same route on old save success", async () => {
		const f = setup();
		const refresh = vi.spyOn(f.company, "refreshStaff");
		f.container.querySelector<HTMLButtonElement>(".meet-start")!.click();
		f.leave();
		f.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(location.hash).toBe(`#/c/${profileA.profileId}/meet`);
		expect(refresh).not.toHaveBeenCalled();
	});
	it("rechecks the route visit after the roster refresh completes", async () => {
		const f = setup();
		let finish!: () => void;
		const refresh = vi.spyOn(f.company, "refreshStaff").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		f.container.querySelector<HTMLButtonElement>(".meet-start")!.click();
		f.resolve();
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		f.leave();
		finish();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(location.hash).toBe(`#/c/${profileA.profileId}/meet`);
	});
	it("recovers when the adapter refuses synchronously before returning a promise", async () => {
		const f = setup();
		f.save.mockImplementationOnce(() => {
			throw new Error("Company access changed.");
		});
		f.container.querySelector<HTMLButtonElement>(".meet-start")!.click();
		await vi.waitFor(() => expect(f.container.textContent).toContain("could not be confirmed"));
		expect(f.container.querySelector<HTMLButtonElement>(".meet-start")!.disabled).toBe(false);
	});
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

	it.each(["navigation", "disposal", "replacement", "detachment"])(
		"ignores a late save failure after %s",
		async (leave) => {
			const f = setup();
			f.container.querySelector<HTMLButtonElement>(".meet-start")!.click();
			if (leave === "navigation") location.hash = "#/";
			else if (leave === "disposal") f.company.stop();
			else if (leave === "replacement") f.leave();
			else f.container.remove();
			f.reject(new TypeError("Failed to fetch"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(f.container.textContent).not.toContain("could not be confirmed");
			expect(f.save).toHaveBeenCalledTimes(1);
		},
	);
});
