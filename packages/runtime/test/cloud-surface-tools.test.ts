import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { cloudActionEffect } from "../src/cloud-action-review.ts";
import {
	cloudCompanyRuntimeInstructions,
	compileCloudNativeCompanyInstructions,
	parseCloudNativeCompanyContext,
} from "../src/cloud-native-company-context.ts";
import { createControlPlaneSurfaceToolsPort } from "../src/cloud-native-company-runtime.ts";
import type { CloudToolContext } from "../src/cloud-native-tool-boundary.ts";
import { cloudToolsOnDemand } from "../src/cloud-native-tools-on-demand.ts";
import {
	createCodingRecordChangeTool,
	createProposeSurfaceTool,
	createStageSurfaceOpsActionTool,
	createStageSurfacePatchTool,
	createStartSurfaceSessionTool,
} from "../src/cloud-surface-tools.ts";
import { buildSurfaceTurnBrief, SURFACE_STAGED_CODING_INSTRUCTIONS } from "../src/cloud-surface-turn-context.ts";
import { nativeCompanyContextFixture } from "./fixtures/native-company-context-fixture.ts";

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
		expect(proposeSurface).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				slug: "headband",
				kind: "custom",
				accentHex: null,
				isGlobal: false,
				activateImmediately: false,
			}),
			expect.any(Object),
		);
		expect(JSON.parse(result.value as string)).toMatchObject({
			surfaceId,
			slug: "headband",
			status: "proposed",
		});
	});

	it("accepts kind, accentHex, isGlobal, and activateImmediately on propose_surface and rejects invalid values", async () => {
		const surfaceId = randomUUID();
		const proposeSurface = vi.fn().mockResolvedValue({ id: surfaceId, slug: "website", status: "active" as const });
		const tool = createProposeSurfaceTool({ proposeSurface });

		const parsed = tool.parseArguments({
			slug: "website",
			title: "Website",
			group: "products",
			archetype: "live_build",
			sourceKind: "code_repo",
			kind: "website",
			accentHex: "#d76f45",
			isGlobal: false,
			activateImmediately: true,
			icon: "globe",
			briefSummary: "Public Scandinavian editorial storefront.",
		});
		const result = await tool.execute(parsed, toolContext());
		expect(proposeSurface).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				slug: "website",
				kind: "website",
				accentHex: "#d76f45",
				isGlobal: false,
				activateImmediately: true,
			}),
			expect.any(Object),
		);
		expect(JSON.parse(result.value as string)).toMatchObject({
			surfaceId,
			slug: "website",
			status: "active",
		});

		const base = {
			slug: "app",
			title: "Mobile App",
			group: "products",
			archetype: "live_build",
			sourceKind: "code_repo",
		};
		expect(() => tool.parseArguments({ ...base, kind: "not_a_kind" })).toThrow();
		expect(() => tool.parseArguments({ ...base, accentHex: "#fff" })).toThrow();
		expect(() => tool.parseArguments({ ...base, accentHex: "d76f45" })).toThrow();
		expect(() => tool.parseArguments({ ...base, accentHex: "#gggggg" })).toThrow();
		expect(() => tool.parseArguments({ ...base, isGlobal: "true" })).toThrow();
		expect(() => tool.parseArguments({ ...base, activateImmediately: 1 })).toThrow();
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
			ownerLabel: "Brand Designer",
			variantLabels: ["Aftenlys", "Stille horisont", "Varmt studie"],
		});
		const result = await tool.execute(parsed, toolContext());
		expect(startSurfaceSession).toHaveBeenCalledTimes(1);
		expect(startSurfaceSession).toHaveBeenCalledWith(
			expect.objectContaining({
				surfaceId,
				explorationCount: 3,
				ownerLabel: "Brand Designer",
				variantLabels: ["Aftenlys", "Stille horisont", "Varmt studie"],
			}),
			expect.any(Object),
		);
		expect(JSON.parse(result.value as string)).toMatchObject({
			sessionId,
			explorationId,
		});

		const inferred = tool.parseArguments({
			surfaceId,
			prompt: "Compare two pricing layouts.",
			variantLabels: ["Minimal", "Detailed"],
		}) as Record<string, unknown>;
		expect(inferred.explorationCount).toBe(2);
		expect(inferred.variantLabels).toEqual(["Minimal", "Detailed"]);

		expect(() => tool.parseArguments({ surfaceId, prompt: "Go", variantLabels: ["Only one"] })).toThrow();
		expect(() => tool.parseArguments({ surfaceId, prompt: "Go", variantLabels: ["A", "B", "C", "D"] })).toThrow();
		expect(() => tool.parseArguments({ surfaceId, prompt: "Go", variantLabels: ["A", "   "] })).toThrow();
		expect(() =>
			tool.parseArguments({ surfaceId, prompt: "Go", explorationCount: 2, variantLabels: ["A", "B", "C"] }),
		).toThrow();
		expect(() => tool.parseArguments({ surfaceId, prompt: "Go", ownerLabel: "   " })).toThrow();
	});

	it("stages studio/identity patches via stage_surface_patch with parseStudioPatchOps validation", async () => {
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const stageSurfacePatch = vi.fn().mockResolvedValue({ changeId, seq: 2, openChangeCount: 2 });
		const tool = createStageSurfacePatchTool(sessionId, { stageSurfacePatch });

		const parsed = tool.parseArguments({
			title: "Refine Nordic linen palette",
			summary: "Updates design tokens and Danish voice guidelines.",
			ops: [
				{ op: "merge_json", path: "tokens.json", patch: { accent: "#d76f45", surface: "#f7f5f2" } },
				{ op: "write_text", path: "voice.md", content: "# Voice\nCalm, direct, Danish editorial." },
				{ op: "delete", path: "legacy-palette.json" },
			],
			notePaths: ["identity/notes/palette-rationale.md"],
			finishSession: true,
		});
		const result = await tool.execute(parsed, toolContext());
		expect(stageSurfacePatch).toHaveBeenCalledWith(
			sessionId,
			{
				title: "Refine Nordic linen palette",
				summary: "Updates design tokens and Danish voice guidelines.",
				ops: [
					{ op: "merge_json", path: "tokens.json", patch: { accent: "#d76f45", surface: "#f7f5f2" } },
					{ op: "write_text", path: "voice.md", content: "# Voice\nCalm, direct, Danish editorial." },
					{ op: "delete", path: "legacy-palette.json" },
				],
				notePaths: ["identity/notes/palette-rationale.md"],
				finishSession: true,
			},
			expect.any(Object),
		);
		expect(JSON.parse(result.value as string)).toMatchObject({
			schema: "qorpera.surface-patch-staged/v1",
			sessionId,
			changeId,
			seq: 2,
			opCount: 3,
			notePaths: ["identity/notes/palette-rationale.md"],
			finishSession: true,
			staged: true,
		});

		expect(() => tool.parseArguments({ title: "Empty", summary: "None", ops: [] })).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Bad op",
				summary: "None",
				ops: [{ op: "rename", path: "a.md" }],
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Missing content",
				summary: "None",
				ops: [{ op: "write_text", path: "a.md" }],
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Traversal",
				summary: "None",
				ops: [{ op: "write_text", path: "../escape.md", content: "nope" }],
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Absolute path",
				summary: "None",
				ops: [{ op: "delete", path: "/etc/passwd" }],
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Bad note path",
				summary: "None",
				ops: [{ op: "delete", path: "old.md" }],
				notePaths: ["../secret.md"],
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Bad finish",
				summary: "None",
				ops: [{ op: "delete", path: "old.md" }],
				finishSession: "yes",
			}),
		).toThrow();
	});

	it("stages operational surface actions via stage_surface_ops_action", async () => {
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const stageSurfaceOpsAction = vi.fn().mockResolvedValue({ changeId, seq: 1, openChangeCount: 1 });
		const tool = createStageSurfaceOpsActionTool(sessionId, { stageSurfaceOpsAction });

		const parsed = tool.parseArguments({
			title: "Follow up with Asger",
			summary: "Drafts a short Danish email asking Asger to elaborate on the timeline.",
			actionKind: "inbox.draft_email",
			actionPayload: {
				to: "asger@example.dk",
				subject: "Opfølgning på næste skridt",
				body: "Hej Asger, vil du uddybe tidsplanen?",
			},
			finishSession: true,
		});
		const result = await tool.execute(parsed, toolContext());
		expect(stageSurfaceOpsAction).toHaveBeenCalledWith(
			sessionId,
			{
				title: "Follow up with Asger",
				summary: "Drafts a short Danish email asking Asger to elaborate on the timeline.",
				actionKind: "inbox.draft_email",
				actionPayload: {
					to: "asger@example.dk",
					subject: "Opfølgning på næste skridt",
					body: "Hej Asger, vil du uddybe tidsplanen?",
				},
				finishSession: true,
			},
			expect.any(Object),
		);
		expect(JSON.parse(result.value as string)).toMatchObject({
			schema: "qorpera.surface-ops-action-staged/v1",
			sessionId,
			changeId,
			seq: 1,
			actionKind: "inbox.draft_email",
			finishSession: true,
			staged: true,
		});

		// WHY: Reject invalid actionKinds and non-object payloads at tool argument boundary.
		expect(() =>
			tool.parseArguments({
				title: "Bad kind",
				summary: "Spaces not allowed",
				actionKind: "send email",
				actionPayload: {},
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Bad payload",
				summary: "Array rejected",
				actionKind: "money.prepare_payment",
				actionPayload: ["not-a-record"],
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Bad finish",
				summary: "Non-boolean rejected",
				actionKind: "files.organize",
				actionPayload: { folder: "sales/" },
				finishSession: 1,
			}),
		).toThrow();
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
		expect(text).not.toContain("## Global Company Identity");
		expect(text).toContain("QorperaOS/surfaces/website/brief.md");
		expect(text).toContain("Warm Danish editorial tone");
		expect(text).toContain("section.pricing > button.cta");
		expect(text).toContain("PreorderCta");
		expect(text).toContain("src/pages/preorder.astro");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("coding_record_change");
	});

	it("injects Global Company Identity into buildSurfaceTurnBrief when identityContext has content", () => {
		const sessionId = randomUUID();
		const withIdentity = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "mobile-app",
			surfaceTitle: "Mobile App",
			briefMarkdown: "Evening sleep wind-down companion.",
			identityContext: {
				briefMarkdown: "Calm Nordic sleep technology built on quiet restraint.",
				voiceSummary: "Warm, reassuring Danish without hype or jargon.",
				tokensJson: '{"accent":"#d76f45","paper":"#f7f5f2","ink":"#161615"}',
			},
			recordChange: vi.fn(),
		});

		expect(withIdentity).toContain("## Global Company Identity");
		expect(withIdentity).toContain("### Brand & Philosophy");
		expect(withIdentity).toContain("Calm Nordic sleep technology");
		expect(withIdentity).toContain("### Voice & Tone");
		expect(withIdentity).toContain("Warm, reassuring Danish");
		expect(withIdentity).toContain("### Design Tokens");
		expect(withIdentity).toContain('{"accent":"#d76f45"');
		expect(withIdentity.indexOf("## Global Company Identity")).toBeLessThan(withIdentity.indexOf("## Surface Brief"));

		const emptyIdentity = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "mobile-app",
			surfaceTitle: "Mobile App",
			briefMarkdown: "Evening sleep wind-down companion.",
			identityContext: { briefMarkdown: "   ", voiceSummary: null, tokensJson: "" },
			recordChange: vi.fn(),
		});
		expect(emptyIdentity).not.toContain("## Global Company Identity");
	});

	it("bridges Surface tools to control-plane RPCs via createControlPlaneSurfaceToolsPort", async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const explorationId = randomUUID();
		const changeId = randomUUID();
		const ctx = toolContext();

		const port = createControlPlaneSurfaceToolsPort(
			{
				async call(method, args) {
					calls.push({ method, args });
					if (method === "qorpera_propose_surface") {
						return { id: surfaceId, slug: "website", status: "active" };
					}
					if (method === "qorpera_service_start_surface_session") {
						return { sessionId, explorationId };
					}
					if (method === "qorpera_record_surface_change") {
						return { changeId, seq: 1, session: { openChangeCount: 1 } };
					}
					return { id: sessionId };
				},
			},
			{ defaultOriginLabel: "Co-Founder" },
		);

		const proposed = await port.proposeSurface(
			ctx.companyId,
			{
				slug: "website",
				title: "Website",
				group: "products",
				archetype: "live_build",
				kind: "website",
				accentHex: "#d76f45",
				isGlobal: false,
				activateImmediately: true,
				sourceKind: "code_repo",
				icon: "globe",
				repositoryKey: "thetaband/website",
				folderRoot: null,
				previewMode: "static_site",
				briefSummary: "Main website",
			},
			ctx,
		);
		expect(proposed).toEqual({ id: surfaceId, slug: "website", status: "active" });
		expect(calls[0]).toMatchObject({
			method: "qorpera_propose_surface",
			args: {
				p_company_id: ctx.companyId,
				p_slug: "website",
				p_kind: "website",
				p_accent_hex: "#d76f45",
				p_is_global: false,
				p_activate_immediately: true,
			},
		});

		const started = await port.startSurfaceSession(
			{
				surfaceId,
				prompt: "Explore 3 visual directions",
				title: "Initial directions",
				explorationCount: 3,
				explorationTitle: "Homepage directions",
				ownerLabel: "Brand Designer",
				variantLabels: ["Aftenlys", "Stille horisont", "Varmt studie"],
			},
			ctx,
		);
		expect(started).toEqual({ sessionId, explorationId });
		expect(calls[1]).toMatchObject({
			method: "qorpera_service_start_surface_session",
			args: {
				p_company_id: ctx.companyId,
				p_surface_id: surfaceId,
				p_origin_label: "Brand Designer",
				p_exploration_count: 3,
				p_variant_labels: ["Aftenlys", "Stille horisont", "Varmt studie"],
			},
		});

		const patched = await port.stageSurfacePatch(
			sessionId,
			{
				title: "Update tokens",
				summary: "Applies terracotta accent.",
				ops: [{ op: "merge_json", path: "tokens.json", patch: { accent: "#d76f45" } }],
				notePaths: ["identity/notes/audit.md"],
				finishSession: true,
			},
			ctx,
		);
		expect(patched).toEqual({ changeId, seq: 1, openChangeCount: 1 });
		expect(calls[2]).toMatchObject({
			method: "qorpera_record_surface_change",
			args: {
				p_session_id: sessionId,
				p_kind: "folder_patch",
				p_affected_paths: ["tokens.json"],
				p_finish_session: true,
			},
		});
		expect(calls[3]).toMatchObject({
			method: "qorpera_surface_complete_session_turn",
			args: {
				p_session_id: sessionId,
				p_state: "ready",
				p_note_paths: ["identity/notes/audit.md"],
			},
		});

		const opsResult = await port.stageSurfaceOpsAction(
			sessionId,
			{
				title: "Draft reply",
				summary: "Follows up with supplier.",
				actionKind: "inbox.draft_email",
				actionPayload: { to: "supplier@example.com" },
				finishSession: true,
			},
			ctx,
		);
		expect(opsResult).toEqual({ changeId, seq: 1, openChangeCount: 1 });
		expect(calls[4]).toMatchObject({
			method: "qorpera_record_surface_change",
			args: {
				p_session_id: sessionId,
				p_kind: "ops_action",
				p_patch_manifest: {
					actionKind: "inbox.draft_email",
					actionPayload: { to: "supplier@example.com" },
				},
				p_finish_session: true,
			},
		});
	});

	it("includes Co-Founder Surfaces & Identity Day-0 guidance only when surface tools are present", () => {
		const f = nativeCompanyContextFixture();
		const context = parseCloudNativeCompanyContext(f.context, f.binding);
		const withBoth = compileCloudNativeCompanyInstructions(context, null, {
			head: "# Head",
			tools: new Set(["company_read", "send_message", "propose_surface", "start_surface_session"]),
		});
		expect(withBoth).toContain("# Surfaces & Identity");
		expect(withBoth).toContain("populate Identity first");
		expect(withBoth).toContain("activateImmediately: true");
		expect(withBoth).toContain("proposed");
		expect(withBoth).toContain("Changes");
		expect(withBoth).toContain("Notes");
		expect(withBoth).toContain("propose_surface");
		expect(withBoth).toContain("start_surface_session");

		const onlyPropose = cloudCompanyRuntimeInstructions(null, false, new Set(["company_read", "propose_surface"]));
		expect(onlyPropose).toContain("# Surfaces & Identity");
		expect(onlyPropose).toContain("propose_surface");
		expect(onlyPropose).not.toContain("start_surface_session");

		const onlyStart = cloudCompanyRuntimeInstructions(
			null,
			false,
			new Set(["company_read", "start_surface_session"]),
		);
		expect(onlyStart).toContain("# Surfaces & Identity");
		expect(onlyStart).toContain("start_surface_session");
		expect(onlyStart).not.toContain("propose_surface");

		const withoutSurfaceTools = cloudCompanyRuntimeInstructions(
			null,
			false,
			new Set(["company_read", "send_message"]),
		);
		expect(withoutSurfaceTools).not.toContain("# Surfaces & Identity");

		const workerWithTools = cloudCompanyRuntimeInstructions(
			{ kind: "agent", source: { kind: "worker-dispatch" } } as never,
			false,
			new Set(["company_read", "propose_surface", "start_surface_session"]),
		);
		expect(workerWithTools).not.toContain("# Surfaces & Identity");
	});

	it("classifies surface tools as internal in action review and direct for Co-Founder", () => {
		for (const name of [
			"propose_surface",
			"start_surface_session",
			"coding_record_change",
			"stage_surface_patch",
			"stage_surface_ops_action",
		]) {
			expect(cloudActionEffect({ name, source: "runtime" }, {})).toBe("internal");
		}

		const proposeTool = createProposeSurfaceTool({ proposeSurface: vi.fn() });
		const startTool = createStartSurfaceSessionTool({ startSurfaceSession: vi.fn() });
		const cofounderOffered = cloudToolsOnDemand([proposeTool, startTool], "cofounder");
		expect(cofounderOffered.deferred.size).toBe(0);

		const employeeOffered = cloudToolsOnDemand([proposeTool, startTool], "employee");
		expect(employeeOffered.deferred.has("propose_surface")).toBe(true);
		expect(employeeOffered.deferred.has("start_surface_session")).toBe(true);
	});
});
