// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { parsePresenceValue, presenceValue } from "../src/app/presence-place.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { EMPTY_APP_LAYOUT, parseAppGroups } from "../src/cloud/app-groups.ts";
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

describe("who is where in the company (the rail's markers)", () => {
	it("says the open conversation and its agent, and a page, app or card when no conversation is open", async () => {
		const s = await setup();
		// An agent's thread is bound to a room of its own, and still stands for the agent.
		s.company.store.set({
			sessions: [{ ...session, staffAgentId: staff.id, executionScope: { roomId: id(55), agentThread: true } }],
		});
		await settle();
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith(`${session.sessionId}@agent:${staff.id}`);
		// A group chat stands for its room.
		s.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id, executionScope: { roomId: id(56) } }] });
		await settle();
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith(`${session.sessionId}@room:${id(56)}`);
		s.view.dispose();
		s.company.setOpenPlace("page:Members");
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith("@page:Members");
		s.company.setOpenPlace(undefined);
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith(null);
	});

	it("groups the other members by where they are, once each, and still finds them in a conversation", async () => {
		const s = await setup();
		await s.publish([
			tab(userB.id, `${session.sessionId}@agent:${staff.id}`),
			tab(userB.id, `${session.sessionId}@agent:${staff.id}`),
			tab(userC, `${id(98)}@agent:${staff.id}`),
			tab(userD, "@page:Members"),
			tab(userE, id(97)),
			tab(userA.id, `${session.sessionId}@agent:${staff.id}`),
		]);
		const places = s.company.peopleByPlace();
		expect(places.get(`agent:${staff.id}`)?.map((person) => person.name)).toEqual(["Sofie Lund", "Mads Holm"]);
		expect(places.get("page:Members")?.map((person) => person.name)).toEqual(["Anna Berg"]);
		// An older tab says its conversation alone: it is in no place, but still in the conversation's header.
		expect([...places.keys()]).toHaveLength(2);
		expect(s.company.presentIn(session.sessionId).map((person) => person.name)).toEqual(["Sofie Lund"]);
		expect(s.company.presentIn(id(97)).map((person) => person.name)).toEqual(["Peter Nørgaard"]);
	});

	it("reads and writes the tracked value", () => {
		expect(presenceValue("s1", "agent:a1")).toBe("s1@agent:a1");
		expect(presenceValue(undefined, "sites")).toBe("@sites");
		expect(presenceValue("s1", undefined)).toBe("s1");
		expect(presenceValue(undefined, undefined)).toBeNull();
		expect(parsePresenceValue("s1@room:r1")).toEqual({ sessionId: "s1", place: "room:r1" });
		expect(parsePresenceValue("@app:crm")).toEqual({ place: "app:crm" });
		expect(parsePresenceValue("s1")).toEqual({ sessionId: "s1" });
		expect(parsePresenceValue(null)).toEqual({});
		// Too long for the channel: the conversation alone.
		expect(presenceValue("s1", `page:${"x".repeat(300)}`)).toBe("s1");
	});

	it("puts the other members' pictures on the agent's row they are in, and takes them off when they leave", async () => {
		const s = await setup();
		const rail = document.createElement("aside");
		document.body.append(rail);
		const context = {
			profiles: [profileA],
			user: userA,
			auth: new AuthController(fixture().cloud),
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
			route: { name: "company", profileId: profileA.profileId, section: "home" } as const,
		};
		const marker = () => rail.querySelector<HTMLElement>(`[data-agent-id="${staff.id}"] .rail-here`);
		await s.publish([tab(userB.id, `${id(98)}@agent:${staff.id}`), tab(userC, `${id(97)}@agent:${staff.id}`)]);
		renderRail(rail, s.company, context);
		expect([...marker()!.querySelectorAll(".person-avatar")].map((face) => face.textContent)).toEqual(["SL", "MH"]);
		expect(rail.querySelector(`[data-agent-id="${staff.id}"]`)?.getAttribute("aria-description")).toBe(
			"Sofie Lund and Mads Holm are here",
		);
		const row = rail.querySelector<HTMLElement>(`[data-agent-id="${staff.id}"]`)!;
		expect(row.style.getPropertyValue("--here-count")).toBe("2");
		const kept = marker();
		renderRail(rail, s.company, context);
		// The same people keep the same marker: nothing grows in again on a redraw.
		expect(marker()).toBe(kept);
		// A renamed member is drawn anew, with the new name's initials and words.
		s.company.store.set({
			team: {
				...s.company.store.get().team!,
				members: members.map((member) =>
					member.userId === userB.id ? { ...member, displayName: "Anna Holt" } : member,
				),
			},
		});
		renderRail(rail, s.company, context);
		expect([...marker()!.querySelectorAll(".person-avatar")].map((face) => face.textContent)).toEqual(["AH", "MH"]);
		expect(row.getAttribute("aria-description")).toBe("Anna Holt and Mads Holm are here");
		await s.publish([]);
		renderRail(rail, s.company, context);
		expect(marker()).toBeNull();
		expect(rail.querySelector(`[data-agent-id="${staff.id}"]`)?.hasAttribute("aria-description")).toBe(false);
		expect(row.style.getPropertyValue("--here-count")).toBe("");
	});

	it("says a member is on What's new, on its entry and on the apps button while the drawer is shut", async () => {
		const s = await setup();
		const rail = document.createElement("aside");
		document.body.append(rail);
		const context = {
			profiles: [profileA],
			user: userA,
			auth: new AuthController(fixture().cloud),
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
			route: { name: "company", profileId: profileA.profileId, section: "home" } as const,
		};
		s.company.store.set({ whatsNew: { ready: 0 } });
		s.view.dispose();
		s.company.setOpenPlace("whats-new");
		expect(s.handle.setOpenThread).toHaveBeenLastCalledWith("@whats-new");
		await s.publish([tab(userB.id, "@whats-new")]);
		renderRail(rail, s.company, context);
		const entry = rail.querySelector<HTMLElement>('.rail-app[data-app-key="whats-new"]')!;
		expect(entry.getAttribute("aria-description")).toBe("Sofie Lund is here");
		expect(rail.querySelector(".rail-apps")?.getAttribute("aria-description")).toBe("Sofie Lund is here");
	});

	it("skips rail layout measurements and empty presence DOM scans on steady-state redraws", async () => {
		const s = await setup();
		const rail = document.createElement("aside");
		document.body.append(rail);
		const auth = new AuthController(fixture().cloud);
		const makeContext = (
			route:
				| { name: "company"; profileId: string; section: "home" }
				| { name: "company"; profileId: string; section: "staff"; id: string },
		) => ({
			profiles: [profileA],
			user: userA,
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
			route,
		});
		s.view.dispose();
		renderRail(rail, s.company, makeContext({ name: "company", profileId: profileA.profileId, section: "home" }));

		const list = rail.querySelector<HTMLElement>(".rail-scroll")!;
		list.animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation);
		const rectSpy = vi.spyOn(list, "getBoundingClientRect");
		const querySpy = vi.spyOn(rail, "querySelectorAll");
		renderRail(rail, s.company, makeContext({ name: "company", profileId: profileA.profileId, section: "home" }));
		expect(rectSpy).not.toHaveBeenCalled();
		expect(querySpy).not.toHaveBeenCalled();

		renderRail(
			rail,
			s.company,
			makeContext({ name: "company", profileId: profileA.profileId, section: "staff", id: staff.id }),
		);
		expect(rectSpy).toHaveBeenCalled();
	});

	it("clears presence markers on cached app tiles that leave and rejoin when a group folds", async () => {
		localStorage.clear();
		const s = await setup();
		s.view.dispose();
		s.company.store.set({
			apps: [
				{
					name: "brand",
					path: "apps/brand",
					manifest: {
						name: "Brand",
						about: null,
						emblem: "page",
						colour: null,
						entry: "index.html",
						owner: staff.id,
						posted: true,
						reads: [],
						writes: [],
						concept: false,
						cover: null,
						kit: null,
					},
					problems: [],
					version: null,
				},
				{
					name: "plan",
					path: "apps/plan",
					manifest: {
						name: "Plan",
						about: null,
						emblem: "page",
						colour: null,
						entry: "index.html",
						owner: staff.id,
						posted: true,
						reads: [],
						writes: [],
						concept: false,
						cover: null,
						kit: null,
					},
					problems: [],
					version: null,
				},
			],
			appGroups: parseAppGroups("- group market: Market\n  - app:brand Brand\n  - app:plan Plan\n"),
			appLayout: { layout: EMPTY_APP_LAYOUT, updatedAt: null },
		});
		const rail = document.createElement("aside");
		document.body.append(rail);
		const auth = new AuthController(fixture().cloud);
		const context = {
			profiles: [profileA],
			user: userA,
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
			route: { name: "company", profileId: profileA.profileId, section: "home" } as const,
		};
		const draw = () => renderRail(rail, s.company, context);
		draw();
		rail.querySelector<HTMLButtonElement>(".rail-apps")!.click();
		rail.querySelector<HTMLButtonElement>(".rail-app-group")!.click();
		await s.publish([tab(userB.id, "@app:brand")]);
		draw();
		const brandBefore = rail.querySelector<HTMLElement>("[data-app-key='app:brand']")!;
		expect(brandBefore.querySelector(".rail-here")).not.toBeNull();
		expect(brandBefore.getAttribute("aria-description")).toBe("Sofie Lund is here");

		rail.querySelector<HTMLButtonElement>(".rail-app-group")!.click();
		expect(rail.querySelector("[data-app-key='app:brand']")).toBeNull();

		await s.publish([]);
		draw();
		rail.querySelector<HTMLButtonElement>(".rail-app-group")!.click();
		const brandAfterEmpty = rail.querySelector<HTMLElement>("[data-app-key='app:brand']")!;
		expect(brandAfterEmpty).toBe(brandBefore);
		expect(brandAfterEmpty.querySelector(".rail-here")).toBeNull();
		expect(brandAfterEmpty.hasAttribute("aria-description")).toBe(false);

		await s.publish([tab(userB.id, "@app:brand")]);
		draw();
		expect(brandAfterEmpty.querySelector(".rail-here")).not.toBeNull();
		rail.querySelector<HTMLButtonElement>(".rail-app-group")!.click();
		await s.publish([tab(userC, `@agent:${staff.id}`)]);
		draw();
		rail.querySelector<HTMLButtonElement>(".rail-app-group")!.click();
		const brandAfterMove = rail.querySelector<HTMLElement>("[data-app-key='app:brand']")!;
		expect(brandAfterMove.querySelector(".rail-here")).toBeNull();
		expect(brandAfterMove.hasAttribute("aria-description")).toBe(false);
		localStorage.clear();
	});
});
