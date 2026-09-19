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
const field = (name: string) =>
	document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`.group-details [name="${name}"]`)!;
function typeField(name: string, value: string) {
	const input = field(name);
	input.focus();
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return input;
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
		expect(field("name").value).toBe("Planning");
		expect(field("purpose").value).toBe("Plan launch");
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
		expect(field("purpose").value).toBe("Plan launch");
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
		expect(field("name").value).toBe("Current group");
		expect(current.textContent).toContain("Participants (1)");
		pending.resolve([{ ...room, name: "Outdated group" }]);
		await settle();
		expect(dialog()).toBe(current);
		expect(field("name").value).toBe("Current group");
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

	it("edits title, subtitle and description in place without an Edit group button", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		expect(button("Edit group")).toBeUndefined();
		expect(field("name").getAttribute("aria-label")).toBe("Group title");
		expect(field("subtitle").value).toBe("Group chat");
		let canonical = { ...room };
		f.updateGroup.mockImplementation(async (_session, observed, draft) => {
			canonical = { ...canonical, ...draft, version: observed.version + 1 };
			f.rpc.mockResolvedValue([canonical]);
			vi.mocked(f.api.listSessions).mockResolvedValue([{ ...group, title: canonical.name }]);
		});
		for (const [key, value] of [
			["name", "Launch team"],
			["subtitle", "Launch coordination"],
			["purpose", "Coordinate the launch schedule"],
		]) {
			const control = typeField(key!, value!);
			if (key === "purpose") control.blur();
			else control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await settle();
			expect(control.value).toBe(value);
		}
		expect(f.updateGroup).toHaveBeenCalledTimes(3);
		expect(f.updateGroup.mock.calls[2]?.[2]).toMatchObject({
			name: "Launch team",
			subtitle: "Launch coordination",
			purpose: "Coordinate the launch schedule",
			members: room.members,
		});
		expect(f.header.querySelector("h1")?.textContent).toBe("Launch team");
		expect(panel.querySelector(".group-edit-form")).toBeNull();
	});

	it("cancels with Escape without closing the panel and rejects empty required text", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		const name = typeField("name", "Discard this");
		name.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		expect(dialog()).toBe(panel);
		expect(name.value).toBe(room.name);
		expect(document.activeElement).toBe(panel);
		typeField("purpose", "   ").blur();
		expect(field("purpose").value).toBe(room.purpose);
		expect(panel.textContent).toContain("Group description cannot be empty.");
		expect(f.updateGroup).not.toHaveBeenCalled();
	});

	it("keeps multiline Enter for text and saves description with Control+Enter", async () => {
		const f = setup();
		f.open();
		await settle();
		const purpose = typeField("purpose", "First line\nSecond line");
		const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		purpose.dispatchEvent(enter);
		expect(enter.defaultPrevented).toBe(false);
		expect(f.updateGroup).not.toHaveBeenCalled();
		purpose.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }),
		);
		await settle();
		expect(f.updateGroup.mock.calls[0]?.[2].purpose).toBe("First line\nSecond line");
	});

	it("retains focused controls and failed edits through refreshes and retries", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		const name = typeField("name", "Keep this name");
		f.company.store.set({ error: "Unrelated refresh" });
		await settle();
		expect(field("name")).toBe(name);
		expect(document.activeElement).toBe(name);
		f.updateGroup.mockRejectedValueOnce(new Error("Save unavailable"));
		name.blur();
		await settle();
		expect(name.value).toBe("Keep this name");
		expect(button("Try again")).toBeDefined();
		f.updateGroup.mockImplementationOnce(async (_session, observed, draft) => {
			f.rpc.mockResolvedValue([{ ...room, ...draft, version: observed.version + 1 }]);
		});
		button("Try again").click();
		await settle();
		expect(f.updateGroup).toHaveBeenCalledTimes(2);
		expect(f.updateGroup.mock.calls[1]?.slice(0, 3)).toEqual(f.updateGroup.mock.calls[0]?.slice(0, 3));
		expect(field("name").value).toBe("Keep this name");
		expect(panel.textContent).toContain("Saved");
	});

	it("discards a rejected draft and reloads canonical details before editing again", async () => {
		const f = setup();
		f.open();
		await settle();
		f.updateGroup.mockRejectedValueOnce(new Error("Group changed"));
		typeField("name", "Rejected name").blur();
		await settle();
		f.rpc.mockResolvedValue([{ ...room, name: "Current name", version: 2 }]);
		button("Discard changes").click();
		await settle();
		expect(field("name").value).toBe("Current name");
		expect(field("name").readOnly).toBe(false);
		expect(button("Try again")).toBeUndefined();
		typeField("name", "Fresh name").blur();
		await settle();
		expect(f.updateGroup.mock.calls[1]?.[1].version).toBe(2);
		expect(f.updateGroup.mock.calls[1]?.[2].name).toBe("Fresh name");
	});

	it("preserves a second focused field while the first field finishes saving", async () => {
		const f = setup();
		f.open();
		await settle();
		const pending = deferred<void>();
		f.updateGroup.mockReturnValueOnce(pending.promise);
		typeField("name", "New name").blur();
		const subtitle = typeField("subtitle", "Still typing");
		f.rpc.mockResolvedValue([{ ...room, name: "New name", version: 2 }]);
		pending.resolve();
		await settle();
		expect(field("subtitle")).toBe(subtitle);
		expect(subtitle.value).toBe("Still typing");
		expect(document.activeElement).toBe(subtitle);
		expect(f.updateGroup).toHaveBeenCalledOnce();
		subtitle.blur();
		await settle();
		expect(f.updateGroup.mock.calls[1]?.[2]).toMatchObject({ name: "New name", subtitle: "Still typing" });
	});

	it("saves the focused field when closing and retains it when reopened", async () => {
		const f = setup();
		f.open();
		await settle();
		f.updateGroup.mockImplementationOnce(async (_session, observed, draft) => {
			f.rpc.mockResolvedValue([{ ...room, ...draft, version: observed.version + 1 }]);
		});
		typeField("name", "Saved on close");
		button("Close group details").click();
		await settle();
		expect(dialog()).toBeNull();
		expect(f.updateGroup.mock.calls[0]?.[2].name).toBe("Saved on close");
		expect(f.updateGroup.mock.calls[0]?.[3].aborted).toBe(false);
		f.open();
		await settle();
		expect(field("name").value).toBe("Saved on close");
	});

	it("edits participants separately, preserves identity and cancels unsaved selection", async () => {
		const f = setup();
		const panel = f.open();
		await settle();
		button("Edit participants").click();
		const extra = [...panel.querySelectorAll<HTMLLabelElement>(".group-member-choice")].find((choice) =>
			choice.textContent?.includes("Unrelated agent"),
		)!;
		extra.querySelector<HTMLInputElement>("input")!.click();
		button("Cancel").click();
		expect(f.updateGroup).not.toHaveBeenCalled();
		button("Edit participants").click();
		const choice = [...panel.querySelectorAll<HTMLLabelElement>(".group-member-choice")].find((item) =>
			item.textContent?.includes("Unrelated agent"),
		)!;
		expect(choice.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
		choice.querySelector<HTMLInputElement>("input")!.click();
		button("Save participants").click();
		await settle();
		expect(f.updateGroup.mock.calls[0]?.[2]).toMatchObject({
			name: room.name,
			purpose: room.purpose,
			members: [...room.members, { kind: "staff_agent", id: id(80) }],
		});
		expect(field("name").value).toBe(room.name);
	});

	it.each([false, true])("discards editing state on role revocation, including pending save: %s", async (saving) => {
		const f = setup();
		const panel = f.open();
		await settle();
		const name = typeField("name", "Revoked draft");
		const pending = deferred<void>();
		if (saving) {
			f.updateGroup.mockReturnValueOnce(pending.promise);
			name.blur();
		}
		f.company.store.set({
			team: {
				...f.company.store.get().team!,
				role: "viewer",
				capabilities: { ...team.capabilities, authorize: false, write: false },
			},
		});
		await settle();
		expect(field("name").readOnly).toBe(true);
		expect(field("name").value).toBe(room.name);
		expect(button("Edit participants")).toBeUndefined();
		expect(panel.textContent).toContain("Only an owner or admin");
		if (saving) {
			expect(f.updateGroup.mock.calls[0]?.[3].aborted).toBe(true);
			pending.resolve();
			await settle();
		}
		f.company.store.set({ team: { ...f.company.store.get().team!, role: "owner", capabilities: team.capabilities } });
		await settle();
		expect(field("name").readOnly).toBe(false);
		expect(field("name").value).toBe(room.name);
	});
});
