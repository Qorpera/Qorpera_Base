import {
	type CompanyComputerStateAdoptionInput,
	planCompanyComputerStateAdoption,
} from "@qorpera/runtime/cloud-company-computer-adoption";
import { describe, expect, it } from "vitest";
import { computerBinding, computerId, computerScope } from "./fixtures/company-computer.ts";

function adoptionInput() {
	return {
		scope: computerScope(),
		legacyRoots: {
			screenStateRoot: "/srv/legacy/.qorpera-computer/screens",
			browserProfilesRoot: "/srv/legacy/profiles/chrome",
		},
		layout: {
			workbenchRoot: "/srv/workbench",
			desktopHome: "/srv/desktop",
			screenStateRoot: "/srv/screens",
			browserProfilesRoot: "/srv/profiles",
		},
		mappings: [
			{
				legacy: { ...computerBinding(), screenOrdinal: 7 },
				binding: computerBinding(),
				browserProfile: { profileId: computerId(40), grantId: computerId(41), version: 3 },
			},
		],
	} satisfies CompanyComputerStateAdoptionInput;
}

describe("legacy state adoption plan (pure mapping, no migration or authority)", () => {
	it("maps the inventoried old ordinal to the same cloud identities and an explicitly named profile", () => {
		const input = adoptionInput();
		const plan = planCompanyComputerStateAdoption(input);
		expect(plan).toEqual([
			{
				legacyOrdinal: 7,
				binding: computerBinding(),
				desktop: {
					source: "/srv/legacy/.qorpera-computer/screens/screen-7",
					destination: `/srv/screens/${computerId(6)}`,
				},
				browser: {
					disposition: "adopt",
					source: "/srv/legacy/profiles/chrome/screen-7",
					destination: `/srv/profiles/${computerId(40)}`,
					grant: { profileId: computerId(40), grantId: computerId(41), version: 3 },
				},
			},
		]);
		Object.assign(input.mappings[0].binding, { staffAgentId: computerId(99) });
		Object.assign(input.mappings[0].browserProfile, { version: 99 });
		expect(plan[0].binding).toEqual(computerBinding());
		expect(plan[0].browser).toMatchObject({ grant: { version: 3 } });
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan[0].binding)).toBe(true);
		expect(Object.isFrozen(plan[0].browser)).toBe(true);
	});

	it("requires an explicit disposition and leaves ungranted profile bytes quarantined", () => {
		const input = adoptionInput();
		const [entry] = planCompanyComputerStateAdoption({
			...input,
			mappings: [{ ...input.mappings[0], browserProfile: null }],
		});
		expect(entry.browser).toEqual({ disposition: "quarantine", source: "/srv/legacy/profiles/chrome/screen-7" });
		Reflect.deleteProperty(input.mappings[0], "browserProfile");
		expect(() => planCompanyComputerStateAdoption(input)).toThrow("EXPLICIT_BROWSER_PROFILE_DISPOSITION_REQUIRED");
	});

	it.each(["companyId", "environmentId", "companyComputerId", "logicalComputerId"] as const)(
		"rejects a substituted %s in either side of the mapping",
		(key) => {
			for (const side of ["legacy", "binding"] as const) {
				const input = adoptionInput();
				Object.assign(input.mappings[0][side], { [key]: computerId(99) });
				expect(() => planCompanyComputerStateAdoption(input)).toThrow("COMPUTER_BINDING_MISMATCH");
			}
		},
	);

	it.each(["screenId", "staffAgentId"] as const)("does not infer a new owner from an old ordinal: %s", (key) => {
		const input = adoptionInput();
		Object.assign(input.mappings[0].legacy, { [key]: computerId(99) });
		expect(() => planCompanyComputerStateAdoption(input)).toThrow("LEGACY_SCREEN_BINDING_MISMATCH");
	});

	it.each([0, 33, 1.5])("rejects an invalid legacy ordinal: %s", (screenOrdinal) => {
		const input = adoptionInput();
		Object.assign(input.mappings[0].legacy, { screenOrdinal });
		expect(() => planCompanyComputerStateAdoption(input)).toThrow("LEGACY_SCREEN_BINDING_MISMATCH");
	});

	it.each(["legacy ordinal", "target ordinal", "screen", "agent", "profile"])(
		"rejects duplicate %s instead of merging persistent state",
		(duplicate) => {
			const input = adoptionInput();
			const first = input.mappings[0];
			const identity = {
				screenId: duplicate === "screen" ? first.binding.screenId : computerId(60),
				staffAgentId: duplicate === "agent" ? first.binding.staffAgentId : computerId(61),
			};
			const second = {
				legacy: { ...first.legacy, ...identity, screenOrdinal: duplicate === "legacy ordinal" ? 7 : 8 },
				binding: { ...first.binding, ...identity, screenOrdinal: duplicate === "target ordinal" ? 1 : 2 },
				browserProfile: {
					profileId: duplicate === "profile" ? computerId(40) : computerId(62),
					grantId: computerId(63),
					version: 1,
				},
			};
			expect(() => planCompanyComputerStateAdoption({ ...input, mappings: [first, second] })).toThrow(
				"AMBIGUOUS_STATE_ADOPTION",
			);
		},
	);

	it.each([{ profileId: "screen-7" }, { grantId: "" }, { version: 0 }, { version: 1.5 }])(
		"does not treat a directory name or invalid grant metadata as a profile grant: %j",
		(bad) => {
			const input = adoptionInput();
			Object.assign(input.mappings[0].browserProfile, bad);
			expect(() => planCompanyComputerStateAdoption(input)).toThrow("EXPLICIT_BROWSER_PROFILE_DISPOSITION_REQUIRED");
		},
	);

	it.each(["relative", "/", "/srv/old/../profiles", "/srv/old/", "/srv/dataset/live", "/srv/credentials"])(
		"rejects unsafe legacy roots: %s",
		(screenStateRoot) => {
			const input = adoptionInput();
			expect(() =>
				planCompanyComputerStateAdoption({ ...input, legacyRoots: { ...input.legacyRoots, screenStateRoot } }),
			).toThrow("UNSAFE_LEGACY_STATE_ROOT");
		},
	);

	it("rejects overlapping roots and invalid target generations", () => {
		const input = adoptionInput();
		expect(() =>
			planCompanyComputerStateAdoption({
				...input,
				legacyRoots: { screenStateRoot: "/srv/old", browserProfilesRoot: "/srv/old/profiles" },
			}),
		).toThrow("OVERLAPPING_LEGACY_STATE_ROOTS");
		Object.assign(input.mappings[0].binding, { computerGeneration: 0 });
		expect(() => planCompanyComputerStateAdoption(input)).toThrow("SCREEN_BINDING_MISMATCH");
	});
});
