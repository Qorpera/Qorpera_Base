// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { invitePendingSpectators, keepPendingSpectators, pendingSpectators } from "../src/app/pending-spectators.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { fixture, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const profileId = profileA.profileId;
const cleanup: (() => void)[] = [];

afterEach(() => {
	for (const done of cleanup.splice(0)) done();
	localStorage.clear();
	document.body.replaceChildren();
});

describe("spectators picked as a company is made", () => {
	it("are invited as viewers and forgotten once invited", async () => {
		const { api } = fixture();
		const invite = vi.spyOn(api, "inviteMember").mockResolvedValue({} as never);
		keepPendingSpectators(profileId, ["mom@example.test", "mom@example.test", "dad@example.test"]);
		expect(pendingSpectators(profileId)).toEqual(["mom@example.test", "dad@example.test"]);
		expect(await invitePendingSpectators(api, profileId)).toEqual([]);
		expect(invite).toHaveBeenCalledWith(profileId, "mom@example.test", "viewer");
		expect(invite).toHaveBeenCalledWith(profileId, "dad@example.test", "viewer");
		expect(pendingSpectators(profileId)).toEqual([]);
	});

	it("keeps those whose invite failed, for the next time the company opens", async () => {
		const { api } = fixture();
		vi.spyOn(api, "inviteMember").mockImplementation(async (_profile, email) => {
			if (email === "dad@example.test") throw new Error("offline");
			return {} as never;
		});
		keepPendingSpectators(profileId, ["mom@example.test", "dad@example.test"]);
		expect(await invitePendingSpectators(api, profileId)).toEqual(["dad@example.test"]);
		expect(pendingSpectators(profileId)).toEqual(["dad@example.test"]);
	});

	it("are invited when an owner opens the company, from any page, and a failure says so", async () => {
		const f = fixture();
		vi.spyOn(f.api, "inviteMember").mockRejectedValue(new Error("offline"));
		keepPendingSpectators(profileId, ["mom@example.test"]);
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		await company.refreshTeam();
		await settle();
		expect(f.api.inviteMember).toHaveBeenCalledWith(profileId, "mom@example.test", "viewer");
		expect(company.store.get().error).toBe(
			"mom@example.test could not be invited to follow. Invite them from the team page.",
		);
		expect(pendingSpectators(profileId)).toEqual(["mom@example.test"]);
	});
});

describe("what a spectator sees", () => {
	function spectator() {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		const auth = new AuthController(f.cloud);
		company.store.set({
			team: { ...team, role: "viewer", capabilities: { ...team.capabilities, write: false } },
			staff: [staff],
			sessions: [{ ...session, staffAgentId: staff.id }],
			loading: false,
		});
		company.conversation(session.sessionId, false).set({ loading: false });
		cleanup.push(() => {
			company.stop();
			auth.dispose();
		});
		return { company, auth };
	}

	it("reads along in a thread, told so, with no word of model accounts", async () => {
		const { company } = spectator();
		const view = new ConversationView(company, session.sessionId);
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		expect(view.el.textContent).toContain("You're a spectator: you read along, and the founders write.");
		expect(view.el.textContent).not.toContain("AI subscriptions");
	});

	it("has no new conversation in the rail", () => {
		const { company, auth } = spectator();
		const rail = document.createElement("aside");
		document.body.append(rail);
		renderRail(rail, company, {
			profiles: [profileA],
			user: userA,
			auth,
			invitations: 0,
			route: { name: "company", profileId, section: "chat", id: session.sessionId },
			openSettings() {},
			openFeedback() {},
			openFriends() {},
		});
		expect(rail.querySelector<HTMLElement>(".rail-add")?.hidden).toBe(true);
	});
});
