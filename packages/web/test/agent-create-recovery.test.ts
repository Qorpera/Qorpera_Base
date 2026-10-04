// @vitest-environment jsdom
import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { NewConversationView } from "../src/app/views/new-conversation.ts";
import type { AgentCreation } from "../src/app/workspace-actions.ts";
import { createWebCompanyAgents } from "../src/cloud/company-agents.ts";
import { WebCompanyFolderRejectedError } from "../src/cloud/company-folder-writes.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { fixture, profileA, staff, stubFigureMotion, team, userA } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The view with the real agent adapter over a company folder in memory; the roster follows the folder's agents. */
function setup() {
	stubFigureMotion();
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [staff], loading: false });
	const fake = folderFake();
	const stop = new AbortController();
	const files = { signal: stop.signal, current: () => {}, folder: () => fake.folder as never };
	const create = vi.fn((_profile: string, draft: AgentCreation, signal: AbortSignal) =>
		createWebCompanyAgents(files).create(draft, signal),
	);
	vi.mocked(f.api.listStaff).mockImplementation(async () => [
		staff,
		...fake.stateFolders().agents.map(({ staffAgentId, file }): HostedStaffAgent => {
			const parsed = parseCompanyStateFile(file, fake.text(file) ?? "");
			return {
				...staff,
				id: staffAgentId,
				displayName: parsed?.ok && parsed.file.kind === "agent" ? parsed.file.name : "",
			};
		}),
	]);
	const view = new NewConversationView(company, { createAgent: create }, () => {});
	document.body.append(view.el);
	cleanup.push(() => {
		view.dispose();
		company.stop();
		stop.abort();
	});
	const input = (label: string, value: string) => {
		const field = view.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
		field.value = value;
		field.dispatchEvent(new Event("input"));
	};
	const submit = () => view.el.querySelector<HTMLButtonElement>('[type="submit"]')!.click();
	const chooseCreate = () => view.el.querySelector<HTMLElement>('[data-choice="create"]')!.click();
	return { ...f, company, fake, create, view, input, submit, chooseCreate };
}

describe("uncertain agent creation", () => {
	it("unlocks the preserved draft only after the folder refuses the creation", async () => {
		const f = setup();
		f.fake.answer("refused", "hook", ["an agent named Ledger already works here"]);
		f.chooseCreate();
		f.input("Agent name", "Ledger");
		f.input("Agent title", "Finance");
		f.submit();
		await vi.waitFor(() => expect(f.view.el.textContent).toContain("Agent creation was rejected"));
		await expect(f.create.mock.results[0]!.value).rejects.toBeInstanceOf(WebCompanyFolderRejectedError);
		expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
		const name = f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!;
		expect(name.value).toBe("Ledger");
		expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent title"]')!.value).toBe("Finance");
		expect(f.view.el.querySelector<HTMLButtonElement>('[type="submit"]')!.textContent).toBe("Create agent");
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.fake.has("agents/ledger")).toBe(false);
		// The corrected draft is a new creation, with a new identity.
		f.input("Agent name", "Bookkeeper");
		f.submit();
		await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(2));
		expect(f.create.mock.calls[1]![1].displayName).toBe("Bookkeeper");
		expect(f.create.mock.calls[1]![1].id).not.toBe(f.create.mock.calls[0]![1].id);
		const created = f.create.mock.calls[1]![1].id;
		await vi.waitFor(() => expect(f.view.el.querySelector(`[data-remove-recipient="${created}"]`)).not.toBeNull());
		expect(f.fake.stateFolders().agents).toEqual([{ staffAgentId: created, file: "agents/bookkeeper/agent.md" }]);
	});

	it("keeps the submitted identity and draft across Back, then clears them after recovery", async () => {
		const f = setup();
		f.fake.loseAnswer();
		f.chooseCreate();
		f.input("Agent name", "Ledger");
		f.input("Agent title", "Finance");
		// Responsibilities agent.md cannot hold are refused before anything is retained.
		f.input("Agent responsibilities", "Keep\u0001the books");
		f.submit();
		await vi.waitFor(() => expect(f.view.el.textContent).toContain("too long or invalid"));
		expect(f.create).not.toHaveBeenCalled();
		expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
		f.input("Agent responsibilities", "Keep the books.");
		f.submit();
		// The folder was created, but its answer was lost.
		await vi.waitFor(() => expect(f.view.el.textContent).toContain("Creation could not be confirmed"));
		expect(f.fake.has("agents/ledger")).toBe(true);
		const first = f.create.mock.calls[0]![1];
		expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(true);
		[...f.view.el.querySelectorAll("button")].find((button) => button.textContent === "Back")!.click();
		expect(f.view.hasInput).toBe(true);
		f.input("Search conversation recipients", "Another agent");
		f.chooseCreate();
		expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe("Ledger");
		f.submit();
		await vi.waitFor(() => expect(f.view.el.querySelector(`[data-remove-recipient="${first.id}"]`)).not.toBeNull());
		// The retry found the agent the lost answer created: one folder, one change set.
		expect(f.create).toHaveBeenCalledTimes(2);
		expect(f.create.mock.calls[1]![1]).toBe(first);
		expect(f.fake.commits).toHaveLength(1);
		expect(f.fake.children("agents")).toEqual(["agents/groups", "agents/ledger"]);
		f.chooseCreate();
		expect(f.view.el.querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
		expect(f.view.el.querySelector<HTMLInputElement>('[aria-label="Agent name"]')!.value).toBe("");
	});

	it("adds a created agent once the roster shows it, without creating it again", async () => {
		const f = setup();
		// The roster has not caught up with the new folder yet.
		vi.mocked(f.api.listStaff).mockResolvedValueOnce([staff]);
		f.chooseCreate();
		f.input("Agent name", "Ledger");
		f.input("Agent title", "Finance");
		f.submit();
		await vi.waitFor(() =>
			expect(f.view.el.textContent).toContain(
				"The agent was created. Retry adding it once the agent list is available.",
			),
		);
		expect(f.view.el.querySelector<HTMLButtonElement>('[type="submit"]')!.textContent).toBe("Add created agent");
		const created = f.create.mock.calls[0]![1].id;
		f.submit();
		await vi.waitFor(() => expect(f.view.el.querySelector(`[data-remove-recipient="${created}"]`)).not.toBeNull());
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.fake.commits).toHaveLength(1);
	});
});
