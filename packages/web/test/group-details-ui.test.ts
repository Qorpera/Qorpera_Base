// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { WorkspaceActions } from "../src/app/workspace-actions.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
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

const group = { ...session, title: "A misleading participant name", executionScope: { roomId: id(79) } };
const room = {
	roomId: id(79),
	sessionId: session.sessionId,
	environmentId: session.environmentId,
	version: 1,
	name: "Planning",
	purpose: "Plan launch",
	status: "active",
	members: [
		{ kind: "staff_agent", id: staff.id },
		{ kind: "member", id: userA.id },
	],
};
function setup() {
	const f = fixture();
	const rpc = vi.mocked(f.cloud.rpc).mockResolvedValue([room]);
	vi.mocked(f.api.listSessions).mockResolvedValue([group]);
	const updateGroup = vi.fn<NonNullable<WorkspaceActions["updateGroup"]>>(async () => {});
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team: {
			...team,
			members: [
				{ userId: userA.id, displayName: "Account A", email: userA.email!, role: "owner", joinedAt: timestamp },
			],
		},
		staff: [staff, { ...staff, id: id(80), displayName: "Unrelated agent" }],
		sessions: [group],
		loading: false,
	});
	const view = new ConversationView(company, session.sessionId, { updateGroup });
	document.body.append(view.el);
	const header = view.el.querySelector<HTMLButtonElement>(".thread-identity")!;
	cleanup.push(() => {
		view.dispose();
		company.stop();
	});
	const open = () => {
		header.focus();
		header.click();
		return dialog()!;
	};
	return { ...f, rpc, company, view, header, open, updateGroup };
}
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[aria-label="Group details"]');
const button = (label: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(control) => control.getAttribute("aria-label") === label || control.textContent === label,
	)!;

describe("group details from the conversation header", () => {
	it("shows the canonical group purpose and only its actual participants", async () => {
		const f = setup();
		expect(f.header.disabled).toBe(false);
		expect(f.header.getAttribute("aria-label")).toBe("Open group details");
		expect(f.header.getAttribute("aria-haspopup")).toBe("dialog");
		expect(f.header.getAttribute("aria-expanded")).toBe("false");
		const panel = f.open();
		expect(f.header.getAttribute("aria-expanded")).toBe("true");
		expect(panel.textContent).toContain("Loading group details…");
		await settle();
		expect(f.rpc).toHaveBeenCalledWith("qorpera_list_company_rooms", { p_profile_id: profileA.profileId });
		expect(panel.textContent).toContain("Planning");
		expect(panel.textContent).toContain("Plan launch");
		expect(panel.textContent).toContain("Participants (2)");
		expect(panel.textContent).toContain(staff.displayName);
		expect(panel.textContent).toContain(staff.role);
		expect(panel.textContent).toContain("Account A");
		expect(panel.textContent).toContain("You");
		expect(panel.textContent).not.toContain("Unrelated agent");
		expect(panel.getAttribute("aria-modal")).toBe("false");
		panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(dialog()).toBeNull();
		expect(f.header.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(f.header);
	});

	it("offers retry after a failed read without showing inferred participants", async () => {
		const f = setup();
		f.rpc.mockRejectedValueOnce(new Error("Network unavailable"));
		const panel = f.open();
		await settle();
		expect(panel.textContent).not.toContain(staff.displayName);
		expect(panel.textContent).not.toContain("Loading group details…");
		button("Retry").click();
		await settle();
		expect(f.rpc).toHaveBeenCalledTimes(2);
		expect(panel.textContent).toContain("Plan launch");
		expect(panel.textContent).toContain(staff.displayName);
	});

	it("fetches current membership when reopened and ignores a prior panel's late response", async () => {
		const f = setup();
		const pending = deferred<unknown>();
		f.rpc.mockReturnValueOnce(pending.promise);
		f.open();
		await settle();
		button("Close group details").click();
		f.rpc.mockResolvedValueOnce([{ ...room, name: "Current group", members: [room.members[1]] }]);
		const current = f.open();
		await settle();
		expect(current.textContent).toContain("Current group");
		expect(current.textContent).toContain("Participants (1)");
		pending.resolve([{ ...room, name: "Outdated group" }]);
		await settle();
		expect(dialog()).toBe(current);
		expect(current.textContent).not.toContain("Outdated group");
		expect(current.textContent).not.toContain(staff.displayName);
		expect(f.rpc).toHaveBeenCalledTimes(2);
	});

	it.each(["navigation", "company", "access", "scope"] as const)(
		"closes on %s loss and discards an outstanding read",
		async (loss) => {
			const f = setup();
			const pending = deferred<unknown>();
			f.rpc.mockReturnValueOnce(pending.promise);
			f.open();
			await settle();
			if (loss === "navigation") f.view.dispose();
			else if (loss === "company") f.company.stop();
			else if (loss === "access") f.company.store.set({ accessLost: true, team: undefined });
			else f.company.store.set({ sessions: [{ ...group, executionScope: { roomId: id(81) } }] });
			await settle();
			expect(dialog()).toBeNull();
			pending.resolve([room]);
			await settle();
			expect(dialog()).toBeNull();
			expect(document.body.textContent).not.toContain("Plan launch");
		},
	);

	it("saves edited name, description and membership, then reloads the canonical details and session title", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		button("Edit group").click();
		const name = panel.querySelector<HTMLInputElement>('input[name="name"]')!;
		const purpose = panel.querySelector<HTMLTextAreaElement>('textarea[name="purpose"]')!;
		expect(document.activeElement).toBe(name);
		name.value = "Launch team";
		name.dispatchEvent(new Event("input", { bubbles: true }));
		purpose.value = "Coordinate the launch schedule";
		purpose.dispatchEvent(new Event("input", { bubbles: true }));
		const extra = [...panel.querySelectorAll<HTMLLabelElement>(".group-member-choice")].find((choice) =>
			choice.textContent?.includes("Unrelated agent"),
		)!;
		extra.querySelector<HTMLInputElement>("input")!.click();
		const owner = [...panel.querySelectorAll<HTMLLabelElement>(".group-member-choice")].find((choice) =>
			choice.textContent?.includes("Account A"),
		)!;
		owner.querySelector<HTMLInputElement>("input")!.click();
		const refreshed = {
			...room,
			version: 2,
			name: name.value,
			purpose: purpose.value,
			members: [
				{ kind: "staff_agent", id: staff.id },
				{ kind: "staff_agent", id: id(80) },
			],
		};
		f.updateGroup.mockImplementationOnce(async () => {
			f.rpc.mockResolvedValue([refreshed]);
			vi.mocked(f.api.listSessions).mockResolvedValue([{ ...group, title: refreshed.name }]);
		});
		button("Save changes").click();
		await settle();
		expect(f.updateGroup).toHaveBeenCalledWith(
			session.sessionId,
			room,
			{ name: refreshed.name, purpose: refreshed.purpose, members: refreshed.members },
			expect.any(AbortSignal),
		);
		expect(f.api.listSessions).toHaveBeenCalledWith(profileA.environmentId, expect.any(AbortSignal));
		expect(f.rpc.mock.calls.length).toBeGreaterThan(1);
		expect(panel.querySelector(".group-edit-form")).toBeNull();
		expect(panel.querySelector("h2")?.textContent).toBe("Launch team");
		expect(panel.querySelector(".group-details-purpose")?.textContent).toBe(refreshed.purpose);
		expect(panel.textContent).toContain("Changes saved.");
		expect(panel.textContent).not.toContain("Account A");
		expect(panel.textContent).toContain("Unrelated agent");
		expect(f.header.querySelector("h1")?.textContent).toBe("Launch team");
		expect(f.company.store.get().groups?.[room.roomId]?.version).toBe(2);
	});

	it("cancels unsaved changes and opens a fresh draft from the saved details", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		button("Edit group").click();
		const name = panel.querySelector<HTMLInputElement>('input[name="name"]')!;
		name.value = "Discard this name";
		name.dispatchEvent(new Event("input", { bubbles: true }));
		panel.querySelector<HTMLInputElement>('.group-member-choice input[type="checkbox"]')!.click();
		button("Cancel").click();
		expect(panel.querySelector(".group-edit-form")).toBeNull();
		expect(panel.querySelector("h2")?.textContent).toBe(room.name);
		expect(f.updateGroup).not.toHaveBeenCalled();
		button("Edit group").click();
		expect(panel.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(room.name);
		expect(panel.querySelector<HTMLInputElement>('.group-member-choice input[type="checkbox"]')?.checked).toBe(true);
	});

	it("retains failed edits and focused controls through company updates, and retries the same draft", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		button("Edit group").click();
		const name = panel.querySelector<HTMLInputElement>('input[name="name"]')!;
		name.value = "Keep this name";
		name.dispatchEvent(new Event("input", { bubbles: true }));
		f.company.store.set({ error: "An unrelated refresh failed" });
		await settle();
		expect(panel.querySelector('input[name="name"]')).toBe(name);
		expect(document.activeElement).toBe(name);
		f.updateGroup.mockRejectedValueOnce(new Error("Save service unavailable"));
		button("Save changes").click();
		await settle();
		expect(panel.textContent).toContain("Save service unavailable");
		expect(name.value).toBe("Keep this name");
		expect(name.matches(":disabled")).toBe(false);
		f.updateGroup.mockImplementationOnce(async (_session, _observed, draft) => {
			f.rpc.mockResolvedValue([{ ...room, ...draft, version: 2 }]);
		});
		button("Save changes").click();
		await settle();
		expect(f.updateGroup).toHaveBeenCalledTimes(2);
		expect(f.updateGroup.mock.calls[1]?.slice(0, 3)).toEqual(f.updateGroup.mock.calls[0]?.slice(0, 3));
		expect(panel.querySelector("h2")?.textContent).toBe("Keep this name");
		expect(panel.textContent).toContain("Changes saved.");
	});

	it("disables the form while saving and submits only once", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		button("Edit group").click();
		const pending = deferred<void>();
		f.updateGroup.mockReturnValueOnce(pending.promise);
		button("Save changes").click();
		const form = panel.querySelector<HTMLFormElement>(".group-edit-form")!;
		expect(panel.querySelector<HTMLFieldSetElement>(".group-edit-fields")?.disabled).toBe(true);
		expect(button("Cancel").matches(":disabled")).toBe(true);
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		expect(f.updateGroup).toHaveBeenCalledOnce();
		pending.resolve();
		await settle();
		expect(panel.querySelector(".group-edit-form")).toBeNull();
	});

	it.each([false, true])("discards editing state on role revocation, including a pending save: %s", async (saving) => {
		const f = setup();
		const panel = f.open();
		await settle();
		button("Edit group").click();
		const name = panel.querySelector<HTMLInputElement>('input[name="name"]')!;
		name.value = "Revoked draft";
		name.dispatchEvent(new Event("input", { bubbles: true }));
		const pending = deferred<void>();
		if (saving) {
			f.updateGroup.mockReturnValueOnce(pending.promise);
			button("Save changes").click();
		}
		f.company.store.set({
			team: {
				...f.company.store.get().team!,
				role: "viewer",
				capabilities: { ...team.capabilities, authorize: false, write: false },
			},
		});
		await settle();
		expect(panel.querySelector(".group-edit-form")).toBeNull();
		expect(button("Edit group")).toBeUndefined();
		expect(panel.textContent).not.toContain("Revoked draft");
		expect(panel.textContent).toContain("Only an owner or admin");
		if (saving) {
			expect(f.updateGroup.mock.calls[0]?.[3].aborted).toBe(true);
			pending.resolve();
			await settle();
			expect(panel.textContent).not.toContain("Changes saved.");
		}
		f.company.store.set({ team: { ...f.company.store.get().team!, role: "owner", capabilities: team.capabilities } });
		await settle();
		button("Edit group").click();
		expect(panel.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe(room.name);
	});
});
