import { describe, expect, it } from "vitest";
import { type PlaceNames, personPlaces, personWhere, placeTarget } from "../src/app/person-place.ts";
import type { PresenceMember } from "../src/cloud/presence.ts";

const profileId = "20000000-0000-4000-8000-000000000001";
const names: PlaceNames = {
	surface: (slug) => (slug === "website" ? { slug: "website", title: "Website" } : undefined),
	agent: (id) =>
		id === "bo"
			? { id: "Bo", name: "Bo", home: false }
			: id === "kaya"
				? { id: "kaya", name: "Kaya", home: true }
				: undefined,
	room: (id) => (id === "r1" ? { sessionId: "s1", title: "Launch" } : undefined),
	page: (name) => (name === "mailbox" ? "Mailbox" : undefined),
};
const tab = (userId: string, value: string | null): PresenceMember => ({
	clientId: `${userId}-${value}`,
	userId,
	name: userId,
	staffAgentId: value,
});

describe("where a teammate is", () => {
	it("names each place in the rail and links to it", () => {
		expect(placeTarget(profileId, "surface:website", names)).toEqual({
			label: "On Website",
			href: `#/c/${profileId}/s/website`,
		});
		expect(placeTarget(profileId, "agent:bo", names)).toEqual({
			label: "With Bo",
			href: `#/c/${profileId}/staff/Bo`,
		});
		expect(placeTarget(profileId, "agent:kaya", names)).toEqual({ label: "With Kaya", href: `#/c/${profileId}` });
		expect(placeTarget(profileId, "room:r1", names)).toEqual({
			label: "In Launch",
			href: `#/c/${profileId}/chat/s1`,
		});
		expect(placeTarget(profileId, "page:mailbox", names)).toEqual({
			label: "On Mailbox",
			href: `#/c/${profileId}/i/mailbox`,
		});
	});

	it("says nothing of a place it does not know", () => {
		for (const place of ["surface:gone", "agent:left", "room:r9", "page:bank", "app:trips", "concepts", "sites"])
			expect(placeTarget(profileId, place, names)).toBeUndefined();
	});

	it("reads only the teammate's own tabs, and takes the first place it knows", () => {
		const here = [
			tab("sofie", "s9@app:trips"),
			tab("mads", "@surface:website"),
			tab("sofie", null),
			tab("sofie", "s1@room:r1"),
			tab("sofie", "@surface:website"),
		];
		expect(personPlaces(here, "sofie")).toEqual(["app:trips", "room:r1", "surface:website"]);
		expect(personWhere(profileId, here, "sofie", names)?.label).toBe("In Launch");
		expect(personWhere(profileId, here, "nora", names)).toBeUndefined();
		expect(personWhere(profileId, undefined, "sofie", names)).toBeUndefined();
	});
});
