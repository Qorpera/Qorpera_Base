import { describe, expect, it } from "vitest";
import { CLOUD_AGENT_FOLDER_BY_ID, cloudAgentFolder, isCloudAgentFolder } from "../src/cloud-agent-folder.ts";
import { companyStatePath } from "../src/company-state-files.ts";

const company = "11111111-1111-4111-8111-111111111111";
const agent = "22222222-2222-4222-8222-222222222222";

describe("an agent's folder", () => {
	it("is its id in a snapshot-v1 company, the default", () => {
		expect(cloudAgentFolder(company, agent)).toBe(`agents/${agent}`);
		expect(cloudAgentFolder(company, agent, CLOUD_AGENT_FOLDER_BY_ID)).toBe(`agents/${agent}`);
	});

	it("is its folder name in a folder-v2 company, where its agent.md is", () => {
		const folder = cloudAgentFolder(company, agent, { core: "folder-v2", handle: "anna-berg" });
		expect(folder).toBe("agents/anna-berg");
		expect(companyStatePath(`${folder}/agent.md`)?.kind).toBe("agent");
		expect(companyStatePath(`${folder}/routines/daily.md`)?.kind).toBe("routine");
	});

	it("refuses an owner that is not an id, and a folder name the company folder would not accept", () => {
		expect(() => cloudAgentFolder("company", agent)).toThrow("Invalid agent folder owner");
		expect(() => cloudAgentFolder(company, "anna")).toThrow("Invalid agent folder owner");
		for (const handle of ["", "Anna", "anna--berg", "-anna", "anna/berg", "..", "groups", "a".repeat(65)])
			expect(() => cloudAgentFolder(company, agent, { core: "folder-v2", handle })).toThrow(
				"Invalid agent folder name",
			);
		expect(cloudAgentFolder(company, agent, { core: "folder-v2", handle: "a".repeat(64) })).toBe(
			`agents/${"a".repeat(64)}`,
		);
	});

	it("tells an agent's folder from other paths", () => {
		expect(isCloudAgentFolder(cloudAgentFolder(company, agent))).toBe(true);
		expect(isCloudAgentFolder(cloudAgentFolder(company, agent, { core: "folder-v2", handle: "anna-berg" }))).toBe(
			true,
		);
		for (const path of [
			"agents",
			"agents/",
			"agents/groups",
			"agents/-a",
			"agents/a--b",
			"agents/Anna",
			"agents/a/b",
			"work/anna",
		])
			expect(isCloudAgentFolder(path)).toBe(false);
	});
});
