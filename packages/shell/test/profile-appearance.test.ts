import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PROFILE_ICON_ID,
	forgetProfileIcon,
	isProfileIconId,
	readProfileIcon,
	writeProfileIcon,
} from "../src/profile-appearance.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `qorpera-profile-appearance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("profile appearance", () => {
	const founder = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
	const other = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";

	it("uses the selected company icon only for its owning account", () => {
		const userData = temporaryRoot();
		const profile = join(userData, "company-a");
		expect(readProfileIcon(userData, founder, profile)).toBe(DEFAULT_PROFILE_ICON_ID);
		writeProfileIcon(userData, founder, profile, "hop-mono-cloud");
		expect(readProfileIcon(userData, founder, profile)).toBe("hop-mono-cloud");
		expect(readProfileIcon(userData, other, profile)).toBe(DEFAULT_PROFILE_ICON_ID);
		forgetProfileIcon(userData, founder, profile);
		expect(readProfileIcon(userData, founder, profile)).toBe(DEFAULT_PROFILE_ICON_ID);
	});

	it("rejects unknown company icon identifiers", () => {
		expect(isProfileIconId("hop-blue-steel")).toBe(true);
		expect(isProfileIconId("agent-gem")).toBe(false);
	});
});
