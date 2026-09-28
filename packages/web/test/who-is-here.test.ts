// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { PresenceMember } from "../src/cloud/presence.ts";
import type { HostedProfileMember } from "../src/cloud/types.ts";
import { fixture, id, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";

const userC = id(31);
const userD = id(32);
const userE = id(33);
const members: HostedProfileMember[] = [
	{ userId: userA.id, email: "a@example.invalid", displayName: "Account A", role: "owner", joinedAt: timestamp },
	{
		userId: userB.id,
		email: "b@example.invalid",
		displayName: "Sofie Lund",
		role: "contributor",
		joinedAt: timestamp,
	},
	{ userId: userC, email: "c@example.invalid", displayName: "Mads Holm", role: "viewer", joinedAt: timestamp },
	{ userId: userD, email: "d@example.invalid", displayName: "Anna Berg", role: "admin", joinedAt: timestamp },
	{
		userId: userE,
		email: "e@example.invalid",
		displayName: "Peter Nørgaard",
		role: "contributor",
		joinedAt: timestamp,
	},
];
const tab = (userId: string, sessionId: string | null, name = "Presence name"): PresenceMember => ({
	clientId: crypto.randomUUID(),
	userId,
	name,
	staffAgentId: sessionId,
});

let dispose: (() => void) | undefined;
let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	visibility = "visible";
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function setup(options: { members?: HostedProfileMember[] } = {}) {
	const f = fixture();
	let publish: ((members: PresenceMember[]) => void) | undefined;
	const handle = { setOpenThread: vi.fn(), sendTyping: vi.fn(), sendActivity: vi.fn(), stop: vi.fn(async () => {}) };
	const join = vi.mocked(f.api.joinPresence).mockImplementation((_profile, onMembers) => {
		publish = onMembers;
		return handle;
	});
	vi.mocked(f.api.getTeam).mockResolvedValue({ ...team, members: options.members ?? members });
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ staff: [staff], sessions: [session], loading: false });
	await company.refreshTeam();
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	view.update();
	await settle();
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return {
		company,
		view,
		join,
		handle,
		publish: async (tabs: PresenceMember[]) => {
			publish?.(tabs);
			await settle();
		},
		here: () => view.el.querySelector<HTMLElement>(".thread-presence")!,
		faces: () => [...view.el.querySelectorAll<HTMLElement>(".thread-presence > .person-avatar")],
	};
}

describe("who is here now", () => {
	it("shows the other members who have this conversation open, once each, in the header", async () => {
		const s = await setup();
		expect(s.join).toHaveBeenCalledWith(profileA.profileId, expect.any(Function), expect.any(Function));
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith(session.sessionId);
		expect(s.here().hidden).toBe(true);
		await s.publish([
			tab(userB.id, session.sessionId),
			tab(userB.id, session.sessionId),
			tab(userC, id(99)),
			tab(userA.id, session.sessionId),
		]);
		expect(s.here().hidden).toBe(false);
		expect(s.faces().map((face) => face.textContent)).toEqual(["SL"]);
		expect(s.here().getAttribute("aria-label")).toBe("Sofie Lund is here");
		const sofie = s.faces()[0];
		await s.publish([tab(userB.id, session.sessionId), tab(userC, session.sessionId)]);
		// A face already shown stays the same element (it does not grow in again).
		expect(s.faces()[0]).toBe(sofie);
		expect(s.here().getAttribute("aria-label")).toBe("Sofie Lund and Mads Holm are here");
		await s.publish([]);
		expect(s.here().hidden).toBe(true);
		expect(s.faces()).toEqual([]);
	});

	it("shows three faces and counts the rest", async () => {
		const s = await setup();
		await s.publish([userB.id, userC, userD, userE].map((user) => tab(user, session.sessionId)));
		expect(s.faces()).toHaveLength(3);
		expect(s.here().querySelector(".thread-presence-more")?.textContent).toBe("+1");
		expect(s.here().title).toBe("Sofie Lund, Mads Holm, Anna Berg, and Peter Nørgaard are here");
	});

	it("joins once however often the team is read, and says nothing after the company stopped", async () => {
		const s = await setup();
		await s.company.refreshTeam();
		await s.company.refreshTeam();
		expect(s.join).toHaveBeenCalledTimes(1);
		s.company.stop();
		const calls = s.handle.setOpenThread.mock.calls.length;
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		s.company.setOpenSession(session.sessionId);
		expect(s.handle.setOpenThread).toHaveBeenCalledTimes(calls);
	});

	it("draws a renamed member's face anew", async () => {
		const s = await setup();
		await s.publish([tab(userB.id, session.sessionId)]);
		const before = s.faces()[0];
		expect(before?.textContent).toBe("SL");
		s.company.store.set({
			team: {
				...s.company.store.get().team!,
				members: members.map((member) =>
					member.userId === userB.id ? { ...member, displayName: "Anna Holt" } : member,
				),
			},
		});
		await settle();
		expect(s.faces()[0]).not.toBe(before);
		expect(s.faces()[0]?.textContent).toBe("AH");
	});

	it("says it shows no conversation while the tab is hidden or the conversation closed", async () => {
		const s = await setup();
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith(null);
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith(session.sessionId);
		s.view.dispose();
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith(null);
		s.company.stop();
		expect(s.handle.stop).toHaveBeenCalledTimes(1);
	});

	it("does not join when the company has no other member", async () => {
		const s = await setup({ members: [members[0]!] });
		expect(s.join).not.toHaveBeenCalled();
		expect(s.here().hidden).toBe(true);
	});
});
