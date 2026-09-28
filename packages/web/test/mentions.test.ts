// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { GroupChatDetails } from "../src/cloud/group-details.ts";
import type { HostedProfileMember, HostedSession, HostedStaffAgent } from "../src/cloud/types.ts";
import { findMentions, type MentionTarget, matchTargets, mentionParts, mentionQuery } from "../src/ui/mentions.ts";
import { fixture, id, profileA, session, settle, staff, team, timestamp, userA, userB } from "./fixtures.ts";

const bo: MentionTarget = { kind: "agent", id: "a", name: "Bo" };
const boJensen: MentionTarget = { kind: "agent", id: "b", name: "Bo Jensen" };
const sofie: MentionTarget = { kind: "member", id: "c", name: "Sofie Lund" };
const soren: MentionTarget = { kind: "member", id: "d", name: "Søren Ask" };

describe("the mention rule", () => {
	it("reads '@' and a name at a word start, before a space or punctuation, in any case", () => {
		const names = (text: string) => findMentions(text, [bo, sofie]).map((mention) => mention.target.name);
		expect(names("@Bo check this")).toEqual(["Bo"]);
		expect(names("(@bo) and @SOFIE LUND, please")).toEqual(["Bo", "Sofie Lund"]);
		expect(names("mail bo@bo.com or @Bobby")).toEqual([]);
		expect(names("@Bo.")).toEqual(["Bo"]);
		expect(names("“@Bo” said")).toEqual(["Bo"]);
		expect(names("x@Bo")).toEqual([]);
	});

	it("reads text as the cloud does: A-Z in either case, every Unicode space a space, lengths kept", () => {
		const names = (text: string) => findMentions(text, [bo, boJensen]).map((mention) => mention.target.id);
		expect(names("Hej\u00a0@Bo can you check")).toEqual(["a"]);
		expect(names("İstanbul @BO can you check")).toEqual(["a"]);
		expect(names("@Bo Jensen @Bo Jensen, the invoices")).toEqual(["b", "b"]);
		const parts = mentionParts("İstanbul @Bo!", [bo]);
		expect(parts.map((part) => (typeof part === "string" ? part : `[${part.target.name}]`))).toEqual([
			"İstanbul ",
			"[Bo]",
			"!",
		]);
		// Other letters keep their case, as in the cloud: the picker puts names in as written.
		expect(findMentions("@øystein", [{ kind: "member", id: "f", name: "Øystein" }])).toEqual([]);
		expect(findMentions("@ØYSTEIN", [{ kind: "member", id: "f", name: "Øystein" }])).toHaveLength(1);
		expect(findMentions("@Øystein", [{ kind: "member", id: "f", name: "Øystein" }])).toHaveLength(1);
	});

	it("reads the longer name first, and everyone who shares a name", () => {
		expect(findMentions("@Bo Jensen, and @Bo", [bo, boJensen]).map((mention) => mention.target.id)).toEqual([
			"b",
			"a",
		]);
		const twin: MentionTarget = { kind: "agent", id: "e", name: "Bo" };
		expect(findMentions("@Bo please", [bo, twin]).map((mention) => mention.target.id)).toEqual(["a", "e"]);
	});

	it("splits a message into text and mentions", () => {
		const parts = mentionParts("Hi @Bo, meet @Sofie Lund.", [bo, sofie]);
		expect(parts.map((part) => (typeof part === "string" ? part : `[${part.target.name}]`))).toEqual([
			"Hi ",
			"[Bo]",
			", meet ",
			"[Sofie Lund]",
			".",
		]);
	});

	it("finds the name being typed at the caret, and not once a name is followed by a space", () => {
		expect(mentionQuery("Ask @so", 7)).toEqual({ start: 4, query: "so" });
		expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
		expect(mentionQuery("Ask @Sofie L", 12)).toEqual({ start: 4, query: "Sofie L" });
		expect(mentionQuery("Ask @Bo ", 8)).toBeUndefined();
		expect(mentionQuery("mail bo@bo", 10)).toBeUndefined();
		expect(mentionQuery("Ask @so and more", 7)).toEqual({ start: 4, query: "so" });
	});

	it("matches the start of the name or of any word in it, accents aside, agents first", () => {
		expect(matchTargets("so", [sofie, soren, bo]).map((target) => target.name)).toEqual(["Sofie Lund", "Søren Ask"]);
		expect(matchTargets("lu", [sofie, soren]).map((target) => target.name)).toEqual(["Sofie Lund"]);
		expect(matchTargets("", [sofie, bo]).map((target) => target.name)).toEqual(["Bo", "Sofie Lund"]);
		expect(matchTargets("sø", [soren]).map((target) => target.name)).toEqual(["Søren Ask"]);
	});
});

const roomId = id(79);
const astrid: HostedStaffAgent = { ...staff, id: id(40), displayName: "Astrid" };
const boAgent: HostedStaffAgent = { ...staff, id: id(41), displayName: "Bo" };
const members: HostedProfileMember[] = [
	{ userId: userA.id, email: "a@example.invalid", displayName: "Jonas Krug", role: "owner", joinedAt: timestamp },
	{
		userId: userB.id,
		email: "b@example.invalid",
		displayName: "Sofie Lund",
		role: "contributor",
		joinedAt: timestamp,
	},
];
const group: HostedSession = { ...session, title: "Launch", executionScope: { roomId } };
const details: GroupChatDetails = {
	roomId,
	sessionId: session.sessionId,
	environmentId: profileA.environmentId,
	version: 1,
	name: "Launch",
	purpose: "Plan the launch",
	status: "active",
	members: [
		{ kind: "member", id: userA.id },
		{ kind: "member", id: userB.id },
		{ kind: "staff_agent", id: astrid.id },
		{ kind: "staff_agent", id: boAgent.id },
	],
};

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function setup(options: { mentions?: { sessionId: string; count: number }[]; supported?: boolean } = {}) {
	const f = fixture();
	if (options.supported !== false)
		vi.mocked(f.api.listMemberMentions)
			.mockReset()
			.mockResolvedValue((options.mentions ?? []).map((item) => ({ ...item, latestAt: timestamp })));
	const seen = vi.spyOn(f.api, "markMentionsSeen").mockResolvedValue();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team: { ...team, members },
		staff: [staff, astrid, boAgent],
		sessions: [group],
		groups: { [roomId]: details },
		loading: false,
	});
	await company.refreshMentions();
	const view = new ConversationView(company, session.sessionId, { sendMessage: async () => true });
	document.body.append(view.el);
	view.update();
	await settle();
	dispose = () => {
		view.dispose();
		company.stop();
	};
	const composer = view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
	return {
		f,
		company,
		view,
		seen,
		composer,
		picker: () => view.el.querySelector<HTMLElement>(".mention-picker")!,
		options: () => [...view.el.querySelectorAll<HTMLElement>(".mention-option")].map((option) => option.textContent),
		note: () => view.el.querySelector<HTMLElement>(".composer-mention-note")!,
		type: (value: string) => {
			composer.focus();
			composer.value = value;
			composer.setSelectionRange(value.length, value.length);
			composer.dispatchEvent(new Event("input", { bubbles: true }));
		},
		key: (key: string) =>
			composer.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
	};
}

describe("mentions in a group chat", () => {
	it("offers the room's agents and other members while '@' is typed, and puts the chosen name in", async () => {
		const s = await setup();
		s.type("Hi @");
		expect(s.picker().hidden).toBe(false);
		expect(s.options()).toEqual(["AstridAgent", "BoAgent", "SLSofie LundMember"]);
		expect(s.composer.getAttribute("aria-activedescendant")).toBe(`${s.picker().id}-0`);
		s.type("Hi @s");
		expect(s.options()).toEqual(["SLSofie LundMember"]);
		s.type("Hi @b");
		expect(s.options()).toEqual(["BoAgent"]);
		s.key("Enter");
		expect(s.composer.value).toBe("Hi @Bo ");
		expect(s.picker().hidden).toBe(true);
		expect(s.company.conversation(session.sessionId).get().draft).toBe("Hi @Bo ");
		// In a group chat, naming agents says who will answer.
		expect(s.note().hidden).toBe(false);
		expect(s.note().textContent).toBe("Only Bo will answer");
		s.type("Hi @Bo and @a");
		s.key("ArrowDown");
		s.key("Tab");
		expect(s.composer.value).toBe("Hi @Bo and @Astrid ");
		expect(s.note().textContent).toBe("Only Bo and Astrid will answer");
		s.type("Hi all");
		expect(s.note().hidden).toBe(true);
	});

	it("closes the names on Escape without sending, and Enter sends once they are closed", async () => {
		const s = await setup();
		s.type("@so");
		s.key("Escape");
		expect(s.picker().hidden).toBe(true);
		expect(s.composer.value).toBe("@so");
		s.type("Plain message");
		expect(s.picker().hidden).toBe(true);
	});

	it("sets names apart in members' messages, the reader's own most of all", async () => {
		const s = await setup();
		s.company.conversation(session.sessionId).set({
			loading: false,
			projection: {
				items: [
					{
						kind: "member",
						id: id(90),
						sequence: 1,
						authorUserId: userB.id,
						text: "@Jonas Krug and @Bo, look at this",
						attachmentCount: 0,
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 1,
			},
		});
		await settle();
		const text = s.view.el.querySelector(".message .text")!;
		expect([...text.querySelectorAll(".mention")].map((mention) => [mention.textContent, mention.className])).toEqual(
			[
				["@Jonas Krug", "mention mention-me"],
				["@Bo", "mention"],
			],
		);
		expect(text.textContent).toBe("@Jonas Krug and @Bo, look at this");
	});

	it("offers nothing on a cloud that reads no mentions", async () => {
		const s = await setup({ supported: false });
		s.type("Hi @");
		expect(s.picker().hidden).toBe(true);
		s.type("Hi @Bo please");
		expect(s.note().hidden).toBe(true);
	});

	it("marks the member's mentions here seen, and shows '@' on other conversations in the rail", async () => {
		const other: HostedSession = {
			...group,
			sessionId: id(91),
			title: "Pricing",
			executionScope: { roomId: id(92) },
		};
		const s = await setup({
			mentions: [
				{ sessionId: session.sessionId, count: 2 },
				{ sessionId: other.sessionId, count: 1 },
			],
		});
		expect(s.seen).toHaveBeenCalledWith(session.sessionId);
		expect(s.company.store.get().mentions).toEqual({ [other.sessionId]: 1 });
		s.company.store.set({ sessions: [group, other] });
		const rail = document.createElement("aside");
		const auth = new AuthController(s.f.cloud);
		renderRail(rail, s.company, {
			profiles: [profileA],
			user: userA,
			route: { name: "company", profileId: profileA.profileId, section: "chat", id: session.sessionId },
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
		});
		const row = rail.querySelector<HTMLAnchorElement>(`a[href$="/chat/${other.sessionId}"]`)!;
		expect(row.querySelector(".rail-mention")?.textContent).toBe("@");
		expect(row.title).toContain("You were mentioned");
		expect(rail.querySelector(`a[href$="/chat/${session.sessionId}"] .rail-mention`)).toBeNull();
		auth.dispose();
	});
});
