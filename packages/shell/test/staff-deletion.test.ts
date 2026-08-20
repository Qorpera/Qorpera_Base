import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeStaffWorkspace } from "../src/staff-deletion.ts";

describe("staff workspace deletion", () => {
	let root: string;
	let agentDirectory: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-staff-deletion-"));
		agentDirectory = join(root, "agents", "agent-id");
		mkdirSync(join(agentDirectory, "artifacts"), { recursive: true });
		mkdirSync(join(agentDirectory, "skills"), { recursive: true });
		writeFileSync(join(agentDirectory, "artifacts", "report.json"), "artifact\n", "utf8");
		writeFileSync(join(agentDirectory, "skills", "private.md"), "skill\n", "utf8");
		writeFileSync(join(agentDirectory, "instructions.md"), "instructions\n", "utf8");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps only artifacts when requested", () => {
		removeStaffWorkspace(agentDirectory, true);

		expect(readFileSync(join(agentDirectory, "artifacts", "report.json"), "utf8")).toBe("artifact\n");
		expect(existsSync(join(agentDirectory, "skills"))).toBe(false);
		expect(existsSync(join(agentDirectory, "instructions.md"))).toBe(false);
	});

	it("removes the complete agent workspace when artifacts are not kept", () => {
		removeStaffWorkspace(agentDirectory, false);

		expect(existsSync(agentDirectory)).toBe(false);
	});
});
