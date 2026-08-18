import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activateStaffAgent,
	archiveStaffAgent,
	createStaffAgent,
	createStaffAgents,
	deleteStaffAgent,
	readStaffAgentMemory,
	readStaffAgents,
	restoreStaffAgent,
	staffAgentDirectoryPath,
	staffAgentInstructionsPath,
	staffAgentMemoryPath,
	staffAgentSkillsPath,
	staffRegistryPath,
	updateStaffAgent,
} from "../src/core/company-staff.ts";

describe("company staff registry", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-company-staff-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("treats a missing registry as empty and creates a portable active staff record", () => {
		expect(readStaffAgents(root)).toEqual([]);
		const created = createStaffAgent(root, {
			displayName: "Night Shift",
			role: "Overnight operations lead",
			charter: "Prepare the founder's morning digest.",
			templateId: "night-shift",
			departmentId: "operations",
			appearance: { color: "#ff6b00", shape: "gem", creature: "palette" },
		});

		expect(created).toMatchObject({
			displayName: "Night Shift",
			employmentStatus: "active",
			lifecycleState: "setup",
			appearance: { color: "#ff6b00", shape: "gem", creature: "palette" },
		});
		expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(staffRegistryPath(root)).toBe(join(root, ".qorpera", "staff.json"));
		expect(staffAgentDirectoryPath(root, created.id)).toBe(join(root, "agents", created.id));
		expect(readFileSync(staffAgentInstructionsPath(root, created.id), "utf-8")).toBe(
			"Prepare the founder's morning digest.",
		);
		expect(existsSync(join(root, "agents", created.id, "artifacts"))).toBe(true);
		expect(readStaffAgents(root)).toEqual([created]);
		expect(readdirSync(join(root, ".qorpera"))).toEqual(["staff.json"]);
	});

	it("updates profile fields without changing identity or employment state", () => {
		const created = createStaffAgent(root, {
			displayName: "Inbox Triage",
			role: "Email assistant",
			charter: "Sort inbound mail.",
			templateId: "inbox-triage",
			departmentId: "operations",
			appearance: { color: "pink", shape: "wide" },
		});
		const updated = updateStaffAgent(root, created.id, {
			displayName: "Chief of Inbox",
			charter: "Sort inbound mail and draft replies.",
			templateId: null,
			departmentId: null,
			appearance: { color: "magenta", shape: "soft-square", creature: "nox" },
		});

		expect(updated).toMatchObject({
			id: created.id,
			displayName: "Chief of Inbox",
			role: created.role,
			employmentStatus: "active",
			createdAt: created.createdAt,
			appearance: { color: "magenta", shape: "soft-square", creature: "nox" },
		});
		expect(updated).not.toHaveProperty("templateId");
		expect(updated).not.toHaveProperty("departmentId");
		expect(readStaffAgents(root)).toEqual([updated]);
		expect(readFileSync(staffAgentInstructionsPath(root, created.id), "utf-8")).toBe(
			"Sort inbound mail and draft replies.",
		);
	});

	it("creates an initial team atomically", () => {
		const created = createStaffAgents(root, [
			{
				displayName: "Operations",
				role: "Operations lead",
				charter: "Keep recurring work moving.",
				appearance: { color: "orange", shape: "round" },
			},
			{
				displayName: "Research",
				role: "Research lead",
				charter: "Build verified research briefs.",
				appearance: { color: "blue", shape: "wide" },
			},
		]);

		expect(created).toHaveLength(2);
		expect(created[0]?.createdAt).toBe(created[1]?.createdAt);
		expect(readStaffAgents(root)).toEqual(created);
		expect(created.every((agent) => existsSync(staffAgentInstructionsPath(root, agent.id)))).toBe(true);

		expect(() =>
			createStaffAgents(root, [
				{
					displayName: "Valid",
					role: "Valid role",
					charter: "Valid charter.",
					appearance: { color: "green", shape: "round" },
				},
				{
					displayName: " Invalid ",
					role: "Invalid role",
					charter: "Invalid charter.",
					appearance: { color: "red", shape: "round" },
				},
			]),
		).toThrow("displayName");
		expect(readStaffAgents(root)).toEqual(created);
	});

	it("archives and restores without deleting the durable staff record", () => {
		const created = createStaffAgent(root, {
			displayName: "Negotiator",
			role: "Commercial negotiator",
			charter: "Research fair prices and negotiate within authority.",
			appearance: { color: "green", shape: "drop" },
		});

		expect(archiveStaffAgent(root, created.id).employmentStatus).toBe("archived");
		expect(readStaffAgents(root)).toHaveLength(1);
		expect(restoreStaffAgent(root, created.id).employmentStatus).toBe("active");
		expect(readStaffAgents(root)).toMatchObject([{ id: created.id, employmentStatus: "active" }]);
	});

	it("keeps conception separate from employment and activates it durably", () => {
		const created = createStaffAgent(root, {
			displayName: "Financial Officer",
			role: "Financial control",
			charter: "Own financial visibility.",
			appearance: { color: "green", shape: "gem" },
		});

		expect(created.lifecycleState).toBe("setup");
		const activated = activateStaffAgent(root, created.id);
		expect(activated).toMatchObject({ lifecycleState: "active", employmentStatus: "active" });
		expect(archiveStaffAgent(root, created.id)).toMatchObject({
			lifecycleState: "active",
			employmentStatus: "archived",
		});
		expect(restoreStaffAgent(root, created.id)).toMatchObject({
			lifecycleState: "active",
			employmentStatus: "active",
		});
	});

	it("provisions a private memory file and personal skills directory with the workspace", () => {
		const created = createStaffAgent(root, {
			displayName: "Archivist",
			role: "Records keeper",
			charter: "Keep durable records current.",
			appearance: { color: "blue", shape: "round" },
		});

		expect(staffAgentMemoryPath(root, created.id)).toBe(join(root, "agents", created.id, "memory.md"));
		expect(staffAgentSkillsPath(root, created.id)).toBe(join(root, "agents", created.id, "skills"));
		expect(existsSync(staffAgentMemoryPath(root, created.id))).toBe(true);
		expect(existsSync(staffAgentSkillsPath(root, created.id))).toBe(true);
		expect(readStaffAgentMemory(root, created.id)).toContain("# Memory");

		writeFileSync(staffAgentMemoryPath(root, created.id), "# Memory\n\nFounder prefers weekly digests.\n", "utf-8");
		updateStaffAgent(root, created.id, { role: "Company archivist" });
		expect(readStaffAgentMemory(root, created.id)).toContain("Founder prefers weekly digests.");
		expect(readStaffAgentMemory(root, "11111111-1111-4111-8111-111111111111")).toBe("");
	});

	it("persists a durable per-agent model choice and clears it back to the company default", () => {
		const created = createStaffAgent(root, {
			displayName: "Analyst",
			role: "Data analyst",
			charter: "Own analytical measures.",
			appearance: { color: "green", shape: "gem" },
		});
		expect(created).not.toHaveProperty("model");

		const chosen = updateStaffAgent(root, created.id, {
			model: { provider: "anthropic", modelId: "claude-fable-5" },
		});
		expect(chosen.model).toEqual({ provider: "anthropic", modelId: "claude-fable-5" });
		expect(readStaffAgents(root)[0]?.model).toEqual({ provider: "anthropic", modelId: "claude-fable-5" });

		const kept = updateStaffAgent(root, created.id, { displayName: "Senior Analyst" });
		expect(kept.model).toEqual({ provider: "anthropic", modelId: "claude-fable-5" });

		const cleared = updateStaffAgent(root, created.id, { model: null });
		expect(cleared).not.toHaveProperty("model");
		expect(readStaffAgents(root)[0]).not.toHaveProperty("model");

		expect(() =>
			updateStaffAgent(root, created.id, { model: { provider: "", modelId: "claude-fable-5" } as never }),
		).toThrow("model provider");
		expect(() =>
			updateStaffAgent(root, created.id, {
				model: { provider: "anthropic", modelId: "claude-fable-5", extra: true } as never,
			}),
		).toThrow("Staff agent model is invalid");
	});

	it("permanently deletes a staff definition when explicitly requested", () => {
		const created = createStaffAgent(root, {
			displayName: "Temporary analyst",
			role: "Analyst",
			charter: "Complete a bounded analysis.",
			appearance: { color: "blue", shape: "round" },
		});

		expect(deleteStaffAgent(root, created.id)).toEqual(created);
		expect(readStaffAgents(root)).toEqual([]);
		expect(existsSync(staffAgentDirectoryPath(root, created.id))).toBe(true);
		expect(() => deleteStaffAgent(root, created.id)).toThrow("Unknown staff agent");
	});

	it("rejects malformed registries instead of silently dropping records", () => {
		const created = createStaffAgent(root, {
			displayName: "Chief of Staff",
			role: "Coordinator",
			charter: "Coordinate the company staff.",
			appearance: { color: "red", shape: "soft-square" },
		});
		const path = staffRegistryPath(root);
		writeFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				agents: {
					[created.id]: { ...created, id: "11111111-1111-4111-8111-111111111111" },
				},
			})}\n`,
			"utf-8",
		);

		expect(() => readStaffAgents(root)).toThrow("Staff agent identity is invalid");
	});

	it("validates API input and refuses unknown agents", () => {
		expect(() =>
			createStaffAgent(root, {
				displayName: " Night Shift ",
				role: "Overnight operations lead",
				charter: "Prepare a digest.",
				appearance: { color: "orange", shape: "gem" },
			}),
		).toThrow("displayName");
		expect(() => updateStaffAgent(root, "11111111-1111-4111-8111-111111111111", {})).toThrow(
			"Staff agent update is invalid",
		);
		expect(() => archiveStaffAgent(root, "11111111-1111-4111-8111-111111111111")).toThrow("Unknown staff agent");
		expect(existsSync(join(root, ".qorpera", "staff.json"))).toBe(false);
	});
});
