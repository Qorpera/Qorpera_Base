import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CloudToolContext } from "../src/cloud-native-tool-boundary.ts";
import {
	createCodingRecordChangeTool,
	createProposeSurfaceTool,
	createStartSurfaceSessionTool,
} from "../src/cloud-surface-tools.ts";
import { buildSurfaceTurnBrief, SURFACE_STAGED_CODING_INSTRUCTIONS } from "../src/cloud-surface-turn-context.ts";

function toolContext(): CloudToolContext {
	return {
		companyId: randomUUID(),
		runId: randomUUID(),
		callId: "call_1",
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
}

describe("cloud surface runtime tools", () => {
	it("stages atomic ChangeUnits via coding_record_change and validates commit SHAs", async () => {
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const recordChange = vi.fn().mockResolvedValue({ changeId, seq: 1, openChangeCount: 1 });
		const tool = createCodingRecordChangeTool(sessionId, { recordChange });

		expect(() => tool.parseArguments({ title: "Bad", summary: "No", commitSha: "not-a-sha" })).toThrow();

		const parsed = tool.parseArguments({
			title: "Add Danish FAQ",
			summary: "Adds expandable Danish FAQ on the pre-order page.",
			commitSha: "1".repeat(40),
		});
		const result = await tool.execute(parsed, toolContext());
		expect(recordChange).toHaveBeenCalledTimes(1);
		expect(result.kind).toBe("text");
		expect(JSON.parse(result.value as string)).toMatchObject({
			schema: "qorpera.surface-change-recorded/v1",
			sessionId,
			changeId,
			seq: 1,
			staged: true,
		});
	});

	it("proposes surfaces in proposed status without unilateral activation", async () => {
		const surfaceId = randomUUID();
		const proposeSurface = vi
			.fn()
			.mockResolvedValue({ id: surfaceId, slug: "headband", status: "proposed" as const });
		const tool = createProposeSurfaceTool({ proposeSurface });

		const parsed = tool.parseArguments({
			slug: "headband",
			title: "Headband",
			group: "products",
			archetype: "studio",
			sourceKind: "folder",
			folderRoot: "hardware/",
		});
		const result = await tool.execute(parsed, toolContext());
		expect(proposeSurface).toHaveBeenCalledTimes(1);
		expect(JSON.parse(result.value as string)).toMatchObject({
			surfaceId,
			slug: "headband",
			status: "proposed",
		});
	});

	it("launches parallel exploration sessions directly onto a Surface", async () => {
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const explorationId = randomUUID();
		const startSurfaceSession = vi.fn().mockResolvedValue({ sessionId, explorationId });
		const tool = createStartSurfaceSessionTool({ startSurfaceSession });

		const parsed = tool.parseArguments({
			surfaceId,
			prompt: "Explore three Danish homepage hero directions.",
			explorationCount: 3,
			explorationTitle: "Homepage visual directions",
		});
		const result = await tool.execute(parsed, toolContext());
		expect(startSurfaceSession).toHaveBeenCalledTimes(1);
		expect(JSON.parse(result.value as string)).toMatchObject({
			sessionId,
			explorationId,
		});
	});

	it("builds Surface turn brief with brief.md, Point-to-Change target, and conflict paths", () => {
		const sessionId = randomUUID();
		const text = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "website",
			surfaceTitle: "Website",
			briefMarkdown: "Warm Danish editorial tone. Terracotta accent #d76f45.",
			pointToChangeTarget: {
				route: "/preorder",
				selector: "section.pricing > button.cta",
				textSnippet: "Se forudbestillingen",
				tagName: "button",
				componentHint: "PreorderCta",
				boundingBox: { x: 100, y: 200, width: 220, height: 48 },
				viewport: { width: 1280, height: 800 },
			},
			conflictPaths: ["src/pages/preorder.astro"],
			recordChange: vi.fn(),
		});

		expect(text).toContain("# Surface Context: Website (website)");
		expect(text).toContain("QorperaOS/surfaces/website/brief.md");
		expect(text).toContain("Warm Danish editorial tone");
		expect(text).toContain("section.pricing > button.cta");
		expect(text).toContain("PreorderCta");
		expect(text).toContain("src/pages/preorder.astro");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("coding_record_change");
	});
});
