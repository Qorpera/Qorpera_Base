// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { fixture, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const profileId = profileA.profileId;
const cleanup: (() => void)[] = [];

afterEach(() => {
	for (const done of cleanup.splice(0)) done();
	document.body.replaceChildren();
});

describe("spectators picked as a company is made", () => {
	it("are invited from the server's list when an owner opens the company, and the team is read again", async () => {
		const f = fixture();
		const invite = vi.mocked(f.api.invitePendingSpectators).mockResolvedValue(["mom@example.test"]);
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		await company.refreshTeam();
		await settle();
		expect(invite).toHaveBeenCalledWith(profileId);
		expect(invite).toHaveBeenCalledTimes(1);
		expect(f.api.getTeam).toHaveBeenCalledTimes(2);
	});

	it("says so when the invites could not go out, once, and says nothing on a cloud without the list", async () => {
		const f = fixture();
		vi.mocked(f.api.invitePendingSpectators).mockRejectedValue(new Error("offline"));
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		await company.refreshTeam();
		await settle();
		expect(company.store.get().error).toBe(
			"The spectators picked for this company could not be invited yet. Opening it again tries once more.",
		);
		const older = fixture();
		vi.mocked(older.api.invitePendingSpectators).mockRejectedValue(
			new CloudRpcError("qorpera_invite_pending_spectators", { code: "PGRST202", message: "missing" }, 404),
		);
		const old = new CompanyController(older.api, profileA, userA.id);
		cleanup.push(() => old.stop());
		await old.refreshTeam();
		await settle();
		expect(old.store.get().error).toBeUndefined();
	});

	it("are never sent by someone who may not manage members", async () => {
		const f = fixture();
		vi.mocked(f.api.getTeam).mockResolvedValue({
			...team,
			role: "viewer",
			capabilities: { ...team.capabilities, write: false, manageMembers: false },
		});
		const invite = vi.mocked(f.api.invitePendingSpectators);
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		await company.refreshTeam();
		expect(invite).not.toHaveBeenCalled();
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
