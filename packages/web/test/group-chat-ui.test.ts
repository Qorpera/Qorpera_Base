// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import type { HostedSession } from "../src/cloud/types.ts";
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
			openFriends: () => {},
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
	it("uses the group artwork canvas and label in the rail and header, preserving them through refresh and rename", () => {
		const group = { ...session, title: "Co-Founder, Yang Tang", executionScope: { roomId: id(79) } };
		const { company, rail, view, draw } = setup(group);
		const row = () => rail.querySelector<HTMLAnchorElement>(`a[href$="/chat/${session.sessionId}"]`)!;
		const identity = view.el.querySelector<HTMLButtonElement>(".thread-identity")!;
		expect(row().querySelector("small")?.textContent).toBe("Group chat");
		expect(row().getAttribute("aria-current")).toBe("page");
		expect(row().title).toBe(`${group.title} · Group chat`);
		for (const root of [row(), identity]) {
			expect(root.querySelector("canvas.group-chat-avatar")).not.toBeNull();
			expect(root.querySelector(".group-chat-avatar svg")).toBeNull();
			expect(root.querySelector(".figure")).toBeNull();
		}
		expect(identity.getAttribute("aria-label")).toBe("Open group details");
		expect(identity.disabled).toBe(false);
		expect(identity.getAttribute("aria-haspopup")).toBe("dialog");
		expect(identity.getAttribute("aria-expanded")).toBe("false");
		// A group has no computer; its header stays on every width.
		expect(view.el.querySelector(".computer-panel")).toBeNull();
		expect(view.show(staff.id, "computer")).toBe(false);
		expect(view.el.querySelector(".computer-panel")).toBeNull();
		expect(view.el.querySelector(".thread-header")?.classList.contains("is-agent")).toBe(false);
		// A group chat's header goes on a wide screen too, as an agent's does: the rail's card stands in for it.
		expect(view.el.querySelector(".thread-header")?.classList.contains("is-group")).toBe(true);
		expect(view.el.querySelector(".thread-status")?.textContent).not.toContain("respond in this group chat");
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
		expect(identity.querySelector("canvas.group-chat-avatar")).not.toBeNull();
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

	it("refreshes the group rail subtitle independently of its title and keeps group artwork", () => {
		const roomId = id(79);
		const { company, rail, draw } = setup({ ...session, executionScope: { roomId } });
		const row = () => rail.querySelector<HTMLAnchorElement>(`a[href$="/chat/${session.sessionId}"]`)!;
		const previous = row();
		const details = {
			roomId,
			sessionId: session.sessionId,
			environmentId: profileA.environmentId,
			name: session.title,
			subtitle: "Launch planning",
			purpose: "Prepare the next launch.",
			version: 1,
			status: "active" as const,
			members: [],
		};
		company.store.set({ groups: { [roomId]: details } });
		draw();
		expect(row()).not.toBe(previous);
		expect(row().querySelector("small")?.textContent).toBe("Launch planning");
		expect(row().title).toBe(`${session.title} · Launch planning`);
		expect(row().querySelector("canvas.group-chat-avatar")).not.toBeNull();
		const unchanged = row();
		draw();
		expect(row()).toBe(unchanged);
		company.store.set({ groups: { [roomId]: { ...details, subtitle: "", version: 2 } } });
		draw();
		expect(row().querySelector("small")?.textContent).toBe("");
		expect(row().title).toBe(session.title);
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
		expect(view.el.querySelector(".thread-header")?.classList.contains("is-agent")).toBe(true);
		expect(view.el.querySelector(".thread-header")?.classList.contains("is-group")).toBe(false);
		expect(view.show(staff.id, "computer")).toBe(true);
		expect(view.el.querySelector(".computer-panel")).not.toBeNull();
		expect(view.el.querySelector(".thread-status")?.textContent).not.toContain("group chat");
	});

	it.each<HostedSession["executionScope"]>([undefined, {}, { roomId: null }, { roomId: 7 }, { group: true }])(
		"does not infer group membership from an absent or non-string room scope: %j",
		(executionScope) => {
			expect(isGroupChat({ ...session, executionScope })).toBe(false);
		},
	);
});
