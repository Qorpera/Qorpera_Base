import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSidebarTranslucency, shellAppearancePath, writeSidebarTranslucency } from "../src/shell-appearance.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryUserData(): string {
	const root = mkdtempSync(join(tmpdir(), "qorpera-shell-appearance-"));
	roots.push(root);
	return join(root, "user-data");
}

describe("shell appearance", () => {
	it("defaults the sidebar to translucent", () => {
		expect(readSidebarTranslucency(temporaryUserData())).toBe(true);
	});

	it("persists one app-wide sidebar preference", () => {
		const userData = temporaryUserData();
		expect(writeSidebarTranslucency(userData, false)).toBe(true);
		expect(readSidebarTranslucency(userData)).toBe(false);
		expect(writeSidebarTranslucency(userData, true)).toBe(true);
		expect(readSidebarTranslucency(userData)).toBe(true);
	});

	it("falls back to translucency for malformed state", () => {
		const userData = temporaryUserData();
		const path = shellAppearancePath(userData);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "not-json", "utf-8");
		expect(readSidebarTranslucency(userData)).toBe(true);
	});
});
