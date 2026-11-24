import { randomUUID } from "node:crypto";
import type { SurfaceFolderContents } from "@qorpera/cloud-client/surface-folder-files";
import {
	describeSurfaceBlocks,
	type JsonValue,
	type StudioPatchOp,
	SURFACE_REPORT_FORMAT,
	starterSurfaceLayout,
} from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import type { CloudCompanyFolderClient } from "../src/cloud-company-folder-client.ts";
import { type CloudToolContext, CloudToolRefusal } from "../src/cloud-native-tool-boundary.ts";
import { CLOUD_PLATFORM_SKILLS, MAX_STUDIO_SKILL_BYTES } from "../src/cloud-platform-skills.ts";
import {
	cloudStudioFileReader,
	openSurfaceLayoutOps,
	runSurfaceSessionTurn,
	type SurfaceSessionRunnerPorts,
	type SurfaceSessionTurnInput,
	surfaceStudioPageView,
} from "../src/cloud-surface-session-runner.ts";
import {
	checkStagedSurfaceDeliverables,
	checkStagedSurfaceLayout,
	createStageSurfacePatchTool,
	LAYOUT_UNCHECKED_NOTE,
} from "../src/cloud-surface-tools.ts";
import { buildSurfaceTurnBrief } from "../src/cloud-surface-turn-context.ts";

function toolContext(): CloudToolContext {
	return {
		companyId: randomUUID(),
		runId: randomUUID(),
		callId: "call_1",
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
}

type Interface = Pick<
	SurfaceSessionTurnInput,
	| "surfaceSlug"
	| "surfaceTitle"
	| "surfaceKind"
	| "surfaceIcon"
	| "surfaceIsGlobal"
	| "surfaceArchetype"
	| "folderRoot"
>;

const PRODUCT: Interface = {
	surfaceSlug: "travel-kit",
	surfaceTitle: "Travel Kit",
	surfaceKind: "custom",
	surfaceIcon: "box",
	surfaceIsGlobal: false,
	surfaceArchetype: "studio",
	folderRoot: "surfaces/travel-kit",
};
const IDENTITY: Interface = {
	surfaceSlug: "identity",
	surfaceTitle: "Identity",
	surfaceKind: "identity",
	surfaceIcon: "spark",
	surfaceIsGlobal: true,
	surfaceArchetype: "studio",
	folderRoot: "identity",
};
const CUSTOM: Interface = {
	surfaceSlug: "field-notes",
	surfaceTitle: "Field Notes",
	surfaceKind: "custom",
	surfaceIcon: "star",
	surfaceIsGlobal: false,
	surfaceArchetype: "studio",
	folderRoot: "surfaces/field-notes",
};

const OLD_SCHEMA_WORDS = [
	"Product Studio file layout",
	"Identity Studio file layout",
	"Report & Analysis file layout",
	"When this surface represents a physical product",
	"The five tabs (Overview, Specs, Vendors, Reports, Files) are always there",
	"do not create standalone HTML/CSS code pages",
];

async function instructionsFor(
	surface: Interface,
	files: Record<string, string> = {},
	readStudioFiles?: SurfaceSessionRunnerPorts["readStudioFiles"],
	company?: Record<string, string | Error>,
): Promise<string> {
	let seen = "";
	await runSurfaceSessionTurn(
		{
			sessionId: randomUUID(),
			surfaceId: randomUUID(),
			companyId: randomUUID(),
			sourceKind: "folder",
			prompt: "Work on the page.",
			...surface,
		},
		{
			readStudioFiles: readStudioFiles ?? (async (): Promise<SurfaceFolderContents> => ({ files, binaries: {} })),
			...(company
				? {
						folder: {
							async readText(path: string, maxBytes: number) {
								const found = company[path];
								if (found instanceof Error) throw found;
								if (found !== undefined && Buffer.byteLength(found) > maxBytes) throw new Error("Too large");
								return found ?? null;
							},
						},
					}
				: {}),
			surfaceTools: { stageSurfacePatch: vi.fn() },
			completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			async executeTurn(req) {
				seen = req.instructions;
				return { state: "ready", replyText: "Done." };
			},
		},
	);
	return seen;
}

const OWN_LAYOUT: { readonly schema: string; readonly tabs: JsonValue } = {
	schema: "qorpera.surface-layout/v1",
	tabs: [
		{
			id: "board",
			title: "Board",
			blocks: [
				{ type: "row", blocks: [{ type: "title" }, { type: "module", from: "modules/price", height: "auto" }] },
			],
		},
	],
};

describe("the page contract a Studio session is told", () => {
	it("gives a Product, an Identity and a Custom interface the block reference and its own starter, not the old schemas", async () => {
		const cases = [
			[PRODUCT, "product"],
			[IDENTITY, "identity"],
			[CUSTOM, "custom"],
		] as const;
		for (const [surface, starter] of cases) {
			const text = await instructionsFor(surface);
			expect(text).toContain(describeSurfaceBlocks());
			expect(text).toContain(
				`No ${surface.folderRoot}/layout.json yet, so the page shows the ${starter} starter:\n${JSON.stringify(starterSurfaceLayout(starter))}`,
			);
			expect(text).toContain(`Change files in ${surface.folderRoot}/ only with stage_surface_patch`);
			expect(text).toContain("Figures filled from an object show only values of at most 18 characters.");
			expect(text).toContain("A company file is bound with a leading slash (/identity/tokens.json).");
			expect(text).toContain(SURFACE_REPORT_FORMAT);
			for (const word of OLD_SCHEMA_WORDS) expect(text).not.toContain(word);
		}
		expect(await instructionsFor(PRODUCT)).toContain('A stage_3d model file (default object.json) is {"model"');
		expect(await instructionsFor(IDENTITY)).toContain("The company look is /identity/tokens.json");
		expect(await instructionsFor(CUSTOM)).not.toContain("A stage_3d model file");
	});

	it("shows an interface its own layout.json, and says when that file does not read", async () => {
		const own = await instructionsFor(CUSTOM, {
			"surfaces/field-notes/layout.json": JSON.stringify(OWN_LAYOUT),
		});
		expect(own).toContain("Drawn from surfaces/field-notes/layout.json:");
		expect(own).toContain('"from":"modules/price"');
		expect(own).not.toContain(JSON.stringify(starterSurfaceLayout("custom")));
		expect(own).toContain("The company look is /identity/tokens.json");
		expect(own).not.toContain('A report file (*.report.json) is {"category"');

		const broken = await instructionsFor(CUSTOM, { "surfaces/field-notes/layout.json": "{ not json" });
		expect(broken).toContain(
			"surfaces/field-notes/layout.json does not read (not valid JSON), so the page shows the custom starter:",
		);
	});

	it("picks the Product starter for a folder that holds a model, as the page does", async () => {
		const text = await instructionsFor(CUSTOM, {
			"surfaces/field-notes/specs.json": JSON.stringify({ model: { kind: "device", layers: ["shell"] } }),
		});
		expect(text).toContain(JSON.stringify(starterSurfaceLayout("product")));
	});

	it("tells a report interface it is a reading page and gives no layout", async () => {
		const text = await instructionsFor({ ...CUSTOM, surfaceIcon: "book" });
		expect(text).toContain("This interface is a reading page, not drawn from a layout");
		expect(text).toContain(SURFACE_REPORT_FORMAT);
		expect(text).not.toContain(describeSurfaceBlocks());
		expect(text).not.toContain("layout.json");
	});

	it("says the layout is unknown, with the block reference alone, when the turn lacks what decides it", async () => {
		const partial = { surfaceIcon: undefined, surfaceIsGlobal: undefined, surfaceArchetype: undefined };
		const product = await instructionsFor({ ...PRODUCT, ...partial, surfaceKind: "product" });
		expect(product).toContain("Its layout is not known for this turn");
		expect(product).toContain(describeSurfaceBlocks());
		expect(product).not.toContain(JSON.stringify(starterSurfaceLayout("product")));

		const custom = await instructionsFor(
			{ ...CUSTOM, ...partial },
			{
				"surfaces/field-notes/layout.json": JSON.stringify(OWN_LAYOUT),
			},
		);
		expect(custom).toContain("Its layout is not known for this turn");

		const ownProduct = await instructionsFor(
			{ ...PRODUCT, ...partial, surfaceKind: "product" },
			{
				"surfaces/travel-kit/layout.json": JSON.stringify(OWN_LAYOUT),
			},
		);
		expect(ownProduct).toContain("Drawn from surfaces/travel-kit/layout.json:");

		expect(await instructionsFor({ ...IDENTITY, ...partial })).toContain(
			JSON.stringify(starterSurfaceLayout("identity")),
		);
		expect(await instructionsFor({ ...CUSTOM, ...partial, surfaceKind: "report" })).toContain(
			"This interface is a reading page",
		);
		expect(surfaceStudioPageView(CUSTOM, "surfaces/field-notes", null)).toEqual({ page: "unknown" });
		expect(
			surfaceStudioPageView({ ...CUSTOM, surfaceArchetype: "live_build" }, "surfaces/field-notes", {
				files: {},
				binaries: {},
			}),
		).toEqual({ page: "none" });
	});
});

const platformSkill = (name: string) =>
	`## Skill: ${name}\nThe platform's ${name} skill: how this page is worked on and what good looks like. The rules above still hold.\n\n${CLOUD_PLATFORM_SKILLS.get(name)!.body.trim()}`;

describe("the skill a Studio session works by", () => {
	it("gives each kind of Studio page its own platform skill after the page contract, and a reading page none", async () => {
		const cases = [
			[PRODUCT, "product-studio"],
			[IDENTITY, "identity-studio"],
			[CUSTOM, "custom-surface"],
		] as const;
		for (const [surface, name] of cases) {
			const text = await instructionsFor(surface);
			expect(text.endsWith(platformSkill(name)), name).toBe(true);
			for (const other of CLOUD_PLATFORM_SKILLS.keys())
				if (other !== name) expect(text).not.toContain(`## Skill: ${other}`);
		}
		const model = await instructionsFor(CUSTOM, {
			"surfaces/field-notes/specs.json": JSON.stringify({ model: { kind: "device", layers: ["shell"] } }),
		});
		expect(model.endsWith(platformSkill("product-studio"))).toBe(true);
		const reading = await instructionsFor({ ...CUSTOM, surfaceIcon: "book" });
		expect(reading).not.toContain("## Skill");
		const unknown = await instructionsFor({
			...PRODUCT,
			surfaceIcon: undefined,
			surfaceIsGlobal: undefined,
			surfaceArchetype: undefined,
			surfaceKind: "product",
		});
		expect(unknown).toContain(
			"## Skill\nWhich kind of page this is, is not known for this turn. Once you know, read its skill with read_skill before you shape or fill the page: product-studio for a product, identity-studio for the company's Identity, custom-surface for any other page.",
		);
		expect(unknown).not.toContain("## Skill: ");
	});

	it("uses a company skill of the same name in place of the platform's, as read_skill finds one", async () => {
		const own = "---\nname: product-studio\ndescription: Our way.\n---\n\nLead with the price.\n";
		const folder = await instructionsFor(PRODUCT, {}, undefined, { "QorperaOS/skills/product-studio/SKILL.md": own });
		expect(
			folder.endsWith(
				"## Skill: product-studio\nThe company's own product-studio skill (QorperaOS/skills/product-studio/SKILL.md), used in place of the platform's: how this page is worked on and what good looks like. The rules above still hold.\n\nLead with the price.",
			),
		).toBe(true);
		expect(folder).not.toContain(CLOUD_PLATFORM_SKILLS.get("product-studio")!.body.trim());

		const flat = await instructionsFor(CUSTOM, {}, undefined, {
			"QorperaOS/skills/custom-surface.md": "Shape it as a board.",
		});
		expect(flat).toContain("The company's own custom-surface skill (QorperaOS/skills/custom-surface.md)");
		expect(flat.endsWith("\n\nShape it as a board.")).toBe(true);

		const both = await instructionsFor(IDENTITY, {}, undefined, {
			"QorperaOS/skills/identity-studio/SKILL.md": "In the folder.",
			"QorperaOS/skills/identity-studio.md": "Flat.",
		});
		expect(both.endsWith("\n\nIn the folder.")).toBe(true);
		expect(
			await instructionsFor(PRODUCT, {}, undefined, { "QorperaOS/skills/identity-studio.md": "Elsewhere." }),
		).toContain(platformSkill("product-studio"));
	});

	it("falls back to the platform's skill when the company's is unreadable, empty or too long", async () => {
		const path = "QorperaOS/skills/product-studio/SKILL.md";
		const fallback = platformSkill("product-studio");
		const broken: Record<string, string | Error>[] = [
			{ [path]: new Error("Company folder file is not UTF-8 text") },
			{ [path]: "---\nname: product-studio\ndescription: Nothing here.\n---\n\n   \n" },
			{ [path]: "" },
			{ [path]: `---\nname: product-studio\n---\n\n${"x".repeat(MAX_STUDIO_SKILL_BYTES + 1)}` },
			{ [path]: "y".repeat(40 * 1024) },
			{ [path]: new Error("Company folder file is not UTF-8 text"), "QorperaOS/skills/product-studio.md": "Flat." },
		];
		for (const company of broken)
			expect((await instructionsFor(PRODUCT, {}, undefined, company)).endsWith(fallback)).toBe(true);
		expect(
			(
				await instructionsFor(PRODUCT, {}, undefined, {
					[path]: `---\nname: product-studio\n---\n\n${"x".repeat(MAX_STUDIO_SKILL_BYTES)}`,
				})
			).endsWith(`\n\n${"x".repeat(MAX_STUDIO_SKILL_BYTES)}`),
		).toBe(true);
	});
});

type FakeFolder = Pick<CloudCompanyFolderClient, "list" | "readRange">;

function folderOf(files: Record<string, string>, fail: { list?: string; read?: string } = {}): FakeFolder {
	const entry = (path: string) => ({
		path,
		kind: "file" as const,
		version: randomUUID(),
		seq: 1,
		updatedAt: "2026-11-24T00:00:00Z",
		authority: { resourceId: randomUUID(), resourceRevision: 1, grantId: null, grantRevision: null },
		file: {
			manifestSha256: "a".repeat(64),
			fileSha256: "b".repeat(64),
			bytes: Buffer.byteLength(files[path] ?? ""),
			mediaType: "application/json",
			executable: false,
		},
	});
	return {
		async list(parent) {
			if (parent === fail.list) throw new Error("folder list unavailable");
			const entries = Object.keys(files)
				.filter((path) => path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes("/"))
				.map(entry);
			return { asOfSeq: 1, entries, next: null };
		},
		async readRange(found) {
			if (found.path === fail.read) throw new Error("file read unavailable");
			return new TextEncoder().encode(files[found.path] ?? "");
		},
	};
}

describe("reading the folder for the page", () => {
	const files = { "surfaces/field-notes/layout.json": JSON.stringify(OWN_LAYOUT) };

	it("shows the folder's own layout when the read succeeds", async () => {
		const text = await instructionsFor(CUSTOM, {}, cloudStudioFileReader(folderOf(files)));
		expect(text).toContain("Drawn from surfaces/field-notes/layout.json:");
	});

	it("says the layout is unknown when listing the folder fails, never a guessed starter", async () => {
		const text = await instructionsFor(
			CUSTOM,
			{},
			cloudStudioFileReader(folderOf(files, { list: "surfaces/field-notes" })),
		);
		expect(text).toContain("Its layout is not known for this turn");
		expect(text).not.toContain("starter:");
	});

	it("says the layout is unknown when reading layout.json fails", async () => {
		const text = await instructionsFor(
			CUSTOM,
			{},
			cloudStudioFileReader(folderOf(files, { read: "surfaces/field-notes/layout.json" })),
		);
		expect(text).toContain("Its layout is not known for this turn");
		expect(text).not.toContain("starter:");
	});

	it("gives the pointer line, never a failed turn or a guessed skill, when the folder and the company skill both fail to read", async () => {
		const files = { "surfaces/field-notes/layout.json": JSON.stringify(OWN_LAYOUT) };
		const broken = new Error("Company folder read unavailable");
		const company = {
			"QorperaOS/skills/custom-surface/SKILL.md": broken,
			"QorperaOS/skills/custom-surface.md": broken,
			"QorperaOS/skills/product-studio/SKILL.md": broken,
			"QorperaOS/skills/identity-studio/SKILL.md": broken,
		};
		for (const fail of [{ list: "surfaces/field-notes" }, { read: "surfaces/field-notes/layout.json" }]) {
			const text = await instructionsFor(CUSTOM, {}, cloudStudioFileReader(folderOf(files, fail)), company);
			expect(text).toContain("Its layout is not known for this turn");
			expect(text).toContain(
				"## Skill\nWhich kind of page this is, is not known for this turn. Once you know, read its skill with read_skill",
			);
			expect(text).not.toContain("## Skill: ");
		}
		const known = await instructionsFor(CUSTOM, {}, cloudStudioFileReader(folderOf(files)), company);
		expect(known).toContain("Drawn from surfaces/field-notes/layout.json:");
		expect(known.endsWith(platformSkill("custom-surface"))).toBe(true);
	});
});

describe("stage_surface_patch and the layout", () => {
	const valid = JSON.stringify(starterSurfaceLayout("custom"));
	const staging = (current: string | null, waitingOps: readonly StudioPatchOp[] | null = []) => ({
		folderRoot: "surfaces/kit",
		waitingOps,
		readLayout: vi.fn(async () => current),
	});
	const check = (ops: StudioPatchOp[], layout: ReturnType<typeof staging>) =>
		checkStagedSurfaceLayout(ops, layout, new AbortController().signal);

	it("refuses a layout that does not parse with the parser's words, and stages nothing", async () => {
		const stageSurfacePatch = vi.fn();
		const layout = staging(null);
		const tool = createStageSurfacePatchTool(randomUUID(), { stageSurfacePatch }, layout);
		const parsed = tool.parseArguments({
			title: "New page",
			summary: "A page with no tabs.",
			ops: [{ op: "write_text", path: "layout.json", content: '{"schema":"qorpera.surface-layout/v1","tabs":[]}' }],
		});
		const refusal = await tool.prepare!(parsed, toolContext()).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(CloudToolRefusal);
		expect((refusal as Error).message).toBe(
			"layout.json would not draw: layout.tabs must hold 1 to 12 entries, not 0. Fix it and stage the patch again; nothing was staged.",
		);
		expect(stageSurfacePatch).not.toHaveBeenCalled();
		expect(layout.readLayout).not.toHaveBeenCalled();

		await expect(
			check([{ op: "write_text", path: "surfaces/kit/layout.json", content: "nope" }], staging(null)),
		).rejects.toThrow("layout.json would not draw: layout is not valid JSON.");
	});

	it("accepts a valid layout, a delete, and files that are not the layout", async () => {
		const layout = staging("garbage");
		const tool = createStageSurfacePatchTool(randomUUID(), { stageSurfacePatch: vi.fn() }, layout);
		const parsed = tool.parseArguments({
			title: "Page",
			summary: "Starter page.",
			ops: [
				{ op: "write_text", path: "layout.json", content: valid },
				{ op: "write_text", path: "modules/price/layout.json", content: "{}" },
				{ op: "merge_json", path: "specs.json", patch: { overview: { weight: "44 g" } } },
			],
		});
		await expect(tool.prepare!(parsed, toolContext())).resolves.toEqual(parsed as JsonValue);
		await expect(check([{ op: "delete", path: "layout.json" }], layout)).resolves.toBe("checked");
		const breakdowns = JSON.stringify({
			schema: "qorpera.surface-layout/v1",
			tabs: [
				{
					id: "breakdowns",
					title: "Breakdowns",
					blocks: [{ type: "explainer", match: "breakdowns/**/scenes.js" }],
				},
			],
		});
		await expect(check([{ op: "write_text", path: "layout.json", content: breakdowns }], layout)).resolves.toBe(
			"checked",
		);
		expect(layout.readLayout).not.toHaveBeenCalled();
	});

	it("checks a merge_json on the layout by its merged result", async () => {
		const breaking = staging(valid);
		await expect(
			check(
				[{ op: "merge_json", path: "layout.json", patch: { tabs: [{ id: "Board", title: "Board", blocks: [] }] } }],
				breaking,
			),
		).rejects.toThrow("layout.json would not draw: layout.tabs[0].id must be a lower-case slug");
		expect(breaking.readLayout).toHaveBeenCalledTimes(1);

		await expect(
			check([{ op: "merge_json", path: "layout.json", patch: { schema: null } }], staging(valid)),
		).rejects.toThrow("layout.json would not draw: layout.schema is missing");
		await expect(
			check([{ op: "merge_json", path: "layout.json", patch: { tabs: OWN_LAYOUT.tabs } }], staging(valid)),
		).resolves.toBe("checked");
		await expect(check([{ op: "merge_json", path: "layout.json", patch: OWN_LAYOUT }], staging(null))).resolves.toBe(
			"checked",
		);
		await expect(
			check([{ op: "merge_json", path: "layout.json", patch: { tabs: [] } }], staging("{ broken")),
		).rejects.toThrow("the file it merges into is not JSON; write it whole with write_text");

		const written = staging(null);
		await expect(
			check(
				[
					{ op: "write_text", path: "layout.json", content: valid },
					{ op: "merge_json", path: "layout.json", patch: { tabs: OWN_LAYOUT.tabs } },
				],
				written,
			),
		).resolves.toBe("checked");
		expect(written.readLayout).not.toHaveBeenCalled();
	});

	it("checks a merge_json on top of this session's own waiting changes to the layout, in their order", async () => {
		const renameTab = { op: "merge_json", path: "layout.json", patch: { tabs: OWN_LAYOUT.tabs } } as const;
		await expect(check([renameTab], staging(null))).rejects.toThrow("layout.schema is missing");
		const waitingWrite = staging(null, [{ op: "write_text", path: "surfaces/kit/layout.json", content: valid }]);
		await expect(check([renameTab], waitingWrite)).resolves.toBe("checked");
		expect(waitingWrite.readLayout).not.toHaveBeenCalled();

		const addSchema = {
			op: "merge_json",
			path: "layout.json",
			patch: { schema: "qorpera.surface-layout/v1" },
		} as const;
		await expect(check([addSchema], staging(valid))).resolves.toBe("checked");
		await expect(check([addSchema], staging(valid, [{ op: "delete", path: "layout.json" }]))).rejects.toThrow(
			"layout.json would not draw: layout.tabs is missing",
		);
		await expect(
			check([addSchema], staging(valid, [{ op: "write_text", path: "modules/price/layout.json", content: "{}" }])),
		).resolves.toBe("checked");
	});

	it("composes on the patches it staged earlier in the turn", async () => {
		const stageSurfacePatch = vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 1, openChangeCount: 1 });
		const tool = createStageSurfacePatchTool(randomUUID(), { stageSurfacePatch }, staging(null));
		const first = tool.parseArguments({
			title: "Page",
			summary: "Starter page.",
			ops: [{ op: "write_text", path: "layout.json", content: valid }],
		});
		await tool.execute(await tool.prepare!(first, toolContext()), toolContext());
		const second = tool.parseArguments({
			title: "Board",
			summary: "One tab.",
			ops: [{ op: "merge_json", path: "layout.json", patch: { tabs: OWN_LAYOUT.tabs } }],
		});
		await expect(tool.prepare!(second, toolContext())).resolves.toEqual(second as JsonValue);
	});

	it("stages an unchecked merge with a note when the session's waiting changes are not known, and still checks a whole file", async () => {
		const stageSurfacePatch = vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 2, openChangeCount: 2 });
		const layout = staging(null, null);
		const tool = createStageSurfacePatchTool(randomUUID(), { stageSurfacePatch }, layout);
		const merge = tool.parseArguments({
			title: "Board",
			summary: "One tab.",
			ops: [{ op: "merge_json", path: "layout.json", patch: { tabs: OWN_LAYOUT.tabs } }],
		});
		const prepared = await tool.prepare!(merge, toolContext());
		expect(prepared).toMatchObject({ layoutUnchecked: true });
		const answer = await tool.execute(prepared, toolContext());
		expect(JSON.parse(answer.value as string)).toMatchObject({ staged: true, note: LAYOUT_UNCHECKED_NOTE });
		expect(stageSurfacePatch).toHaveBeenCalledTimes(1);
		expect(layout.readLayout).not.toHaveBeenCalled();

		await expect(
			check([{ op: "write_text", path: "layout.json", content: "nope" }], staging(null, null)),
		).rejects.toThrow("layout.json would not draw: layout is not valid JSON.");
		const written = tool.parseArguments({
			title: "Page",
			summary: "Starter page.",
			ops: [{ op: "write_text", path: "layout.json", content: valid }],
		});
		const plain = await tool.execute(await tool.prepare!(written, toolContext()), toolContext());
		expect(JSON.parse(plain.value as string)).not.toHaveProperty("note");
	});

	it("stages a layout merge unchecked with the note when the turn's waiting ops are null or absent", async () => {
		expect(openSurfaceLayoutOps(null)).toBeUndefined();
		expect(openSurfaceLayoutOps(undefined)).toBeUndefined();
		expect(openSurfaceLayoutOps([{ op: "delete", path: "layout.json" }])).toEqual([
			{ op: "delete", path: "layout.json" },
		]);
		for (const openLayoutOps of [openSurfaceLayoutOps(null), undefined]) {
			const stageSurfacePatch = vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 1, openChangeCount: 1 });
			let answer: unknown;
			await runSurfaceSessionTurn(
				{
					sessionId: randomUUID(),
					surfaceId: randomUUID(),
					companyId: randomUUID(),
					sourceKind: "folder",
					prompt: "Rename the tab.",
					...CUSTOM,
					...(openLayoutOps ? { openLayoutOps } : {}),
				},
				{
					folder: { readText: async () => null },
					readStudioFiles: async () => ({ files: {}, binaries: {} }),
					surfaceTools: { stageSurfacePatch },
					completeSessionTurn: vi.fn().mockResolvedValue(undefined),
					async executeTurn(req) {
						const tool = req.tools.find((item) => item.name === "stage_surface_patch")!;
						const parsed = tool.parseArguments({
							title: "Board",
							summary: "One tab.",
							ops: [{ op: "merge_json", path: "layout.json", patch: { tabs: OWN_LAYOUT.tabs } }],
						});
						const result = await tool.execute(await tool.prepare!(parsed, toolContext()), toolContext());
						answer = JSON.parse(result.value as string);
						return { state: "ready", replyText: "Done." };
					},
				},
			);
			expect(answer).toMatchObject({ staged: true, note: LAYOUT_UNCHECKED_NOTE });
			expect(stageSurfacePatch).toHaveBeenCalledTimes(1);
		}
	});

	it("validates staged *.report.json payloads and refuses bundling multiple reports or standalone HTML files", async () => {
		const validReport = JSON.stringify({
			category: "Analysis",
			headline: "Q3 Retention Breakdown",
			subtitle: "Cohort trends across Europe.",
			sections: [
				{
					id: "cohorts",
					heading: "Cohort retention",
					paragraphs: ["Month-3 retention rose 6 points after onboarding changes."],
					blocks: [
						{
							kind: "bar_chart",
							heading: "Retention by cohort",
							items: [
								{ label: "Q2", value: 41 },
								{ label: "Q3", value: 47 },
							],
						},
					],
				},
			],
		});
		const validSecondReport = JSON.stringify({
			headline: "Launch Post",
			sections: [{ id: "intro", heading: "Why we built it", paragraphs: ["Built for quiet nights."] }],
		});

		expect(() =>
			checkStagedSurfaceDeliverables([
				{ op: "write_text", path: "reports/q3.report.json", content: validReport },
				{ op: "write_text", path: "layout.json", content: valid },
			]),
		).not.toThrow();

		expect(() =>
			checkStagedSurfaceDeliverables([
				{ op: "write_text", path: "reports/q3.report.json", content: validReport },
				{ op: "write_text", path: "reports/launch.report.json", content: validSecondReport },
			]),
		).toThrow("Stage each report (*.report.json) or standalone HTML document in its own stage_surface_patch call");

		expect(() =>
			checkStagedSurfaceDeliverables([
				{ op: "write_text", path: "post-1.html", content: "<html><title>One</title></html>" },
				{ op: "write_text", path: "post-2.html", content: "<html><title>Two</title></html>" },
			]),
		).toThrow("Stage each report (*.report.json) or standalone HTML document in its own stage_surface_patch call");

		expect(() =>
			checkStagedSurfaceDeliverables([
				{ op: "write_text", path: "modules/calc/index.html", content: "<html></html>" },
				{ op: "write_text", path: "modules/calc/frame.html", content: "<html></html>" },
			]),
		).not.toThrow();

		expect(() =>
			checkStagedSurfaceDeliverables([
				{ op: "delete", path: "reports/old-1.report.json" },
				{ op: "delete", path: "reports/old-2.report.json" },
			]),
		).not.toThrow();

		expect(() =>
			checkStagedSurfaceDeliverables([{ op: "write_text", path: "bad.report.json", content: "{ not json" }]),
		).toThrow("bad.report.json would not render as a report: content is not valid JSON.");

		expect(() =>
			checkStagedSurfaceDeliverables([
				{ op: "write_text", path: "bad.report.json", content: JSON.stringify({ headline: "Empty", sections: [] }) },
			]),
		).toThrow("bad.report.json would not render as a report: sections must be a non-empty array.");

		expect(() =>
			checkStagedSurfaceDeliverables([
				{
					op: "write_text",
					path: "bad.report.json",
					content: JSON.stringify({
						headline: "Bad block",
						sections: [{ id: "s1", heading: "One", blocks: [{ kind: "unknown_chart" }] }],
					}),
				},
			]),
		).toThrow("sections[0].blocks[0].kind must be one of quote, bar_chart, line_chart, table, callout, figure");

		expect(() =>
			checkStagedSurfaceDeliverables([
				{
					op: "write_text",
					path: "q3\u2013retention.report.json",
					content: "{ not json",
				},
			]),
		).toThrow("q3?retention.report.json would not render as a report: content is not valid JSON.");

		const stageSurfacePatch = vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 1, openChangeCount: 1 });
		const deferredTool = createStageSurfacePatchTool(randomUUID(), { stageSurfacePatch }, undefined, {
			deferSessionCompletion: true,
		});
		const props = (deferredTool.inputSchema as { properties: Record<string, unknown> }).properties;
		expect(props).not.toHaveProperty("finishSession");
		const parsedBad = deferredTool.parseArguments({
			title: "Three posts",
			summary: "Bundled.",
			ops: [
				{ op: "write_text", path: "a.report.json", content: validReport },
				{ op: "write_text", path: "b.report.json", content: validSecondReport },
			],
		});
		await expect(deferredTool.prepare!(parsedBad, toolContext())).rejects.toBeInstanceOf(CloudToolRefusal);
		expect(stageSurfacePatch).not.toHaveBeenCalled();

		const parsedDeferred = deferredTool.parseArguments({
			title: "Q3 retention",
			summary: "Single report.",
			ops: [{ op: "write_text", path: "q3.report.json", content: validReport }],
			finishSession: true,
		});
		const preparedDeferred = await deferredTool.prepare!(parsedDeferred, toolContext());
		const deferredResult = await deferredTool.execute(preparedDeferred, toolContext());
		expect(stageSurfacePatch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ finishSession: false }),
			expect.anything(),
		);
		expect(JSON.parse(deferredResult.value as string)).not.toHaveProperty("finishSession");

		const multiDeliverableOps = [
			{ op: "write_text" as const, path: "reports/q3.report.json", content: validReport },
			{ op: "write_text" as const, path: "reports/launch.report.json", content: validSecondReport },
		];
		expect(() => checkStagedSurfaceDeliverables(multiDeliverableOps, { allowMultipleDeliverables: true })).not.toThrow();
		expect(() =>
			checkStagedSurfaceDeliverables(
				[
					{ op: "write_text", path: "post-1.html", content: "<html><title>One</title></html>" },
					{ op: "write_text", path: "post-2.html", content: "<html><title>Two</title></html>" },
				],
				{ allowMultipleDeliverables: true },
			),
		).not.toThrow();
		expect(() =>
			checkStagedSurfaceDeliverables(
				[
					{ op: "write_text", path: "reports/q3.report.json", content: validReport },
					{ op: "write_text", path: "reports/bad.report.json", content: "{ not json" },
				],
				{ allowMultipleDeliverables: true },
			),
		).toThrow("reports/bad.report.json would not render as a report: content is not valid JSON.");

		const folderBrief = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "editorial",
			surfaceTitle: "Editorial",
			briefMarkdown: null,
			folderRoot: "surfaces/editorial",
			repositoryKey: null,
		});
		expect(folderBrief).toContain("stage one `stage_surface_patch` call per independent deliverable");
		expect(folderBrief).not.toContain(".qorpera/checks.json");
		expect(folderBrief).not.toContain("coding_finish");
	});
});
