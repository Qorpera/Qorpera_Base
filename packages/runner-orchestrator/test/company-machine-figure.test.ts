import { existsSync, readFileSync } from "node:fs";
import { STAFF_CHARACTER_BY_TEMPLATE, STAFF_CHARACTER_IDS } from "@qorpera/cloud-client/staff-characters";
import { describe, expect, it } from "vitest";
import { companyComputerScreenCharacter } from "../../runtime/src/cloud-company-computer-desktop.ts";
import { computerBinding } from "../../runtime/test/fixtures/company-computer.ts";
import { COMPANY_MACHINE_DESKTOP_FIGURE, companyMachineDesktopFigure } from "../src/company-machine-figure.ts";

const source = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const byId = (agentId: string) => companyMachineDesktopFigure({ staffAgentId: agentId });

describe("the figure a machine's desktop shows (20260930737000)", () => {
	it("is the saved figure, a retired one's replacement, else the template's, else one from the agent's id", () => {
		const starter = (figure: unknown, templateId: unknown = null, staffAgentId = id(9)) => ({
			staffAgentId,
			figure,
			templateId,
		});
		for (const figure of STAFF_CHARACTER_IDS) expect(companyMachineDesktopFigure(starter(figure))).toBe(figure);
		// A saved figure wins over the template.
		expect(companyMachineDesktopFigure(starter("star", "co-founder"))).toBe("star");
		// The retired ghost is drawn as the moon, as every client draws it.
		expect(companyMachineDesktopFigure(starter("ghost"))).toBe("moon");
		expect(companyMachineDesktopFigure(starter("ghost", "co-founder"))).toBe("moon");
		// No saved figure, or one nobody knows: the template's; the founding agent's template is the crown.
		expect(companyMachineDesktopFigure(starter(null, "co-founder"))).toBe("crown");
		expect(companyMachineDesktopFigure(starter("dragon", "co-founder"))).toBe("crown");
		for (const [templateId, figure] of Object.entries(STAFF_CHARACTER_BY_TEMPLATE))
			expect(companyMachineDesktopFigure(starter(null, templateId))).toBe(figure);
		// Neither: a stable one from the agent's id, the same every time, and not the same for every agent.
		const walked = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => id(n));
		for (const agentId of walked) {
			expect(STAFF_CHARACTER_IDS as readonly string[]).toContain(byId(agentId));
			expect(byId(agentId)).toBe(byId(agentId));
			expect(companyMachineDesktopFigure(starter(null, null, agentId))).toBe(byId(agentId));
			expect(companyMachineDesktopFigure(starter(undefined, "no-such-template", agentId))).toBe(byId(agentId));
			expect(companyMachineDesktopFigure({ staffAgentId: agentId })).toBe(byId(agentId));
		}
		expect(new Set(walked.map((agentId) => byId(agentId))).size).toBeGreaterThan(3);
		// A template's name that is an object's own word is no template.
		expect(companyMachineDesktopFigure(starter(null, "constructor", id(3)))).toBe(byId(id(3)));
		expect(companyMachineDesktopFigure(starter(null, "__proto__", id(3)))).toBe(byId(id(3)));
	});

	it("is nothing for a starter SQL did not name, or an answer that is not a starter's", () => {
		for (const starter of [
			undefined,
			null,
			"star",
			7,
			[],
			[{ staffAgentId: id(9), figure: "star" }],
			{},
			{ figure: "star", templateId: "co-founder" },
			{ staffAgentId: null, figure: "star" },
			{ staffAgentId: "ada", figure: "star" },
			{ staffAgentId: `${id(9)}\n`, figure: "star" },
		])
			expect(companyMachineDesktopFigure(starter)).toBeUndefined();
	});

	it("is always one of the twelve words the machine image has a backdrop for, never more", () => {
		const hostile = [
			"../../etc/passwd",
			"star\nmoon",
			"star moon",
			"",
			" ",
			"STAR",
			"x".repeat(4096),
			{ toString: () => "star" },
		];
		for (const figure of hostile)
			for (const templateId of [null, "co-founder", ...hostile]) {
				const word = companyMachineDesktopFigure({ staffAgentId: id(9), figure, templateId });
				expect(STAFF_CHARACTER_IDS as readonly string[]).toContain(word);
				expect(word).toMatch(/^[a-z]+$/);
			}
	});

	it("draws the figure the office desktop draws, and follows the web client's rule", () => {
		expect([1, 2, 3, 4, 8].map((n) => byId(id(n)))).toEqual(["heart", "star", "cloud", "bolt", "planet"]);
		expect(byId("9f0c1b2e-7d4a-4c3b-8e5f-a1b2c3d4e5f6")).toBe("flame");
		const templates = [
			undefined,
			"co-founder",
			"no-such-template",
			"__proto__",
			...Object.keys(STAFF_CHARACTER_BY_TEMPLATE),
		];
		const figures = [undefined, "ghost", "dragon", ...STAFF_CHARACTER_IDS];
		for (const n of Array.from({ length: 24 }, (_, index) => index + 1)) {
			const binding = { ...computerBinding(), staffAgentId: id(n) };
			for (const templateId of templates)
				for (const figure of figures)
					expect(companyMachineDesktopFigure({ staffAgentId: id(n), figure, templateId })).toBe(
						companyComputerScreenCharacter(binding, templateId, figure),
					);
		}
		const walk = /for \(const character of [a-zA-Z.]+\) seed = \(seed \* 31 \+ character\.charCodeAt\(0\)\) >>> 0;/;
		const web = source("packages/web/src/ui/avatar.ts");
		expect(web).toMatch(walk);
		expect(web).toContain(
			'const FIGURE_BY_TEMPLATE: Record<string, FigureId> = { "co-founder": "crown", ...STAFF_CHARACTER_BY_TEMPLATE };',
		);
		expect(web).toContain("export const FIGURE_IDS = STAFF_CHARACTER_IDS;");
		expect(web).toContain("const saved = drawnStaffCharacter(agent.appearance?.creature);");
	});

	it("names the place the machine's desktop reads", () => {
		expect(COMPANY_MACHINE_DESKTOP_FIGURE).toBe("/etc/qorpera-machine/desktop-figure");
		// The machine image's side (the desktop's look, #1704) names the same file, once it is in this tree.
		const look = new URL("../../../deploy/machine/desktop-look", import.meta.url);
		if (existsSync(look))
			expect(readFileSync(look, "utf8")).toMatch(
				/\nFIGURE=\$\{QORPERA_DESKTOP_FIGURE:-\/etc\/qorpera-machine\/desktop-figure\}\n/,
			);
	});
});
