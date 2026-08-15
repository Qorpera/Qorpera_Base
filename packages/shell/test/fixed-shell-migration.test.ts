import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateCompanyToFixedShell } from "../src/fixed-shell-migration.ts";

let root = "";

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("fixed shell migration", () => {
	it("removes only the obsolete company-owned shell tree", () => {
		root = join(tmpdir(), `qorpera-fixed-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "userland", ".versions", "v1"), { recursive: true });
		mkdirSync(join(root, ".qorpera"), { recursive: true });
		mkdirSync(join(root, "trail"), { recursive: true });
		mkdirSync(join(root, "app", "surfaces"), { recursive: true });
		writeFileSync(join(root, "userland", "index.html"), "old shell", "utf-8");
		writeFileSync(join(root, "userland", ".versions", "v1", "index.html"), "older shell", "utf-8");
		writeFileSync(join(root, ".qorpera", "staff.json"), "staff", "utf-8");
		writeFileSync(join(root, "trail", "session.jsonl"), "trail", "utf-8");
		writeFileSync(join(root, "app", "surfaces", "board.html"), "surface", "utf-8");

		expect(migrateCompanyToFixedShell(root)).toEqual({
			removed: true,
			filesRemoved: 2,
			versionsRemoved: 1,
		});
		expect(existsSync(join(root, "userland"))).toBe(false);
		expect(readFileSync(join(root, ".qorpera", "staff.json"), "utf-8")).toBe("staff");
		expect(readFileSync(join(root, "trail", "session.jsonl"), "utf-8")).toBe("trail");
		expect(readFileSync(join(root, "app", "surfaces", "board.html"), "utf-8")).toBe("surface");
	});

	it("is a no-op after migration", () => {
		root = join(tmpdir(), `qorpera-fixed-shell-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		expect(migrateCompanyToFixedShell(root)).toEqual({
			removed: false,
			filesRemoved: 0,
			versionsRemoved: 0,
		});
	});
});
