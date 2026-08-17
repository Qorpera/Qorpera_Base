import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveStaffAgent,
	createStaffAgent,
	createStaffAgents,
	readStaffAgents,
	replaceStaffAgents,
	restoreStaffAgent,
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
			appearance: { color: "#ff6b00", shape: "gem", creature: "palette" },
		});
		expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(staffRegistryPath(root)).toBe(join(root, ".qorpera", "staff.json"));
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

	it("replaces the local projection with validated stable cloud identities", () => {
		const initial = createStaffAgent(root, {
			displayName: "Local only",
			role: "Temporary role",
			charter: "This record will be replaced.",
			appearance: { color: "gray", shape: "round" },
		});
		const cloud = {
			...initial,
			id: "11111111-1111-4111-8111-111111111111",
			displayName: "Shared operator",
			updatedAt: new Date(Date.parse(initial.updatedAt) + 1_000).toISOString(),
		};

		expect(replaceStaffAgents(root, [cloud])).toEqual([cloud]);
		expect(readStaffAgents(root)).toEqual([cloud]);
		expect(() => replaceStaffAgents(root, [cloud, cloud])).toThrow("Duplicate staff agent");
		expect(readStaffAgents(root)).toEqual([cloud]);
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
