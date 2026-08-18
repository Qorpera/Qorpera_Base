import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateCompanyToAgentsOnly } from "../src/agents-only-company-migration.ts";

let root = "";

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("agents-only company migration", () => {
	it("removes obsolete company-authored shell and application trees only", () => {
		root = join(tmpdir(), `qorpera-agents-only-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(root, "userland", ".versions", "v1"), { recursive: true });
		mkdirSync(join(root, "app", "surfaces"), { recursive: true });
		mkdirSync(join(root, ".qorpera"), { recursive: true });
		mkdirSync(join(root, "agents", "agent-1", "artifacts"), { recursive: true });
		mkdirSync(join(root, "connectors"), { recursive: true });
		mkdirSync(join(root, "files"), { recursive: true });
		mkdirSync(join(root, "trail"), { recursive: true });
		writeFileSync(join(root, "userland", "index.html"), "old shell", "utf-8");
		writeFileSync(join(root, "userland", ".versions", "v1", "index.html"), "older shell", "utf-8");
		writeFileSync(join(root, "app", "projection.json"), "{}", "utf-8");
		writeFileSync(join(root, "app", "surfaces", "board.html"), "surface", "utf-8");
		writeFileSync(join(root, ".qorpera", "staff.json"), "staff", "utf-8");
		writeFileSync(join(root, "agents", "agent-1", "artifacts", "health.json"), "artifact", "utf-8");
		writeFileSync(join(root, "files", "work.md"), "work", "utf-8");
		writeFileSync(join(root, "trail", "session.jsonl"), "trail", "utf-8");

		expect(migrateCompanyToAgentsOnly(root)).toEqual({
			removed: true,
			removedRoots: ["userland", "app"],
			filesRemoved: 4,
			versionsRemoved: 1,
		});
		expect(existsSync(join(root, "userland"))).toBe(false);
		expect(existsSync(join(root, "app"))).toBe(false);
		expect(existsSync(join(root, ".qorpera", "staff.json"))).toBe(true);
		expect(existsSync(join(root, "agents", "agent-1", "artifacts", "health.json"))).toBe(true);
		expect(existsSync(join(root, "files", "work.md"))).toBe(true);
		expect(existsSync(join(root, "trail", "session.jsonl"))).toBe(true);
	});

	it("is a no-op after migration", () => {
		root = join(tmpdir(), `qorpera-agents-only-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		expect(migrateCompanyToAgentsOnly(root)).toEqual({
			removed: false,
			removedRoots: [],
			filesRemoved: 0,
			versionsRemoved: 0,
		});
	});
});
