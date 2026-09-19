// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { HostedSession } from "../src/cloud/types.ts";
import { icon } from "../src/ui/dom.ts";
import { isGroupChat } from "../src/ui/group-chat.ts";
import { fixture, id, profileA, session, staff, team, userA } from "./fixtures.ts";

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

function setup(initial: HostedSession) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	const auth = new AuthController(f.cloud);
	company.store.set({ team, staff: [staff], sessions: [initial], loading: false });
	const rail = document.createElement("aside");
	const view = new ConversationView(company, session.sessionId);
	document.body.append(rail, view.el);
	const draw = () => {
		renderRail(rail, company, {
			profiles: [profileA],
			user: userA,
			route: { name: "company", profileId: profileA.profileId, section: "chat", id: session.sessionId },
			auth,
			invitations: 0,
			openSettings: () => {},
			openFeedback: () => {},
		});
		view.update();
	};
	draw();
	dispose = () => {
		view.dispose();
		company.stop();
		auth.dispose();
	};
	return { company, rail, view, draw };
}

describe("group chat identity", () => {
	it("uses the group picker icon and label in the rail and header, preserving them through refresh and rename", () => {
		const group = { ...session, title: "Co-Founder, Yang Tang", executionScope: { roomId: id(79) } };
		const { company, rail, view, draw } = setup(group);
		const row = () => rail.querySelector<HTMLAnchorElement>(`a[href$="/chat/${session.sessionId}"]`)!;
		const identity = view.el.querySelector<HTMLButtonElement>(".thread-identity")!;
		expect(row().querySelector("small")?.textContent).toBe("Group chat");
		expect(row().getAttribute("aria-current")).toBe("page");
		expect(row().title).toBe(`${group.title} · Group chat`);
		for (const root of [row(), identity]) {
			expect(root.querySelector(".group-chat-avatar svg")?.outerHTML).toBe(icon("friends").outerHTML);
			expect(root.querySelector(".figure")).toBeNull();
		}
		expect(identity.getAttribute("aria-label")).toBe(`${group.title} · Group chat`);
		expect(identity.disabled).toBe(true);
		expect(identity.hasAttribute("aria-haspopup")).toBe(false);
		expect(identity.hasAttribute("aria-expanded")).toBe(false);
		expect(view.el.querySelector<HTMLButtonElement>(".thread-computer")?.hidden).toBe(true);
		expect(view.el.querySelector(".thread-status")?.textContent).toContain("respond in this group chat");
		expect(view.el.textContent).not.toContain("team rooms");
		const previousRow = row();
		const previousAvatar = identity.querySelector(".group-chat-avatar");
		draw();
		expect(row()).toBe(previousRow);
		expect(identity.querySelector(".group-chat-avatar")).toBe(previousAvatar);
		company.store.set({ sessions: [{ ...group, title: "Planning" }] });
		draw();
		expect(row().querySelector("strong")?.textContent).toBe("Planning");
		expect(identity.querySelector("h1")?.textContent).toBe("Planning");
		expect(identity.querySelector(".group-chat-avatar svg")?.outerHTML).toBe(icon("friends").outerHTML);
	});

	it("updates an existing session's identity when its room scope arrives without a title change", () => {
		const { company, rail, view, draw } = setup(session);
		expect(view.el.querySelector(".group-chat-avatar")).toBeNull();
		company.store.set({ sessions: [{ ...session, executionScope: { roomId: id(79) } }] });
		draw();
		expect(view.el.querySelector(".thread-identity .group-chat-avatar")).not.toBeNull();
		expect(rail.querySelector(".group-chat-avatar")).not.toBeNull();
		company.store.set({ sessions: [session] });
		draw();
		expect(view.el.querySelector(".group-chat-avatar")).toBeNull();
		expect(rail.querySelector(".group-chat-avatar")).toBeNull();
	});

	it("keeps an agent's shared room as an individual agent conversation", () => {
		const { rail, view } = setup({
			...session,
			staffAgentId: staff.id,
			executionScope: { roomId: id(79), agentThread: true },
		});
		expect(rail.querySelector(".group-chat-avatar")).toBeNull();
		expect(rail.querySelector(`a[href$="/chat/${session.sessionId}"]`)).toBeNull();
		const identity = view.el.querySelector<HTMLButtonElement>(".thread-identity")!;
		expect(identity.querySelector(".figure")).not.toBeNull();
		expect(identity.querySelector("h1")?.textContent).toBe(staff.displayName);
		expect(identity.disabled).toBe(false);
		expect(identity.getAttribute("aria-label")).toBe("Open agent details");
		expect(identity.getAttribute("aria-haspopup")).toBe("dialog");
		expect(view.el.querySelector<HTMLButtonElement>(".thread-computer")?.hidden).toBe(false);
		expect(view.el.querySelector(".thread-status")?.textContent).not.toContain("group chat");
	});

	it.each<HostedSession["executionScope"]>([undefined, {}, { roomId: null }, { roomId: 7 }, { group: true }])(
		"does not infer group membership from an absent or non-string room scope: %j",
		(executionScope) => {
			expect(isGroupChat({ ...session, executionScope })).toBe(false);
		},
	);
});
