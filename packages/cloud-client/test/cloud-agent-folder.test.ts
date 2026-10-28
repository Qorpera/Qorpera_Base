import { describe, expect, it } from "vitest";
import { cloudAgentFolder, isCloudAgentFolder } from "../src/cloud-agent-folder.ts";
import { companyStatePath } from "../src/company-state-files.ts";

const company = "11111111-1111-4111-8111-111111111111";
const agent = "22222222-2222-4222-8222-222222222222";
const place = { core: "folder-v2", handle: "anna-berg" } as const;

describe("an agent's folder", () => {
	it("is its folder name under QorperaOS/agents, where its agent.md is", () => {
		const folder = cloudAgentFolder(company, agent, place);
		expect(folder).toBe("QorperaOS/agents/anna-berg");
		expect(companyStatePath(`${folder}/agent.md`)?.kind).toBe("agent");
		expect(companyStatePath(`${folder}/routines/daily.md`)?.kind).toBe("routine");
	});

	it("refuses an owner that is not an id, and a folder name the company folder would not accept", () => {
		expect(() => cloudAgentFolder("company", agent, place)).toThrow("Invalid agent folder owner");
		expect(() => cloudAgentFolder(company, "anna", place)).toThrow("Invalid agent folder owner");
		for (const handle of ["", "Anna", "anna--berg", "-anna", "anna/berg", "..", "groups", "a".repeat(65)])
			expect(() => cloudAgentFolder(company, agent, { core: "folder-v2", handle })).toThrow(
				"Invalid agent folder name",
			);
		// No other kind of place is left: an agent's folder is never its id (legacy sweep step C, AF).
		expect(() => cloudAgentFolder(company, agent, { core: "snapshot-v1" } as never)).toThrow(
			"Invalid agent folder name",
		);
		expect(cloudAgentFolder(company, agent, { core: "folder-v2", handle: "a".repeat(64) })).toBe(
			`QorperaOS/agents/${"a".repeat(64)}`,
		);
	});

	it("tells an agent's folder from other paths", () => {
		expect(isCloudAgentFolder(cloudAgentFolder(company, agent, place))).toBe(true);
		// The database's keys name the root in lowercase.
		expect(isCloudAgentFolder("qorperaos/agents/anna-berg")).toBe(true);
		for (const path of [
			"QorperaOS",
			"QorperaOS/agents",
			"agents",
			"agents/anna-berg",
			"qorperaosx/agents/anna-berg",
			"work/QorperaOS/agents/anna-berg",
			"QorperaOS/agents/",
			"QorperaOS/agents/groups",
			"QorperaOS/agents/-a",
			"QorperaOS/agents/a--b",
			"QorperaOS/agents/Anna",
			"QorperaOS/agents/a/b",
			"work/anna",
		])
			expect(isCloudAgentFolder(path)).toBe(false);
	});
});
