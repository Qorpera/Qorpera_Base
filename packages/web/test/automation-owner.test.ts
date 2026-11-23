import type { SurfaceAutomationSummary } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { automationChoices, automationOwnerView, offersWaitingOn, offerWaitsOn } from "../src/app/automation-owner.ts";
import type { HostedProfileMember } from "../src/cloud/types.ts";
import { id } from "./fixtures.ts";

const jonas = id(1);
const sofie = id(2);
const vic = id(3);
const member = (userId: string, displayName: string, role: HostedProfileMember["role"]): HostedProfileMember => ({
	userId,
	email: `${displayName.toLowerCase()}@example.test`,
	displayName,
	role,
	joinedAt: "2026-11-23T08:00:00.000Z",
});
const members = [
	member(jonas, "Jonas", "owner"),
	member(sofie, "Sofie Lund", "contributor"),
	member(vic, "Vic", "viewer"),
];
const automation: SurfaceAutomationSummary = {
	id: id(10),
	key: "tidy-files",
	title: "Tidy Files",
	scheduleSummary: "Mondays 08:00",
	targetSurfaceSlug: "files",
	outputMode: "surface_session",
	enabled: true,
	status: "idle",
	lastRunAt: null,
	lastOutcomeSummary: null,
	nextRunAt: null,
	ownable: true,
	ownerUserId: jonas,
	offer: null,
};
const offered = (status: "open" | "no", to = sofie): SurfaceAutomationSummary => ({
	...automation,
	offer: { id: id(11), fromUserId: jonas, toUserId: to, offeredByUserId: jonas, status, answeredAt: null },
});

describe("automation owner", () => {
	it("wears its owner's face, and the owner or an admin may hand it to each teammate who is not a viewer", () => {
		expect(automationOwnerView(automation, jonas, "owner", members)).toEqual({
			face: { userId: jonas, name: "Jonas" },
			offeredToYou: undefined,
			note: undefined,
			mayTake: false,
		});
		expect(automationChoices(automation, jonas, "owner", members)).toEqual([
			{ kind: "hand", to: { userId: sofie, name: "Sofie Lund" } },
		]);
		expect(automationChoices(automation, sofie, "admin", members)).toEqual([]);
		expect(automationChoices(automation, sofie, "contributor", members)).toEqual([]);
		expect(automationChoices(automation, vic, "viewer", members)).toEqual([]);
	});

	it("shows an open offer to the teammate with the offerer's face, and lets the offerer take it back", () => {
		const open = offered("open");
		expect(offerWaitsOn(open, sofie)).toBe(true);
		expect(offerWaitsOn(open, jonas)).toBe(false);
		expect(offersWaitingOn([open, automation], sofie)).toBe(1);
		expect(automationOwnerView(open, sofie, "contributor", members)).toMatchObject({
			face: { userId: jonas },
			offeredToYou: { offerId: id(11), from: { userId: jonas, name: "Jonas" } },
		});
		expect(automationOwnerView(open, jonas, "owner", members).note).toBe("Offered to Sofie");
		expect(automationChoices(open, jonas, "owner", members)).toEqual([{ kind: "withdraw", offerId: id(11) }]);
		expect(automationChoices(open, sofie, "contributor", members)).toEqual([]);
	});

	it("says a no in plain words, to the owner and to the teammate who said it", () => {
		expect(automationOwnerView(offered("no"), jonas, "owner", members).note).toBe("Sofie said no");
		expect(automationOwnerView(offered("no"), sofie, "contributor", members).note).toBe("You said no");
		expect(offersWaitingOn([offered("no")], sofie)).toBe(0);
	});

	it("shows nobody, which any member but a viewer takes with one click", () => {
		const nobody = { ...automation, ownerUserId: null };
		expect(automationOwnerView(nobody, sofie, "contributor", members)).toEqual({
			face: "nobody",
			offeredToYou: undefined,
			note: "Nobody",
			mayTake: true,
		});
		expect(automationOwnerView(nobody, vic, "viewer", members).mayTake).toBe(false);
		expect(automationChoices(nobody, sofie, "contributor", members)).toEqual([{ kind: "take" }]);
		expect(automationChoices(nobody, jonas, "owner", members)).toEqual([
			{ kind: "take" },
			{ kind: "hand", to: { userId: sofie, name: "Sofie Lund" } },
		]);
	});

	it("says when its owner's login cannot pay, and stays plain for a legacy routine or before the members are read", () => {
		expect(automationOwnerView({ ...automation, status: "needs_attention" }, jonas, "owner", members).note).toBe(
			"Paused: no model account pays for it",
		);
		const routine = { ...automation, ownable: false, ownerUserId: null };
		expect(automationOwnerView(routine, jonas, "owner", members)).toEqual({
			face: undefined,
			offeredToYou: undefined,
			note: undefined,
			mayTake: false,
		});
		expect(automationChoices(routine, jonas, "owner", members)).toEqual([]);
		expect(automationOwnerView(automation, jonas, "owner", []).face).toBeUndefined();
	});
});
