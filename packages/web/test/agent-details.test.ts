// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { AgentDetails } from "../src/app/views/agent-details.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
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

function open(actions: WorkspaceActions = {}, agent: HostedStaffAgent = staff) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, staff: [agent], loading: false });
	const anchor = document.createElement("button");
	document.body.append(anchor);
	const onClose = vi.fn();
	const details = new AgentDetails(company, agent, actions, onClose, anchor);
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
