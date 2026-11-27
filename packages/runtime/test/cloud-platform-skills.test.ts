import { readdirSync, readFileSync } from "node:fs";
import { parseCloudSkillFile } from "@qorpera/cloud-client/cloud-skill-file";
import { SURFACE_BLOCK_TYPES, SURFACE_STARTER_KINDS, UUID_PATTERN } from "@qorpera/contracts";
import { describe, expect, it } from "vitest";
import { CLOUD_PLATFORM_SKILLS, PLATFORM_SKILL_FILES, SURFACE_STARTER_SKILLS } from "../src/cloud-platform-skills.ts";
import { cloudStudioSkill } from "../src/cloud-skill-tools.ts";
import { SURFACE_ESCALATION_WAKE_PROTOCOL } from "../src/cloud-surface-escalation-wake.ts";

const SKILLS = new URL("../skills/", import.meta.url);
const STUDIO_TOOLS = [
	"stage_surface_patch",
	"compose_surface_layout",
	"stage_surface_artifact",
	"make_picture",
	"inspect_surface",
	"surface_reply",
	"surface_ask",
	"narrate_explainer",
	"company_read",
	"company_list",
	"company_search",
	"data_describe",
	"data_query",
	"read_skill",
	"search_skills",
];

describe("the platform's skills", () => {
	it("ship exactly the SKILL.md files under packages/runtime/skills", () => {
		const names = readdirSync(SKILLS, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		expect(Object.keys(PLATFORM_SKILL_FILES).sort()).toEqual(names);
		for (const name of names)
			expect(PLATFORM_SKILL_FILES[name], name).toBe(readFileSync(new URL(`${name}/SKILL.md`, SKILLS), "utf8"));
		expect([...CLOUD_PLATFORM_SKILLS.keys()]).toEqual(names);
	});

	it("give every Studio starter its own skill, and ship four more: research's writer and second reader, a talk's writer and cold listener", () => {
		expect(Object.keys(SURFACE_STARTER_SKILLS).sort()).toEqual([...SURFACE_STARTER_KINDS].sort());
		expect(
			[...Object.values(SURFACE_STARTER_SKILLS), "research-check", "research-posts", "talk-listen", "talks"].sort(),
		).toEqual([...CLOUD_PLATFORM_SKILLS.keys()]);
	});

	it("hand a research question from Strategy to the writer, and the writer's draft to a second reader", () => {
		const strategy = PLATFORM_SKILL_FILES["strategy-studio"] as string;
		const writer = PLATFORM_SKILL_FILES["research-posts"] as string;
		expect(strategy).toContain("Read the company's vision first, whole");
		expect(strategy).toContain("ask the founder with `surface_ask`, as open questions");
		expect(strategy).toContain("`read_skill` research-posts");
		expect(strategy).not.toMatch(/light and scannable|Never pause to ask/);
		expect(writer).toContain("the research-check skill (`read_skill`)");
		expect(writer).toContain("A run on GPT has no helpers: read alone");
		expect(writer).toContain(
			"Set a source's checked day only from the second reader's line for it, never on your own",
		);
		for (const start of ['"Research plan:"', '"Second reader needed:"']) {
			expect(writer, start).toContain(start);
			expect(SURFACE_ESCALATION_WAKE_PROTOCOL, start).toContain(start);
		}
		expect(SURFACE_ESCALATION_WAKE_PROTOCOL).toContain("the research-check skill (read_skill)");
		for (const name of ["research-posts", "research-check"])
			expect(CLOUD_PLATFORM_SKILLS.get(name)?.description, name).toBeTruthy();
	});

	it("are short skill files that name no file, path or tool a Studio session does not have", () => {
		for (const [name, text] of Object.entries(PLATFORM_SKILL_FILES)) {
			const document = parseCloudSkillFile(text);
			expect(Buffer.byteLength(text), name).toBeLessThanOrEqual(4096);
			expect(document.fields.get("name")?.value, name).toBe(name);
			expect(document.description, name).toBeTruthy();
			expect(document.body.trim().length, name).toBeGreaterThan(0);
			expect(text, name).not.toMatch(/#\d|QorperaOS\/|\.(?:md|ts|sql|json|css|glb|svg|html)\b/);
			for (const [word] of text.matchAll(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g))
				expect([...STUDIO_TOOLS, ...SURFACE_BLOCK_TYPES], `${name}: ${word}`).toContain(word);
			expect(CLOUD_PLATFORM_SKILLS.get(name)).toMatchObject({
				name,
				description: document.description,
				body: document.body,
				version: expect.stringMatching(UUID_PATTERN),
			});
			expect(CLOUD_PLATFORM_SKILLS.get(name)?.version[14]).toBe("4");
		}
	});
});

describe("the skill a Studio session gets at turn start", () => {
	const signal = new AbortController().signal;
	const reader = (files: Record<string, string | Error>) => async (path: string) => {
		const found = files[path];
		if (found instanceof Error) throw found;
		return found ?? null;
	};

	it("is the platform's without a company folder or without a company skill of the name", async () => {
		const platform = {
			name: "custom-surface",
			path: null,
			body: CLOUD_PLATFORM_SKILLS.get("custom-surface")!.body.trim(),
		};
		expect(await cloudStudioSkill("custom-surface", undefined, signal)).toEqual(platform);
		expect(await cloudStudioSkill("custom-surface", reader({}), signal)).toEqual(platform);
		expect(await cloudStudioSkill("no-such-skill", reader({}), signal)).toBeNull();
		expect(
			await cloudStudioSkill("no-such-skill", reader({ "QorperaOS/skills/no-such-skill.md": "Ours." }), signal),
		).toEqual({ name: "no-such-skill", path: "QorperaOS/skills/no-such-skill.md", body: "Ours." });
	});

	it("stops at an aborted read instead of falling back", async () => {
		const controller = new AbortController();
		const read = async () => {
			controller.abort(new Error("stopped"));
			throw new Error("aborted read");
		};
		await expect(cloudStudioSkill("product-studio", read, controller.signal)).rejects.toThrow("stopped");
	});
});
