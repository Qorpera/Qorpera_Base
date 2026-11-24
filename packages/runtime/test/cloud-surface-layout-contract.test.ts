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
import { type CloudToolContext, CloudToolRefusal } from "../src/cloud-native-tool-boundary.ts";
import {
	runSurfaceSessionTurn,
	type SurfaceSessionTurnInput,
	surfaceStudioPageView,
} from "../src/cloud-surface-session-runner.ts";
import { checkStagedSurfaceLayout, createStageSurfacePatchTool } from "../src/cloud-surface-tools.ts";

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

async function instructionsFor(surface: Interface, files: Record<string, string> = {}): Promise<string> {
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
			readStudioFiles: async (): Promise<SurfaceFolderContents> => ({ files, binaries: {} }),
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

const OWN_LAYOUT = {
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

describe("stage_surface_patch and the layout", () => {
	const valid = JSON.stringify(starterSurfaceLayout("custom"));
	const staging = (current: string | null) => ({
		folderRoot: "surfaces/kit",
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
		await expect(check([{ op: "delete", path: "layout.json" }], layout)).resolves.toBeUndefined();
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
		).resolves.toBeUndefined();
		await expect(
			check([{ op: "merge_json", path: "layout.json", patch: OWN_LAYOUT }], staging(null)),
		).resolves.toBeUndefined();
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
		).resolves.toBeUndefined();
		expect(written.readLayout).not.toHaveBeenCalled();
	});
});
