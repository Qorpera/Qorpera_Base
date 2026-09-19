// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
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
	const view = new ConversationView(company, session.sessionId);
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
	return { ...f, rpc, company, view, header, open };
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
});
