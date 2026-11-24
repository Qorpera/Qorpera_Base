// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { MemberChats, type MemberChatsHost } from "../src/app/member-chats.ts";
import { contactPlaces, railContacts, weave } from "../src/app/rail-contacts.ts";
import type { Route } from "../src/app/router.ts";
import type { InviteCalls } from "../src/app/views/invite-sheet.ts";
import { renderRail, type ShellContext } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import {
	type MemberChatCalls,
	type MemberChatList,
	type MemberChatSummary,
	type MemberContactPlace,
	type MemberContactPlacing,
	memberChatCalls,
	parseMemberChatList,
	parseMemberChats,
} from "../src/cloud/member-chats.ts";
import { applySidebarRequest, type CompanySidebar, PIN_LIMIT } from "../src/cloud/sidebar.ts";
import type { HostedProfileMember, HostedProfileTeam, HostedStaffAgent } from "../src/cloud/types.ts";
import appCss from "../src/styles/app.css?raw";
import { openMenu } from "../src/ui/context-menu.ts";
import { h } from "../src/ui/dom.ts";
import {
	deferred,
	fixture,
	id,
	profileA,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
} from "./fixtures.ts";
import { searchFromRail } from "./search-window-helpers.ts";

/* A member's contacts in their own rail (Jonas, 10 Nov 2026: "not sure I like the member contacts at the top,
 * undraggable and un-hideable"): where each stands (app/rail-contacts.ts), how a place is kept (app/member-chats.ts,
 * cloud/member-chats.ts) and the rail itself: contacts drag, pin and hide like agents, and their places are the
 * member's own. */

const me = userA.id;
const sofie = id(60);
const mads = id(61);
const nora = id(62);
const member = (userId: string, name: string): HostedProfileMember => ({
	userId,
	email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.invalid`,
	displayName: name,
	role: userId === me ? "owner" : "admin",
	joinedAt: timestamp,
});
const people = [member(me, "Ann Holm"), member(sofie, "Sofie Lund"), member(mads, "Mads Berg")];
const agent = (n: number, name: string): HostedStaffAgent => ({ ...staff, id: id(n), displayName: name });
const cofounder: HostedStaffAgent = { ...agent(40, "Co-Founder"), templateId: "co-founder" };
const [ada, bo, cy, dee] = [agent(41, "Ada"), agent(42, "Bo"), agent(43, "Cy"), agent(44, "Dee")];
const research = id(70);
const ops = id(71);
/** Research holds Bo then Ada, Ops nobody; Cy is in no section and Dee is pinned. */
const demo = (): CompanySidebar => ({
	sections: [
		{ sectionId: research, name: "Research" },
		{ sectionId: ops, name: "Ops" },
	],
	placements: { [bo.id]: { sectionId: research, position: 0 }, [ada.id]: { sectionId: research, position: 1 } },
	pinned: [dee.id],
	hidden: [],
});
const summary = (userId: string, extra: Partial<MemberChatSummary> = {}): MemberChatSummary => ({
	userId,
	lastSeenAt: null,
	unread: 0,
	readSeq: 0,
	theirReadSeq: 0,
	last: null,
	...extra,
});
const placed = (userId: string, place: MemberContactPlace, extra: Partial<MemberChatSummary> = {}) =>
	summary(userId, { place, ...extra });
const listed = (chats: MemberChatSummary[], placing = true): MemberChatList => ({ chats, placing });
const asRecord = (chats: MemberChatSummary[]) => Object.fromEntries(chats.map((chat) => [chat.userId, chat]));

const cleanup: (() => void)[] = [];
beforeEach(() => {
	stubFigureMotion();
	vi.stubGlobal("innerWidth", 1280);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	openMenu()?.close();
	document.body.replaceChildren();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("where a contact stands", () => {
	const contact = (userId: string, after: string | undefined, rank: number) => ({
		userId,
		zone: "unassigned",
		...(after ? { after } : {}),
		rank,
		hidden: false,
		place: { zone: "unassigned" as const, ...(after ? { after } : {}), rank },
	});

	it("weaves contacts among a zone's agents, each after the one it stands after", () => {
		expect(weave(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
		expect(weave(["a", "b", "c"], [contact("x", "a", 0), contact("y", undefined, 0), contact("z", "c", 0)])).toEqual([
			"y",
			"a",
			"x",
			"b",
			"c",
			"z",
		]);
		// After the same agent: by rank, then as given. An anchor that left the zone leaves its contact last.
		expect(
			weave(["a", "b"], [contact("x", "a", 2), contact("gone", "q", 0), contact("y", "a", 1), contact("w", "a", 2)]),
		).toEqual(["a", "y", "x", "w", "b", "gone"]);
		// The Members group has no agents: its contacts stand by rank alone.
		expect(weave([], [contact("x", undefined, 5001), contact("y", undefined, 0)])).toEqual(["y", "x"]);
	});

	it("draws a contact where its member put it, and in the Members group until then", () => {
		const chats = asRecord([
			summary(sofie),
			placed(mads, { zone: "section", sectionId: research, after: bo.id, rank: 1 }),
			placed(nora, { zone: "pinned", rank: 0 }, { hidden: true }),
		]);
		const drawn = railContacts([sofie, mads, nora, id(99)], chats, new Set([research]));
		expect(drawn.map(({ userId, zone, after, rank, hidden }) => ({ userId, zone, after, rank, hidden }))).toEqual([
			// Never placed: the Members group, after the placed ones, in the order the members joined.
			{ userId: sofie, zone: "members", after: undefined, rank: 5000, hidden: false },
			{ userId: mads, zone: `section:${research}`, after: bo.id, rank: 1, hidden: false },
			{ userId: nora, zone: "pinned", after: undefined, rank: 0, hidden: true },
		]);
		// What hiding or showing one sends: its kept place, or the Members group for one never placed.
		expect(drawn.map((item) => item.place)).toEqual([
			{ zone: "members", rank: 5000 },
			{ zone: "section", sectionId: research, after: bo.id, rank: 1 },
			{ zone: "pinned", rank: 0 },
		]);
		// A section that is gone: back in the Members group, and that is its place from here on (the cloud refuses a
		// section the company does not have, so the kept one is never sent back to it).
		const gone = railContacts([sofie, mads, nora], chats, new Set([ops]));
		expect(gone.map((item) => [item.zone, item.rank])).toEqual([
			["members", 5000],
			["members", 5001],
			["pinned", 0],
		]);
		expect(gone[1]?.place).toEqual({ zone: "members", rank: 5001 });
		// A rail with no sidebar has the Members group alone: everyone is drawn there, a pinned place kept as it is.
		const bare = railContacts([sofie, mads, nora], chats, undefined);
		expect(bare.map((item) => item.zone)).toEqual(["members", "members", "members"]);
		expect(bare.map((item) => item.place)).toEqual([
			{ zone: "members", rank: 5000 },
			{ zone: "members", rank: 5001 },
			{ zone: "pinned", rank: 0 },
		]);
	});

	it("reads each contact's place off a zone's rows, and names only the ones that change", () => {
		const chats = asRecord([
			placed(sofie, { zone: "section", sectionId: research, after: bo.id, rank: 0 }),
			summary(mads),
			summary(nora, { hidden: true }),
		]);
		// Bo, Sofie, Mads, Ada, Nora: Sofie stays after Bo, Mads joins her there, Nora stands after Ada.
		expect(contactPlaces(`section:${research}`, [bo.id, sofie, mads, ada.id, nora], chats)).toEqual([
			{ userId: mads, place: { zone: "section", sectionId: research, after: bo.id, rank: 1 }, hidden: false },
			{ userId: nora, place: { zone: "section", sectionId: research, after: ada.id, rank: 0 }, hidden: true },
		]);
		// First in a zone: no anchor. A contact dragged out of Hidden shows again where it lands.
		expect(contactPlaces("pinned", [nora, dee.id, sofie], chats, nora)).toEqual([
			{ userId: nora, place: { zone: "pinned", rank: 0 }, hidden: false },
			{ userId: sofie, place: { zone: "pinned", after: dee.id, rank: 0 }, hidden: false },
		]);
		expect(contactPlaces("unassigned", [mads, cy.id], chats)).toEqual([
			{ userId: mads, place: { zone: "unassigned", rank: 0 }, hidden: false },
		]);
		// The Members group orders its contacts by rank alone.
		expect(contactPlaces("members", [mads, sofie], chats)).toEqual([
			{ userId: mads, place: { zone: "members", rank: 0 }, hidden: false },
			{ userId: sofie, place: { zone: "members", rank: 1 }, hidden: false },
		]);
		// Nothing moved: nothing to keep.
		expect(contactPlaces(`section:${research}`, [bo.id, sofie, ada.id], chats)).toEqual([]);
	});
});

describe("the cloud's contact places", () => {
	const wire = (userId: string, extra: Record<string, unknown> = {}) => ({
		userId,
		lastSeenAt: null,
		unread: 0,
		readSeq: 0,
		theirReadSeq: 0,
		last: null,
		...extra,
	});

	it("reads each contact's place and whether the cloud keeps places at all", () => {
		const list = parseMemberChatList({
			schema: "qorpera.member-chats/v1",
			placing: true,
			chats: [
				wire(sofie, { hidden: false }),
				wire(mads, { hidden: true, place: { zone: "section", sectionId: research, after: bo.id, rank: 2 } }),
				wire(nora, { hidden: false, place: { zone: "members", rank: 0 } }),
			],
		});
		expect(list.placing).toBe(true);
		expect(list.chats.map(({ userId, place, hidden }) => ({ userId, place, hidden }))).toEqual([
			{ userId: sofie, place: undefined, hidden: undefined },
			{ userId: mads, place: { zone: "section", sectionId: research, after: bo.id, rank: 2 }, hidden: true },
			{ userId: nora, place: { zone: "members", rank: 0 }, hidden: undefined },
		]);
		// A cloud from before places: the same list, and nothing can be moved.
		expect(parseMemberChatList({ schema: "qorpera.member-chats/v1", chats: [wire(sofie)] })).toEqual({
			chats: [summary(sofie)],
			placing: false,
		});
	});

	it("refuses a place the cloud could not have kept", () => {
		for (const place of [
			{ zone: "top", rank: 0 },
			{ zone: "section", rank: 0 },
			{ zone: "section", sectionId: "research", rank: 0 },
			{ zone: "pinned", sectionId: research, rank: 0 },
			{ zone: "members", after: bo.id, rank: 0 },
			{ zone: "pinned", after: "first", rank: 0 },
			{ zone: "members", rank: -1 },
			{ zone: "members", rank: 10000 },
			{ zone: "members", rank: 1.5 },
			{ zone: "members" },
			"pinned",
		])
			expect(
				() => parseMemberChats({ schema: "qorpera.member-chats/v1", chats: [wire(sofie, { place })] }),
				JSON.stringify(place),
			).toThrow();
		expect(() =>
			parseMemberChats({ schema: "qorpera.member-chats/v1", chats: [wire(sofie, { hidden: "no" })] }),
		).toThrow();
	});

	it("sends each contact's whole place, and takes the list it answers", async () => {
		const rpc = vi.fn(
			async (_name: string, _args?: Record<string, unknown>): Promise<unknown> => ({
				schema: "qorpera.member-chats/v1",
				placing: true,
				chats: [wire(sofie, { hidden: true, place: { zone: "pinned", after: dee.id, rank: 1 } })],
			}),
		);
		const calls = memberChatCalls({ rpc }, profileA.profileId);
		const answer = await calls.place([
			{ userId: sofie, place: { zone: "pinned", after: dee.id, rank: 1 }, hidden: true },
			{ userId: mads, place: { zone: "section", sectionId: research, rank: 0 }, hidden: false },
			{ userId: nora, place: { zone: "members", rank: 3 }, hidden: false },
		]);
		expect(rpc.mock.calls).toEqual([
			[
				"qorpera_place_member_contacts",
				{
					p_profile_id: profileA.profileId,
					p_contacts: [
						{ userId: sofie, zone: "pinned", after: dee.id, rank: 1, hidden: true },
						{ userId: mads, zone: "section", sectionId: research, rank: 0, hidden: false },
						{ userId: nora, zone: "members", rank: 3, hidden: false },
					],
				},
			],
		]);
		expect(answer.placing).toBe(true);
		expect(answer.chats[0]).toMatchObject({ userId: sofie, hidden: true, place: { zone: "pinned", after: dee.id } });
	});
});

describe("keeping a place", () => {
	function chats(calls: Partial<MemberChatCalls>, initial: MemberChatSummary[] = [summary(sofie), summary(mads)]) {
		const state: { summaries?: Readonly<Record<string, MemberChatSummary>>; placing?: boolean; failed: number } = {
			summaries: asRecord(initial),
			failed: 0,
		};
		const all = {
			list: vi.fn(async () => listed(initial)),
			place: vi.fn(async (_contacts: readonly MemberContactPlacing[]) => listed(initial)),
			...calls,
		} as MemberChatCalls;
		const host: MemberChatsHost = {
			userId: me,
			calls: () => all,
			available: () => true,
			visible: () => true,
			summaries: () => state.summaries,
			setSummaries: (next, placing) => {
				state.summaries = next;
				if (placing !== undefined) state.placing = placing;
			},
			setUnavailable: () => {},
			placeFailed: () => {
				state.failed++;
			},
		};
		const controller = new MemberChats(host);
		cleanup.push(() => controller.stop());
		return { controller, calls: all, state };
	}
	const pinned: MemberContactPlace = { zone: "pinned", rank: 0 };

	it("draws a place at once, sends it, and takes the list the cloud answers", async () => {
		const answer = deferred<MemberChatList>();
		const { controller, calls, state } = chats({ place: vi.fn(() => answer.promise) });
		controller.place([
			{ userId: sofie.toUpperCase(), place: pinned, hidden: true },
			// Someone who is no contact of this member is not sent.
			{ userId: nora, place: pinned, hidden: false },
		]);
		expect(state.summaries?.[sofie]).toEqual({ ...summary(sofie), place: pinned, hidden: true });
		expect(state.summaries?.[mads]).toEqual(summary(mads));
		await settle();
		expect(calls.place).toHaveBeenCalledTimes(1);
		expect(calls.place).toHaveBeenLastCalledWith([{ userId: sofie, place: pinned, hidden: true }]);
		// Shown again: `hidden` goes from what is drawn, as the cloud answers a shown contact.
		controller.place([{ userId: sofie, place: pinned, hidden: false }]);
		expect(state.summaries?.[sofie]).toEqual({ ...summary(sofie), place: pinned });
		answer.resolve(listed([placed(sofie, pinned, { unread: 4 }), summary(mads)]));
		await settle();
		// Both are kept, one after the other; the last answer is the list as it stands.
		expect(calls.place).toHaveBeenCalledTimes(2);
		expect(state.summaries?.[sofie]).toEqual(placed(sofie, pinned, { unread: 4 }));
		expect(state.placing).toBe(true);
		expect(state.failed).toBe(0);
	});

	it("takes no list from before a place while the place is on its way", async () => {
		const before = deferred<MemberChatList>();
		const during = deferred<MemberChatList>();
		const answer = deferred<MemberChatList>();
		const list = vi
			.fn<MemberChatCalls["list"]>()
			.mockReturnValueOnce(before.promise)
			.mockReturnValueOnce(during.promise);
		const { controller, state } = chats({ list, place: vi.fn(() => answer.promise) });
		const early = controller.refresh();
		controller.place([{ userId: sofie, place: pinned, hidden: false }]);
		const late = controller.refresh();
		// Both lists are from before the cloud kept the place: neither puts the contact back.
		before.resolve(listed([summary(sofie), summary(mads)]));
		during.resolve(listed([summary(sofie), summary(mads)]));
		await Promise.all([early, late]);
		expect(state.summaries?.[sofie]?.place).toEqual(pinned);
		answer.resolve(listed([placed(sofie, pinned), summary(mads, { unread: 1 })]));
		await settle();
		expect(state.summaries).toEqual(asRecord([placed(sofie, pinned), summary(mads, { unread: 1 })]));
	});

	it("says so when a place was not kept, and shows what the cloud has", async () => {
		const { controller, calls, state } = chats({
			place: vi.fn(async () => {
				throw new Error("Failed to fetch");
			}),
		});
		controller.place([{ userId: sofie, place: pinned, hidden: false }]);
		expect(state.summaries?.[sofie]?.place).toEqual(pinned);
		await settle();
		expect(state.failed).toBe(1);
		expect(calls.list).toHaveBeenCalledTimes(1);
		expect(state.summaries).toEqual(asRecord([summary(sofie), summary(mads)]));
	});

	it("sends a big change in parts of a hundred", async () => {
		const many = Array.from({ length: 230 }, (_, index) => summary(id(1000 + index)));
		const { controller, calls } = chats({}, many);
		controller.place(
			many.map((chat, rank) => ({ userId: chat.userId, place: { zone: "members", rank }, hidden: false })),
		);
		await settle();
		expect(vi.mocked(calls.place).mock.calls.map(([contacts]) => contacts.length)).toEqual([100, 100, 30]);
	});
});

/** A company with the demo sidebar and other members, whose cloud keeps contacts' places as the real one does. */
function companyWith(
	options: {
		chats?: MemberChatSummary[];
		members?: HostedProfileMember[];
		sidebar?: CompanySidebar | "missing";
		/** The company's agents beside the Co-Founder (Ada, Bo, Cy and Dee when not said). */
		agents?: HostedStaffAgent[];
		/** A cloud from before places: the list says nothing of them. */
		placing?: boolean;
		capabilities?: HostedProfileTeam["capabilities"];
		route?: Route;
		invites?: InviteCalls;
		/** Whether the cloud keeps the next place. */
		keeps?: () => boolean;
	} = {},
) {
	const f = fixture();
	const agents = options.agents ?? [ada, bo, cy, dee];
	let stored = options.sidebar === "missing" ? undefined : (options.sidebar ?? demo());
	if (stored) vi.spyOn(f.api, "readCompanySidebar").mockImplementation(async () => structuredClone(stored!));
	const manage = vi.spyOn(f.api, "manageCompanySidebar").mockImplementation(async (_profileId, request) => {
		stored = applySidebarRequest(
			stored!,
			request,
			agents.map((item) => item.id),
		);
		return structuredClone(stored);
	});
	const kept = new Map((options.chats ?? [summary(sofie), summary(mads)]).map((chat) => [chat.userId, chat]));
	const placing = options.placing !== false;
	const list = () => ({
		schema: "qorpera.member-chats/v1",
		...(placing ? { placing: true } : {}),
		chats: [...kept.values()].map(({ hidden, ...chat }) => ({
			...chat,
			...(placing ? { hidden: hidden === true } : {}),
		})),
	});
	const places: MemberContactPlacing[][] = [];
	vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
		if (name === "qorpera_list_member_chats") return list();
		if (name === "qorpera_place_member_contacts") {
			if (options.keeps?.() === false) throw new Error("Failed to fetch");
			const contacts = args.p_contacts as (MemberContactPlace & { userId: string; hidden: boolean })[];
			// As the cloud does: a section the company does not have refuses the whole call.
			if (contacts.some((item) => item.sectionId && !stored?.sections.some((s) => s.sectionId === item.sectionId)))
				throw new CloudRpcError(name, { message: "Contact places are invalid", code: "22023" }, 400);
			places.push(contacts.map(({ userId, hidden, ...place }) => ({ userId, place, hidden })));
			for (const { userId, hidden, ...place } of contacts) {
				const { hidden: _was, ...chat } = kept.get(userId)!;
				kept.set(userId, { ...chat, place, ...(hidden ? { hidden: true as const } : {}) });
			}
			return list();
		}
		throw new Error(`Unexpected RPC ${name}`);
	});
	const company = new CompanyController(f.api, profileA, me);
	company.store.set({
		loading: false,
		staff: [cofounder, ...agents],
		team: {
			...team,
			...(options.capabilities ? { capabilities: options.capabilities } : {}),
			members: options.members ?? people,
		},
	});
	cleanup.push(() => company.stop());
	const rail = h("aside", { class: "rail" });
	document.body.append(h("div", { class: "frame" }, rail));
	const auth = new AuthController(f.cloud);
	cleanup.push(() => auth.dispose());
	const route: Route = options.route ?? { name: "company", profileId: profileA.profileId, section: "home" };
	const openCard = vi.fn<NonNullable<ShellContext["openAgentCard"]>>();
	const draw = () =>
		renderRail(rail, company, {
			profiles: [profileA],
			user: userA,
			route,
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
			openFriends: () => {},
			agentActions: {},
			openAgentCard: openCard,
			openGroupCard: () => {},
			...(options.invites ? { invites: options.invites } : {}),
		});
	cleanup.push(company.store.subscribe(draw));
	draw();
	const ready = Promise.all([company.refreshSidebar(), company.memberChats.refresh()]).then(settle);
	return { f, company, rail, draw, manage, places, openCard, ready };
}

const names = (elements: Iterable<Element>) =>
	[...elements].map((element) => element.querySelector("strong")?.textContent);
/** The rail's zones, each with its title (when it shows one) and its rows. */
const zones = (rail: HTMLElement): Record<string, (string | null | undefined)[]> => ({
	pinned: names(rail.querySelectorAll(".rail-pinned > a")),
	...Object.fromEntries(
		[...rail.querySelectorAll<HTMLElement>(".rail-section")].map((group) => [
			group.classList.contains("rail-members")
				? "members"
				: (group.querySelector<HTMLElement>(".rail-section-title")!.textContent ?? ""),
			names(group.querySelectorAll(".rail-section-list > a")),
		]),
	),
});
const rowOf = (rail: HTMLElement, name: string) =>
	[...rail.querySelectorAll<HTMLElement>("[data-agent-id], [data-member-id]")].find(
		(row) => row.querySelector("strong")?.textContent === name,
	)!;
function rightClick(element: Element) {
	const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
	element.dispatchEvent(event);
	return event;
}
const menuItems = () =>
	[...document.querySelectorAll<HTMLElement>(".context-menu [role^=menuitem]")].map((item) => item.textContent);
const choose = (label: string) =>
	[...document.querySelectorAll<HTMLElement>(".context-menu [role^=menuitem]")]
		.find((item) => item.textContent === label)!
		.click();

describe("contacts in the rail", () => {
	it("stands contacts in the Members group, after everything the company arranges", async () => {
		const { rail, ready } = companyWith();
		await ready;
		expect(zones(rail)).toEqual({
			pinned: ["Dee"],
			Research: ["Bo", "Ada"],
			Ops: [],
			Unassigned: ["Cy"],
			members: ["Sofie Lund", "Mads Berg"],
		});
		// The group is named, as the sections are; it is a place contacts land in.
		const group = rail.querySelector<HTMLElement>(".rail-members")!;
		expect(group.querySelector<HTMLElement>(".rail-section-title")!.hidden).toBe(false);
		expect(group.querySelector(".rail-agents-label")!.textContent).toBe("Members");
		expect(group.dataset.dropZone).toBe("members");
		const dock = rail.querySelector(".rail-scroll")!.lastElementChild!;
		expect(dock.classList.contains("rail-dock")).toBe(true);
		expect(group.parentElement).toBe(dock);
		expect(dock.lastElementChild).toBe(group);
	});

	it("folds Members by default, like Agents, and opens it from its title for good", async () => {
		const { rail, ready } = companyWith();
		await ready;
		const group = rail.querySelector<HTMLElement>(".rail-members")!;
		const title = group.querySelector<HTMLButtonElement>("button.rail-section-title")!;
		expect(group.classList.contains("is-open")).toBe(false);
		expect(title.getAttribute("aria-expanded")).toBe("false");
		expect(group.querySelector(".rail-agents-count")!.textContent).toBe("2");
		expect(group.querySelector(".rail-agents-body")!.hasAttribute("inert")).toBe(true);
		title.click();
		expect(group.classList.contains("is-open")).toBe(true);
		expect(group.querySelector(".rail-agents-body")!.hasAttribute("inert")).toBe(false);
		expect(localStorage.getItem("qorpera.web.rail-members-open")).toBe("1");
	});

	it("holds Members open while a member's message waits, until it is folded by hand or another waits", async () => {
		const { rail, company, ready } = companyWith({
			members: [...people, member(nora, "Nora Friis")],
			chats: [summary(sofie, { unread: 2 }), summary(mads, { unread: 1 }), summary(nora)],
		});
		await ready;
		const group = rail.querySelector<HTMLElement>(".rail-members")!;
		const unread = async (userId: string, count: number) => {
			const chats = company.store.get().memberChats!;
			company.store.set({ memberChats: { ...chats, [userId]: { ...chats[userId]!, unread: count } } });
			await settle();
		};
		expect(group.classList.contains("is-open")).toBe(true);
		group.querySelector<HTMLButtonElement>("button.rail-section-title")!.click();
		expect(group.classList.contains("is-open")).toBe(false);
		expect(localStorage.getItem("qorpera.web.rail-members-open")).toBe("0");
		await unread(sofie, 0);
		expect(group.classList.contains("is-open")).toBe(false);
		await unread(nora, 1);
		expect(group.classList.contains("is-open")).toBe(true);
	});

	it("draws each contact where its member put it: pinned as a card, in a section after its agent", async () => {
		const { rail, company, ready } = companyWith({
			members: [...people, member(nora, "Nora Friis")],
			chats: [
				placed(sofie, { zone: "pinned", after: dee.id, rank: 0 }, { unread: 2 }),
				placed(mads, { zone: "section", sectionId: research, after: bo.id, rank: 0 }),
				placed(nora, { zone: "unassigned", rank: 0 }),
			],
		});
		await ready;
		expect(zones(rail)).toEqual({
			pinned: ["Dee", "Sofie"],
			Research: ["Bo", "Mads Berg", "Ada"],
			Ops: [],
			Unassigned: ["Nora Friis", "Cy"],
			members: [],
		});
		const card = rail.querySelector<HTMLElement>(`.rail-pinned [data-member-id="${sofie}"]`)!;
		expect(card.classList.contains("rail-pin-member")).toBe(true);
		expect(card.querySelector(".rail-count")?.textContent).toBe("2");
		// With nobody in it the Members group names nothing; it stays in the list as the place to drop a contact back.
		expect(rail.querySelector(".rail-members")!.classList.contains("is-empty")).toBe(true);
		// Bo is pinned: Mads keeps standing after him, where he was put, and so stands first in the section.
		void company.changeSidebar({ action: "set_pins", order: [dee.id, bo.id] });
		await settle();
		expect(zones(rail).Research).toEqual(["Mads Berg", "Ada"]);
		expect(zones(rail).pinned).toEqual(["Dee", "Sofie", "Bo"]);
	});

	it("leaves a contact at the end of its zone when its agent left, and in the Members group when its section is gone", async () => {
		const { rail, company, ready } = companyWith({
			chats: [
				placed(sofie, { zone: "section", sectionId: research, after: cy.id, rank: 0 }),
				placed(mads, { zone: "section", sectionId: id(79), after: bo.id, rank: 0 }),
			],
		});
		await ready;
		expect(zones(rail)).toMatchObject({ Research: ["Bo", "Ada", "Sofie Lund"], members: ["Mads Berg"] });
		// Without the sidebar the rail has one list and the Members group: every contact stands there.
		company.store.set({ sidebarUnavailable: true, sidebar: undefined });
		await settle();
		expect(zones(rail)).toEqual({
			pinned: [],
			Unassigned: ["Ada", "Bo", "Cy", "Dee"],
			members: ["Sofie Lund", "Mads Berg"],
		});
	});

	it("hides a contact from its menu, counts its messages on the fold, and shows it again from there", async () => {
		const { rail, places, ready } = companyWith({
			chats: [summary(sofie, { unread: 3 }), placed(mads, { zone: "unassigned", after: cy.id, rank: 0 })],
		});
		await ready;
		expect(rightClick(rowOf(rail, "Sofie Lund")).defaultPrevented).toBe(true);
		expect(openMenu()?.el.getAttribute("aria-label")).toBe("Sofie Lund actions");
		expect(menuItems()).toEqual(["Message", "Pin", "Hide from sidebar"]);
		choose("Hide from sidebar");
		await settle();
		// Never placed, she keeps her place in the Members group for when she is shown again.
		expect(places).toEqual([[{ userId: sofie, place: { zone: "members", rank: 5000 }, hidden: true }]]);
		expect(zones(rail).members).toEqual([]);
		const fold = rail.querySelector<HTMLElement>(".rail-hidden-toggle")!;
		expect(fold.querySelector(".rail-hidden-count")?.textContent).toBe("1");
		// A hidden contact is still heard: her three messages stand on the fold.
		expect(fold.querySelector<HTMLElement>(".rail-hidden-unread")?.hidden).toBe(false);
		expect(fold.querySelector(".rail-hidden-unread")?.textContent).toBe("3");
		expect(fold.getAttribute("aria-label")).toBe("Hidden: 1 · Unread: 3");
		expect(searchFromRail(rail, "sofie")).toEqual(["Sofie Lund"]);
		fold.click();
		const hidden = rail.querySelector<HTMLElement>(`.rail-hidden-list [data-member-id="${sofie}"]`)!;
		expect(hidden.querySelector(".rail-count")?.textContent).toBe("3");
		// Open, the fold lists her with her own count.
		expect(fold.querySelector<HTMLElement>(".rail-hidden-unread")?.hidden).toBe(true);
		rightClick(hidden);
		expect(menuItems()).toEqual(["Message", "Show in sidebar"]);
		choose("Show in sidebar");
		await settle();
		expect(places[1]).toEqual([{ userId: sofie, place: { zone: "members", rank: 5000 }, hidden: false }]);
		expect(zones(rail).members).toEqual(["Sofie Lund"]);
		expect(rail.querySelector(".rail-hidden")).toBeNull();
		// A placed contact keeps its place while hidden.
		rightClick(rowOf(rail, "Mads Berg"));
		choose("Hide from sidebar");
		await settle();
		expect(places[2]).toEqual([{ userId: mads, place: { zone: "unassigned", after: cy.id, rank: 0 }, hidden: true }]);
		expect(zones(rail).Unassigned).toEqual(["Cy"]);
	});

	it("hides and shows a contact whose section the company deleted", async () => {
		// Review of #1652, F1: the kept place named a section that is gone, the cloud refused it, and the contact could
		// be neither hidden nor shown again.
		const { rail, company, places, ready } = companyWith({
			chats: [summary(sofie), placed(mads, { zone: "section", sectionId: id(79), after: bo.id, rank: 0 })],
		});
		await ready;
		expect(zones(rail).members).toEqual(["Sofie Lund", "Mads Berg"]);
		rightClick(rowOf(rail, "Mads Berg"));
		choose("Hide from sidebar");
		await settle();
		expect(places).toEqual([[{ userId: mads, place: { zone: "members", rank: 5001 }, hidden: true }]]);
		expect(company.store.get().railError).toBeUndefined();
		expect(zones(rail).members).toEqual(["Sofie Lund"]);
		rail.querySelector<HTMLElement>(".rail-hidden-toggle")!.click();
		rightClick(rail.querySelector(`.rail-hidden-list [data-member-id="${mads}"]`)!);
		choose("Show in sidebar");
		await settle();
		expect(places[1]).toEqual([{ userId: mads, place: { zone: "members", rank: 5001 }, hidden: false }]);
		expect(zones(rail).members).toEqual(["Sofie Lund", "Mads Berg"]);
		// A section deleted while the contact is hidden in it: shown again, it stands in the Members group.
		rightClick(rowOf(rail, "Sofie Lund"));
		choose("Hide from sidebar");
		await settle();
		const hiddenInOps = company.store.get().memberChats![sofie]!;
		company.store.set({
			memberChats: {
				...company.store.get().memberChats,
				[sofie]: { ...hiddenInOps, place: { zone: "section", sectionId: id(78), rank: 0 } },
			},
		});
		rightClick(rail.querySelector(`.rail-hidden-list [data-member-id="${sofie}"]`)!);
		choose("Show in sidebar");
		await settle();
		expect(places.at(-1)).toEqual([{ userId: sofie, place: { zone: "members", rank: 5000 }, hidden: false }]);
		expect(company.store.get().railError).toBeUndefined();
	});

	it("pins and unpins a contact from its menu", async () => {
		const { rail, places, ready } = companyWith();
		await ready;
		rightClick(rowOf(rail, "Mads Berg"));
		choose("Pin");
		await settle();
		expect(places).toEqual([[{ userId: mads, place: { zone: "pinned", after: dee.id, rank: 0 }, hidden: false }]]);
		expect(zones(rail)).toMatchObject({ pinned: ["Dee", "Mads"], members: ["Sofie Lund"] });
		rightClick(rail.querySelector(`.rail-pinned [data-member-id="${mads}"]`)!);
		expect(menuItems()).toEqual(["Message", "Unpin", "Hide from sidebar"]);
		choose("Unpin");
		await settle();
		// Back in the Members group, after the contacts there.
		expect(places[1]).toEqual([
			{ userId: sofie, place: { zone: "members", rank: 0 }, hidden: false },
			{ userId: mads, place: { zone: "members", rank: 1 }, hidden: false },
		]);
		expect(zones(rail)).toMatchObject({ pinned: ["Dee"], members: ["Sofie Lund", "Mads Berg"] });
		// Hidden, a pinned contact loses its pin, as a hidden agent does: shown again, it is in the Members group.
		rightClick(rowOf(rail, "Sofie Lund"));
		choose("Pin");
		await settle();
		expect(zones(rail).pinned).toEqual(["Dee", "Sofie"]);
		rightClick(rail.querySelector(`.rail-pinned [data-member-id="${sofie}"]`)!);
		choose("Hide from sidebar");
		await settle();
		expect(places.at(-1)).toEqual([
			{ userId: mads, place: { zone: "members", rank: 0 }, hidden: false },
			{ userId: sofie, place: { zone: "members", rank: 1 }, hidden: true },
		]);
		expect(zones(rail)).toMatchObject({ pinned: ["Dee"], members: ["Mads Berg"] });
	});

	it("says the pinned row is full, and pins nothing more", async () => {
		const full = Array.from({ length: PIN_LIMIT }, (_, index) => agent(100 + index, `Agent ${index}`));
		const { rail, company, places, ready } = companyWith({
			agents: full,
			sidebar: { sections: [], placements: {}, pinned: full.map((item) => item.id), hidden: [] },
		});
		await ready;
		rightClick(rowOf(rail, "Mads Berg"));
		choose("Pin");
		await settle();
		expect(places).toEqual([]);
		expect(company.store.get().railError).toBe("The pinned row is full. Unpin something first.");
	});

	it("counts agents and contacts alike against the pinned row's limit", async () => {
		// Review of #1652, F3: with 23 agents and a contact pinned, one more agent made 25 cards.
		const most = Array.from({ length: PIN_LIMIT - 1 }, (_, index) => agent(100 + index, `Agent ${index}`));
		const { rail, manage, places, openCard, company, ready } = companyWith({
			agents: [...most, ada, bo],
			chats: [placed(sofie, { zone: "pinned", rank: 0 }), summary(mads)],
			sidebar: { sections: [], placements: {}, pinned: most.map((item) => item.id), hidden: [] },
		});
		await ready;
		expect(rail.querySelectorAll(".rail-pinned > a")).toHaveLength(PIN_LIMIT);
		// An agent's card offers no Pin, and another contact is told the row is full.
		rightClick(rowOf(rail, "Ada"));
		expect(openCard.mock.lastCall?.[2].pin).toBeUndefined();
		rightClick(rowOf(rail, "Mads Berg"));
		choose("Pin");
		await settle();
		expect(company.store.get().railError).toBe("The pinned row is full. Unpin something first.");
		expect(manage).not.toHaveBeenCalled();
		expect(places).toEqual([]);
		// One card fewer, and the card offers Pin again: the agent takes the last place.
		rightClick(rail.querySelector(`.rail-pinned [data-member-id="${sofie}"]`)!);
		choose("Unpin");
		await settle();
		rightClick(rowOf(rail, "Ada"));
		const card = openCard.mock.lastCall![2];
		expect(card.pinned).toBe(false);
		card.pin!();
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "set_pins",
			order: [...most.map((item) => item.id), ada.id],
		});
		// Full again, of agents alone: the contact finds no room now.
		rightClick(rowOf(rail, "Sofie Lund"));
		choose("Pin");
		await settle();
		expect(company.store.get().railError).toBe("The pinned row is full. Unpin something first.");
		expect(rail.querySelectorAll(".rail-pinned > a")).toHaveLength(PIN_LIMIT);
	});

	it("offers no menu and no drag on a cloud that keeps no places, or without the sidebar's pinned row", async () => {
		const old = companyWith({ placing: false });
		await old.ready;
		expect(zones(old.rail).members).toEqual(["Sofie Lund", "Mads Berg"]);
		expect(old.rail.querySelector<HTMLElement>(".rail-members")!.dataset.dropZone).toBeUndefined();
		rightClick(rowOf(old.rail, "Sofie Lund"));
		expect(menuItems()).toEqual(["Message"]);
		openMenu()?.close();
		document.body.replaceChildren();
		// No sidebar: nothing to pin to, but a contact still hides.
		const bare = companyWith({ sidebar: "missing" });
		await bare.ready;
		rightClick(rowOf(bare.rail, "Sofie Lund"));
		expect(menuItems()).toEqual(["Message", "Hide from sidebar"]);
	});

	it("puts a contact back and says why when the cloud did not keep its place", async () => {
		let keeps = false;
		const { rail, company, ready } = companyWith({ keeps: () => keeps });
		await ready;
		rightClick(rowOf(rail, "Sofie Lund"));
		choose("Pin");
		await settle();
		expect(company.store.get().railError).toBe("The sidebar could not be changed. Try again.");
		expect(zones(rail)).toMatchObject({ pinned: ["Dee"], members: ["Sofie Lund", "Mads Berg"] });
		// The next try takes what the rail said away, and is kept.
		keeps = true;
		rightClick(rowOf(rail, "Sofie Lund"));
		choose("Pin");
		await settle();
		expect(company.store.get().railError).toBeUndefined();
		expect(zones(rail).pinned).toEqual(["Dee", "Sofie"]);
	});

	it("moves the focused contact with Alt and an arrow, and steps an agent over a contact", async () => {
		const { rail, manage, places, ready } = companyWith({
			chats: [placed(sofie, { zone: "section", sectionId: research, after: bo.id, rank: 0 }), summary(mads)],
		});
		await ready;
		const press = (row: HTMLElement, key: string) => {
			row.focus();
			row.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }));
		};
		// Bo, Sofie, Ada: Sofie steps up, over Bo. Only where she stands changes.
		press(rowOf(rail, "Sofie Lund"), "ArrowUp");
		await settle();
		expect(places).toEqual([
			[{ userId: sofie, place: { zone: "section", sectionId: research, rank: 0 }, hidden: false }],
		]);
		expect(zones(rail).Research).toEqual(["Sofie Lund", "Bo", "Ada"]);
		expect(document.activeElement).toBe(rowOf(rail, "Sofie Lund"));
		// Already first: nothing to do.
		press(rowOf(rail, "Sofie Lund"), "ArrowUp");
		await settle();
		expect(places).toHaveLength(1);
		// Bo steps up over Sofie: the company's order of its agents is as it was, and nothing of it is sent.
		press(rowOf(rail, "Bo"), "ArrowUp");
		await settle();
		expect(manage).not.toHaveBeenCalled();
		expect(places[1]).toEqual([
			{ userId: sofie, place: { zone: "section", sectionId: research, after: bo.id, rank: 0 }, hidden: false },
		]);
		expect(zones(rail).Research).toEqual(["Bo", "Sofie Lund", "Ada"]);
		// Ada steps up over Sofie, then over Bo: the second step is the company's, and Sofie follows what she sees.
		press(rowOf(rail, "Ada"), "ArrowUp");
		await settle();
		expect(manage).not.toHaveBeenCalled();
		expect(zones(rail).Research).toEqual(["Bo", "Ada", "Sofie Lund"]);
		press(rowOf(rail, "Ada"), "ArrowUp");
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: ada.id,
			sectionId: research,
			order: [ada.id, bo.id],
		});
		expect(zones(rail).Research).toEqual(["Ada", "Bo", "Sofie Lund"]);
		expect(places.at(-1)).toEqual([
			{ userId: sofie, place: { zone: "section", sectionId: research, after: bo.id, rank: 0 }, hidden: false },
		]);
		// Alone in the Members group, Mads has nowhere to step.
		press(rowOf(rail, "Mads Berg"), "ArrowDown");
		await settle();
		expect(places).toHaveLength(4);
	});
});

describe("People at the foot of the rail", () => {
	const online = (userId: string, value: string) => ({
		clientId: `${userId}-tab`,
		userId,
		name: "Sofie",
		staffAgentId: value,
	});

	it("says where a teammate is, and one click takes you there", async () => {
		const { company, rail, ready } = companyWith();
		await ready;
		company.store.set({ here: [online(sofie, `@agent:${bo.id}`)] });
		await settle();
		const row = rowOf(rail, "Sofie Lund");
		expect(row.querySelector("small")?.textContent).toBe("With Bo");
		expect(row.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/staff/${bo.id}`);
		expect(rowOf(rail, "Mads Berg").getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/member/${mads}`);
		company.store.set({ here: [online(sofie, "@app:trips")] });
		await settle();
		expect(rowOf(rail, "Sofie Lund").querySelector("small")?.textContent).toBe("Online now");
		expect(rowOf(rail, "Sofie Lund").getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/member/${sofie}`);
	});

	it("opens the chat while a message of theirs waits, whatever they look at", async () => {
		const { company, rail, ready } = companyWith({
			chats: [
				summary(sofie, {
					unread: 1,
					last: { id: id(95), seq: 1, authorUserId: sofie, text: "Look at the prices", createdAt: timestamp },
				}),
				summary(mads),
			],
		});
		await ready;
		company.store.set({ here: [online(sofie, `@agent:${bo.id}`)] });
		await settle();
		const row = rowOf(rail, "Sofie Lund");
		expect(row.querySelector("small")?.textContent).toBe("Look at the prices");
		expect(row.getAttribute("data-href")).toBe(`#/c/${profileA.profileId}/member/${sofie}`);
	});

	it("offers Go to and Message on a teammate's menu, before Pin and Hide", async () => {
		const { company, rail, ready } = companyWith();
		await ready;
		company.store.set({ here: [online(sofie, `@agent:${bo.id}`)] });
		await settle();
		rightClick(rowOf(rail, "Sofie Lund"));
		const labels = [...document.querySelectorAll(".context-menu [role^=menuitem]")].map(
			(item) => item.querySelector(".context-menu-label")?.textContent,
		);
		expect(labels).toEqual(["Go to Sofie", "Message", "Pin", "Hide from sidebar"]);
		expect(document.querySelector(".context-menu [role^=menuitem] .person-avatar")?.textContent).toBe("SL");
		document.querySelector<HTMLElement>(".context-menu [role^=menuitem]")!.click();
		expect(location.hash).toBe(`#/c/${profileA.profileId}/staff/${bo.id}`);
		rightClick(rowOf(rail, "Mads Berg"));
		expect(menuItems()).toEqual(["Message", "Pin", "Hide from sidebar"]);
		choose("Message");
		expect(location.hash).toBe(`#/c/${profileA.profileId}/member/${mads}`);
	});

	it("ends People with Invite for those who may invite, which opens the invite sheet", async () => {
		const invites = {
			listFriends: vi.fn(async () => []),
			inviteMember: vi.fn(),
			cancelInvitation: vi.fn(),
		} as unknown as InviteCalls;
		const { rail, ready } = companyWith({ invites });
		await ready;
		const list = rail.querySelector<HTMLElement>(".rail-members .rail-section-list")!;
		expect(names(list.children)).toEqual(["Sofie Lund", "Mads Berg", "Invite"]);
		list.querySelector<HTMLButtonElement>(".rail-row-invite")!.click();
		expect(document.querySelector(".company-invite-sheet")?.getAttribute("aria-label")).toBe("Invite people");
		document.querySelector<HTMLElement>(".company-invite-sheet")!.remove();
		document.body.replaceChildren();
		const viewer = companyWith({
			invites,
			capabilities: { read: true, write: true, authorize: false, manageMembers: false },
		});
		await viewer.ready;
		expect(viewer.rail.querySelector(".rail-row-invite")).toBeNull();
	});

	it("shows People with Invite alone to a founder with no teammates yet", async () => {
		const invites = { listFriends: vi.fn(async () => []) } as unknown as InviteCalls;
		const { rail, ready } = companyWith({ invites, members: [people[0]!], chats: [] });
		await ready;
		const group = rail.querySelector<HTMLElement>(".rail-members")!;
		expect(group.classList.contains("is-empty")).toBe(false);
		expect(names(group.querySelectorAll(".rail-section-list > *"))).toEqual(["Invite"]);
	});

	it("puts Invite people in the company menu for those who may invite", async () => {
		const invites = { listFriends: vi.fn(async () => []) } as unknown as InviteCalls;
		const { rail, ready } = companyWith({ invites });
		await ready;
		rail.querySelector<HTMLButtonElement>(".rail-company")!.click();
		expect(menuItems()).toContain("Invite people");
		choose("Invite people");
		expect(document.querySelector(".company-invite-sheet")).not.toBeNull();
	});
});

describe("dragging contacts in the rail", () => {
	let boxSpy: ReturnType<typeof vi.spyOn> | undefined;
	afterEach(() => {
		boxSpy = undefined;
	});
	const ROW = "[data-agent-id], [data-room-id], [data-member-id], .rail-section-title";
	/** jsdom has no layout: each row and zone gets a box, top to bottom in document order. */
	function layout(rail: HTMLElement) {
		const boxes = new Map<Element, DOMRect>();
		let y = 0;
		for (const element of rail.querySelectorAll<HTMLElement>(
			`.rail-scroll ${ROW.split(", ").join(", .rail-scroll ")}`,
		)) {
			boxes.set(element, new DOMRect(0, y, 300, 40));
			y += 40;
		}
		// A zone spans its children.
		for (const zone of rail.querySelectorAll<HTMLElement>("[data-drop-zone]")) {
			const inner = [...zone.querySelectorAll(ROW)].map((child) => boxes.get(child)!);
			const top = inner.length ? Math.min(...inner.map((box) => box.top)) : 0;
			const bottom = inner.length ? Math.max(...inner.map((box) => box.bottom)) : 0;
			boxes.set(zone, new DOMRect(0, top, 300, bottom - top));
		}
		boxSpy?.mockRestore();
		boxSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			return this.matches(".rail-scroll") ? new DOMRect(0, 0, 300, 2000) : (boxes.get(this) ?? new DOMRect());
		});
		document.elementsFromPoint = (x: number, y: number) =>
			[...boxes]
				.filter(([, box]) => x >= box.left && x <= box.right && y >= box.top && y < box.bottom)
				.map(([element]) => element)
				.reverse();
		return boxes;
	}
	const pointer = (type: string, x: number, y: number) =>
		new PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			pointerType: "mouse",
			button: 0,
			clientX: x,
			clientY: y,
		});
	/** Drags a row onto another row or a title: above its middle unless `below`. Answers the zone that lit up.
	 * `meanwhile` runs while the row is held over its place, before it is let go. */
	function drag(from: Element, onto: Element, rail: HTMLElement, below = false, meanwhile?: () => void) {
		const boxes = layout(rail);
		const start = boxes.get(from)!;
		const to = boxes.get(onto)!;
		const y = to.top + (below ? 35 : 5);
		from.dispatchEvent(pointer("pointerdown", 20, start.top + 20));
		document.dispatchEvent(pointer("pointermove", 20, start.top + 34));
		document.dispatchEvent(pointer("pointermove", 20, y));
		const lit = rail.querySelector<HTMLElement>(".is-drop-target")?.dataset.dropZone;
		const kind = rail.querySelector<HTMLElement>(".rail-scroll")!.dataset.dragging;
		meanwhile?.();
		document.dispatchEvent(pointer("pointerup", 20, y));
		return { lit, kind };
	}
	const titleOf = (rail: HTMLElement, zone: string) =>
		rail.querySelector<HTMLElement>(`[data-drop-zone="${zone}"] .rail-section-title`)!;

	it("drags a contact into a section, between its agents, and back to the Members group", async () => {
		const { rail, manage, places, ready } = companyWith({ chats: [summary(sofie)], members: people.slice(0, 2) });
		await ready;
		// Onto Ada's upper half: between Bo and Ada.
		const into = drag(rowOf(rail, "Sofie Lund"), rowOf(rail, "Ada"), rail);
		expect(into).toEqual({ lit: `section:${research}`, kind: "member" });
		await settle();
		expect(places).toEqual([
			[{ userId: sofie, place: { zone: "section", sectionId: research, after: bo.id, rank: 0 }, hidden: false }],
		]);
		expect(zones(rail)).toMatchObject({ Research: ["Bo", "Sofie Lund", "Ada"], members: [] });
		// The company's sidebar is not touched: where a contact stands is its member's own.
		expect(manage).not.toHaveBeenCalled();
		expect(rail.querySelector<HTMLElement>(".rail-scroll")!.dataset.dragging).toBeUndefined();
		// The Members group is empty now; a dragged contact still finds it.
		const back = drag(rowOf(rail, "Sofie Lund"), titleOf(rail, "members"), rail, true);
		expect(back.lit).toBe("members");
		await settle();
		expect(places[1]).toEqual([{ userId: sofie, place: { zone: "members", rank: 0 }, hidden: false }]);
		expect(zones(rail)).toMatchObject({ Research: ["Bo", "Ada"], members: ["Sofie Lund"] });
	});

	it("pins a contact by dragging it into the pinned row, among the pinned agents", async () => {
		const { rail, manage, places, ready } = companyWith();
		await ready;
		expect(drag(rowOf(rail, "Mads Berg"), rowOf(rail, "Dee"), rail).lit).toBe("pinned");
		await settle();
		expect(places).toEqual([[{ userId: mads, place: { zone: "pinned", rank: 0 }, hidden: false }]]);
		expect(zones(rail).pinned).toEqual(["Mads", "Dee"]);
		expect(manage).not.toHaveBeenCalled();
		// An agent pinned between them: the pins the cloud takes name agents only, and Mads stays first.
		drag(rowOf(rail, "Cy"), rowOf(rail, "Dee"), rail);
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [cy.id, dee.id] });
		expect(zones(rail).pinned).toEqual(["Mads", "Cy", "Dee"]);
		expect(places).toHaveLength(1);
	});

	it("keeps contacts where the member sees them when an agent is dragged past them, in or out", async () => {
		const { rail, manage, places, ready } = companyWith({
			chats: [
				placed(sofie, { zone: "section", sectionId: research, after: bo.id, rank: 0 }),
				placed(mads, { zone: "unassigned", after: cy.id, rank: 0 }),
			],
		});
		await ready;
		expect(zones(rail)).toMatchObject({ Research: ["Bo", "Sofie Lund", "Ada"], Unassigned: ["Cy", "Mads Berg"] });
		// Bo below Sofie: the agents' order is as it was, so the company's sidebar hears nothing; Sofie stands first.
		drag(rowOf(rail, "Bo"), rowOf(rail, "Sofie Lund"), rail, true);
		await settle();
		expect(manage).not.toHaveBeenCalled();
		expect(places).toEqual([
			[{ userId: sofie, place: { zone: "section", sectionId: research, rank: 0 }, hidden: false }],
		]);
		expect(zones(rail).Research).toEqual(["Sofie Lund", "Bo", "Ada"]);
		// Cy into Research, above Sofie. The move names agents only, and both zones keep their contacts in place:
		// Sofie after Cy now, and Mads first among what is in no section, his agent gone from there.
		drag(rowOf(rail, "Cy"), rowOf(rail, "Sofie Lund"), rail);
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: cy.id,
			sectionId: research,
			order: [cy.id, bo.id, ada.id],
		});
		expect(places.slice(1)).toEqual([
			[{ userId: sofie, place: { zone: "section", sectionId: research, after: cy.id, rank: 0 }, hidden: false }],
			[{ userId: mads, place: { zone: "unassigned", rank: 0 }, hidden: false }],
		]);
		expect(zones(rail)).toMatchObject({ Research: ["Cy", "Sofie Lund", "Bo", "Ada"], Unassigned: ["Mads Berg"] });
	});

	it("keeps a contact where the member saw it when the agent it stood after is dragged away", async () => {
		const { rail, manage, places, ready } = companyWith({
			chats: [placed(sofie, { zone: "section", sectionId: research, after: bo.id, rank: 0 }), summary(mads)],
		});
		await ready;
		expect(zones(rail).Research).toEqual(["Bo", "Sofie Lund", "Ada"]);
		// Bo below Ada, in his own section: Sofie stays first, not after Ada.
		drag(rowOf(rail, "Bo"), rowOf(rail, "Ada"), rail, true);
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: bo.id,
			sectionId: research,
			order: [ada.id, bo.id],
		});
		expect(places.at(-1)).toEqual([
			{ userId: sofie, place: { zone: "section", sectionId: research, rank: 0 }, hidden: false },
		]);
		expect(zones(rail).Research).toEqual(["Sofie Lund", "Ada", "Bo"]);
		// Bo out to the agents in no section: Sofie still first in Research, not at its end.
		drag(rowOf(rail, "Bo"), rowOf(rail, "Cy"), rail);
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, {
			action: "move_agent",
			staffAgentId: bo.id,
			sectionId: null,
			order: [bo.id, cy.id, dee.id],
		});
		expect(places.flat().filter((change) => change.userId === sofie && change.place.after !== undefined)).toEqual([]);
		expect(zones(rail).Research).toEqual(["Sofie Lund", "Ada"]);
	});

	it("keeps a contact where it was moved meanwhile when an agent or a contact is dropped beside it", async () => {
		const { rail, company, manage, places, ready } = companyWith({
			chats: [placed(sofie, { zone: "pinned", after: dee.id, rank: 0 }), summary(mads)],
		});
		await ready;
		expect(zones(rail).pinned).toEqual(["Dee", "Sofie"]);
		/** Sofie unpinned on another device, while the lifted rail still shows her pinned. */
		const unpinSofie = () => {
			const chats = company.store.get().memberChats!;
			company.store.set({
				memberChats: { ...chats, [sofie]: { ...chats[sofie]!, place: { zone: "members", rank: 0 } } },
			});
		};
		drag(rowOf(rail, "Cy"), rowOf(rail, "Dee"), rail, false, unpinSofie);
		await settle();
		expect(manage).toHaveBeenLastCalledWith(profileA.profileId, { action: "set_pins", order: [cy.id, dee.id] });
		// Nothing puts her back in the pinned row.
		expect(places.flat().filter((change) => change.userId === sofie)).toEqual([]);
		expect(zones(rail).pinned).toEqual(["Cy", "Dee"]);
		// The same for a contact dropped there: only Mads is placed.
		const chats = company.store.get().memberChats!;
		company.store.set({
			memberChats: { ...chats, [sofie]: { ...chats[sofie]!, place: { zone: "pinned", after: dee.id, rank: 0 } } },
		});
		await settle();
		drag(rowOf(rail, "Mads Berg"), rowOf(rail, "Dee"), rail, false, unpinSofie);
		await settle();
		expect(places.at(-1)).toEqual([
			{ userId: mads, place: { zone: "pinned", after: cy.id, rank: 0 }, hidden: false },
		]);
		expect(places.flat().filter((change) => change.userId === sofie)).toEqual([]);
	});

	it("takes no agent in a pinned row that agents and a contact fill together", async () => {
		const most = Array.from({ length: PIN_LIMIT - 1 }, (_, index) => agent(100 + index, `Agent ${index}`));
		const { rail, manage, places, ready } = companyWith({
			agents: [...most, ada],
			chats: [placed(sofie, { zone: "pinned", rank: 0 }), summary(mads)],
			sidebar: { sections: [], placements: {}, pinned: most.map((item) => item.id), hidden: [] },
		});
		await ready;
		const first = rail.querySelector(".rail-pinned > a")!;
		// Refused, the space stays in the zone the row was lifted from.
		expect(drag(rowOf(rail, "Ada"), first, rail).lit).toBe("unassigned");
		expect(drag(rowOf(rail, "Mads Berg"), first, rail).lit).toBe("members");
		// A card that is in the row still moves within it.
		expect(
			drag(rail.querySelector(`.rail-pinned [data-member-id="${sofie}"]`)!, rowOf(rail, "Agent 5"), rail).lit,
		).toBe("pinned");
		await settle();
		expect(manage).not.toHaveBeenCalled();
		expect(places).toHaveLength(1);
		expect(rail.querySelectorAll(".rail-pinned > a")).toHaveLength(PIN_LIMIT);
	});

	it("takes no agent in the Members group, and lets a member who cannot organize place their contacts", async () => {
		const { rail, manage, places, ready } = companyWith({
			capabilities: { read: true, write: false, authorize: false, manageMembers: false },
		});
		await ready;
		// An agent finds no place to land among the contacts: the space stays where it was lifted from.
		expect(drag(rowOf(rail, "Cy"), rowOf(rail, "Sofie Lund"), rail)).toEqual({ lit: "unassigned", kind: "agent" });
		// A viewer cannot move the company's agents, and still places a contact in a section: it is their own rail.
		expect(drag(rowOf(rail, "Cy"), rowOf(rail, "Ada"), rail).lit).toBe("unassigned");
		expect(drag(rowOf(rail, "Sofie Lund"), rowOf(rail, "Ada"), rail).lit).toBe(`section:${research}`);
		await settle();
		expect(manage).not.toHaveBeenCalled();
		expect(places).toHaveLength(1);
		expect(zones(rail).Research).toEqual(["Bo", "Sofie Lund", "Ada"]);
	});

	it("shows a hidden contact again where it is dragged out of Hidden", async () => {
		localStorage.setItem("qorpera.web.rail-hidden-open", "1");
		const { rail, places, ready } = companyWith({ chats: [summary(sofie, { hidden: true }), summary(mads)] });
		await ready;
		const hidden = rail.querySelector<HTMLElement>(`.rail-hidden-list [data-member-id="${sofie}"]`)!;
		expect(drag(hidden, rowOf(rail, "Cy"), rail, true).lit).toBe("unassigned");
		await settle();
		expect(places).toEqual([
			[{ userId: sofie, place: { zone: "unassigned", after: cy.id, rank: 0 }, hidden: false }],
		]);
		expect(zones(rail).Unassigned).toEqual(["Cy", "Sofie Lund"]);
		expect(rail.querySelector(".rail-hidden")).toBeNull();
	});
});

describe("the rail's empty Members group", () => {
	// With nobody in it the group is no category and takes no room; a dragged contact shows it as the place to drop
	// one back, and a dragged agent does not (it cannot land there). jsdom's computed style ignores specificity, so
	// this reads which rules reach the group and what they set.
	it("shows only while a contact is dragged", () => {
		const style = h("style", {});
		style.textContent = appCss.replace(/^@import .*;$/gm, "");
		document.head.append(style);
		cleanup.push(() => style.remove());
		const rules = [...style.sheet!.cssRules].filter(
			(rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && Boolean(rule.style.display),
		);
		const group = h("div", { class: "rail-section rail-members is-empty" }, h("div", { class: "rail-section-list" }));
		const list = h("div", { class: "rail-scroll" }, group);
		document.body.append(h("div", { class: "frame" }, h("aside", { class: "rail" }, list)));
		const displays = () =>
			new Set(rules.filter((rule) => group.matches(rule.selectorText)).map((rule) => rule.style.display));
		expect(displays()).toEqual(new Set(["none"]));
		list.classList.add("rail-dragging");
		list.dataset.dragging = "agent";
		expect(displays()).toEqual(new Set(["none"]));
		list.dataset.dragging = "member";
		expect(displays()).toContain("block");
		// Someone in it: nothing hides it.
		delete list.dataset.dragging;
		list.classList.remove("rail-dragging");
		group.classList.remove("is-empty");
		expect(displays().has("none")).toBe(false);
	});
});
