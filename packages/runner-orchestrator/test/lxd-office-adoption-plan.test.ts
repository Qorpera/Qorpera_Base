import { describe, expect, it } from "vitest";
import { planLxdOfficeAdoption } from "../src/lxd-office-adoption-plan.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "../src/lxd-office-inventory-worker.ts";
import { lxdOfficeProviderBindingSha256 } from "../src/lxd-office-start-control.ts";
import type { OfficeInventoryEntry } from "../src/lxd-office-storage-inventory.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(empty = false) {
	const { binding } = officePhysicalFixture();
	const scope = {
		companyId: binding.companyId,
		environmentId: binding.environmentId,
		companyComputerId: binding.companyComputerId,
		logicalComputerId: binding.logicalComputerId,
	};
	const paths = empty
		? ["."]
		: [
				".",
				"legacy",
				"legacy/workbench",
				"legacy/workbench/note.txt",
				"legacy/screens",
				"legacy/screens/screen-7",
				"legacy/screens/screen-7/settings",
				"legacy/profiles",
				"legacy/profiles/screen-7",
				"legacy/profiles/screen-7/Cookies",
				"loose.txt",
			];
	const entries: OfficeInventoryEntry[] = paths.sort().map((path, index) => {
		const file = /(?:note.txt|settings|Cookies|loose.txt)$/.test(path);
		return {
			path,
			kind: file ? "file" : "directory",
			dev: "1",
			ino: String(index + 1),
			uid: 1000,
			gid: 1000,
			mode: file ? 0o755 : 0o700,
			mtimeNs: "1",
			ctimeNs: "1",
			bytes: file ? 1 : 0,
			sha256: file ? "a".repeat(64) : null,
		};
	});
	const observation: LxdOfficeStorageObservation = {
		schema: "qorpera.lxd-office-storage-observation/v1",
		intentId: id(1),
		allocationId: binding.allocationId,
		providerBindingSha256: lxdOfficeProviderBindingSha256(binding),
		hostBootId: id(2),
		inventory: {
			schema: "qorpera.office-storage-inventory/v1",
			root: binding.workbenchSource,
			mountId: "123",
			entries,
			totalBytes: empty ? 0 : 4,
		},
	};
	const input = {
		schema: "qorpera.lxd-office-adoption-input/v1",
		adoptionId: id(3),
		shared: { workbench: empty ? null : "legacy/workbench", desktopHome: null as string | null },
		legacy: empty
			? null
			: {
					roots: { screenStateRoot: "legacy/screens", browserProfilesRoot: "legacy/profiles" },
					mappings: [
						{
							legacy: { ...scope, screenId: id(4), staffAgentId: id(5), screenOrdinal: 7 },
							binding: {
								...scope,
								screenId: id(4),
								staffAgentId: id(5),
								screenOrdinal: 1,
								screenGeneration: 2,
								computerGeneration: 1,
							},
							browserProfile: { profileId: id(6), grantId: id(7), version: 3 } as {
								profileId: string;
								grantId: string;
								version: number;
							} | null,
						},
					],
				},
		quarantine: empty ? [] : ["loose.txt"],
	};
	return { binding, observation, input, entries, plan: () => planLxdOfficeAdoption(input, binding, observation) };
}
describe("executable office adoption mapping", () => {
	it("compiles the shared historical mapper into private destinations with exact source evidence", () => {
		const f = fixture();
		const plan = f.plan();
		expect(plan.observationSha256).toBe(officeDigest(f.observation));
		expect(plan.guestLayout.workbenchRoot).toBe(`/var/lib/qorpera-office/.qorpera-adopted-${id(3)}/workbench`);
		expect(
			plan.items
				.filter((item) => item.kind === "file")
				.map((item) => [item.destination, item.source?.path, item.mode]),
		).toEqual([
			["workbench/note.txt", "legacy/workbench/note.txt", 0o700],
			[`profiles/${id(6)}/Cookies`, "legacy/profiles/screen-7/Cookies", 0o700],
			[`screens/${id(4)}/settings`, "legacy/screens/screen-7/settings", 0o700],
		]);
		expect(plan.quarantine).toEqual(["loose.txt"]);
		expect(plan.screens[0].legacyOrdinal).toBe(7);
		expect(plan.screens[0].browser).toMatchObject({
			disposition: "adopt",
			grant: { profileId: id(6), grantId: id(7), version: 3 },
		});
		Object.assign(f.entries.find((item) => item.path.endsWith("note.txt"))!, { sha256: "changed" });
		f.input.legacy!.mappings[0].browserProfile!.version = 99;
		expect(plan.items.find((item) => item.destination.endsWith("note.txt"))!.source!.sha256).toBe("a".repeat(64));
		expect(Object.isFrozen(plan.items[0])).toBe(true);
		expect(plan.screens[0].browser).toMatchObject({ grant: { version: 3 } });
	});
	it("initializes empty roots only from an actual empty source inventory", () => {
		const f = fixture(true);
		expect(f.plan().items.map((item) => [item.destination, item.source])).toEqual([
			["desktop", null],
			["profiles", null],
			["screens", null],
			["workbench", null],
		]);
	});
	it("quarantines an explicitly ungranted profile without exposing its cookies to the workbench", () => {
		const f = fixture();
		f.input.legacy!.mappings[0].browserProfile = null;
		const plan = f.plan();
		expect(plan.quarantine).toEqual(["legacy/profiles/screen-7", "loose.txt"]);
		expect(plan.items.some((item) => item.source?.path.endsWith("Cookies"))).toBe(false);
	});
	it("rejects any undisposed file and any nonexistent source", () => {
		const f = fixture();
		f.input.quarantine = [];
		expect(f.plan).toThrow("UNREVIEWED_OFFICE_STORAGE");
		f.input.quarantine = ["missing"];
		expect(f.plan).toThrow("SOURCE_MISSING");
	});
	it("permits explicit sensitive-subtree quarantine but never silently copies provider identity", () => {
		const f = fixture();
		const file = f.entries.find((entry) => entry.kind === "file")!;
		f.entries.push(
			{ ...file, path: "legacy/workbench/.codex", kind: "directory", bytes: 0, sha256: null },
			{ ...file, path: "legacy/workbench/.codex/auth.json" },
		);
		expect(f.plan).toThrow("SENSITIVE_STATE_REQUIRES_QUARANTINE");
		f.input.quarantine.push("legacy/workbench/.codex");
		const plan = f.plan();
		expect(plan.items.some((item) => item.source?.path.includes(".codex"))).toBe(false);
		expect(plan.quarantine).toContain("legacy/workbench/.codex");
	});
	it.each(["..", "../legacy", "/legacy", "legacy//screens", "legacy/./screens", "legacy\\screens", "legacy\nname"])(
		"rejects path traversal or aliases: %s",
		(path) => {
			const f = fixture();
			f.input.shared.workbench = path;
			expect(f.plan).toThrow("UNSAFE_OFFICE_ADOPTION_PATH");
		},
	);
	it.each(["shared overlap", "quarantine overlap", "duplicate", "file source"])(
		"rejects ambiguous state selection: %s",
		(reason) => {
			const f = fixture();
			if (reason === "shared overlap") f.input.shared.desktopHome = "legacy";
			if (reason === "quarantine overlap") f.input.quarantine.push("legacy");
			if (reason === "duplicate") f.input.quarantine.push("legacy/workbench");
			if (reason === "file source") f.input.shared.desktopHome = "loose.txt";
			expect(f.plan).toThrow();
		},
	);
	it.each(["scope", "generation", "agent", "profile"])("rejects mismatched screen/grant metadata: %s", (reason) => {
		const f = fixture();
		const map = f.input.legacy!.mappings[0];
		if (reason === "scope") map.binding.companyId = id(99);
		if (reason === "generation") map.binding.computerGeneration = 2;
		if (reason === "agent") map.legacy.staffAgentId = id(99);
		if (reason === "profile") map.browserProfile!.grantId = "screen-7";
		expect(f.plan).toThrow();
	});
	it("cannot reuse another allocation, root or policy observation", () => {
		for (const key of ["allocationId", "providerBindingSha256"] as const) {
			const f = fixture();
			Object.assign(f.observation, { [key]: "different" });
			expect(f.plan).toThrow("OBSERVATION_MISMATCH");
		}
		const f = fixture();
		Object.assign(f.observation.inventory, { root: "/other" });
		expect(f.plan).toThrow("OBSERVATION_MISMATCH");
	});
	it("refuses an existing destination and open input records", () => {
		const f = fixture();
		f.entries.push({ ...f.entries[0], path: `.qorpera-adopted-${id(3)}` });
		expect(f.plan).toThrow("DESTINATION_OR_INVENTORY_INVALID");
		const other = fixture();
		expect(() =>
			planLxdOfficeAdoption({ ...other.input, deleteOriginal: true }, other.binding, other.observation),
		).toThrow();
		Object.assign(other.input.legacy!.mappings[0].browserProfile!, { token: "not allowed" });
		expect(other.plan).toThrow();
	});
});
