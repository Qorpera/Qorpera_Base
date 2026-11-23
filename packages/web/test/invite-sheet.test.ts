// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { type InviteCalls, openInviteSheet } from "../src/app/views/invite-sheet.ts";
import type { HostedFriend, HostedProfileInvitation } from "../src/cloud/types.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, id, profileA, settle, team, timestamp, userA } from "./fixtures.ts";

const friend = (n: number, name: string, status: HostedFriend["status"] = "accepted"): HostedFriend => ({
	userId: id(n),
	email: `${name.toLowerCase()}@example.invalid`,
	displayName: name,
	status,
	direction: "outgoing",
	since: timestamp,
});
const mads = friend(61, "Mads");
const anna = friend(62, "Anna");
const sofie = friend(60, "Sofie");
const invitation = (email: string, role: HostedProfileInvitation["role"]): HostedProfileInvitation => ({
	id: id(90),
	profileId: profileA.profileId,
	email,
	role,
	invitedByUserId: userA.id,
	createdAt: timestamp,
	expiresAt: timestamp,
});

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

function sheet(
	invitations: HostedProfileInvitation[] = [],
	friends = [mads, anna, sofie, friend(63, "Pia", "pending")],
) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		loading: false,
		team: {
			...team,
			members: [
				{ userId: userA.id, email: "ann@example.invalid", displayName: "Ann", role: "owner", joinedAt: timestamp },
				{ userId: sofie.userId, email: sofie.email, displayName: "Sofie", role: "admin", joinedAt: timestamp },
			],
			invitations,
		},
	});
	cleanup.push(() => company.stop());
	const refreshTeam = vi.spyOn(company, "refreshTeam").mockResolvedValue();
	const calls = {
		listFriends: vi.fn(async () => friends),
		inviteMember: vi.fn<InviteCalls["inviteMember"]>(async () => invitation("x@example.invalid", "viewer")),
		cancelInvitation: vi.fn<InviteCalls["cancelInvitation"]>(async () => {}),
	} satisfies InviteCalls;
	const anchor = h("button", { type: "button" }, "Qorpera");
	document.body.append(anchor);
	openInviteSheet(company, calls, anchor);
	return { company, calls, refreshTeam, anchor };
}

const root = () => document.querySelector<HTMLElement>(".company-invite-sheet");
const people = () =>
	[...root()!.querySelectorAll(".hero-invite-person")].map((row) => [
		row.querySelector("strong")?.textContent,
		row.querySelector("small")?.textContent,
		[...row.querySelectorAll<HTMLElement>(".hero-invite-role[aria-pressed=true]")].map(
			(pressed) => pressed.textContent,
		),
	]);
const press = (name: string, role: string) =>
	[...root()!.querySelectorAll<HTMLElement>(".hero-invite-person")]
		.find((row) => row.querySelector("strong")?.textContent === name)!
		.querySelectorAll<HTMLButtonElement>(".hero-invite-role")
		.forEach((button) => {
			if (button.textContent === role) button.click();
		});

describe("the company's invite sheet", () => {
	it("lists the friends who are not in the company yet, as the new-company sheet does", async () => {
		sheet();
		expect(root()?.getAttribute("aria-label")).toBe("Invite people");
		expect(root()?.textContent).toContain("Loading your friends");
		await settle();
		expect(people()).toEqual([
			["Mads", "mads@example.invalid", []],
			["Anna", "anna@example.invalid", []],
		]);
		expect([...root()!.querySelectorAll(".hero-invite-role")].map((button) => button.textContent)).toEqual([
			"Builder",
			"Spectator",
			"Builder",
			"Spectator",
		]);
	});

	it("invites at the press: a builder as a contributor, a spectator as a viewer", async () => {
		const { calls, refreshTeam } = sheet();
		await settle();
		press("Mads", "Builder");
		await settle();
		expect(calls.inviteMember).toHaveBeenCalledWith(profileA.profileId, mads.email, "contributor");
		expect(refreshTeam).toHaveBeenCalled();
		press("Anna", "Spectator");
		await settle();
		expect(calls.inviteMember).toHaveBeenLastCalledWith(profileA.profileId, anna.email, "viewer");
		expect(calls.cancelInvitation).not.toHaveBeenCalled();
	});

	it("shows an invited friend's role, takes it back on a second press and changes it on the other", async () => {
		const { calls } = sheet([invitation(mads.email, "contributor")]);
		await settle();
		expect(people()[0]).toEqual(["Mads", "Builds with you, on their own subscription.", ["Builder"]]);
		press("Mads", "Builder");
		await settle();
		expect(calls.cancelInvitation).toHaveBeenCalledWith(profileA.profileId, id(90));
		expect(calls.inviteMember).not.toHaveBeenCalled();
		press("Mads", "Spectator");
		await settle();
		expect(calls.cancelInvitation).toHaveBeenCalledTimes(2);
		expect(calls.inviteMember).toHaveBeenCalledWith(profileA.profileId, mads.email, "viewer");
	});

	it("invites again with the old role when a swap fails, and takes a failed team read as nothing", async () => {
		const { calls, refreshTeam } = sheet([invitation(mads.email, "contributor")]);
		await settle();
		calls.inviteMember.mockRejectedValueOnce(new Error("Try again in a minute"));
		press("Mads", "Spectator");
		await settle();
		expect(calls.cancelInvitation).toHaveBeenCalledWith(profileA.profileId, id(90));
		expect(calls.inviteMember.mock.calls.map(([, email, role]) => [email, role])).toEqual([
			[mads.email, "viewer"],
			[mads.email, "contributor"],
		]);
		expect(root()?.querySelector("[role=alert]")?.textContent).toContain("Try again in a minute");
		refreshTeam.mockRejectedValueOnce(new Error("Failed to fetch"));
		press("Anna", "Builder");
		await settle();
		expect(calls.inviteMember).toHaveBeenLastCalledWith(profileA.profileId, anna.email, "contributor");
		expect(root()?.querySelector("[role=alert]")).toBeNull();
	});

	it("adds someone by email as a spectator, and lists who was invited by email with Remove", async () => {
		const { calls } = sheet([invitation("guest@example.invalid", "viewer")]);
		await settle();
		expect(people().at(-1)).toEqual(["guest@example.invalid", "Follows the chats. No subscription.", []]);
		const input = root()!.querySelector<HTMLInputElement>(".hero-invite-email")!;
		input.value = "not an email";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(calls.inviteMember).not.toHaveBeenCalled();
		input.value = " New@Example.invalid ";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(calls.inviteMember).toHaveBeenCalledWith(profileA.profileId, "new@example.invalid", "viewer");
		[...root()!.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Remove")!
			.click();
		await settle();
		expect(calls.cancelInvitation).toHaveBeenCalledWith(profileA.profileId, id(90));
	});

	it("says why a call failed, and closes on Done, Escape or a press outside", async () => {
		const { calls, anchor } = sheet();
		calls.inviteMember.mockRejectedValueOnce(new Error("this account already has access"));
		await settle();
		press("Mads", "Builder");
		await settle();
		expect(root()?.querySelector("[role=alert]")?.textContent).toContain("already has access");
		[...root()!.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "Done")!
			.click();
		expect(root()).toBeNull();
		expect(document.activeElement).toBe(anchor);
		sheet();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(root()).toBeNull();
		sheet();
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		expect(root()).toBeNull();
	});
});
