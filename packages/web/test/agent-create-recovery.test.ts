// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { NewConversationView } from "../src/app/views/new-conversation.ts";
import type { AgentCreation } from "../src/app/workspace-actions.ts";
import { fixture, profileA, staff, stubFigureMotion, team, userA } from "./fixtures.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("uncertain agent creation", () => {
	it("keeps the submitted identity and draft across Back, then clears them after recovery", async () => {
		stubFigureMotion();
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [staff], loading: false });
		const create = vi
			.fn(async (_profile: string, draft: AgentCreation) => {
				vi.mocked(f.api.listStaff).mockResolvedValue([
					staff,
					{ ...staff, id: draft.id, displayName: draft.displayName },
				]);
				return draft.id;
			})
			.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		const view = new NewConversationView(company, { createAgent: create }, () => {});
		document.body.append(view.el);
		cleanup.push(() => {
			view.dispose();
			company.stop();
		});
		const chooseCreate = () => view.el.querySelector<HTMLElement>('[data-choice="create"]')!.click();
		const input = (label: string, value: string) => {
			const field = view.el.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
			field.value = value;
			field.dispatchEvent(new Event("input"));
		};
		chooseCreate();
		input("Agent name", "界".repeat(64));
		input("Agent title", "Finance");
		view.el.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("too long or invalid"));
		expect(create).not.toHaveBeenCalled();
		expect(view.el.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
		input("Agent name", "Ledger");
		view.el.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
		await vi.waitFor(() => expect(view.el.textContent).toContain("Creation could not be confirmed"));
		const first = create.mock.calls[0]![1];
		expect(view.el.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
		[...view.el.querySelectorAll("button")].find((button) => button.textContent === "Back")!.click();
		expect(view.hasInput).toBe(true);
		input("Search conversation recipients", "Another agent");
		chooseCreate();
		expect(view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe("Ledger");
		view.el.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
		await vi.waitFor(() => expect(view.el.querySelector(`[data-remove-recipient="${first.id}"]`)).not.toBeNull());
		expect(create).toHaveBeenCalledTimes(2);
		expect(create.mock.calls[1]![1]).toBe(first);
		chooseCreate();
		expect(view.el.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
		expect(view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe("");
	});
});
