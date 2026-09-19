// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { AgentDetails } from "../src/app/views/agent-details.ts";
import type { AgentDraft, WorkspaceActions } from "../src/app/workspace-actions.ts";
import type { WebNativeSubscription } from "../src/cloud/native-subscription.ts";
import type { HostedCompanyOrganization } from "../src/cloud/organization.ts";
import type { WebRoutines } from "../src/cloud/routines.ts";
import type { HostedStaffAgent } from "../src/cloud/types.ts";
import { FIGURE_IDS, figureFor } from "../src/ui/avatar.ts";
import { deferred, fixture, id, profileA, settle, staff, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("innerWidth", 1280);
	// A desktop window: anchored details stay beside their agent.
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	// jsdom has no native dialog methods.
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal;
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
});
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function open(actions: WorkspaceActions = {}, agent: HostedStaffAgent = staff, scope?: AbortSignal) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [agent], loading: false });
	const anchor = document.createElement("button");
	document.body.append(anchor);
	const onClose = vi.fn();
	const details = new AgentDetails(company, agent, actions, onClose, anchor, scope);
	cleanup.push(() => {
		details.dispose();
		company.stop();
	});
	return { ...f, company, details, onClose, dialog: details.dialog.el };
}
const field = (label: string) =>
	document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const named = (label: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.getAttribute("aria-label") === label || item.textContent === label,
	)!;
function type(label: string, value: string) {
	const control = field(label);
	control.focus();
	control.value = value;
	control.dispatchEvent(new Event("input", { bubbles: true }));
	return control;
}
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
const status = () => document.querySelector(".agent-details-status")?.textContent;
const saving = () => vi.fn(async (_agent: HostedStaffAgent, _draft: unknown, _signal: AbortSignal) => {});

describe("agent saves across panel lifetimes", () => {
	it("keeps a failed close-save draft and offers an explicit retry when reopened", async () => {
		const pending = deferred<void>();
		const updateAgent = saving().mockReturnValueOnce(pending.promise);
		const f = open({ updateAgent });
		type("Agent name", "Unsaved name");
		f.details.dialog.close();
		pending.reject(new Error("offline"));
		await settle();
		const reopened = new AgentDetails(f.company, staff, { updateAgent }, () => {});
		cleanup.push(() => reopened.dispose());
		expect(field("Agent name").value).toBe("Unsaved name");
		expect(status()).toContain("could not be saved");
		await settle();
		expect(updateAgent).toHaveBeenCalledTimes(1);
		named("Try again").click();
		await settle();
		expect(updateAgent).toHaveBeenCalledTimes(2);
		expect(updateAgent.mock.calls[1]![1]).toMatchObject({ displayName: "Unsaved name" });
		expect(status()).toBe("Saved");
	});
	it("serializes reopened edits and retains the first accepted change in the next full draft", async () => {
		const first = deferred<void>();
		let remote = { ...staff };
		let calls = 0;
		const updateAgent = vi.fn(async (_agent: HostedStaffAgent, draft: AgentDraft) => {
			// The server applies the first write before its response reaches the browser.
			remote = { ...remote, displayName: draft.displayName, role: draft.role, charter: draft.charter };
			if (++calls === 1) await first.promise;
		});
		const f = open({ updateAgent });
		vi.mocked(f.api.listStaff).mockImplementation(async () => [remote]);
		type("Agent name", "Kept name");
		f.details.dialog.close();
		expect(remote.displayName).toBe("Kept name");
		const reopened = new AgentDetails(f.company, staff, { updateAgent }, () => {});
		cleanup.push(() => reopened.dispose());
		expect(field("Agent name").value).toBe("Kept name");
		expect(status()).toBe("Saving…");
		press(type("Agent title", "New role"), "Enter");
		type("Agent description", "New description").blur();
		expect(updateAgent).toHaveBeenCalledTimes(1);
		first.resolve();
		await settle();
		expect(updateAgent).toHaveBeenCalledTimes(2);
		expect(remote).toMatchObject({ displayName: "Kept name", role: "New role", charter: "New description" });
		expect(field("Agent name").value).toBe("Kept name");
		expect(status()).toBe("Saved");
	});
	it("coalesces reopened edits while the first save refreshes the roster", async () => {
		const roster = deferred<HostedStaffAgent[]>();
		const updateAgent = saving();
		const f = open({ updateAgent });
		vi.mocked(f.api.listStaff).mockReturnValueOnce(roster.promise);
		type("Agent name", "Kept name");
		f.details.dialog.close();
		await settle();
		const reopened = new AgentDetails(f.company, staff, { updateAgent }, () => {});
		cleanup.push(() => reopened.dispose());
		press(type("Agent title", "Lead"), "Enter");
		expect(updateAgent).toHaveBeenCalledTimes(1);
		roster.resolve([{ ...staff, displayName: "Kept name" }]);
		await settle();
		expect(updateAgent).toHaveBeenCalledTimes(2);
		expect(updateAgent.mock.calls[1]![1]).toMatchObject({ displayName: "Kept name", role: "Lead" });
	});
	it.each(["navigation", "company", "authority"] as const)(
		"cancels closed-panel writes and queued edits on %s loss",
		async (loss) => {
			const pending = deferred<void>();
			const updateAgent = saving().mockReturnValueOnce(pending.promise);
			const scope = new AbortController();
			const f = open({ updateAgent }, staff, scope.signal);
			press(type("Agent name", "Queued name"), "Enter");
			type("Agent title", "Queued title").blur();
			f.details.dialog.close();
			const signal = updateAgent.mock.calls[0]![2];
			if (loss === "navigation") scope.abort();
			else if (loss === "company") f.company.stop();
			else f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
			await settle();
			expect(signal.aborted).toBe(true);
			pending.resolve();
			await settle();
			expect(updateAgent).toHaveBeenCalledTimes(1);
			expect(f.api.listStaff).not.toHaveBeenCalled();
			if (loss !== "company") {
				const reopened = new AgentDetails(f.company, staff, { updateAgent }, () => {});
				cleanup.push(() => reopened.dispose());
				expect(field("Agent name").value).toBe(staff.displayName);
			}
		},
	);
	it("isolates an unsaved draft from another company controller", async () => {
		const updateAgent = saving().mockRejectedValueOnce(new Error("offline"));
		const first = open({ updateAgent });
		type("Agent name", "Only in this company");
		first.details.dialog.close();
		await settle();
		open({ updateAgent });
		expect(field("Agent name").value).toBe(staff.displayName);
		expect(status()).toBe("");
	});
	it("only saves a newly entered edit after authority is restored during cancellation", async () => {
		const pending = deferred<void>();
		const updateAgent = saving().mockReturnValueOnce(pending.promise);
		const f = open({ updateAgent });
		press(type("Agent name", "Revoked name"), "Enter");
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(updateAgent.mock.calls[0]![2].aborted).toBe(true);
		f.company.store.set({ team });
		await settle();
		press(type("Agent title", "Authorized title"), "Enter");
		expect(updateAgent).toHaveBeenCalledTimes(1);
		pending.resolve();
		await settle();
		expect(updateAgent).toHaveBeenCalledTimes(2);
		expect(updateAgent.mock.calls[1]![1]).toMatchObject({ displayName: staff.displayName, role: "Authorized title" });
	});
	it.each([
		["Agent name", staff.displayName],
		["Agent title", staff.role],
		["Agent description", staff.charter],
	])("discards focused uncommitted %s text when authority is revoked", async (label, saved) => {
		const updateAgent = saving();
		const f = open({ updateAgent });
		const control = type(label, "Uncommitted before revocation");
		f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, authorize: false } } });
		await settle();
		expect(control.readOnly).toBe(true);
		expect(control.value).toBe(saved);
		f.company.store.set({ team });
		await settle();
		control.blur();
		await settle();
		expect(updateAgent).not.toHaveBeenCalled();
	});
});

describe("agent details edited in place", () => {
	it("saves a field on Enter, gives it back on Escape and closes on a second Escape", async () => {
		const updateAgent = saving();
		const f = open({ updateAgent });
		expect(document.querySelector(".agent-inline-field.is-editable")).not.toBeNull();
		const name = type("Agent name", "  Ada  ");
		press(name, "Enter");
		expect(updateAgent).toHaveBeenCalledTimes(1);
		expect(updateAgent.mock.calls[0]![1]).toMatchObject({
			displayName: "Ada",
			role: staff.role,
			charter: staff.charter,
		});
		expect(name.value).toBe("Ada");
		expect(document.activeElement).toBe(f.dialog);
		await settle();
		expect(f.api.listStaff).toHaveBeenCalled();
		expect(status()).toBe("Saved");
		const role = type("Agent title", "Not this");
		press(role, "Escape");
		expect(role.value).toBe(staff.role);
		expect(f.dialog.isConnected).toBe(true);
		expect(updateAgent).toHaveBeenCalledTimes(1);
		press(f.dialog, "Escape");
		expect(f.dialog.isConnected).toBe(false);
		expect(f.onClose).toHaveBeenCalledTimes(1);
	});
	it("folds changes made during a save into one following write", async () => {
		const first = deferred<void>();
		const updateAgent = saving().mockReturnValueOnce(first.promise);
		open({ updateAgent });
		press(type("Agent name", "Ada"), "Enter");
		type("Agent title", "Lead").blur();
		const description = type("Agent description", "Owns the launch.");
		press(description, "Enter");
		expect(field("Agent description")).toBe(document.activeElement);
		press(description, "Enter", { ctrlKey: true });
		expect(updateAgent).toHaveBeenCalledTimes(1);
		first.resolve();
		await settle();
		await settle();
		expect(updateAgent).toHaveBeenCalledTimes(2);
		expect(updateAgent.mock.calls[1]![1]).toMatchObject({
			displayName: "Ada",
			role: "Lead",
			charter: "Owns the launch.",
		});
	});
	it("keeps the text after a failed save and saves it again on request", async () => {
		const updateAgent = saving().mockRejectedValueOnce(new Error("offline"));
		open({ updateAgent });
		press(type("Agent name", "Ada"), "Enter");
		await settle();
		expect(status()).toContain("could not be saved");
		expect(field("Agent name").value).toBe("Ada");
		named("Try again").click();
		await settle();
		expect(updateAgent).toHaveBeenCalledTimes(2);
		expect(updateAgent.mock.calls[1]![1]).toMatchObject({ displayName: "Ada" });
		expect(status()).toBe("Saved");
	});
	it("refuses an empty name and puts the saved one back", () => {
		const updateAgent = saving();
		open({ updateAgent });
		press(type("Agent name", "   "), "Enter");
		expect(updateAgent).not.toHaveBeenCalled();
		expect(field("Agent name").value).toBe(staff.displayName);
		expect(status()).toBe("An agent needs a name.");
	});
	it("takes roster changes into fields that are not being typed in", async () => {
		const f = open({ updateAgent: saving() });
		type("Agent title", "Typing");
		f.company.store.set({ staff: [{ ...staff, displayName: "Renamed elsewhere", role: "Changed elsewhere" }] });
		await settle();
		expect(field("Agent name").value).toBe("Renamed elsewhere");
		expect(field("Agent title").value).toBe("Typing");
	});
	it("saves a field left open when the panel is closed, and drops it when the panel is disposed", async () => {
		const updateAgent = saving();
		const kept = open({ updateAgent });
		type("Agent name", "Kept");
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(kept.dialog.isConnected).toBe(false);
		expect(updateAgent).toHaveBeenCalledTimes(1);
		expect(updateAgent.mock.calls[0]![1]).toMatchObject({ displayName: "Kept" });
		await settle();
		// The save carried on after the panel closed.
		expect(kept.api.listStaff).toHaveBeenCalled();
		const dropped = open({ updateAgent });
		type("Agent name", "Dropped");
		dropped.details.dispose();
		expect(updateAgent).toHaveBeenCalledTimes(1);
	});
});

describe("agent figure", () => {
	it("opens a picker under the figure and saves each choice", () => {
		const updateAgent = saving();
		const f = open({ updateAgent });
		const figure = named("Edit figure");
		expect(figure.disabled).toBe(false);
		figure.click();
		const picker = f.dialog.querySelector<HTMLElement>(".agent-figure-picker")!;
		expect(picker.hidden).toBe(false);
		expect(figure.getAttribute("aria-expanded")).toBe("true");
		expect(f.dialog.classList.contains("is-choosing-figure")).toBe(true);
		expect(picker.querySelector(".color-grid")).not.toBeNull();
		expect(named("Reset")).toBeDefined();
		const other = FIGURE_IDS.find((item) => item !== figureFor(staff))!;
		named(other).click();
		expect(updateAgent).toHaveBeenCalledTimes(1);
		expect(updateAgent.mock.calls[0]![1]).toMatchObject({ figure: other, displayName: staff.displayName });
		expect(picker.hidden).toBe(false);
		press(named(other), "Escape");
		expect(picker.hidden).toBe(true);
		expect(document.activeElement).toBe(figure);
		expect(f.dialog.isConnected).toBe(true);
		figure.click();
		f.dialog.querySelector(".agent-inline-description")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(picker.hidden).toBe(true);
	});
	it("offers the Co-Founder figures only", () => {
		const f = open({ updateAgent: saving() }, { ...staff, id: id(40), templateId: "co-founder" });
		named("Edit figure").click();
		const picker = f.dialog.querySelector<HTMLElement>(".agent-figure-picker")!;
		expect(picker.classList.contains("figures-only")).toBe(true);
		expect(picker.querySelector(".color-grid, .agent-figure-reset")).toBeNull();
	});
});

describe("agent pages", () => {
	const organization: HostedCompanyOrganization = {
		schema: "qorpera.company-organization/v1",
		profileId: profileA.profileId,
		cofounder: { staffAgentId: staff.id, formationId: id(30) },
		formation: {
			formationId: id(30),
			state: "operating",
			status: "active",
			revision: 1,
			projectionStatus: "ready",
			sourcePath: "company/formation.json",
		},
		responsibilities: [
			{
				responsibilityId: id(31),
				slug: "quality",
				name: "Product quality",
				outcome: "Fewer defects",
				status: "active",
				accountableStaffAgentId: staff.id,
				attentionCadence: "weekly",
				measures: [],
				version: 1,
				sourcePath: "quality.json",
			},
		],
		projects: [],
	};
	it("opens routines and responsibilities from the corner, each with a way back", async () => {
		const routines = {
			list: vi.fn(async () => []),
			runs: vi.fn(async () => []),
			save: vi.fn(async () => {}),
			setEnabled: vi.fn(async () => {}),
		} satisfies WebRoutines;
		const nativeSubscription = {
			listConnections: vi.fn(async () => ({ connections: [] })),
		} as unknown as WebNativeSubscription;
		const f = open({ routines, nativeSubscription });
		const tools = [...f.dialog.querySelectorAll(".surface-tools button")].map((item) =>
			item.getAttribute("aria-label"),
		);
		expect(tools).toEqual(["Responsibilities", "Routines", "Close agent details"]);
		const toRoutines = named("Routines");
		toRoutines.click();
		// Until the first read answers, the page does not claim there are none.
		expect(f.dialog.textContent).toContain("Reading routines…");
		expect(f.dialog.textContent).not.toContain("has no routines yet");
		await settle();
		expect(f.dialog.dataset.page).toBe("routines");
		expect(toRoutines.getAttribute("aria-pressed")).toBe("true");
		expect(f.dialog.querySelector("h2")?.textContent).toBe("Routines");
		expect(f.dialog.textContent).toContain(`${staff.displayName} has no routines yet.`);
		expect(named("New routine")).toBeDefined();
		expect(document.activeElement).toBe(named("Back to agent details"));
		named("Back to agent details").click();
		expect(f.dialog.dataset.page).toBe("details");
		expect(f.dialog.contains(field("Agent name"))).toBe(true);
		expect(document.activeElement).toBe(toRoutines);
		f.company.store.set({ organization });
		await settle();
		named("Responsibilities").click();
		expect(f.dialog.textContent).toContain("Product quality");
		expect(f.dialog.querySelector(".responsibility-node")?.getAttribute("href")).toBe(
			`#/c/${profileA.profileId}/responsibility/${id(31)}`,
		);
		named("Responsibilities").click();
		expect(f.dialog.dataset.page).toBe("details");
		f.company.store.set({ staff: [{ ...staff, displayName: "Renamed" }] });
		await settle();
		toRoutines.click();
		await settle();
		// The list is read again each time the page opens, under the agent's current name.
		expect(routines.list).toHaveBeenCalledTimes(2);
		expect(f.dialog.textContent).toContain("Renamed has no routines yet.");
		expect(f.cloud.rpc).not.toHaveBeenCalled();
	});
	it("says when an agent has no responsibilities", () => {
		const f = open();
		named("Responsibilities").click();
		expect(f.dialog.textContent).toContain("No responsibilities assigned yet.");
		expect(f.dialog.querySelector(".agent-page-link")?.getAttribute("href")).toBe(
			`#/c/${profileA.profileId}/organization`,
		);
	});
});
