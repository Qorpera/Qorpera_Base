import { describe, expect, it } from "vitest";
import {
	profileInvitationIdFromArgv,
	profileInvitationIdFromProtocolUrl,
	profileInvitationProtocolUrl,
} from "../src/profile-invitation-handoff.ts";

const invitationId = "A8450F9D-C912-43EA-81F6-62C7247D752A";

describe("profile invitation protocol handoff", () => {
	it("creates and parses only the dedicated invitation route", () => {
		const url = profileInvitationProtocolUrl(invitationId);
		expect(url).toBe("qorpera://profile-invitation/a8450f9d-c912-43ea-81f6-62c7247d752a");
		expect(profileInvitationIdFromProtocolUrl(url)).toBe(invitationId.toLowerCase());
		expect(profileInvitationIdFromArgv(["Qorpera Base.exe", "--flag", url])).toBe(invitationId.toLowerCase());
	});

	it("rejects alternate origins, extra URL data, and malformed identifiers", () => {
		for (const value of [
			`https://qorpera.com/#invitation=${invitationId}`,
			`qorpera://other/${invitationId}`,
			`qorpera://profile-invitation/${invitationId}?source=email`,
			`qorpera://profile-invitation/${invitationId}#extra`,
			"qorpera://profile-invitation/not-an-invitation",
			`qorpera://user@profile-invitation/${invitationId}`,
		]) {
			expect(profileInvitationIdFromProtocolUrl(value)).toBeUndefined();
		}
	});
});
