import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeSurfaceBlocks, type JsonValue, starterSurfaceLayout } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { cloudActionEffect, cloudActionReviewMandate } from "../src/cloud-action-review.ts";
import type { CloudAgentSendReceipt } from "../src/cloud-agent-mouth.ts";
import { decodeChangeDiffOutput, parseGitNumstatZ } from "../src/cloud-coding-preflight-land.ts";
import type { CloudCompanyPathControl } from "../src/cloud-company-path-gateway.ts";
import { CloudControlRpcRefused } from "../src/cloud-control-errors.ts";
import { cloudFolderFileTools } from "../src/cloud-folder-file-tools.ts";
import {
	cloudCompanyRuntimeInstructions,
	compileCloudNativeCompanyInstructions,
	parseCloudNativeCompanyContext,
} from "../src/cloud-native-company-context.ts";
import { CloudNativeCompanyRuntime, createControlPlaneSurfaceToolsPort } from "../src/cloud-native-company-runtime.ts";
import type { NativeCompanyExecutionRequest, NativeProviderControlPlane } from "../src/cloud-native-provider-host.ts";
import { type CloudNativeTool, type CloudToolContext, CloudToolRefusal } from "../src/cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperationControlPlane } from "../src/cloud-native-tool-operations.ts";
import { cloudToolsOnDemand } from "../src/cloud-native-tools-on-demand.ts";
import { CLOUD_PLATFORM_SKILLS } from "../src/cloud-platform-skills.ts";
import { CLOUD_RUNTIME_NATIVE_BINARY_SHA256 } from "../src/cloud-runtime-bundle.generated.ts";
import * as runtimeBundle from "../src/cloud-runtime-bundle.ts";
import {
	CLOUD_RUNTIME_HIRE_OVERLAY_VERSION,
	CLOUD_RUNTIME_SURFACE_FIRST_OVERLAY_VERSION,
	cloudCoFounderPlanningRun,
	cloudRuntimeHireBehavior,
} from "../src/cloud-runtime-hire-overlays.ts";
import {
	createCodingRecordChangeTool,
	createManageSurfaceAutomationTool,
	createProposeSurfaceTool,
	createStageSurfaceOpsActionTool,
	createStageSurfacePatchTool,
	createStartSurfaceSessionTool,
	createSteerSurfaceSessionTool,
} from "../src/cloud-surface-tools.ts";
import {
	buildSurfaceTurnBrief,
	parseSurfaceTurnOpenChanges,
	parseSurfaceTurnResolvedChanges,
	SURFACE_STAGED_CODING_INSTRUCTIONS,
} from "../src/cloud-surface-turn-context.ts";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";
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
				icon: "page",
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

		const isolated = tool.parseArguments({
			slug: "thetabands",
			title: "Thetabands",
			group: "products",
			archetype: "studio",
			kind: "product",
			sourceKind: "folder",
		}) as Record<string, unknown>;
		expect(isolated.folderRoot).toBe("surfaces/thetabands");

		const identity = tool.parseArguments({
			slug: "identity",
			title: "Identity",
			group: "products",
			archetype: "studio",
			kind: "identity",
			isGlobal: true,
			sourceKind: "folder",
		}) as Record<string, unknown>;
		expect(identity.folderRoot).toBe("identity");

		const globalReport = tool.parseArguments({
			slug: "company-research",
			title: "Company Research",
			group: "products",
			archetype: "studio",
			kind: "report",
			isGlobal: true,
			sourceKind: "folder",
		}) as Record<string, unknown>;
		expect(globalReport.folderRoot).toBe("surfaces/company-research");
	});

	it("accepts kind, figure, isGlobal, and activateImmediately on propose_surface and rejects colours and unknown figures", async () => {
		const surfaceId = randomUUID();
		const proposeSurface = vi.fn().mockResolvedValue({ id: surfaceId, slug: "website", status: "active" as const });
		const tool = createProposeSurfaceTool({ proposeSurface });
		expect(tool.description).toContain('Analytics (live business numbers, kind "dashboard")');
		expect(JSON.stringify(tool.inputSchema)).toContain("Analytics: studio, kind dashboard.");

		const parsed = tool.parseArguments({
			slug: "website",
			title: "Website",
			group: "products",
			archetype: "live_build",
			sourceKind: "code_repo",
			kind: "website",
			figure: "shop",
			isGlobal: false,
			activateImmediately: true,
			briefSummary: "Public Scandinavian editorial storefront.",
		});
		const result = await tool.execute(parsed, toolContext());
		expect(proposeSurface).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				slug: "website",
				kind: "website",
				icon: "figure:shop",
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
		expect(() => tool.parseArguments({ ...base, accentHex: "#d76f45" })).toThrow();
		expect(() => tool.parseArguments({ ...base, icon: "globe" })).toThrow();
		expect(() => tool.parseArguments({ ...base, figure: "dragon" })).toThrow();
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
				title: "Binary",
				summary: "None",
				ops: [
					{
						op: "write_file",
						path: "model.glb",
						file: {
							manifestSha256: "a".repeat(64),
							fileSha256: "b".repeat(64),
							bytes: 1024,
							mediaType: "model/gltf-binary",
						},
					},
				],
			}),
		).toThrow("ops[0].op write_file is not available in stage_surface_patch");
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
				title: "Dot segment",
				summary: "None",
				ops: [{ op: "write_text", path: "./voice.md", content: "nope" }],
			}),
		).toThrow();
		expect(() =>
			tool.parseArguments({
				title: "Empty segment",
				summary: "None",
				ops: [{ op: "write_text", path: "a//b.md", content: "nope" }],
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
		expect(text).toContain("## Surface Projection & Parallel Preview");
		expect(text).toContain("toggle multiple unmerged staged changes from concurrent sessions");
		expect(text).toContain("atomic, self-contained, and conflict-minimizing");
		expect(text).not.toContain("## Global Company Identity");
		expect(text).toContain("QorperaOS/surfaces/website/brief.md");
		expect(text).toContain("Warm Danish editorial tone");
		expect(text).toContain("section.pricing > button.cta");
		expect(text).toContain("PreorderCta");
		expect(text).toContain("src/pages/preorder.astro");
		expect(text).toContain("git merge main");
		expect(text).toContain("git cherry-pick");
		expect(text).toContain("coding_record_change");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("coding_record_change");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("direct live projection");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("toggled on or off simultaneously in Preview");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("atomic, self-contained, and conflict-minimizing");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("surfaceGate");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("apps/<repo>*/index.html");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("scrolled viewport-sized slices");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("structural skeleton");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("qorpera-identity.css");
		expect(text).toContain("surfaceGate");
		expect(text).toContain("runChecks: true");
		expect(text.trimEnd().endsWith(`Session ID: ${sessionId}`)).toBe(true);
		const secondSessionId = randomUUID();
		const secondText = buildSurfaceTurnBrief({
			sessionId: secondSessionId,
			surfaceSlug: "website",
			surfaceTitle: "Website",
			briefMarkdown: "Warm Danish editorial tone. Terracotta accent #d76f45.",
			recordChange: vi.fn(),
		});
		const marker = "## Surface Brief (QorperaOS/surfaces/website/brief.md)";
		const prefixEnd = text.indexOf(marker) + marker.length;
		expect(prefixEnd).toBeGreaterThan(marker.length);
		expect(secondText.slice(0, prefixEnd)).toBe(text.slice(0, prefixEnd));
		expect(secondText.trimEnd().endsWith(`Session ID: ${secondSessionId}`)).toBe(true);
	});

	it("formats structured conflictDetails and mainSha in buildSurfaceTurnBrief", () => {
		const sessionId = randomUUID();
		const brief = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "website",
			surfaceTitle: "Website",
			briefMarkdown: "Landing page",
			mainSha: "1".repeat(40),
			conflictPaths: ["src/pricing.tsx", "src/badges.css"],
			conflictDetails: [
				{
					changeId: randomUUID(),
					title: "Pricing tiers",
					branch: "qorpera/coding/worker-a",
					parentSha: "1".repeat(40),
					headSha: "a".repeat(40),
					conflictPaths: ["src/pricing.tsx"],
				},
				{
					changeId: randomUUID(),
					title: "Pricing badges",
					branch: "qorpera/coding/worker-b",
					parentSha: "1".repeat(40),
					headSha: "b".repeat(40),
					conflictPaths: ["src/pricing.tsx", "src/badges.css"],
				},
			],
		});

		expect(brief).toContain("## Conflict Reconciliation");
		expect(brief).toContain(`Target main SHA: \`${"1".repeat(40)}\``);
		expect(brief).toContain("Pricing tiers");
		expect(brief).toContain("qorpera/coding/worker-a");
		expect(brief).toContain(`${"1".repeat(40)}..${"a".repeat(40)}`);
		expect(brief).toContain("Pricing badges");
		expect(brief).toContain("src/badges.css");
		expect(brief).toContain("git merge main");
		expect(brief).toContain("git cherry-pick <parentSha>..<headSha>");
	});

	it("renders folder reconciliation patches without git instructions in buildSurfaceTurnBrief and sends baseFiles envelope", async () => {
		const sessionId = randomUUID();
		const brief = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "identity",
			surfaceTitle: "Identity",
			sourceKind: "folder",
			isInternalReconciliation: true,
			folderRoot: "identity",
			briefMarkdown: "Brand guide",
			conflictPaths: ["identity/guide.md"],
			conflictDetails: [
				{
					changeId: randomUUID(),
					title: "Buyer journey",
					kind: "folder_patch",
					prompt: "Add buyer journey diagram",
					summary: "Adds buyer journey section",
					affectedPaths: ["identity/guide.md", "identity/journey.svg"],
					patchManifest: [
						{ op: "write_text", path: "identity/guide.md", content: "# Brand\nJourney" },
						{ op: "write_text", path: "identity/journey.svg", content: "<svg />" },
					],
				},
				{
					changeId: randomUUID(),
					title: "Lighter blue",
					kind: "folder_patch",
					prompt: "Use lighter blue on dark backgrounds",
					summary: "Lighter blue token and copy",
					affectedPaths: ["identity/guide.md"],
					patchManifest: [{ op: "write_text", path: "identity/guide.md", content: "# Brand\nLighter blue" }],
				},
			],
		});

		expect(brief).toContain("## Conflict Reconciliation");
		expect(brief).toContain("Target Studio folder: `identity/`");
		expect(brief).toContain("Add buyer journey diagram");
		expect(brief).toContain("identity/journey.svg");
		expect(brief).toContain("stage_surface_patch");
		expect(brief).toContain("Never ask the founder questions.");
		expect(brief).not.toContain("git cherry-pick");
		expect(brief).not.toContain("git merge main");

		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const port = createControlPlaneSurfaceToolsPort({
			async call(method, args) {
				calls.push({ method, args });
				return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
			},
		});
		await port.stageSurfacePatch!(
			sessionId,
			{
				title: "Update guide",
				summary: "Adds section",
				ops: [{ op: "write_text", path: "identity/guide.md", content: "# Brand\nNew" }],
				baseFiles: { "identity/guide.md": "# Brand\nOld" },
				notePaths: [],
				finishSession: true,
			},
			toolContext(),
		);
		expect(calls[0]?.method).toBe("qorpera_native_surface_record_change");
		expect(calls[0]?.args.p_patch_manifest).toEqual({
			ops: [{ op: "write_text", path: "identity/guide.md", content: "# Brand\nNew" }],
			baseFiles: { "identity/guide.md": "# Brand\nOld" },
		});
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
		expect(emptyIdentity).toContain("## Live Shared Company Files");
		expect(emptyIdentity).toContain("qorpera-identity.css");
		expect(emptyIdentity).toContain("var(--q-color-accent)");
		expect(emptyIdentity).toContain("public/qorpera-shared/product/specs.json");

		const withShared = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "website",
			surfaceTitle: "Website",
			briefMarkdown: "Main storefront.",
			sharedAssets: {
				tokensCss: ":root {\n\t--q-color-accent: #d76f45;\n}\n",
				companyProfileJson: '{"name":"Thetaband"}',
				productSpecsJson: '{"batteryHours":14}',
				productCatalogJson: '{"sku":"TB-1"}',
				hasLogoSvg: true,
			},
		});
		expect(withShared).toContain("### Compiled Identity CSS (`qorpera-identity.css`)");
		expect(withShared).toContain("--q-color-accent: #d76f45;");
		expect(withShared).toContain("### Shared Company Profile (`public/qorpera-shared/identity/company.json`)");
		expect(withShared).toContain("### Shared Product Specs (`public/qorpera-shared/product/specs.json`)");
		expect(withShared).toContain("### Shared Product Catalog (`public/qorpera-shared/product/catalog.json`)");
		expect(withShared).toContain("public/qorpera-shared/identity/logo.svg");

		const identitySelf = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "identity",
			surfaceTitle: "Identity",
			briefMarkdown: "Brand hub.",
		});
		expect(identitySelf).toContain("## Live Shared Company Files");
		expect(identitySelf).toContain("automatically recompile `identity/tokens.css`");
		expect(identitySelf).not.toContain("Identity Studio Projection");
		expect(identitySelf).not.toContain("Palette, Typography, Design System");
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
					if (method === "qorpera_native_surface_propose") {
						return { id: surfaceId, slug: "website", status: "active" };
					}
					if (method === "qorpera_native_surface_start_session") {
						return { sessionId, explorationId };
					}
					if (method === "qorpera_native_surface_record_change") {
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
				isGlobal: false,
				activateImmediately: true,
				sourceKind: "code_repo",
				icon: "figure:browser",
				repositoryKey: "thetaband/website",
				folderRoot: null,
				previewMode: "static_site",
				briefSummary: "Main website",
			},
			ctx,
		);
		expect(proposed).toEqual({ id: surfaceId, slug: "website", status: "active" });
		expect(calls[0]).toMatchObject({
			method: "qorpera_native_surface_propose",
			args: {
				p_profile_id: ctx.companyId,
				p_slug: "website",
				p_kind: "website",
				p_icon: "figure:browser",
				p_accent_hex: null,
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
			method: "qorpera_native_surface_start_session",
			args: {
				p_profile_id: ctx.companyId,
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
			method: "qorpera_native_surface_record_change",
			args: {
				p_profile_id: ctx.companyId,
				p_session_id: sessionId,
				p_kind: "folder_patch",
				p_affected_paths: ["tokens.json"],
				p_finish_session: true,
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
		expect(calls[3]).toMatchObject({
			method: "qorpera_native_surface_record_change",
			args: {
				p_profile_id: ctx.companyId,
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
			"manage_surface_automation",
			"coding_record_change",
			"stage_surface_patch",
			"stage_surface_ops_action",
		]) {
			expect(cloudActionEffect({ name, source: "runtime" }, {})).toBe("internal");
		}

		const proposeTool = createProposeSurfaceTool({ proposeSurface: vi.fn() });
		const startTool = createStartSurfaceSessionTool({ startSurfaceSession: vi.fn() });
		const automationTool = createManageSurfaceAutomationTool(randomUUID(), { manageAutomation: vi.fn() });
		const cofounderOffered = cloudToolsOnDemand([proposeTool, startTool, automationTool], "cofounder");
		expect(cofounderOffered.deferred.size).toBe(0);

		const employeeOffered = cloudToolsOnDemand([proposeTool, startTool, automationTool], "employee");
		expect(employeeOffered.deferred.has("propose_surface")).toBe(true);
		expect(employeeOffered.deferred.has("start_surface_session")).toBe(true);
		expect(employeeOffered.deferred.has("manage_surface_automation")).toBe(true);
	});

	it("validates and executes manage_surface_automation across create, update, and delete", async () => {
		const companyId = randomUUID();
		const automationId = randomUUID();
		const manageAutomation = vi.fn().mockImplementation(async (_cid, req) => {
			if (req.action === "delete") {
				return { deleted: true as const, id: req.automationId };
			}
			return {
				id: req.automationId ?? automationId,
				key: "weekly-copy-audit",
				title: req.title ?? "Weekly copy audit",
				prompt: req.prompt ?? "Audit homepage copy for clarity.",
				scheduleSummary: req.scheduleSummary ?? "Every Monday · 09:00",
				targetSurfaceSlug: req.targetSurfaceSlug ?? "website",
				enabled: req.enabled ?? true,
				status: (req.enabled ?? true) ? ("idle" as const) : ("paused" as const),
			};
		});
		const tool = createManageSurfaceAutomationTool(companyId, { manageAutomation });

		const createdArgs = tool.parseArguments({
			action: "create",
			title: "Weekly copy audit",
			prompt: "Audit homepage copy and stage clear conversion improvements.",
			scheduleSummary: "Every Monday · 09:00",
			targetSurfaceSlug: "website",
			enabled: true,
		});
		const createdRes = await tool.execute(createdArgs, toolContext());
		expect(manageAutomation).toHaveBeenCalledWith(
			companyId,
			{
				action: "create",
				automationId: null,
				title: "Weekly copy audit",
				prompt: "Audit homepage copy and stage clear conversion improvements.",
				scheduleSummary: "Every Monday · 09:00",
				targetSurfaceSlug: "website",
				enabled: true,
			},
			expect.any(Object),
		);
		expect(JSON.parse(createdRes.value as string)).toMatchObject({
			schema: "qorpera.surface-automation-managed/v1",
			action: "create",
			id: automationId,
			key: "weekly-copy-audit",
			targetSurfaceSlug: "website",
			enabled: true,
		});

		const updatedArgs = tool.parseArguments({
			action: "update",
			automationId,
			enabled: false,
		});
		const updatedRes = await tool.execute(updatedArgs, toolContext());
		expect(JSON.parse(updatedRes.value as string)).toMatchObject({
			action: "update",
			id: automationId,
			enabled: false,
			status: "paused",
		});

		const deletedArgs = tool.parseArguments({
			action: "delete",
			automationId,
		});
		const deletedRes = await tool.execute(deletedArgs, toolContext());
		expect(JSON.parse(deletedRes.value as string)).toMatchObject({
			action: "delete",
			deleted: true,
			id: automationId,
		});

		expect(() => tool.parseArguments({ action: "create", title: "Missing prompt" })).toThrow();
		expect(() => tool.parseArguments({ action: "create", prompt: "Missing title" })).toThrow();
		expect(() =>
			tool.parseArguments({ action: "create", automationId, title: "Has id", prompt: "Should fail" }),
		).toThrow();
		expect(() => tool.parseArguments({ action: "update", title: "Missing id" })).toThrow();
		expect(() => tool.parseArguments({ action: "update", automationId })).toThrow();
		expect(() => tool.parseArguments({ action: "delete" })).toThrow();
		expect(() => tool.parseArguments({ action: "delete", automationId, title: "Unexpected" })).toThrow();
		expect(() =>
			tool.parseArguments({
				action: "create",
				title: "Bad slug",
				prompt: "Check site",
				targetSurfaceSlug: "Bad Slug!",
			}),
		).toThrow();
		expect(() => tool.parseArguments({ action: "update", automationId: "not-a-uuid", enabled: false })).toThrow();
	});

	it("bridges listSurfaceSenses and manageAutomation on createControlPlaneSurfaceToolsPort", async () => {
		const companyId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const automationId = randomUUID();
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const port = createControlPlaneSurfaceToolsPort({
			async call(method, args) {
				calls.push({ method, args });
				if (method === "qorpera_native_surface_describe_senses") {
					return {
						surfaces: [
							{
								id: surfaceId,
								slug: "website",
								title: "Website",
								kind: "website",
								archetype: "live_build",
								status: "active",
								isGlobal: false,
								sourceKind: "code_repo",
								repositoryKey: "thetaband/website",
								folderRoot: null,
								unpublishedChangeCount: 2,
								publishStatus: "idle",
								activeSessions: [
									{
										id: sessionId,
										title: "Hero refresh",
										state: "ready",
										explorationId: null,
										openChangeCount: 1,
										hasConflict: false,
									},
								],
							},
						],
						automations: [
							{
								id: automationId,
								key: "weekly-copy-audit",
								title: "Weekly copy audit",
								scheduleSummary: "Every Monday · 09:00",
								targetSurfaceSlug: "website",
								enabled: true,
								status: "idle",
							},
						],
					};
				}
				if (method === "qorpera_native_surface_manage_automation") {
					if (args.p_action === "delete") {
						return { deleted: true, id: automationId };
					}
					return {
						id: automationId,
						key: "weekly-copy-audit",
						title: "Weekly copy audit",
						prompt: "Review copy",
						scheduleSummary: "Every Monday · 09:00",
						targetSurfaceSlug: "website",
						enabled: true,
						status: "idle",
					};
				}
				return {};
			},
		});

		const senses = await port.listSurfaceSenses(companyId);
		expect(calls[0]).toEqual({
			method: "qorpera_native_surface_describe_senses",
			args: { p_profile_id: companyId },
		});
		expect(senses.surfaces).toHaveLength(1);
		expect(senses.surfaces[0]).toMatchObject({
			id: surfaceId,
			slug: "website",
			unpublishedChangeCount: 2,
			publishStatus: "idle",
			activeSessions: [{ id: sessionId, state: "ready", openChangeCount: 1, hasConflict: false }],
		});
		expect(senses.automations).toHaveLength(1);
		expect(senses.automations[0]?.key).toBe("weekly-copy-audit");

		const created = await port.manageAutomation(
			companyId,
			{
				action: "create",
				automationId: null,
				title: "Weekly copy audit",
				prompt: "Review copy",
				scheduleSummary: "Every Monday · 09:00",
				targetSurfaceSlug: "website",
				enabled: true,
			},
			toolContext(),
		);
		expect(calls[1]).toEqual({
			method: "qorpera_native_surface_manage_automation",
			args: {
				p_profile_id: companyId,
				p_action: "create",
				p_automation_id: null,
				p_title: "Weekly copy audit",
				p_prompt: "Review copy",
				p_schedule_summary: "Every Monday · 09:00",
				p_target_surface_slug: "website",
				p_enabled: true,
			},
		});
		expect(created).toMatchObject({ id: automationId, key: "weekly-copy-audit", enabled: true });

		const deleted = await port.manageAutomation(
			companyId,
			{
				action: "delete",
				automationId,
				title: null,
				prompt: null,
				scheduleSummary: null,
				targetSurfaceSlug: null,
				enabled: null,
			},
			toolContext(),
		);
		expect(deleted).toEqual({ deleted: true, id: automationId });
	});

	it("builds a high-signal Surface-First Co-Founder overlay (v22) with zero legacy hiring or doc-sprawl while preserving v21", () => {
		expect(CLOUD_RUNTIME_HIRE_OVERLAY_VERSION).toBe("qorpera.hire-overlay/v21");
		expect(CLOUD_RUNTIME_SURFACE_FIRST_OVERLAY_VERSION).toBe("qorpera.hire-overlay/v22");

		const surfaceHas = (tool: string) =>
			new Set([
				"company_read",
				"company_write",
				"propose_surface",
				"start_surface_session",
				"manage_surface_automation",
				"update_reading",
			]).has(tool);
		const surfacePlaybook = cloudRuntimeHireBehavior("cofounder", {
			has: surfaceHas,
			visionAgreed: false,
			surfaceFirst: true,
		});
		const surfacePlanning = cloudCoFounderPlanningRun({
			has: surfaceHas,
			visionAgreed: false,
			surfaceFirst: true,
		});
		const combined = `${surfacePlaybook}\n${surfacePlanning}`;

		expect(combined).toContain("code/<owner>/<name>");
		expect(combined).toContain("code/surfaces/<slug>/");
		expect(combined).toContain("identity/");
		expect(combined).toContain("identity/brief.md");
		expect(combined).toContain("identity/tokens.json");
		expect(combined).toContain("identity/tokens.css");
		expect(combined).toContain("qorpera-identity.css");
		expect(combined).toContain("identity/company.json");
		expect(combined).toContain("product/specs.json");
		expect(combined).toContain("product/catalog.json");
		expect(combined).toContain("<folderRoot>/");
		expect(combined).toContain("Preview");
		expect(combined).toContain("activateImmediately: true");
		expect(combined).toContain("propose_surface");
		expect(combined).toContain("start_surface_session");
		expect(combined).toContain("manage_surface_automation");
		expect(combined).toContain("Co-Founder Pulse");
		expect(combined).toContain("cofounder-pulse");
		expect(combined).toContain("stay silent");
		expect(combined).toContain("senses.surfaces");
		expect(combined).toContain("QorperaOS/surfaces/<slug>/notes/");
		expect(combined).toContain("static mock");
		expect(combined).toContain("Settings → Company connections");
		expect(combined).not.toContain('Connections (including "connect GitHub") are retired');
		expect(combined).not.toContain("vision/vision.md");
		const surfaceEmployee = cloudRuntimeHireBehavior("employee", {
			has: surfaceHas,
			visionAgreed: true,
			surfaceFirst: true,
		});
		expect(surfaceEmployee).toContain("real application rather than hand-rolling a standalone static mock");
		expect(surfaceEmployee).toContain("Settings → Company connections");

		for (const legacyTerm of [
			"hire_team",
			"hire_agent",
			"save_app",
			"organize_apps",
			"offer_agents_to_member",
			"vision-draft.md",
			"company-plan.md",
			"concept-brief.md",
			"solution.md",
			"Customer Researcher",
			"Market Watcher",
		]) {
			expect(combined).not.toContain(legacyTerm);
		}

		const legacyPlaybook = cloudRuntimeHireBehavior("cofounder", {
			has: () => true,
			visionAgreed: false,
		});
		expect(legacyPlaybook).toContain("hire_team");
		expect(legacyPlaybook).toContain("vision-draft.md");
		expect(legacyPlaybook).toContain("company-plan.md");

		const f = nativeCompanyContextFixture();
		const context = parseCloudNativeCompanyContext(f.context, f.binding);
		const surfaceInstructions = compileCloudNativeCompanyInstructions(context, null, {
			head: "# Head",
			tools: new Set([
				"company_read",
				"send_message",
				"propose_surface",
				"start_surface_session",
				"manage_surface_automation",
			]),
			surfaceFirst: true,
		});
		expect(surfaceInstructions).toContain("Each Surface is a direct live projection");
		expect(surfaceInstructions).toContain("senses.surfaces");
		expect(surfaceInstructions).toContain("senses.automations");
		expect(surfaceInstructions).toContain("manage_surface_automation");
		expect(surfaceInstructions).toContain("no standing role silos");
		expect(surfaceInstructions).not.toContain("hire_team");
		expect(surfaceInstructions).not.toContain("vision-draft.md");
		expect(surfaceInstructions).not.toContain("company-plan.md");
		expect(surfaceInstructions).not.toContain("each area owner drives their area");
		expect(surfaceInstructions).not.toContain("reading.md");
	});

	it("selects Surface-First Co-Founder mandate in cloudActionReviewMandate when surfaceFirst is true and preserves legacy default", () => {
		const f = nativeCompanyContextFixture();
		const cofounderContext = parseCloudNativeCompanyContext({ ...f.context, agentKind: "cofounder" }, f.binding);
		const employeeContext = parseCloudNativeCompanyContext({ ...f.context, agentKind: "employee" }, f.binding);
		const vision = "# Thetaband\nCalm Nordic sleep headband.";

		const surfaceMandate = cloudActionReviewMandate(cofounderContext, null, vision, { surfaceFirst: true });
		expect(surfaceMandate).toContain("Surface-First mode");
		expect(surfaceMandate).toContain("Identity (identity/)");
		expect(surfaceMandate).toContain("propose_surface");
		expect(surfaceMandate).toContain("start_surface_session");
		expect(surfaceMandate).toContain("manage_surface_automation");
		expect(surfaceMandate).toContain("active Interfaces (Identity, Strategy, and product/custom Surfaces)");
		expect(surfaceMandate).not.toContain("vision.md and reading.md");
		expect(surfaceMandate).toContain("without member approval is not");
		expect(surfaceMandate).not.toContain("hires the team");
		expect(surfaceMandate).not.toContain("weekday planning routine");

		const legacyDefaultMandate = cloudActionReviewMandate(cofounderContext, null, vision);
		const legacyExplicitFalseMandate = cloudActionReviewMandate(cofounderContext, null, vision, {
			surfaceFirst: false,
		});
		expect(legacyDefaultMandate).toBe(legacyExplicitFalseMandate);
		expect(legacyDefaultMandate).toContain("hires the team");
		expect(legacyDefaultMandate).toContain("weekday planning routine");
		expect(legacyDefaultMandate).not.toContain("Surface-First mode");

		expect(cloudActionReviewMandate(employeeContext, null, vision, { surfaceFirst: true })).toBe(
			cloudActionReviewMandate(employeeContext, null, vision, { surfaceFirst: false }),
		);
	});

	it("enforces surfaceFilePolicy on cloudFolderFileTools for cofounder doc-sprawl guard and surface_worker confinement", async () => {
		const f = await folderWriterFixture({
			folders: [
				"identity",
				"QorperaOS/surfaces",
				"QorperaOS/surfaces/website",
				"QorperaOS/surfaces/website/notes",
				"QorperaOS/surfaces/identity",
				"QorperaOS/surfaces/identity/notes",
				"strategy",
				"reports",
			],
			files: {
				"identity/tokens.json": '{"accent":"#d76f45"}',
				"QorperaOS/surfaces/website/notes/existing.md": "# Existing note\n",
				"QorperaOS/surfaces/identity/notes/existing.md": "# Identity note\n",
				"strategy/existing.md": "# Legacy strategy\n",
			},
		});
		try {
			const makeCaller = (policy?: Parameters<typeof cloudFolderFileTools>[0]["surfaceFilePolicy"]) => {
				const tools = cloudFolderFileTools({
					folder: f.folder,
					operations: f.operations(),
					identity: f.identity,
					...(policy ? { surfaceFilePolicy: policy } : {}),
				});
				const getTool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
				return (name: string, args: JsonValue, context = f.context) =>
					getTool(name).execute(getTool(name).parseArguments(args), context);
			};

			const cofounderBlocked = makeCaller({ mode: "cofounder", allowExplicitMemberDoc: false });
			for (const blockedRoot of [
				"strategy",
				"research",
				"operations",
				"plans",
				"docs",
				"memos",
				"reports",
				"meetings",
				"marketing",
				"sales",
			]) {
				await expect(
					cofounderBlocked("company_write", {
						path: `${blockedRoot}/auto-dump.md`,
						operationKey: `write-${blockedRoot}`,
						expectedVersion: null,
						text: "# Unrequested doc",
					}),
				).rejects.toSatisfy(
					(error: unknown) =>
						error instanceof CloudToolRefusal &&
						error.message.includes("SURFACE_FILE_POLICY_REFUSED") &&
						error.message.includes("start_surface_session") &&
						error.message.includes("QorperaOS/surfaces/<slug>/notes/"),
				);
				await expect(
					cofounderBlocked("company_mkdir", {
						path: `${blockedRoot}/sub`,
						operationKey: `mkdir-${blockedRoot}`,
						expectedVersion: null,
					}),
				).rejects.toThrow(CloudToolRefusal);
			}

			await expect(
				cofounderBlocked("company_write", {
					path: "Strategy/UpperCase.md",
					operationKey: "write-upper-strategy",
					expectedVersion: null,
					text: "# Blocked regardless of case",
				}),
			).rejects.toThrow(CloudToolRefusal);

			const identityWrite = await cofounderBlocked("company_write", {
				path: "identity/voice.md",
				operationKey: "write-identity-voice",
				expectedVersion: null,
				text: "# Voice\nDirect and warm.",
			});
			expect(JSON.parse(String(identityWrite.value)).state).toBe("applied");

			const noteWrite = await cofounderBlocked("company_write", {
				path: "QorperaOS/surfaces/website/notes/rationale.md",
				operationKey: "write-surface-note",
				expectedVersion: null,
				text: "# Rationale\nFocused Danish hero.",
			});
			expect(JSON.parse(String(noteWrite.value)).state).toBe("applied");

			const cofounderExplicit = makeCaller({ mode: "cofounder", allowExplicitMemberDoc: true });
			const explicitWrite = await cofounderExplicit("company_write", {
				path: "strategy/requested-memo.md",
				operationKey: "write-explicit-memo",
				expectedVersion: null,
				text: "# Requested Memo",
			});
			expect(JSON.parse(String(explicitWrite.value)).state).toBe("applied");

			const workerCaller = makeCaller({
				mode: "surface_worker",
				writableRoots: ["QorperaOS/surfaces/identity/notes"],
				stagedRoots: ["identity"],
			});
			const stagedOnly = (error: unknown) =>
				error instanceof CloudToolRefusal &&
				error.message.includes("SURFACE_FILE_POLICY_REFUSED: nothing was written;") &&
				error.message.includes("is in this Studio's folder identity/") &&
				error.message.includes("Stage this change with stage_surface_patch") &&
				error.message.includes("notes under QorperaOS/surfaces/identity/notes/ only");
			await expect(
				workerCaller("company_write", {
					path: "identity/palette.json",
					operationKey: "worker-write-studio",
					expectedVersion: null,
					text: '{"paper":"#f7f5f2"}',
				}),
			).rejects.toSatisfy(stagedOnly);
			await expect(
				workerCaller("company_mkdir", {
					path: "identity/drafts",
					operationKey: "worker-mkdir-studio",
					expectedVersion: null,
				}),
			).rejects.toSatisfy(stagedOnly);
			await expect(
				workerCaller("company_mkdir", {
					path: "identity",
					operationKey: "worker-mkdir-studio-root",
					expectedVersion: null,
				}),
			).rejects.toSatisfy(stagedOnly);
			expect(await f.folder.read("identity/palette.json", new AbortController().signal)).toMatchObject({
				entry: null,
			});

			const tokensBefore = await f.folder.read("identity/tokens.json", new AbortController().signal);
			expect(tokensBefore.entry).not.toBeNull();
			await expect(
				workerCaller("company_edit", {
					path: "identity/tokens.json",
					operationKey: "worker-edit-studio",
					expectedVersion: tokensBefore.entry!.version,
					oldText: "#d76f45",
					newText: "#c85a32",
				}),
			).rejects.toSatisfy(stagedOnly);
			const tokensRead = await workerCaller("company_read", { path: "identity/tokens.json" });
			expect(String(tokensRead.value)).toContain("#d76f45");
			expect(String(tokensRead.value)).not.toContain("#c85a32");

			const noteOk = await workerCaller("company_write", {
				path: "QorperaOS/surfaces/identity/notes/palette.md",
				operationKey: "worker-write-note",
				expectedVersion: null,
				text: "# Palette rationale",
			});
			expect(JSON.parse(String(noteOk.value)).state).toBe("applied");
			const noteFolderOk = await workerCaller("company_mkdir", {
				path: "QorperaOS/surfaces/identity/notes/drafts",
				operationKey: "worker-mkdir-note",
				expectedVersion: null,
			});
			expect(JSON.parse(String(noteFolderOk.value)).state).toBe("applied");
			const existingNote = await f.folder.read(
				"QorperaOS/surfaces/identity/notes/existing.md",
				new AbortController().signal,
			);
			const noteEditOk = await workerCaller("company_edit", {
				path: "QorperaOS/surfaces/identity/notes/existing.md",
				operationKey: "worker-edit-note",
				expectedVersion: existingNote.entry!.version,
				oldText: "# Identity note",
				newText: "# Identity note, revised",
			});
			expect(JSON.parse(String(noteEditOk.value)).state).toBe("applied");

			await expect(
				workerCaller("company_delete", {
					path: "identity/tokens.json",
					operationKey: "worker-delete-studio",
					expectedVersion: tokensBefore.entry!.version,
				}),
			).rejects.toSatisfy(stagedOnly);
			await expect(
				workerCaller("company_move", {
					from: "identity/tokens.json",
					to: "QorperaOS/surfaces/identity/notes/tokens.json",
					operationKey: "worker-move-out-of-studio",
					expectedVersion: tokensBefore.entry!.version,
					asOfSeq: null,
				}),
			).rejects.toSatisfy(stagedOnly);
			const paletteNote = await f.folder.read(
				"QorperaOS/surfaces/identity/notes/palette.md",
				new AbortController().signal,
			);
			await expect(
				workerCaller("company_move", {
					from: "QorperaOS/surfaces/identity/notes/palette.md",
					to: "identity/palette.md",
					operationKey: "worker-move-into-studio",
					expectedVersion: paletteNote.entry!.version,
					asOfSeq: null,
				}),
			).rejects.toSatisfy(stagedOnly);
			expect((await f.folder.read("identity/tokens.json", new AbortController().signal)).entry).not.toBeNull();
			expect((await f.folder.read("identity/palette.md", new AbortController().signal)).entry).toBeNull();
			const noteMoved = await workerCaller(
				"company_move",
				{
					from: "QorperaOS/surfaces/identity/notes/palette.md",
					to: "QorperaOS/surfaces/identity/notes/drafts/palette.md",
					operationKey: "worker-move-note",
					expectedVersion: paletteNote.entry!.version,
					asOfSeq: null,
				},
				{ ...f.context, callId: "worker-move-note", actionReviewId: randomUUID() },
			);
			expect(JSON.parse(String(noteMoved.value)).state).toBe("applied");
			expect(
				(await f.folder.read("QorperaOS/surfaces/identity/notes/drafts/palette.md", new AbortController().signal))
					.entry,
			).not.toBeNull();

			const nestedCaller = makeCaller({
				mode: "surface_worker",
				writableRoots: ["QorperaOS/surfaces/website/notes"],
				stagedRoots: ["QorperaOS/surfaces/website"],
			});
			const nestedNote = await nestedCaller("company_write", {
				path: "QorperaOS/surfaces/website/notes/hero.md",
				operationKey: "nested-write-note",
				expectedVersion: null,
				text: "# Hero",
			});
			expect(JSON.parse(String(nestedNote.value)).state).toBe("applied");
			await expect(
				nestedCaller("company_write", {
					path: "QorperaOS/surfaces/website/hero.json",
					operationKey: "nested-write-studio",
					expectedVersion: null,
					text: "{}",
				}),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof CloudToolRefusal &&
					error.message.includes("is in this Studio's folder QorperaOS/surfaces/website/") &&
					error.message.includes("stage_surface_patch"),
			);

			await expect(
				workerCaller("company_write", {
					path: "code/website/index.html",
					operationKey: "worker-write-outside",
					expectedVersion: null,
					text: "<h1>Nope</h1>",
				}),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof CloudToolRefusal &&
					error.message.includes(
						"outside this Surface worker's writable roots (QorperaOS/surfaces/identity/notes/)",
					),
			);
			await expect(
				workerCaller("company_write", {
					path: "identity-extra/escape.txt",
					operationKey: "worker-write-prefix-escape",
					expectedVersion: null,
					text: "nope",
				}),
			).rejects.toThrow(CloudToolRefusal);
			await expect(
				workerCaller("company_mkdir", {
					path: "strategy/new-folder",
					operationKey: "worker-mkdir-outside",
					expectedVersion: null,
				}),
			).rejects.toThrow(CloudToolRefusal);

			const existingStrategy = await f.folder.read("strategy/existing.md", new AbortController().signal);
			expect(existingStrategy.entry).not.toBeNull();
			await expect(
				workerCaller("company_edit", {
					path: "strategy/existing.md",
					operationKey: "worker-edit-outside",
					expectedVersion: existingStrategy.entry!.version,
					oldText: "# Legacy strategy",
					newText: "# Mutated",
				}),
			).rejects.toThrow(CloudToolRefusal);

			const legacyCaller = makeCaller(undefined);
			const legacyWrite = await legacyCaller("company_write", {
				path: "reports/legacy-ok.md",
				operationKey: "legacy-write-ok",
				expectedVersion: null,
				text: "# Legacy report",
			});
			expect(JSON.parse(String(legacyWrite.value)).state).toBe("applied");
		} finally {
			f.run.close();
		}
	});

	it("lets an Analytics session save a named question directly in an existing database, and nothing else under data/", async () => {
		const f = await folderWriterFixture({
			folders: ["data", "data/shop", "data/shop/queries", "data/crm", "surfaces", "surfaces/numbers"],
			files: {
				"data/shop/database.toml": 'format = "qorpera.database/v1"\n',
				"data/shop/tables/001-orders.sql": "create table orders (id int);\n",
				"data/crm/database.toml": 'format = "qorpera.database/v1"\n',
			},
		});
		try {
			const callerFor = (savesQuestions: boolean) => {
				const tools = cloudFolderFileTools({
					folder: f.folder,
					operations: f.operations(),
					identity: f.identity,
					surfaceFilePolicy: {
						mode: "surface_worker",
						writableRoots: ["QorperaOS/surfaces/numbers/notes"],
						stagedRoots: ["surfaces/numbers"],
						savesQuestions,
					},
				});
				const getTool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
				return (name: string, args: JsonValue) =>
					getTool(name).execute(getTool(name).parseArguments(args), f.context);
			};
			const analytics = callerFor(true);
			const question =
				"-- Bookings each week.\nselect date_trunc('week', at) as week, count(*) as bookings from bookings group by 1;\n";
			const saved = await analytics("company_write", {
				path: "data/shop/queries/bookings-weeks.sql",
				operationKey: "save-question",
				expectedVersion: null,
				text: question,
			});
			expect(JSON.parse(String(saved.value)).state).toBe("applied");
			const folderMade = await analytics("company_mkdir", {
				path: "data/crm/queries",
				operationKey: "make-queries",
				expectedVersion: null,
			});
			expect(JSON.parse(String(folderMade.value)).state).toBe("applied");
			const refusedUnderData = (error: unknown) =>
				error instanceof CloudToolRefusal &&
				error.message.includes("SURFACE_FILE_POLICY_REFUSED: nothing was written;") &&
				error.message.includes("saves only a named question, data/<database>/queries/<name>.sql");
			for (const [path, key] of [
				["data/shop/tables/002-bookings.sql", "step"],
				["data/shop/actions/add.sql", "action"],
				["data/shop/queries/Bookings.sql", "capital"],
				["data/shop/queries/bookings_weeks.sql", "underscore"],
				["data/shop/queries/notes.md", "not-sql"],
				["data/shop/queries/deep/one.sql", "nested"],
				["data/shop/database.toml", "toml"],
			]) {
				await expect(
					analytics("company_write", { path, operationKey: `refuse-${key}`, expectedVersion: null, text: "x" }),
				).rejects.toSatisfy(refusedUnderData);
			}
			await expect(
				analytics("company_write", {
					path: "data/nowhere/queries/count.sql",
					operationKey: "refuse-missing-db",
					expectedVersion: null,
					text: question,
				}),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof CloudToolRefusal && error.message.includes("there is no database data/nowhere/"),
			);
			expect(await f.folder.read("data/nowhere/queries/count.sql", new AbortController().signal)).toMatchObject({
				entry: null,
			});

			const other = callerFor(false);
			await expect(
				other("company_write", {
					path: "data/shop/queries/other.sql",
					operationKey: "other-session",
					expectedVersion: null,
					text: question,
				}),
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof CloudToolRefusal &&
					error.message.includes("is outside this Surface worker's writable roots"),
			);
		} finally {
			f.run.close();
		}
	});

	it("wires Surface-First runtime mode to strip legacy org-chart/app tools and inject senses.surfaces", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "qorpera-surface-runtime-test-"));
		const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
		const binarySha256 = createHash("sha256")
			.update(await readFile(process.execPath))
			.digest("hex");
		const assertBundle = runtimeBundle.assertCloudRuntimeBundle;
		const bundleSpy = vi
			.spyOn(runtimeBundle, "assertCloudRuntimeBundle")
			.mockImplementation((identity) => assertBundle(identity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256));

		try {
			const f = nativeCompanyContextFixture();
			f.context = { ...f.context, agentKind: "cofounder" };
			const wakeInputId = randomUUID();
			const surfaceId = randomUUID();
			const sessionId = randomUUID();
			const automationId = randomUUID();
			const wake = {
				schema: "qorpera.wake-envelope/v1",
				id: randomUUID(),
				runId: f.context.identity.runId,
				kind: "human",
				companyId: f.context.identity.companyId,
				environmentId: f.context.identity.environmentId,
				staffAgentId: f.context.identity.staffAgentId,
				requesterUserId: f.context.identity.requesterUserId,
				actorStaffId: null,
				actorUserId: f.context.identity.requesterUserId,
				audience: {
					kind: f.context.identity.audienceKind,
					userId: f.context.identity.audienceUserId,
					sessionId: f.context.identity.sessionId,
				},
				source: { kind: "input", id: wakeInputId, occurrenceKey: `input:${wakeInputId}` },
				policy: {
					schema: "qorpera.wake-policy/v1",
					kind: "human",
					initial: "required",
					final: "required",
					silenceAllowed: false,
					maxPublicSends: null,
				},
				time: {
					utc: "2026-09-02T08:00:00.000000Z",
					local: "2026-09-02T10:00:00.000000",
					timeZone: "Europe/Copenhagen",
				},
				pins: {
					companySnapshotId: randomUUID(),
					staffVersion: f.context.identity.staffVersion,
					wakeSchema: "qorpera.wake-envelope/v1",
					runtimeBundleVersion: null,
				},
				routine: null,
				payload: { inputIds: [wakeInputId] },
				parentRunId: null,
				causal: { rootId: randomUUID(), agentIds: [f.context.identity.staffAgentId] },
			};

			const folderFiles = new Map<string, string>([["note.md", "Quiet studio notes."]]);
			const folderSha = (text: string) => createHash("sha256").update(text).digest("hex");
			const folderVersion = (path: string, text: string) => {
				const hex = createHash("sha256").update(`${path}\n${text}`).digest("hex");
				return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
			};
			const folderEntry = (path: string) => {
				const text = folderFiles.get(path);
				if (text === undefined) return null;
				return {
					path,
					kind: "file",
					version: folderVersion(path, text),
					seq: 1,
					updatedAt: "2026-10-01T00:00:00+00:00",
					manifestSha256: folderSha(`manifest:${text}`),
					fileSha256: folderSha(text),
					bytes: Buffer.byteLength(text),
					mediaType: "text/markdown",
					executable: false,
					authority: { resourceId: randomUUID(), resourceRevision: 1, grantId: randomUUID(), grantRevision: 1 },
				};
			};

			let nativeAdmission: Record<string, unknown> | undefined;
			const deliveries = new Map<string, CloudAgentSendReceipt>();
			const control = {
				describeToolAuthority: vi.fn(async () => structuredClone(f.authority)),
				beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async () => {
					throw new Error("No generic effects expected");
				}),
				completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(async () => {
					throw new Error("No generic effects expected");
				}),
				completeFolderToolOperation: vi.fn<
					NonNullable<CloudNativeToolOperationControlPlane["completeFolderToolOperation"]>
				>(async () => {
					throw new Error("No folder writes expected");
				}),
				sendMessage: vi.fn<NativeProviderControlPlane["sendMessage"]>(async (request, input) => {
					const receipt = deliveries.get(input.idempotencyKey) ?? {
						schema: "qorpera.agent-send/v1",
						runId: request.authority.runId,
						sessionId: f.context.identity.sessionId as string,
						messageId: randomUUID(),
						phase: input.phase,
						sequence: deliveries.size + 1,
					};
					deliveries.set(input.idempotencyKey, receipt);
					return receipt;
				}),
				appendInteractionRequest: vi.fn<NonNullable<NativeProviderControlPlane["appendInteractionRequest"]>>(
					async () => {
						throw new Error("No cards expected");
					},
				),
			};

			const pathCall: CloudCompanyPathControl["call"] = async (method, args, signal) => {
				if (method === "qorpera_company_machines_available") return true;
				if (method === "qorpera_company_home_available")
					return { schema: "qorpera.company-home/v1", available: false };
				if (method === "qorpera_record_runtime_observation_batch") {
					const batch = args.p_observations as { attemptId: string; phase: string }[];
					return {
						schema: "qorpera.runtime-observation-batch-receipt/v1",
						runId: f.binding.runId,
						receipts: batch.map((observation) => ({
							schema: "qorpera.runtime-observation-receipt/v1",
							runId: f.binding.runId,
							attemptId: observation.attemptId,
							phase: observation.phase,
							ingestedAt: new Date().toISOString(),
							replayed: false,
						})),
					};
				}
				if (method === "qorpera_folder_read") {
					const entry = folderEntry(args.p_path as string);
					return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: entry !== null, entry };
				}
				if (method === "qorpera_folder_list") {
					const parent = `${args.p_parent as string}/`;
					const entries = [...folderFiles.keys()]
						.filter((path) => path.startsWith(parent) && !path.slice(parent.length).includes("/"))
						.sort()
						.map((path) => folderEntry(path));
					return { schema: "qorpera.folder-list/v1", asOfSeq: 1, entries, next: null };
				}
				if (method === "qorpera_folder_record_release") {
					return {
						schema: "qorpera.folder-release/v1",
						releaseId: args.p_release_id,
						reads: (args.p_reads as unknown[]).length,
						replay: false,
					};
				}
				if (method === "qorpera_memory_run_log_place") return { off: true };
				if (method === "qorpera_memory_run_resume_receipts") return null;
				if (method === "qorpera_folder_note_interface_changes") {
					return { schema: "qorpera.interface-change-notes/v1", noted: 0 };
				}
				if (method === "qorpera_begin_native_company_execution_v3") {
					nativeAdmission = {
						runId: f.binding.runId,
						jobId: f.binding.jobId,
						leaseId: f.binding.leaseId,
						binarySha256: args.p_binary_sha256,
						runtimeBundleSha256: args.p_runtime_bundle_sha256,
						reasoningPolicySha256: args.p_reasoning_policy_sha256,
						reasoningEffort: "low",
						toolCatalogSha256: createHash("sha256")
							.update(args.p_tool_catalog_text as string)
							.digest("hex"),
					};
					return { schema: "qorpera.native-company-execution-admission/v1", ...nativeAdmission };
				}
				if (method === "qorpera_bind_native_company_context") {
					const admission = nativeAdmission!;
					return {
						schema: "qorpera.native-company-execution-start/v1",
						...admission,
						contextSha256: args.p_context_sha256,
						contextBytes: args.p_context_bytes,
					};
				}
				if (method === "qorpera_describe_company_run_context") return structuredClone(f.context);
				if (method === "qorpera_begin_action_review") {
					return { schema: "qorpera.action-review-begin/v1", state: "approved", reviewId: randomUUID() };
				}
				if (method === "qorpera_read_native_wake") return structuredClone(wake);
				if (method === "qorpera_describe_agent_open_work") {
					return {
						schema: "qorpera.agent-open-work/v1",
						runId: f.binding.runId,
						todos: { open: 0, blocked: 0 },
						workers: { active: 0, blocked: 0 },
					};
				}
				if (method === "qorpera_describe_company_senses") {
					return {
						schema: "qorpera.company-senses/v1",
						runId: f.binding.runId,
						agents: [{ handle: "cofounder", todos: { open: 0, blocked: 0, doneLast7d: 0 } }],
						questions: { count: 0, oldest: [] },
					};
				}
				if (method === "qorpera_list_native_connector_tools") return [];
				if (method === "qorpera_assert_company_path_reads") return null;
				if (method === "qorpera_check_native_run") return await control.describeToolAuthority();
				if (method === "qorpera_fence_native_context") {
					const authority = await control.describeToolAuthority();
					const receipt = await pathCall(
						"qorpera_record_native_context_view",
						{ p_environment_id: args.p_environment_id, p_binding: args.p_binding, p_view: args.p_view },
						signal,
					);
					return { schema: "qorpera.native-context-fence/v1", authority, receipt, kept: args.p_paths };
				}
				if (method === "qorpera_record_native_context_view") {
					return {
						schema: "qorpera.native-context-view-receipt/v1",
						viewId: randomUUID(),
						requestId: (args.p_view as Record<string, unknown>).requestId,
						sha256: "b".repeat(64),
						ordinal: 1,
					};
				}
				throw new Error(`Unexpected RPC: ${method}`);
			};

			const evidencePath = join(tempRoot, "evidence.json");
			const identityRoot = join(tempRoot, "identity");
			await mkdir(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
			await writeFile(join(identityRoot, "codex", "auth.json"), '{"tokens":{"access_token":"SYNTHETIC_SECRET"}}', {
				mode: 0o600,
			});

			const listSurfaceSenses = vi.fn().mockResolvedValue({
				surfaces: [
					{
						id: surfaceId,
						slug: "website",
						title: "Website",
						kind: "website" as const,
						archetype: "live_build" as const,
						status: "active" as const,
						isGlobal: false,
						sourceKind: "code_repo" as const,
						repositoryKey: "thetaband/website",
						folderRoot: null,
						unpublishedChangeCount: 1,
						publishStatus: "idle" as const,
						activeSessions: [
							{
								id: sessionId,
								title: "Initial directions",
								state: "ready" as const,
								explorationId: null,
								openChangeCount: 1,
								hasConflict: false,
							},
						],
					},
				],
				automations: [
					{
						id: automationId,
						key: "weekly-audit",
						title: "Weekly audit",
						scheduleSummary: "Every Monday · 09:00",
						targetSurfaceSlug: "website",
						enabled: true,
						status: "idle" as const,
					},
				],
			});

			const runtime = new CloudNativeCompanyRuntime({
				controlPlane: control,
				pathControl: { call: pathCall },
				command: [process.execPath, rpcFixture, "company-runtime", evidencePath],
				binarySha256,
				timeoutMs: 10_000,
				surfaceTools: {
					proposeSurface: vi.fn(),
					startSurfaceSession: vi.fn(),
					listSurfaceSenses,
					manageAutomation: vi.fn(),
				},
				folderBytes: () => ({
					put: async () => {
						throw new Error("No folder writes expected");
					},
					get: async (file: { fileSha256: string }) => {
						const text = [...folderFiles.values()].find((value) => folderSha(value) === file.fileSha256);
						if (text === undefined) throw new Error("No such file bytes");
						return new TextEncoder().encode(text);
					},
					range: async (file: { fileSha256: string }, offset: number, length: number) => {
						const text = [...folderFiles.values()].find((value) => folderSha(value) === file.fileSha256);
						if (text === undefined) throw new Error("No such file bytes");
						return new TextEncoder().encode(text).subarray(offset, offset + length);
					},
				}),
			});

			const request: NativeCompanyExecutionRequest = {
				runtime: "company-path-v1",
				authority: {
					...f.binding,
					encryptedCapsuleReference: `native-capsule/${f.binding.credentialCapsuleId}`,
					attestationPolicySha256: "a".repeat(64),
					expiresAt: "2099-08-28T12:00:00Z",
				},
				job: {
					jobId: f.binding.jobId,
					jobType: "agent_turn",
					requiredCapability: "agent_turn",
					attemptCount: 1,
					payload: { instructions: "LOCAL_PAYLOAD_IS_NOT_AUTHORITY" },
				},
			};

			await runtime.execute(request, identityRoot, new AbortController().signal);

			const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
				threadParameters: {
					developerInstructions: string;
					dynamicTools: { tools: { name: string; description: string }[] }[];
				};
				turnParameters: { input: { text: string }[] };
			};

			const directTools = evidence.threadParameters.dynamicTools[0].tools.map((tool) => tool.name);
			const moreTools = evidence.threadParameters.dynamicTools[0].tools.find((tool) => tool.name === "more_tools");
			const deferredTools = moreTools
				? [...moreTools.description.matchAll(/^- ([a-z][a-z0-9_]*)(?::|$)/gm)].map((match) => match[1])
				: [];
			const allOffered = new Set([...directTools, ...deferredTools]);

			expect(directTools).toContain("propose_surface");
			expect(directTools).toContain("start_surface_session");
			expect(directTools).toContain("manage_surface_automation");
			for (const stripped of [
				"hire_agent",
				"hire_team",
				"end_role",
				"save_app",
				"post_app",
				"app_guide",
				"organize_apps",
				"organize_sidebar",
				"offer_agents_to_member",
				"crew_and_members",
				"update_reading",
			]) {
				expect(allOffered.has(stripped)).toBe(false);
			}

			const instructions = evidence.threadParameters.developerInstructions;
			expect(instructions).toContain("# Surfaces & Identity");
			expect(instructions).toContain("Each Surface is a direct live projection");
			expect(instructions).toContain("first line of QorperaOS/vision/vision.md");
			expect(instructions).toContain("senses.surfaces");
			expect(instructions).not.toContain("hire_team");
			expect(instructions).not.toContain("reading.md");
			expect(instructions).not.toContain("vision-draft.md");
			expect(instructions).not.toContain("company-plan.md");
			expect(instructions).not.toContain("Customer Researcher");

			const prompt = JSON.parse(evidence.turnParameters.input[0].text) as {
				senses: {
					agents: unknown[];
					surfaces: { id: string; slug: string; activeSessions: { id: string; state: string }[] }[];
					automations: { id: string; key: string }[];
				};
			};
			expect(listSurfaceSenses).toHaveBeenCalledWith(f.context.identity.companyId, expect.any(AbortSignal));
			expect(prompt.senses.agents).toHaveLength(1);
			expect(prompt.senses.surfaces).toHaveLength(1);
			expect(prompt.senses.surfaces[0]).toMatchObject({
				id: surfaceId,
				slug: "website",
				activeSessions: [{ id: sessionId, state: "ready" }],
			});
			expect(prompt.senses.automations).toEqual([
				{
					id: automationId,
					key: "weekly-audit",
					title: "Weekly audit",
					scheduleSummary: "Every Monday · 09:00",
					targetSurfaceSlug: "website",
					enabled: true,
					status: "idle",
				},
			]);
		} finally {
			bundleSpy.mockRestore();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("executes surface-session wakes end-to-end through CloudNativeCompanyRuntime using tenant-scoped native surface RPCs", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "qorpera-surface-session-wake-test-"));
		const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
		const binarySha256 = createHash("sha256")
			.update(await readFile(process.execPath))
			.digest("hex");
		const assertBundle = runtimeBundle.assertCloudRuntimeBundle;
		const bundleSpy = vi
			.spyOn(runtimeBundle, "assertCloudRuntimeBundle")
			.mockImplementation((identity) => assertBundle(identity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256));

		try {
			const f = nativeCompanyContextFixture();
			f.context = {
				...f.context,
				agentKind: "cofounder",
				identity: { ...f.context.identity, sessionId: null },
			};
			f.authority = {
				...f.authority,
				identity: { ...f.authority.identity, sessionId: null },
			};
			const surfaceId = randomUUID();
			const sessionId = randomUUID();
			const leaseToken = randomUUID();
			const changeId = randomUUID();
			const wake = {
				schema: "qorpera.wake-envelope/v1",
				id: randomUUID(),
				runId: f.context.identity.runId,
				kind: "agent",
				companyId: f.context.identity.companyId,
				environmentId: f.context.identity.environmentId,
				staffAgentId: f.context.identity.staffAgentId,
				requesterUserId: f.context.identity.requesterUserId,
				actorStaffId: null,
				actorUserId: null,
				audience: {
					kind: f.context.identity.audienceKind,
					userId: f.context.identity.audienceUserId,
					sessionId: null,
				},
				source: {
					kind: "surface-session",
					id: sessionId,
					occurrenceKey: `surface-session:${sessionId}:${leaseToken}`,
				},
				policy: {
					schema: "qorpera.wake-policy/v1",
					kind: "agent",
					initial: "forbidden",
					final: "forbidden",
					silenceAllowed: true,
					maxPublicSends: 0,
				},
				time: {
					utc: "2026-09-02T08:00:00.000000Z",
					local: "2026-09-02T10:00:00.000000",
					timeZone: "Europe/Copenhagen",
				},
				pins: {
					companySnapshotId: null,
					companySeq: 1,
					staffVersion: f.context.identity.staffVersion,
					wakeSchema: "qorpera.wake-envelope/v1",
					runtimeBundleVersion: null,
				},
				routine: null,
				payload: {
					schema: "qorpera.surface-session-wake/v1",
					surfaceSessionId: sessionId,
					surfaceId,
					profileId: f.context.identity.companyId,
					surfaceSlug: "identity",
					sourceKind: "folder",
					originKind: "member",
					memberInitiated: true,
					leaseToken,
				},
				parentRunId: null,
				causal: { rootId: randomUUID(), agentIds: [f.context.identity.staffAgentId] },
			};

			const companySkill =
				"---\nname: identity-studio\ndescription: How this company keeps its identity.\n---\n\nKeep every mark in ink on paper.\n";
			const folderFiles = new Map<string, string>([
				["identity/tokens.json", '{"accent":"#1f2937"}'],
				["QorperaOS/skills/identity-studio/SKILL.md", companySkill],
			]);
			const folderSha = (text: string) => createHash("sha256").update(text).digest("hex");
			const folderVersion = (path: string, text: string) => {
				const hex = createHash("sha256").update(`${path}\n${text}`).digest("hex");
				return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
			};
			const folderEntry = (path: string) => {
				const text = folderFiles.get(path);
				if (text === undefined) return null;
				return {
					path,
					kind: "file",
					version: folderVersion(path, text),
					seq: 1,
					updatedAt: "2026-10-01T00:00:00+00:00",
					manifestSha256: folderSha(`manifest:${text}`),
					fileSha256: folderSha(text),
					bytes: Buffer.byteLength(text),
					mediaType: "application/json",
					executable: false,
					authority: { resourceId: randomUUID(), resourceRevision: 1, grantId: randomUUID(), grantRevision: 1 },
				};
			};

			let nativeAdmission: Record<string, unknown> | undefined;
			const surfaceCalls: { method: string; args: Record<string, unknown> }[] = [];
			const memberMessageId = randomUUID();
			const memberInputId = randomUUID();
			const memberImagePath = `QorperaOS/surfaces/identity/images/${memberInputId}/${"e".repeat(64)}.png`;
			const control = {
				describeToolAuthority: vi.fn(async () => structuredClone(f.authority)),
				beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async () => {
					throw new Error("No generic effects expected");
				}),
				completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(async () => {
					throw new Error("No generic effects expected");
				}),
				completeFolderToolOperation: vi.fn<
					NonNullable<CloudNativeToolOperationControlPlane["completeFolderToolOperation"]>
				>(async () => {
					throw new Error("No folder writes expected");
				}),
				sendMessage: vi.fn<NativeProviderControlPlane["sendMessage"]>(async () => {
					throw new Error("No public chat messages expected");
				}),
				appendInteractionRequest: vi.fn<NonNullable<NativeProviderControlPlane["appendInteractionRequest"]>>(
					async () => {
						throw new Error("No cards expected");
					},
				),
			};

			const pathCall: CloudCompanyPathControl["call"] = async (method, args, signal) => {
				if (method === "qorpera_company_machines_available") return false;
				if (method === "qorpera_company_home_available")
					return { schema: "qorpera.company-home/v1", available: false };
				if (method === "qorpera_record_runtime_observation_batch") {
					const batch = args.p_observations as { attemptId: string; phase: string }[];
					return {
						schema: "qorpera.runtime-observation-batch-receipt/v1",
						runId: f.binding.runId,
						receipts: batch.map((observation) => ({
							schema: "qorpera.runtime-observation-receipt/v1",
							runId: f.binding.runId,
							attemptId: observation.attemptId,
							phase: observation.phase,
							ingestedAt: new Date().toISOString(),
							replayed: false,
						})),
					};
				}
				if (method === "qorpera_folder_read") {
					const entry = folderEntry(args.p_path as string);
					return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: entry !== null, entry };
				}
				if (method === "qorpera_folder_list") {
					return { schema: "qorpera.folder-list/v1", asOfSeq: 1, entries: [], next: null };
				}
				if (method === "qorpera_folder_record_release") {
					return {
						schema: "qorpera.folder-release/v1",
						releaseId: args.p_release_id,
						reads: (args.p_reads as unknown[]).length,
						replay: false,
					};
				}
				if (method === "qorpera_begin_native_company_execution_v3") {
					nativeAdmission = {
						runId: f.binding.runId,
						jobId: f.binding.jobId,
						leaseId: f.binding.leaseId,
						binarySha256: args.p_binary_sha256,
						runtimeBundleSha256: args.p_runtime_bundle_sha256,
						reasoningPolicySha256: args.p_reasoning_policy_sha256,
						reasoningEffort: "low",
						toolCatalogSha256: createHash("sha256")
							.update(args.p_tool_catalog_text as string)
							.digest("hex"),
					};
					return { schema: "qorpera.native-company-execution-admission/v1", ...nativeAdmission };
				}
				if (method === "qorpera_bind_native_company_context") {
					const admission = nativeAdmission!;
					return {
						schema: "qorpera.native-company-execution-start/v1",
						...admission,
						contextSha256: args.p_context_sha256,
						contextBytes: args.p_context_bytes,
					};
				}
				if (method === "qorpera_describe_company_run_context") return structuredClone(f.context);
				if (method === "qorpera_read_native_wake") return structuredClone(wake);
				if (method === "qorpera_assert_company_path_reads") return null;
				if (method === "qorpera_check_native_run") return await control.describeToolAuthority();
				if (method === "qorpera_fence_native_context") {
					const authority = await control.describeToolAuthority();
					const receipt = await pathCall(
						"qorpera_record_native_context_view",
						{ p_environment_id: args.p_environment_id, p_binding: args.p_binding, p_view: args.p_view },
						signal,
					);
					return { schema: "qorpera.native-context-fence/v1", authority, receipt, kept: args.p_paths };
				}
				if (method === "qorpera_record_native_context_view") {
					return {
						schema: "qorpera.native-context-view-receipt/v1",
						viewId: randomUUID(),
						requestId: (args.p_view as Record<string, unknown>).requestId,
						sha256: "b".repeat(64),
						ordinal: 1,
					};
				}
				if (method === "qorpera_native_surface_read_session_turn") {
					surfaceCalls.push({ method, args });
					return {
						sessionId,
						surfaceId,
						surfaceSlug: "identity",
						surfaceTitle: "Identity",
						sourceKind: "folder",
						prompt: "Try a warmer terracotta primary accent.",
						state: "queued",
						repositoryKey: null,
						folderRoot: "identity",
						briefSummary: "Global visual identity",
						explorationVariantLabel: null,
						originKind: "member",
						originRef: null,
						baseSha: null,
						branchHeadSha: null,
						conflictPaths: [],
					};
				}
				if (method === "qorpera_native_surface_session_images") {
					expect(args).toEqual({
						p_profile_id: f.context.identity.companyId,
						p_session_id: sessionId,
						p_lease_token: leaseToken,
					});
					return {
						schema: "qorpera.native-surface-session-images/v1",
						sessionId,
						latestMemberMessageId: memberMessageId,
						messages: [
							{
								messageId: memberMessageId,
								clientInputId: memberInputId,
								latest: true,
								images: [{ sha256: "e".repeat(64), bytes: 9, mediaType: "image/png", path: memberImagePath }],
							},
						],
					};
				}
				if (method === "qorpera_native_surface_record_change") {
					surfaceCalls.push({ method, args });
					return { changeId, seq: 1, session: { openChangeCount: 1 } };
				}
				if (method === "qorpera_native_surface_complete_turn") {
					surfaceCalls.push({ method, args });
					return { id: sessionId, state: args.p_state };
				}
				if (method === "qorpera_native_surface_renew_lease") {
					surfaceCalls.push({ method, args });
					return { renewed: true };
				}
				throw new Error(`Unexpected RPC: ${method}`);
			};

			const evidencePath = join(tempRoot, "evidence.json");
			const identityRoot = join(tempRoot, "identity");
			await mkdir(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
			await writeFile(join(identityRoot, "codex", "auth.json"), '{"tokens":{"access_token":"SYNTHETIC_SECRET"}}', {
				mode: 0o600,
			});

			const runtime = new CloudNativeCompanyRuntime({
				controlPlane: control,
				pathControl: { call: pathCall },
				command: [process.execPath, rpcFixture, "company-surface-session", evidencePath],
				binarySha256,
				timeoutMs: 10_000,
				surfaceFirst: true,
				folderBytes: () => ({
					put: async () => {
						throw new Error("No folder writes expected");
					},
					get: async (file: { fileSha256: string }) => {
						const text = [...folderFiles.values()].find((value) => folderSha(value) === file.fileSha256);
						if (text === undefined) throw new Error("No such file bytes");
						return new TextEncoder().encode(text);
					},
					range: async (file: { fileSha256: string }, offset: number, length: number) => {
						const text = [...folderFiles.values()].find((value) => folderSha(value) === file.fileSha256);
						if (text === undefined) throw new Error("No such file bytes");
						return new TextEncoder().encode(text).subarray(offset, offset + length);
					},
				}),
			});

			const request: NativeCompanyExecutionRequest = {
				runtime: "company-path-v1",
				authority: {
					...f.binding,
					encryptedCapsuleReference: `native-capsule/${f.binding.credentialCapsuleId}`,
					attestationPolicySha256: "a".repeat(64),
					expiresAt: "2099-08-28T12:00:00Z",
				},
				job: {
					jobId: f.binding.jobId,
					jobType: "agent_turn",
					requiredCapability: "agent_turn",
					attemptCount: 1,
					payload: {},
				},
			};

			const execResult = await runtime.execute(request, identityRoot, new AbortController().signal);
			expect(execResult.delivery.messageCount).toBe(0);

			const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
				threadParameters: {
					developerInstructions?: string;
					dynamicTools: { tools: { name: string }[] }[];
				};
				outputs: { output: string }[];
			};
			const offeredNames = evidence.threadParameters.dynamicTools[0].tools.map((tool) => tool.name);
			expect(offeredNames).toContain("read_skill");
			expect(offeredNames).toContain("search_skills");
			expect(offeredNames).not.toContain("update_skill");
			const instructions = evidence.threadParameters.developerInstructions ?? "";
			expect(instructions).toContain(
				"## Skill: identity-studio\nThe company's own identity-studio skill (QorperaOS/skills/identity-studio/SKILL.md), used in place of the platform's: how this page is worked on and what good looks like. The rules above still hold.\n\nKeep every mark in ink on paper.",
			);
			expect(instructions).not.toContain(CLOUD_PLATFORM_SKILLS.get("identity-studio")!.body.trim());
			const [read, refused] = evidence.outputs.map((output) => output.output);
			expect(read).toContain("Keep every mark in ink on paper.");
			expect(read).toContain("QorperaOS/skills/identity-studio/SKILL.md");
			expect(refused).toContain("INVALID_ARGUMENTS: Invalid skill scope");
			expect(JSON.stringify(evidence)).toContain(
				"Images the member attached (open each with company_read on its path)",
			);
			expect(JSON.stringify(evidence)).toContain(`- ${memberImagePath}`);
			expect(offeredNames).toContain("stage_surface_patch");
			expect(offeredNames).toContain("surface_reply");
			expect(offeredNames).toContain("surface_ask");
			expect(offeredNames).toContain("company_read");
			expect(offeredNames).not.toContain("send_message");

			expect(surfaceCalls.filter((call) => call.method === "qorpera_native_surface_renew_lease")).toEqual([
				{
					method: "qorpera_native_surface_renew_lease",
					args: {
						p_profile_id: f.context.identity.companyId,
						p_session_id: sessionId,
						p_lease_token: leaseToken,
						p_extend_seconds: 300,
					},
				},
			]);
			expect(surfaceCalls.filter((call) => call.method !== "qorpera_native_surface_renew_lease")).toEqual([
				{
					method: "qorpera_native_surface_read_session_turn",
					args: {
						p_profile_id: f.context.identity.companyId,
						p_session_id: sessionId,
						p_lease_token: leaseToken,
					},
				},
				{
					method: "qorpera_native_surface_record_change",
					args: expect.objectContaining({
						p_profile_id: f.context.identity.companyId,
						p_session_id: sessionId,
						p_kind: "folder_patch",
						p_title: "Warm terracotta accent",
						p_affected_paths: ["tokens.json"],
						p_lease_token: leaseToken,
					}),
				},
				{
					method: "qorpera_native_surface_complete_turn",
					args: {
						p_profile_id: f.context.identity.companyId,
						p_session_id: sessionId,
						p_state: "ready",
						p_reply_text: "Staged the warm terracotta accent direction for preview.",
						p_question: null,
						p_note_paths: ["QorperaOS/surfaces/identity/notes/palette.md"],
						p_branch_head_sha: null,
						p_lease_token: leaseToken,
					},
				},
			]);
		} finally {
			bundleSpy.mockRestore();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("threads the interface kind, icon and folder from qorpera_native_surface_read_session_turn into the page contract and shared specs", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "qorpera-product-surface-session-test-"));
		const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
		const binarySha256 = createHash("sha256")
			.update(await readFile(process.execPath))
			.digest("hex");
		const assertBundle = runtimeBundle.assertCloudRuntimeBundle;
		const bundleSpy = vi
			.spyOn(runtimeBundle, "assertCloudRuntimeBundle")
			.mockImplementation((identity) => assertBundle(identity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256));

		try {
			const f = nativeCompanyContextFixture();
			f.context = {
				...f.context,
				agentKind: "cofounder",
				identity: { ...f.context.identity, sessionId: null },
			};
			f.authority = {
				...f.authority,
				identity: { ...f.authority.identity, sessionId: null },
			};
			const surfaceId = randomUUID();
			const sessionId = randomUUID();
			const leaseToken = randomUUID();
			const changeId = randomUUID();
			const wake = {
				schema: "qorpera.wake-envelope/v1",
				id: randomUUID(),
				runId: f.context.identity.runId,
				kind: "agent",
				companyId: f.context.identity.companyId,
				environmentId: f.context.identity.environmentId,
				staffAgentId: f.context.identity.staffAgentId,
				requesterUserId: f.context.identity.requesterUserId,
				actorStaffId: null,
				actorUserId: null,
				audience: {
					kind: f.context.identity.audienceKind,
					userId: f.context.identity.audienceUserId,
					sessionId: null,
				},
				source: {
					kind: "surface-session",
					id: sessionId,
					occurrenceKey: `surface-session:${sessionId}:${leaseToken}`,
				},
				policy: {
					schema: "qorpera.wake-policy/v1",
					kind: "agent",
					initial: "forbidden",
					final: "forbidden",
					silenceAllowed: true,
					maxPublicSends: 0,
				},
				time: {
					utc: "2026-09-02T08:00:00.000000Z",
					local: "2026-09-02T10:00:00.000000",
					timeZone: "Europe/Copenhagen",
				},
				pins: {
					companySnapshotId: null,
					companySeq: 1,
					staffVersion: f.context.identity.staffVersion,
					wakeSchema: "qorpera.wake-envelope/v1",
					runtimeBundleVersion: null,
				},
				routine: null,
				payload: {
					schema: "qorpera.surface-session-wake/v1",
					surfaceSessionId: sessionId,
					surfaceId,
					profileId: f.context.identity.companyId,
					surfaceSlug: "thetabands",
					sourceKind: "folder",
					originKind: "member",
					memberInitiated: true,
					leaseToken,
				},
				parentRunId: null,
				causal: { rootId: randomUUID(), agentIds: [f.context.identity.staffAgentId] },
			};

			const folderFiles = new Map<string, string>([
				["identity/tokens.json", '{"accent":"#7c6fd6"}'],
				["surfaces/thetabands/specs.json", '{"overview":{"product":"Thetabands Gen 1","weight":"44 g"}}'],
			]);
			const folderSha = (text: string) => createHash("sha256").update(text).digest("hex");
			const folderVersion = (path: string, text: string) => {
				const hex = createHash("sha256").update(`${path}\n${text}`).digest("hex");
				return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
			};
			const folderEntry = (path: string) => {
				const text = folderFiles.get(path);
				if (text === undefined) return null;
				return {
					path,
					kind: "file",
					version: folderVersion(path, text),
					seq: 1,
					updatedAt: "2026-10-01T00:00:00+00:00",
					manifestSha256: folderSha(`manifest:${text}`),
					fileSha256: folderSha(text),
					bytes: Buffer.byteLength(text),
					mediaType: "application/json",
					executable: false,
					authority: { resourceId: randomUUID(), resourceRevision: 1, grantId: randomUUID(), grantRevision: 1 },
				};
			};

			let nativeAdmission: Record<string, unknown> | undefined;
			const control = {
				describeToolAuthority: vi.fn(async () => structuredClone(f.authority)),
				beginToolOperation: vi.fn<CloudNativeToolOperationControlPlane["beginToolOperation"]>(async () => {
					throw new Error("No generic effects expected");
				}),
				completeToolOperation: vi.fn<CloudNativeToolOperationControlPlane["completeToolOperation"]>(async () => {
					throw new Error("No generic effects expected");
				}),
				completeFolderToolOperation: vi.fn<
					NonNullable<CloudNativeToolOperationControlPlane["completeFolderToolOperation"]>
				>(async () => {
					throw new Error("No folder writes expected");
				}),
				sendMessage: vi.fn<NativeProviderControlPlane["sendMessage"]>(async () => {
					throw new Error("No public chat messages expected");
				}),
				appendInteractionRequest: vi.fn<NonNullable<NativeProviderControlPlane["appendInteractionRequest"]>>(
					async () => {
						throw new Error("No cards expected");
					},
				),
			};

			const pathCall: CloudCompanyPathControl["call"] = async (method, args, signal) => {
				if (method === "qorpera_company_machines_available") return false;
				if (method === "qorpera_company_home_available")
					return { schema: "qorpera.company-home/v1", available: false };
				if (method === "qorpera_record_runtime_observation_batch") {
					const batch = args.p_observations as { attemptId: string; phase: string }[];
					return {
						schema: "qorpera.runtime-observation-batch-receipt/v1",
						runId: f.binding.runId,
						receipts: batch.map((observation) => ({
							schema: "qorpera.runtime-observation-receipt/v1",
							runId: f.binding.runId,
							attemptId: observation.attemptId,
							phase: observation.phase,
							ingestedAt: new Date().toISOString(),
							replayed: false,
						})),
					};
				}
				if (method === "qorpera_folder_read") {
					const entry = folderEntry(args.p_path as string);
					return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: entry !== null, entry };
				}
				if (method === "qorpera_folder_list") {
					return { schema: "qorpera.folder-list/v1", asOfSeq: 1, entries: [], next: null };
				}
				if (method === "qorpera_folder_record_release") {
					return {
						schema: "qorpera.folder-release/v1",
						releaseId: args.p_release_id,
						reads: (args.p_reads as unknown[]).length,
						replay: false,
					};
				}
				if (method === "qorpera_begin_native_company_execution_v3") {
					nativeAdmission = {
						runId: f.binding.runId,
						jobId: f.binding.jobId,
						leaseId: f.binding.leaseId,
						binarySha256: args.p_binary_sha256,
						runtimeBundleSha256: args.p_runtime_bundle_sha256,
						reasoningPolicySha256: args.p_reasoning_policy_sha256,
						reasoningEffort: "low",
						toolCatalogSha256: createHash("sha256")
							.update(args.p_tool_catalog_text as string)
							.digest("hex"),
					};
					return { schema: "qorpera.native-company-execution-admission/v1", ...nativeAdmission };
				}
				if (method === "qorpera_bind_native_company_context") {
					const admission = nativeAdmission!;
					return {
						schema: "qorpera.native-company-execution-start/v1",
						...admission,
						contextSha256: args.p_context_sha256,
						contextBytes: args.p_context_bytes,
					};
				}
				if (method === "qorpera_describe_company_run_context") return structuredClone(f.context);
				if (method === "qorpera_read_native_wake") return structuredClone(wake);
				if (method === "qorpera_assert_company_path_reads") return null;
				if (method === "qorpera_check_native_run") return await control.describeToolAuthority();
				if (method === "qorpera_fence_native_context") {
					const authority = await control.describeToolAuthority();
					const receipt = await pathCall(
						"qorpera_record_native_context_view",
						{ p_environment_id: args.p_environment_id, p_binding: args.p_binding, p_view: args.p_view },
						signal,
					);
					return { schema: "qorpera.native-context-fence/v1", authority, receipt, kept: args.p_paths };
				}
				if (method === "qorpera_record_native_context_view") {
					return {
						schema: "qorpera.native-context-view-receipt/v1",
						viewId: randomUUID(),
						requestId: (args.p_view as Record<string, unknown>).requestId,
						sha256: "b".repeat(64),
						ordinal: 1,
					};
				}
				if (method === "qorpera_native_surface_read_session_turn") {
					return {
						sessionId,
						surfaceId,
						surfaceSlug: "thetabands",
						surfaceTitle: "Thetabands",
						surfaceKind: "custom",
						surfaceIcon: "box",
						surfaceIsGlobal: false,
						surfaceArchetype: "studio",
						sourceKind: "folder",
						prompt: "Design headband variants and audit suppliers.",
						state: "queued",
						repositoryKey: null,
						folderRoot: "surfaces/thetabands",
						productFolderRoots: ["surfaces/thetabands"],
						briefSummary: "Physical EEG headband product studio",
						explorationVariantLabel: null,
						originKind: "member",
						originRef: null,
						baseSha: null,
						branchHeadSha: null,
						conflictPaths: [],
					};
				}
				if (method === "qorpera_native_surface_session_images") {
					return {
						schema: "qorpera.native-surface-session-images/v1",
						sessionId,
						latestMemberMessageId: null,
						messages: [],
					};
				}
				if (method === "qorpera_native_surface_record_change") {
					return { changeId, seq: 1, session: { openChangeCount: 1 } };
				}
				if (method === "qorpera_native_surface_complete_turn") {
					return { id: sessionId, state: args.p_state };
				}
				if (method === "qorpera_native_surface_renew_lease") {
					return { renewed: true };
				}
				throw new Error(`Unexpected RPC: ${method}`);
			};

			const evidencePath = join(tempRoot, "evidence.json");
			const identityRoot = join(tempRoot, "identity");
			await mkdir(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
			await writeFile(join(identityRoot, "codex", "auth.json"), '{"tokens":{"access_token":"SYNTHETIC_SECRET"}}', {
				mode: 0o600,
			});

			const runtime = new CloudNativeCompanyRuntime({
				controlPlane: control,
				pathControl: { call: pathCall },
				command: [process.execPath, rpcFixture, "company-surface-session", evidencePath],
				binarySha256,
				timeoutMs: 10_000,
				surfaceFirst: true,
				folderBytes: () => ({
					put: async () => {
						throw new Error("No folder writes expected");
					},
					get: async (file: { fileSha256: string }) => {
						const text = [...folderFiles.values()].find((value) => folderSha(value) === file.fileSha256);
						if (text === undefined) throw new Error("No such file bytes");
						return new TextEncoder().encode(text);
					},
					range: async (file: { fileSha256: string }, offset: number, length: number) => {
						const text = [...folderFiles.values()].find((value) => folderSha(value) === file.fileSha256);
						if (text === undefined) throw new Error("No such file bytes");
						return new TextEncoder().encode(text).subarray(offset, offset + length);
					},
				}),
			});

			const request: NativeCompanyExecutionRequest = {
				runtime: "company-path-v1",
				authority: {
					...f.binding,
					encryptedCapsuleReference: `native-capsule/${f.binding.credentialCapsuleId}`,
					attestationPolicySha256: "a".repeat(64),
					expiresAt: "2099-08-28T12:00:00Z",
				},
				job: {
					jobId: f.binding.jobId,
					jobType: "agent_turn",
					requiredCapability: "agent_turn",
					attemptCount: 1,
					payload: {},
				},
			};

			await runtime.execute(request, identityRoot, new AbortController().signal);
			const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
				threadParameters: { developerInstructions?: string };
				turnParameters: unknown;
			};
			const instructions = evidence.threadParameters.developerInstructions ?? "";
			expect(instructions).toContain(describeSurfaceBlocks());
			expect(instructions).toContain(
				`No surfaces/thetabands/layout.json yet, so the page shows the product starter:\n${JSON.stringify(starterSurfaceLayout("product"))}`,
			);
			expect(instructions).toContain('A report file (*.report.json) is {"category"');
			expect(instructions).toContain(
				`## Skill: product-studio\nThe platform's product-studio skill: how this page is worked on and what good looks like. The rules above still hold.\n\n${CLOUD_PLATFORM_SKILLS.get("product-studio")!.body.trim()}`,
			);
			expect(instructions).not.toContain("Product Studio file layout");
			expect(instructions).not.toContain("When this surface represents a physical product");
			expect(JSON.stringify(evidence.turnParameters)).toContain("Thetabands Gen 1");
		} finally {
			bundleSpy.mockRestore();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("forwards parentSha and leaseToken from coding_record_change to qorpera_native_surface_record_change", async () => {
		const rpcCalls: { method: string; args: Record<string, unknown> }[] = [];
		const leaseToken = randomUUID();
		const sessionId = randomUUID();
		const companyId = randomUUID();
		const parentSha = "1".repeat(40);
		const commitSha = "2".repeat(40);
		const port = createControlPlaneSurfaceToolsPort(
			{
				async call(method, args) {
					rpcCalls.push({ method, args });
					return { changeId: randomUUID(), seq: 1, session: { openChangeCount: 1 } };
				},
			},
			{ leaseToken },
		);
		const tool = createCodingRecordChangeTool(sessionId, { recordChange: port.recordChange });
		const parsed = tool.parseArguments({
			title: "Add pricing section",
			summary: "Adds transparent pricing tiers to the landing page.",
			parentSha,
			commitSha,
			dependsOnChangeIds: [],
		});
		await tool.execute(parsed, {
			companyId,
			signal: new AbortController().signal,
		} as CloudToolContext);
		expect(rpcCalls).toEqual([
			{
				method: "qorpera_native_surface_record_change",
				args: expect.objectContaining({
					p_profile_id: companyId,
					p_session_id: sessionId,
					p_kind: "git_range",
					p_parent_sha: parentSha,
					p_head_sha: commitSha,
					p_lease_token: leaseToken,
				}),
			},
		]);
	});

	it("rethrows tagged turn errors from #surfaceSessionTurn after marking the surface session failed", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "qorpera-surface-session-err-test-"));
		const binarySha256 = createHash("sha256")
			.update(await readFile(process.execPath))
			.digest("hex");
		const assertBundle = runtimeBundle.assertCloudRuntimeBundle;
		const bundleSpy = vi
			.spyOn(runtimeBundle, "assertCloudRuntimeBundle")
			.mockImplementation((identity) => assertBundle(identity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256));

		try {
			const f = nativeCompanyContextFixture();
			f.context = {
				...f.context,
				agentKind: "cofounder",
				identity: { ...f.context.identity, sessionId: null },
			};
			f.authority = {
				...f.authority,
				identity: { ...f.authority.identity, sessionId: null },
			};
			const surfaceId = randomUUID();
			const sessionId = randomUUID();
			const leaseToken = randomUUID();
			const wake = {
				schema: "qorpera.wake-envelope/v1",
				id: randomUUID(),
				runId: f.context.identity.runId,
				kind: "agent",
				companyId: f.context.identity.companyId,
				environmentId: f.context.identity.environmentId,
				staffAgentId: f.context.identity.staffAgentId,
				requesterUserId: f.context.identity.requesterUserId,
				actorStaffId: null,
				actorUserId: null,
				audience: {
					kind: f.context.identity.audienceKind,
					userId: f.context.identity.audienceUserId,
					sessionId: null,
				},
				source: {
					kind: "surface-session",
					id: sessionId,
					occurrenceKey: `surface-session:${sessionId}:${leaseToken}`,
				},
				policy: {
					schema: "qorpera.wake-policy/v1",
					kind: "agent",
					initial: "forbidden",
					final: "forbidden",
					silenceAllowed: true,
					maxPublicSends: 0,
				},
				time: {
					utc: "2026-09-02T08:00:00.000000Z",
					local: "2026-09-02T10:00:00.000000",
					timeZone: "Europe/Copenhagen",
				},
				pins: {
					companySnapshotId: null,
					companySeq: 1,
					staffVersion: f.context.identity.staffVersion,
					wakeSchema: "qorpera.wake-envelope/v1",
					runtimeBundleVersion: null,
				},
				routine: null,
				payload: {
					schema: "qorpera.surface-session-wake/v1",
					surfaceSessionId: sessionId,
					surfaceId,
					profileId: f.context.identity.companyId,
					surfaceSlug: "identity",
					sourceKind: "folder",
					originKind: "member",
					memberInitiated: true,
					leaseToken,
				},
				parentRunId: null,
				causal: { rootId: randomUUID(), agentIds: [f.context.identity.staffAgentId] },
			};

			const completed: Record<string, unknown>[] = [];
			const taggedFailure = Object.assign(new Error("Simulated admission failure"), {
				nativeFailureStage: "native-tools",
				nativeFailureCategory: "authority_unavailable",
			});
			const pathCall: CloudCompanyPathControl["call"] = async (method, args) => {
				if (method === "qorpera_company_machines_available") return false;
				if (method === "qorpera_company_home_available")
					return { schema: "qorpera.company-home/v1", available: false };
				if (method === "qorpera_record_runtime_observation_batch") {
					const batch = args.p_observations as { attemptId: string; phase: string }[];
					return {
						schema: "qorpera.runtime-observation-batch-receipt/v1",
						runId: f.binding.runId,
						receipts: batch.map((observation) => ({
							schema: "qorpera.runtime-observation-receipt/v1",
							runId: f.binding.runId,
							attemptId: observation.attemptId,
							phase: observation.phase,
							ingestedAt: new Date().toISOString(),
							replayed: false,
						})),
					};
				}
				if (method === "qorpera_folder_read") {
					return { schema: "qorpera.folder-read/v1", asOfSeq: 1, found: false, entry: null };
				}
				if (method === "qorpera_describe_company_run_context") return structuredClone(f.context);
				if (method === "qorpera_read_native_wake") return structuredClone(wake);
				if (method === "qorpera_native_surface_read_session_turn") {
					return {
						sessionId,
						surfaceId,
						surfaceSlug: "identity",
						surfaceTitle: "Identity",
						sourceKind: "folder",
						prompt: "Update palette.",
						state: "queued",
						repositoryKey: null,
						folderRoot: "identity",
						briefSummary: null,
						explorationVariantLabel: null,
						originKind: "member",
						originRef: null,
						baseSha: null,
						branchHeadSha: null,
						conflictPaths: [],
					};
				}
				if (method === "qorpera_native_surface_session_images") {
					return {
						schema: "qorpera.native-surface-session-images/v1",
						sessionId,
						latestMemberMessageId: null,
						messages: [],
					};
				}
				if (method === "qorpera_begin_native_company_execution_v3") {
					throw taggedFailure;
				}
				if (method === "qorpera_native_surface_complete_turn") {
					completed.push(args);
					return { id: sessionId, state: args.p_state };
				}
				throw new Error(`Unexpected RPC: ${method}`);
			};

			const identityRoot = join(tempRoot, "identity");
			await mkdir(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
			await writeFile(join(identityRoot, "codex", "auth.json"), '{"tokens":{"access_token":"SYNTHETIC_SECRET"}}', {
				mode: 0o600,
			});

			const runtime = new CloudNativeCompanyRuntime({
				controlPlane: {
					describeToolAuthority: vi.fn(async () => structuredClone(f.authority)),
					beginToolOperation: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
					completeToolOperation: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
					completeFolderToolOperation: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
					sendMessage: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
				},
				pathControl: { call: pathCall },
				command: [process.execPath, "-e", "process.exit(0)"],
				binarySha256,
				timeoutMs: 10_000,
				surfaceFirst: true,
				folderBytes: () => ({
					put: async () => {
						throw new Error("No folder writes expected");
					},
					get: async () => {
						throw new Error("No file bytes");
					},
					range: async () => {
						throw new Error("No file bytes");
					},
				}),
			});

			await expect(
				runtime.execute(
					{
						runtime: "company-path-v1",
						authority: {
							...f.binding,
							encryptedCapsuleReference: `native-capsule/${f.binding.credentialCapsuleId}`,
							attestationPolicySha256: "a".repeat(64),
							expiresAt: "2099-08-28T12:00:00Z",
						},
						job: {
							jobId: f.binding.jobId,
							jobType: "agent_turn",
							requiredCapability: "agent_turn",
							attemptCount: 1,
							payload: {},
						},
					},
					identityRoot,
					new AbortController().signal,
				),
			).rejects.toThrow("Cloud context authority unavailable");

			expect(completed).toEqual([
				expect.objectContaining({
					p_profile_id: f.context.identity.companyId,
					p_session_id: sessionId,
					p_state: "failed",
					p_lease_token: leaseToken,
				}),
			]);
		} finally {
			bundleSpy.mockRestore();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("bounds stage_surface_patch size, merge_json keys/depth, unsafe paths, listSurfaceSenses signal, and conflictPaths brief truncation", async () => {
		const sessionId = randomUUID();
		const patchTool = createStageSurfacePatchTool(sessionId, {
			stageSurfacePatch: vi.fn(),
		});

		for (const badPath of [".", "a/./b.json", "a//b.json", "dir/", "a\0b.json", "C:file.json"]) {
			expect(() =>
				patchTool.parseArguments({
					title: "Bad path",
					summary: "Tests path hygiene",
					ops: [{ op: "delete", path: badPath }],
				}),
			).toThrow();
		}

		expect(() =>
			patchTool.parseArguments({
				title: "Oversized patch",
				summary: "Tests 512 KiB cap",
				ops: [
					{ op: "write_text", path: "a.txt", content: "x".repeat(200_000) },
					{ op: "write_text", path: "b.txt", content: "y".repeat(200_000) },
					{ op: "write_text", path: "c.txt", content: "z".repeat(200_000) },
				],
			}),
		).toThrow(/524288|exceeds/);

		const protoPatch = JSON.parse('{"__proto__":{"polluted":true}}') as JsonValue;
		expect(() =>
			patchTool.parseArguments({
				title: "Proto pollution",
				summary: "Tests disallowed keys",
				ops: [{ op: "merge_json", path: "tokens.json", patch: protoPatch }],
			}),
		).toThrow(/forbidden key/);

		let deep: Record<string, JsonValue> = { leaf: 1 };
		for (let i = 0; i < 20; i += 1) {
			deep = { next: deep };
		}
		expect(() =>
			patchTool.parseArguments({
				title: "Deep json",
				summary: "Tests nesting depth cap",
				ops: [{ op: "merge_json", path: "tokens.json", patch: deep }],
			}),
		).toThrow(/nesting depth/);

		let observedSignal: AbortSignal | undefined;
		const port = createControlPlaneSurfaceToolsPort({
			call: async (_method, _args, signal) => {
				observedSignal = signal;
				return { surfaces: [], automations: [] };
			},
		});
		await port.listSurfaceSenses(randomUUID());
		expect(observedSignal).toBeDefined();

		const conflictPaths = Array.from({ length: 140 }, (_, idx) => `src/file-${idx}.ts`);
		const brief = buildSurfaceTurnBrief({
			sessionId,
			surfaceSlug: "web",
			surfaceTitle: "Website",
			briefMarkdown: null,
			conflictPaths,
		});
		expect(brief).toContain("- src/file-0.ts");
		expect(brief).toContain("- src/file-99.ts");
		expect(brief).not.toContain("- src/file-100.ts");
		expect(brief).toContain("and 40 more paths");
	});

	it("routes worker-dispatch coding wakes with surfaceSession into CloudNativeCodingDriver with full prompt and refuses code_repo on legacy surface-session wakes", async () => {
		const tempRoot = await mkdtemp(join(tmpdir(), "qorpera-surface-coding-route-test-"));
		const binarySha256 = createHash("sha256")
			.update(await readFile(process.execPath))
			.digest("hex");
		const assertBundle = runtimeBundle.assertCloudRuntimeBundle;
		const bundleSpy = vi
			.spyOn(runtimeBundle, "assertCloudRuntimeBundle")
			.mockImplementation((identity) => assertBundle(identity, CLOUD_RUNTIME_NATIVE_BINARY_SHA256));

		try {
			const f = nativeCompanyContextFixture();
			f.context = {
				...f.context,
				agentKind: "cofounder",
				identity: { ...f.context.identity, sessionId: null },
			};
			f.authority = {
				...f.authority,
				identity: { ...f.authority.identity, sessionId: null },
			};
			const workerId = randomUUID();
			const surfaceId = randomUUID();
			const sessionId = randomUUID();
			const leaseToken = randomUUID();
			const fullPrompt = `${"Design the mobile meditation preview flow. ".repeat(65)}FULL_PROMPT_TAIL`;
			const codingWake = {
				schema: "qorpera.wake-envelope/v1",
				id: randomUUID(),
				runId: f.context.identity.runId,
				kind: "agent",
				companyId: f.context.identity.companyId,
				environmentId: f.context.identity.environmentId,
				staffAgentId: f.context.identity.staffAgentId,
				requesterUserId: f.context.identity.requesterUserId,
				actorStaffId: null,
				actorUserId: null,
				audience: {
					kind: "company",
					userId: null,
					sessionId: null,
				},
				source: {
					kind: "worker-dispatch",
					id: workerId,
					occurrenceKey: `worker-dispatch:${workerId}:1`,
				},
				policy: {
					schema: "qorpera.wake-policy/v1",
					kind: "agent",
					initial: "forbidden",
					final: "forbidden",
					silenceAllowed: true,
					maxPublicSends: 0,
				},
				time: {
					utc: "2026-09-02T08:00:00.000000Z",
					local: "2026-09-02T10:00:00.000000",
					timeZone: "Europe/Copenhagen",
				},
				pins: {
					companySnapshotId: null,
					companySeq: 1,
					staffVersion: f.context.identity.staffVersion,
					wakeSchema: "qorpera.wake-envelope/v1",
					runtimeBundleVersion: null,
				},
				routine: null,
				payload: {
					schema: "qorpera.worker-dispatch/v1",
					workerId,
					workerKey: `surface-${sessionId.replaceAll("-", "")}`,
					sequence: 1,
					species: "coding",
					title: "Meditationsforløbet i Preview",
					todo: { todoKey: null, title: null, path: null },
					parentRunId: null,
					access: "read",
					outputFolder: null,
					dispatch: {
						goal: fullPrompt.slice(0, 2000),
						definitionOfDone: "Commit and call coding_finish.",
						context: "",
						sources: [],
						followUp: null,
						authority: "Work only in the Surface repository worktree.",
						output: "Call coding_record_change and coding_finish.",
						cancellation: "Stop if cancelled.",
						completion: "Sync back to surface session.",
					},
					coding: {
						harness: "codex",
						repository: { host: "qorpera", owner: "surfaces", name: "meditation-app", baseBranch: "main" },
						branch: `qorpera/coding/${workerId}`,
						baseSha: "a".repeat(40),
						harnessSessionRef: null,
						sequence: 1,
						vmId: randomUUID(),
					},
					surfaceSession: {
						sessionId,
						surfaceId,
						surfaceSlug: "meditation-app",
						leaseToken,
					},
				},
				parentRunId: null,
				causal: { rootId: randomUUID(), agentIds: [f.context.identity.staffAgentId] },
			};

			const recordedRpcs: { method: string; args: Record<string, unknown> }[] = [];
			let activeWake: Record<string, unknown> = codingWake;
			const codingMessageId = randomUUID();
			const codingInputId = randomUUID();
			const codingImagePath = `QorperaOS/surfaces/meditation-app/images/${codingInputId}/${"e".repeat(64)}.png`;
			const codingExecute = vi.fn(async (_req, _root, _signal, ctx) => {
				expect(ctx.surfaceSession).toMatchObject({
					sessionId,
					surfaceSlug: "meditation-app",
					surfaceTitle: "Meditationsapp",
					fullPrompt,
					memberImages: [
						{
							clientInputId: codingInputId,
							sha256: "e".repeat(64),
							bytes: 9,
							mediaType: "image/png",
							path: codingImagePath,
							latest: true,
						},
					],
				});
				expect(typeof ctx.surfaceSession!.viewAttachment).toBe("function");
				await ctx.surfaceSession!.recordChange(
					sessionId,
					{
						title: "Mobile flow",
						summary: "Adds interactive meditation preview.",
						commitSha: "b".repeat(40),
						dependsOnChangeIds: [],
					},
					{ companyId: f.context.identity.companyId, signal: new AbortController().signal } as CloudToolContext,
				);
				return {
					providerSessionId: "native-coding-thread",
					delivery: { messageCount: 0, finalMessageId: null },
				};
			});

			const identityRoot = join(tempRoot, "identity");
			await mkdir(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
			await writeFile(join(identityRoot, "codex", "auth.json"), '{"tokens":{"access_token":"SYNTHETIC_SECRET"}}', {
				mode: 0o600,
			});

			const runtime = new CloudNativeCompanyRuntime({
				controlPlane: {
					describeToolAuthority: vi.fn(async () => ({
						...structuredClone(f.authority),
						identity: {
							...structuredClone(f.authority.identity),
							audienceKind: "company",
							audienceUserId: null,
							sessionId: null,
						},
					})),
					beginToolOperation: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
					completeToolOperation: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
					completeFolderToolOperation: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
					sendMessage: vi.fn(async () => {
						throw new Error("Unexpected");
					}),
				},
				pathControl: {
					call: async (method, args) => {
						recordedRpcs.push({ method, args });
						if (method === "qorpera_describe_company_run_context") {
							return {
								...structuredClone(f.context),
								identity: {
									...structuredClone(f.context.identity),
									audienceKind: "company",
									audienceUserId: null,
									sessionId: null,
								},
							};
						}
						if (method === "qorpera_read_native_wake") return structuredClone(activeWake);
						if (method === "qorpera_native_surface_complete_turn") {
							return { id: sessionId, state: args.p_state };
						}
						if (method === "qorpera_native_surface_read_session_turn") {
							return {
								sessionId,
								surfaceId,
								surfaceSlug: "meditation-app",
								surfaceTitle: "Meditationsapp",
								sourceKind: "code_repo",
								prompt: fullPrompt,
								state: "running",
								repositoryKey: "surfaces/meditation-app",
								folderRoot: null,
								briefSummary: "Mobile meditation app.",
								explorationVariantLabel: null,
								originKind: "member",
								originRef: null,
								baseSha: "a".repeat(40),
								branchHeadSha: null,
								conflictPaths: [],
							};
						}
						if (method === "qorpera_native_surface_session_images") {
							return {
								schema: "qorpera.native-surface-session-images/v1",
								sessionId,
								latestMemberMessageId: codingMessageId,
								messages: [
									{
										messageId: codingMessageId,
										clientInputId: codingInputId,
										latest: true,
										images: [
											{ sha256: "e".repeat(64), bytes: 9, mediaType: "image/png", path: codingImagePath },
										],
									},
								],
							};
						}
						if (method === "qorpera_native_surface_record_change") {
							return { changeId: randomUUID(), seq: 1, session: { openChangeCount: 1 } };
						}
						if (method === "qorpera_record_runtime_observation_batch") {
							const batch = args.p_observations as { attemptId: string; phase: string }[];
							return {
								schema: "qorpera.runtime-observation-batch-receipt/v1",
								runId: f.binding.runId,
								receipts: batch.map((o) => ({
									schema: "qorpera.runtime-observation-receipt/v1",
									runId: f.binding.runId,
									attemptId: o.attemptId,
									phase: o.phase,
									ingestedAt: new Date().toISOString(),
									replayed: false,
								})),
							};
						}
						throw new Error(`Unexpected RPC: ${method}`);
					},
				},
				coding: { execute: codingExecute },
				command: [process.execPath, "-e", "process.exit(0)"],
				binarySha256,
				timeoutMs: 10_000,
				surfaceFirst: true,
				folderBytes: () => ({
					put: async () => {
						throw new Error("No folder writes expected");
					},
					get: async () => {
						throw new Error("No file bytes");
					},
					range: async () => {
						throw new Error("No file bytes");
					},
				}),
			});

			await runtime.execute(
				{
					runtime: "company-path-v1",
					authority: {
						...f.binding,
						encryptedCapsuleReference: `native-capsule/${f.binding.credentialCapsuleId}`,
						attestationPolicySha256: "a".repeat(64),
						expiresAt: "2099-08-28T12:00:00Z",
					},
					job: {
						jobId: f.binding.jobId,
						jobType: "agent_turn",
						requiredCapability: "agent_turn",
						attemptCount: 1,
						payload: {},
					},
				},
				identityRoot,
				new AbortController().signal,
			);

			expect(codingExecute).toHaveBeenCalledTimes(1);
			for (const identityPath of ["identity/brief.md", "identity/voice.md", "identity/tokens.json"]) {
				expect(
					recordedRpcs.filter((rpc) => rpc.method === "qorpera_folder_read" && rpc.args.p_path === identityPath),
				).toHaveLength(1);
			}
			expect(recordedRpcs).toContainEqual({
				method: "qorpera_native_surface_record_change",
				args: expect.objectContaining({
					p_session_id: sessionId,
					p_kind: "git_range",
					p_head_sha: "b".repeat(40),
					p_lease_token: leaseToken,
				}),
			});

			activeWake = {
				...codingWake,
				id: randomUUID(),
				source: {
					kind: "surface-session",
					id: sessionId,
					occurrenceKey: `surface-session:${sessionId}:${leaseToken}`,
				},
				payload: {
					schema: "qorpera.surface-session-wake/v1",
					surfaceSessionId: sessionId,
					surfaceId,
					profileId: f.context.identity.companyId,
					surfaceSlug: "meditation-app",
					sourceKind: "code_repo",
					originKind: "member",
					memberInitiated: true,
					leaseToken,
				},
			};
			await expect(
				runtime.execute(
					{
						runtime: "company-path-v1",
						authority: {
							...f.binding,
							encryptedCapsuleReference: `native-capsule/${f.binding.credentialCapsuleId}`,
							attestationPolicySha256: "a".repeat(64),
							expiresAt: "2099-08-28T12:00:00Z",
						},
						job: {
							jobId: f.binding.jobId,
							jobType: "agent_turn",
							requiredCapability: "agent_turn",
							attemptCount: 1,
							payload: {},
						},
					},
					identityRoot,
					new AbortController().signal,
				),
			).rejects.toThrow("Code repository surface sessions run through the coding executor; retry this session.");
			expect(recordedRpcs).toContainEqual({
				method: "qorpera_native_surface_complete_turn",
				args: expect.objectContaining({
					p_session_id: sessionId,
					p_state: "failed",
					p_lease_token: leaseToken,
				}),
			});
		} finally {
			bundleSpy.mockRestore();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("updates existing open changes in place across coding, folder_patch, and ops_action tools with follow-up targeting guards", async () => {
		const sessionId = randomUUID();
		const c1 = randomUUID();
		const c2 = randomUUID();
		const unknownId = randomUUID();
		const baseSha = "a".repeat(40);
		const head1 = "b".repeat(40);
		const head2 = "c".repeat(40);
		const head3 = "d".repeat(40);

		const rpcCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
		const port = createControlPlaneSurfaceToolsPort({
			async call(method, args) {
				rpcCalls.push({ method, args });
				return {
					changeId: (args.p_change_id as string | undefined) ?? c2,
					seq: 1,
					openChangeCount: 1,
					updated: Boolean(args.p_change_id),
				};
			},
		});
		const ctx = toolContext();
		const recUpdate = await port.recordChange(
			sessionId,
			{
				title: "Revised hero",
				summary: "Updated.",
				commitSha: head2,
				parentSha: baseSha,
				changeId: c1,
			},
			ctx,
		);
		expect(recUpdate).toEqual({ changeId: c1, seq: 1, openChangeCount: 1, updated: true });
		expect(rpcCalls[0]?.args).toMatchObject({
			p_change_id: c1,
			p_parent_sha: baseSha,
			p_head_sha: head2,
			p_depends_on_change_ids: null,
		});

		const recRebase = await port.recordChange(
			sessionId,
			{
				title: "Rebased pricing",
				summary: "Shifted onto revised hero.",
				commitSha: head3,
				parentSha: head2,
				dependsOnChangeIds: [],
				changeId: c2,
				rebase: true,
			},
			ctx,
		);
		expect(recRebase.updated).toBe(true);
		expect(rpcCalls[1]?.args).toMatchObject({
			p_change_id: c2,
			p_parent_sha: head2,
			p_head_sha: head3,
			p_depends_on_change_ids: [],
			p_patch_manifest: { rebase: true },
		});

		const patchUpdate = await port.stageSurfacePatch(
			sessionId,
			{
				title: "Full redo",
				summary: "Replaced manifest.",
				ops: [{ op: "write_text", path: "brief.md", content: "New" }],
				notePaths: [],
				finishSession: false,
				changeId: c1,
				replaceAll: true,
			},
			ctx,
		);
		expect(patchUpdate.updated).toBe(true);
		expect(rpcCalls[2]?.args).toMatchObject({
			p_change_id: c1,
			p_patch_manifest: { ops: [{ op: "write_text", path: "brief.md", content: "New" }], replaceAll: true },
		});

		const opsUpdate = await port.stageSurfaceOpsAction(
			sessionId,
			{
				title: "Updated email",
				summary: "Shorter copy.",
				actionKind: "inbox.draft_email",
				actionPayload: { body: "Updated" },
				finishSession: false,
				changeId: c1,
			},
			ctx,
		);
		expect(opsUpdate.updated).toBe(true);
		expect(rpcCalls[3]?.args).toMatchObject({ p_change_id: c1, p_depends_on_change_ids: null });

		await port.recordChange(
			sessionId,
			{
				title: "Fresh insert with null deps",
				summary: "Normalizes null deps on insert.",
				commitSha: head2,
				parentSha: baseSha,
				dependsOnChangeIds: null,
			},
			ctx,
		);
		expect(rpcCalls[4]?.args).toMatchObject({ p_depends_on_change_ids: [] });

		const recordedCoding: unknown[] = [];
		const singleCodingTool = createCodingRecordChangeTool(
			sessionId,
			{
				recordChange: vi.fn(async (_sid, req) => {
					recordedCoding.push(req);
					return {
						changeId: req.changeId ?? c2,
						seq: req.changeId ? 1 : 2,
						openChangeCount: req.changeId ? 1 : 2,
						updated: Boolean(req.changeId),
					};
				}),
			},
			{
				openChanges: [
					{
						changeId: c1,
						seq: 1,
						title: "Gør heroen roligere",
						summary: "Initial sketch.",
						kind: "git_range",
						status: "staged",
						parentSha: baseSha,
						headSha: head1,
						affectedPaths: ["index.html"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: null,
						baseFiles: null,
					},
				],
			},
		);
		const autoTargeted = singleCodingTool.parseArguments({
			title: "Superpower-style hero",
			summary: "Revised direction.",
			parentSha: head1,
			commitSha: head2,
		});
		expect(autoTargeted).not.toHaveProperty("dependsOnChangeIds");
		const autoResult = await singleCodingTool.execute(autoTargeted, ctx);
		expect(recordedCoding[0]).toMatchObject({ changeId: c1, parentSha: baseSha, commitSha: head2 });
		expect(JSON.parse(autoResult.kind === "text" ? autoResult.value : "{}")).toMatchObject({
			changeId: c1,
			updated: true,
		});
		const clearDepsUpdate = singleCodingTool.parseArguments({
			title: "Superpower-style hero",
			summary: "Clear deps explicitly.",
			commitSha: head2,
			changeId: c1,
			dependsOnChangeIds: [],
		});
		expect(clearDepsUpdate).toMatchObject({ changeId: c1, dependsOnChangeIds: [] });

		let secondError = "";
		try {
			singleCodingTool.parseArguments({ title: "Another pass", summary: "Ambiguous.", commitSha: head3 });
		} catch (error) {
			secondError = error instanceof Error ? error.message : String(error);
		}
		expect(secondError).toContain(c1);
		expect(secondError).toContain("createNew: true");
		expect(/^[\u0020-\u007e]+$/.test(secondError)).toBe(true);

		const createdSecond = singleCodingTool.parseArguments({
			title: "Footer links",
			summary: "Separate deliverable.",
			parentSha: head2,
			commitSha: head3,
			createNew: true,
		});
		await singleCodingTool.execute(createdSecond, ctx);
		expect(recordedCoding[1]).not.toHaveProperty("changeId");

		const multiCodingTool = createCodingRecordChangeTool(
			sessionId,
			{
				recordChange: vi.fn(async (_sid, req) => ({
					changeId: req.changeId ?? c2,
					seq: 2,
					openChangeCount: 2,
					updated: true,
				})),
			},
			{
				openChanges: [
					{
						changeId: c1,
						seq: 1,
						title: "Hero",
						summary: "",
						kind: "git_range",
						status: "staged",
						parentSha: baseSha,
						headSha: head1,
						affectedPaths: ["index.html"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: null,
						baseFiles: null,
					},
					{
						changeId: c2,
						seq: 2,
						title: "Pricing",
						summary: "",
						kind: "git_range",
						status: "staged",
						parentSha: head1,
						headSha: head2,
						affectedPaths: ["pricing.html"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: null,
						baseFiles: null,
					},
				],
				replyChangeId: c2,
			},
		);
		expect(
			multiCodingTool.parseArguments({ title: "Tighter pricing", summary: "Adjusted.", commitSha: head3 }),
		).toMatchObject({ changeId: c2, parentSha: head1 });
		expect(() =>
			multiCodingTool.parseArguments({
				title: "Bad",
				summary: "Both.",
				commitSha: head3,
				changeId: c1,
				createNew: true,
			}),
		).toThrow(/not both/);
		expect(() =>
			multiCodingTool.parseArguments({ title: "Bad", summary: "Unknown.", commitSha: head3, changeId: unknownId }),
		).toThrow(/not an open change/);
		expect(() =>
			multiCodingTool.parseArguments({
				title: "Tip wrong parent",
				summary: "Needs rebase.",
				parentSha: "9".repeat(40),
				commitSha: head3,
				changeId: c2,
			}),
		).toThrow(/rebase: true/);
		expect(
			multiCodingTool.parseArguments({
				title: "Tip rebased",
				summary: "Rebased.",
				parentSha: "9".repeat(40),
				commitSha: head3,
				changeId: c2,
				rebase: true,
			}),
		).toMatchObject({ changeId: c2, parentSha: "9".repeat(40), rebase: true });

		const nonTipReplyCodingTool = createCodingRecordChangeTool(
			sessionId,
			{
				recordChange: vi.fn(async (_sid, req) => ({
					changeId: req.changeId ?? c1,
					seq: 1,
					openChangeCount: 2,
					updated: true,
				})),
			},
			{
				openChanges: [
					{
						changeId: c1,
						seq: 1,
						title: "Hero",
						summary: "",
						kind: "git_range",
						status: "staged",
						parentSha: baseSha,
						headSha: head1,
						affectedPaths: ["index.html"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: null,
						baseFiles: null,
					},
					{
						changeId: c2,
						seq: 2,
						title: "Pricing",
						summary: "",
						kind: "git_range",
						status: "staged",
						parentSha: head1,
						headSha: head2,
						affectedPaths: ["pricing.html"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: null,
						baseFiles: null,
					},
				],
				replyChangeId: c1,
			},
		);
		expect(() =>
			nonTipReplyCodingTool.parseArguments({
				title: "Make hero blue",
				summary: "Committed on top of pricing.",
				parentSha: head2,
				commitSha: head3,
			}),
		).toThrow(/not the tip change/);
		expect(() =>
			nonTipReplyCodingTool.parseArguments({
				title: "Non-tip without parent",
				summary: "Omitted parent.",
				commitSha: head3,
				changeId: c1,
			}),
		).toThrow(/explicit parentSha/);
		expect(() =>
			nonTipReplyCodingTool.parseArguments({
				title: "Non-tip with wrong parent",
				summary: "Wrong parent.",
				parentSha: head2,
				commitSha: head3,
				changeId: c1,
			}),
		).toThrow(/rebase: true/);
		expect(
			nonTipReplyCodingTool.parseArguments({
				title: "Hero rebased cleanly",
				summary: "Matches original base.",
				parentSha: baseSha,
				commitSha: head3,
				changeId: c1,
			}),
		).toMatchObject({ changeId: c1, parentSha: baseSha, commitSha: head3 });

		const validReportA = JSON.stringify({
			headline: "Report A",
			sections: [{ heading: "Overview", paragraphs: ["Body A"] }],
		});
		const validReportB = JSON.stringify({
			headline: "Report B",
			sections: [{ heading: "Overview", paragraphs: ["Body B"] }],
		});
		const stagedPatches: unknown[] = [];
		const patchTool = createStageSurfacePatchTool(
			sessionId,
			{
				stageSurfacePatch: vi.fn(async (_sid, req) => {
					stagedPatches.push(req);
					return { changeId: req.changeId ?? c2, seq: 1, openChangeCount: 1, updated: Boolean(req.changeId) };
				}),
			},
			undefined,
			{
				openChanges: [
					{
						changeId: c1,
						seq: 1,
						title: "Report A",
						summary: "Draft report.",
						kind: "folder_patch",
						status: "staged",
						parentSha: null,
						headSha: null,
						affectedPaths: ["reports/a.report.json"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: [{ op: "write_text", path: "reports/a.report.json", content: validReportA }],
						baseFiles: { "reports/a.report.json": null },
					},
				],
			},
		);
		const badAddSecondReport = patchTool.parseArguments({
			title: "Add Report B into C1",
			summary: "Should fail single-deliverable check on merged ops.",
			ops: [{ op: "write_text", path: "reports/b.report.json", content: validReportB }],
		});
		await expect(patchTool.prepare!(badAddSecondReport, ctx)).rejects.toThrow(CloudToolRefusal);

		const goodReplaceReport = patchTool.parseArguments({
			title: "Replace with Report B",
			summary: "Replaces whole change.",
			ops: [{ op: "write_text", path: "reports/b.report.json", content: validReportB }],
			replaceAll: true,
		});
		const preparedReplace = await patchTool.prepare!(goodReplaceReport, ctx);
		await patchTool.execute(preparedReplace, ctx);
		expect(stagedPatches[0]).toMatchObject({ changeId: c1, replaceAll: true });

		expect(() =>
			patchTool.parseArguments({
				title: "Invalid",
				summary: "replaceAll with createNew",
				ops: [{ op: "write_text", path: "notes.md", content: "x" }],
				createNew: true,
				replaceAll: true,
			}),
		).toThrow(/replaceAll/);

		const opsTool = createStageSurfaceOpsActionTool(
			sessionId,
			{
				stageSurfaceOpsAction: vi.fn(async (_sid, req) => ({
					changeId: req.changeId ?? c2,
					seq: 1,
					openChangeCount: 2,
					updated: Boolean(req.changeId),
				})),
			},
			{
				openChanges: [
					{
						changeId: c1,
						seq: 1,
						title: "Email Ada",
						summary: "",
						kind: "ops_action",
						status: "staged",
						parentSha: null,
						headSha: null,
						affectedPaths: [],
						previewBaseChangeIds: [],
						actionKind: "inbox.draft_email",
						patchManifest: null,
						baseFiles: null,
					},
					{
						changeId: c2,
						seq: 2,
						title: "Email Bo",
						summary: "",
						kind: "ops_action",
						status: "staged",
						parentSha: null,
						headSha: null,
						affectedPaths: [],
						previewBaseChangeIds: [],
						actionKind: "inbox.draft_email",
						patchManifest: null,
						baseFiles: null,
					},
				],
				replyChangeId: c1,
			},
		);
		expect(
			opsTool.parseArguments({
				title: "Email Ada (short)",
				summary: "Tighter note.",
				actionKind: "inbox.draft_email",
				actionPayload: { body: "Hi Ada" },
			}),
		).toMatchObject({ changeId: c1 });

		const opt1 = randomUUID();
		const opt2 = randomUUID();
		const optionGroupCodingTool = createCodingRecordChangeTool(
			sessionId,
			{
				recordChange: vi.fn(async (_sid, req) => ({
					changeId: req.changeId ?? randomUUID(),
					seq: 1,
					openChangeCount: 2,
					updated: Boolean(req.changeId),
				})),
			},
			{
				openChanges: [
					{
						changeId: opt1,
						seq: 1,
						title: "Calm studio",
						summary: "",
						kind: "git_range",
						status: "staged",
						parentSha: baseSha,
						headSha: head1,
						optionGroupKey: "homepage-direction",
						optionGroupTitle: "Homepage direction",
						affectedPaths: ["index.html"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: null,
						baseFiles: null,
					},
					{
						changeId: opt2,
						seq: 2,
						title: "Bold editorial",
						summary: "",
						kind: "git_range",
						status: "staged",
						parentSha: baseSha,
						headSha: head2,
						optionGroupKey: "homepage-direction",
						optionGroupTitle: "Homepage direction",
						affectedPaths: ["index.html"],
						previewBaseChangeIds: [],
						actionKind: null,
						patchManifest: null,
						baseFiles: null,
					},
				],
				replyChangeId: opt1,
			},
		);
		expect(
			optionGroupCodingTool.parseArguments({
				title: "Calm studio v2",
				summary: "Darker header.",
				parentSha: baseSha,
				commitSha: head3,
			}),
		).toMatchObject({ changeId: opt1, parentSha: baseSha, commitSha: head3 });
		expect(
			optionGroupCodingTool.parseArguments({
				title: "Minimalist third option",
				summary: "New option in group.",
				parentSha: baseSha,
				commitSha: head3,
				optionGroup: "homepage-direction",
			}),
		).not.toHaveProperty("changeId");
		expect(() =>
			optionGroupCodingTool.parseArguments({
				title: "Wrong group",
				summary: "Cannot switch group.",
				parentSha: baseSha,
				commitSha: head3,
				changeId: opt1,
				optionGroup: "other-group",
			}),
		).toThrow(/Cannot change optionGroup/);
	});

	it("validates and forwards optionGroup and optionGroupTitle on coding_record_change and stage_surface_patch", async () => {
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const recordChange = vi.fn().mockResolvedValue({ changeId, seq: 1, openChangeCount: 1 });
		const codingTool = createCodingRecordChangeTool(sessionId, { recordChange });

		expect(() =>
			codingTool.parseArguments({
				title: "Option A",
				summary: "Direction A",
				commitSha: "1".repeat(40),
				optionGroup: "Not Valid",
			}),
		).toThrow();
		expect(() =>
			codingTool.parseArguments({
				title: "Option A",
				summary: "Direction A",
				commitSha: "1".repeat(40),
				optionGroupTitle: "Missing key",
			}),
		).toThrow();

		const parsedCoding = codingTool.parseArguments({
			title: "Broker direction",
			summary: "Editorial homepage concept.",
			commitSha: "2".repeat(40),
			optionGroup: "homepage-direction",
			optionGroupTitle: "Homepage direction",
		});
		await codingTool.execute(parsedCoding, toolContext());
		expect(recordChange).toHaveBeenCalledWith(
			sessionId,
			expect.objectContaining({
				optionGroup: "homepage-direction",
				optionGroupTitle: "Homepage direction",
			}),
			expect.anything(),
		);

		const stageSurfacePatch = vi.fn().mockResolvedValue({ changeId, seq: 1, openChangeCount: 1 });
		const patchTool = createStageSurfacePatchTool(sessionId, { stageSurfacePatch });
		expect(() =>
			patchTool.parseArguments({
				title: "Palette A",
				summary: "Warm palette",
				ops: [{ op: "merge_json", path: "tokens.json", patch: { accent: "#d76f45" } }],
				optionGroupTitle: "Missing key",
			}),
		).toThrow();

		const parsedPatch = patchTool.parseArguments({
			title: "Warm palette",
			summary: "Warm linen tones.",
			ops: [{ op: "merge_json", path: "tokens.json", patch: { accent: "#d76f45" } }],
			optionGroup: "palette",
			optionGroupTitle: "Brand palette",
		});
		await patchTool.execute(parsedPatch, toolContext());
		expect(stageSurfacePatch).toHaveBeenCalledWith(
			sessionId,
			expect.objectContaining({
				optionGroup: "palette",
				optionGroupTitle: "Brand palette",
			}),
			expect.anything(),
		);

		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const port = createControlPlaneSurfaceToolsPort({
			async call(method, args) {
				calls.push({ method, args });
				return { changeId, seq: 1, session: { openChangeCount: 1 } };
			},
		});
		const ctx = toolContext();
		await port.recordChange(
			sessionId,
			{
				title: "Option 1",
				summary: "Standalone page 1",
				commitSha: "3".repeat(40),
				dependsOnChangeIds: [],
				optionGroup: "homepage-direction",
				optionGroupTitle: "Homepage direction",
			},
			ctx,
		);
		await port.stageSurfacePatch(
			sessionId,
			{
				title: "Option 2",
				summary: "Standalone patch 2",
				ops: [{ op: "merge_json", path: "tokens.json", patch: { accent: "#111111" } }],
				notePaths: [],
				optionGroup: "palette",
				optionGroupTitle: "Brand palette",
				finishSession: true,
			},
			ctx,
		);
		expect(calls[0]).toMatchObject({
			method: "qorpera_native_surface_record_change",
			args: {
				p_option_group_key: "homepage-direction",
				p_option_group_title: "Homepage direction",
			},
		});
		expect(calls[1]).toMatchObject({
			method: "qorpera_native_surface_record_change",
			args: {
				p_option_group_key: "palette",
				p_option_group_title: "Brand palette",
			},
		});
	});

	it("forbids in-page concept switchers and emits chosen-option reset hints in buildSurfaceTurnBrief", () => {
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("NEVER embed a concept switcher");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("optionGroup");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("git read-tree --reset -u $BASE");

		const chosenHead = "2".repeat(40);
		const branchTip = "3".repeat(40);
		const brief = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "website",
			surfaceTitle: "Website",
			repositoryKey: "brooks/website",
			briefMarkdown: "Broker homepage.",
			branchHeadSha: branchTip,
			openChanges: [
				{
					id: randomUUID(),
					title: "Option 2: Showcase",
					parentSha: "1".repeat(40),
					headSha: chosenHead,
					optionGroupKey: null,
					optionGroupTitle: null,
				},
			],
		});
		expect(brief).toContain("## Active Staged Changes on This Session");
		expect(brief).toContain(`git read-tree --reset -u ${chosenHead}`);
		expect(brief).toContain("Option 2: Showcase");

		const mainSha = "4".repeat(40);
		const emptyOpenBrief = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "website",
			surfaceTitle: "Website",
			repositoryKey: "brooks/website",
			briefMarkdown: "Broker homepage.",
			mainSha,
			branchHeadSha: branchTip,
			openChanges: [],
		});
		expect(emptyOpenBrief).toContain("## Session Branch Sync");
		expect(emptyOpenBrief).toContain(`git log ${mainSha}..HEAD`);
		expect(emptyOpenBrief).toContain(`git reset --hard ${mainSha}`);
		expect(emptyOpenBrief).not.toContain(`git read-tree --reset -u ${mainSha}`);
		expect(emptyOpenBrief).toContain(`parentSha: "${mainSha}"`);

		const syncedBrief = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "website",
			surfaceTitle: "Website",
			repositoryKey: "brooks/website",
			briefMarkdown: "Broker homepage.",
			mainSha,
			branchHeadSha: mainSha,
			openChanges: [],
		});
		expect(syncedBrief).not.toContain("## Session Branch Sync");
	});

	it("surfaces discarded changes across code_repo and folder turns and relays discarded-parent refusals", async () => {
		const mainSha = "1".repeat(40);
		const c1Head = "2".repeat(40);
		const c2Head = "3".repeat(40);
		const c1Id = randomUUID();
		const c2Id = randomUUID();

		const parsedOpen = parseSurfaceTurnOpenChanges([
			{
				id: c1Id,
				seq: 1,
				title: "Tre retninger for Thetabands hjemmeside",
				summary: "Three calm homepage directions.",
				status: "staged",
				parentSha: mainSha,
				headSha: c1Head,
				affectedPaths: ["index.html", "styles.css"],
				optionGroupKey: null,
				optionGroupTitle: null,
			},
		]);
		const parsedResolved = parseSurfaceTurnResolvedChanges([
			{
				id: c2Id,
				seq: 2,
				title: "Superpower-inspired sketches",
				summary: "Three bold dark-hero variations.",
				status: "discarded",
				parentSha: c1Head,
				headSha: c2Head,
				affectedPaths: ["index.html", "hero.css"],
				optionGroupKey: null,
				optionGroupTitle: null,
				discardedByExploration: false,
				resolvedAt: "2026-11-25T03:30:00Z",
			},
			{
				id: randomUUID(),
				title: "Ignored status",
				status: "staged",
				parentSha: null,
				headSha: null,
				optionGroupKey: null,
				optionGroupTitle: null,
			},
		]);
		expect(parsedOpen).toHaveLength(1);
		expect(parsedOpen[0]?.seq).toBe(1);
		expect(parsedOpen[0]?.affectedPaths).toEqual(["index.html", "styles.css"]);
		expect(parsedResolved).toHaveLength(1);
		expect(parsedResolved[0]?.status).toBe("discarded");

		const briefAfterTipDiscard = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "website",
			surfaceTitle: "Hjemmeside",
			repositoryKey: "thetaband/website",
			briefMarkdown: "Danish presale site.",
			mainSha,
			branchHeadSha: c2Head,
			openChanges: parsedOpen,
			resolvedChanges: parsedResolved,
		});
		expect(briefAfterTipDiscard).toContain("## Active Staged Changes on This Session");
		expect(briefAfterTipDiscard).toContain(`#1 \`${c1Id}\` — Tre retninger for Thetabands hjemmeside`);
		expect(briefAfterTipDiscard).toContain("IMPORTANT — Worktree Out of Sync");
		expect(briefAfterTipDiscard).toContain('"Superpower-inspired sketches"');
		expect(briefAfterTipDiscard).toContain(`git read-tree --reset -u ${c1Head}`);
		expect(briefAfterTipDiscard).toContain("(or its `changeId` to update it in place)");
		expect(briefAfterTipDiscard).toContain("## Resolved Changes on This Session");
		expect(briefAfterTipDiscard).toContain("#2 Superpower-inspired sketches — discarded by member");
		expect(briefAfterTipDiscard).toContain("removed by the member and are no longer staged or shown in Preview");

		const briefAfterOptionDiscard = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "website",
			surfaceTitle: "Hjemmeside",
			repositoryKey: "thetaband/website",
			briefMarkdown: "Danish presale site.",
			mainSha,
			branchHeadSha: c2Head,
			openChanges: [
				{
					id: c1Id,
					seq: 1,
					title: "Editorial direction",
					parentSha: mainSha,
					headSha: c1Head,
					optionGroupKey: "homepage-direction",
					optionGroupTitle: "Homepage direction",
				},
			],
			resolvedChanges: [
				{
					id: c2Id,
					seq: 2,
					title: "Bold direction",
					status: "discarded",
					parentSha: mainSha,
					headSha: c2Head,
					optionGroupKey: "homepage-direction",
					optionGroupTitle: "Homepage direction",
					discardedByExploration: false,
				},
			],
		});
		expect(briefAfterOptionDiscard).toContain("IMPORTANT — Worktree Out of Sync");
		expect(briefAfterOptionDiscard).toContain(`git read-tree --reset -u ${mainSha}`);
		expect(briefAfterOptionDiscard).toContain(`optionGroup: "homepage-direction"`);
		expect(briefAfterOptionDiscard).toContain(`parentSha: "${mainSha}"`);
		expect(briefAfterOptionDiscard).not.toContain(`git read-tree --reset -u ${c1Head}`);

		const briefAfterBaseDiscard = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "website",
			surfaceTitle: "Hjemmeside",
			repositoryKey: "thetaband/website",
			briefMarkdown: "Danish presale site.",
			mainSha,
			branchHeadSha: c2Head,
			openChanges: [
				{
					id: c2Id,
					seq: 2,
					title: "Superpower-inspired sketches",
					parentSha: c1Head,
					headSha: c2Head,
					optionGroupKey: null,
					optionGroupTitle: null,
				},
			],
			resolvedChanges: [
				{
					id: c1Id,
					seq: 1,
					title: "Tre retninger for Thetabands hjemmeside",
					status: "discarded",
					parentSha: mainSha,
					headSha: c1Head,
					optionGroupKey: null,
					optionGroupTitle: null,
					discardedByExploration: false,
				},
			],
		});
		expect(briefAfterBaseDiscard).toContain("was originally branched from discarded change");
		expect(briefAfterBaseDiscard).toContain("Tre retninger for Thetabands hjemmeside");

		const briefAllDiscarded = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "website",
			surfaceTitle: "Hjemmeside",
			repositoryKey: "thetaband/website",
			briefMarkdown: "Danish presale site.",
			mainSha,
			branchHeadSha: c2Head,
			openChanges: [],
			resolvedChanges: parsedResolved,
		});
		expect(briefAllDiscarded).toContain("## Resolved Changes on This Session");
		expect(briefAllDiscarded).toContain("## Session Branch Sync");
		expect(briefAllDiscarded).toContain("prior changes on this session were discarded by the member");
		expect(briefAllDiscarded).toContain(`git reset --hard ${mainSha}`);

		const folderBrief = buildSurfaceTurnBrief({
			sessionId: randomUUID(),
			surfaceSlug: "identity",
			surfaceTitle: "Identity",
			sourceKind: "folder",
			folderRoot: "identity",
			briefMarkdown: "Brand identity.",
			openChanges: [
				{
					id: c1Id,
					seq: 1,
					title: "Updated brief",
					summary: "Sharper positioning.",
					parentSha: null,
					headSha: null,
					affectedPaths: ["brief.md"],
					optionGroupKey: null,
					optionGroupTitle: null,
				},
			],
			resolvedChanges: [
				{
					id: c2Id,
					seq: 2,
					title: "Experimental voice",
					summary: "Playful draft.",
					status: "discarded",
					parentSha: null,
					headSha: null,
					affectedPaths: ["voice.md"],
					optionGroupKey: null,
					optionGroupTitle: null,
					discardedByExploration: false,
				},
			],
		});
		expect(folderBrief).toContain("## Active Staged Changes on This Session");
		expect(folderBrief).toContain(`#1 \`${c1Id}\` — Updated brief`);
		expect(folderBrief).toContain("## Resolved Changes on This Session");
		expect(folderBrief).toContain("#2 Experimental voice — discarded by member");
		expect(folderBrief).not.toContain("git read-tree");

		const refusalTool = createCodingRecordChangeTool(randomUUID(), {
			recordChange: async () => {
				throw new CloudControlRpcRefused(
					"22023",
					`parentSha ${c2Head} belongs to discarded change "Superpower-inspired sketches".`,
				);
			},
		});
		await expect(
			refusalTool.execute(
				refusalTool.parseArguments({
					title: "Hero tweak",
					summary: "Adjusted spacing.",
					parentSha: c2Head,
					commitSha: "4".repeat(40),
				}),
				toolContext(),
			),
		).rejects.toThrow(CloudToolRefusal);
	});

	it("steers an existing Surface session via steer_surface_session with optional changeId", async () => {
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const steerSurfaceSession = vi.fn().mockResolvedValue({
			sessionId,
			state: "queued",
		});
		const tool = createSteerSurfaceSessionTool({ steerSurfaceSession });

		const parsed = tool.parseArguments({
			sessionId,
			message: "Feature the annual plan first and drop the footnote.",
			changeId,
		});
		const result = await tool.execute(parsed, toolContext());
		expect(steerSurfaceSession).toHaveBeenCalledWith(
			{
				sessionId,
				message: "Feature the annual plan first and drop the footnote.",
				changeId,
			},
			expect.any(Object),
		);
		expect(JSON.parse(result.value as string)).toMatchObject({
			schema: "qorpera.surface-session-steered/v1",
			sessionId,
			state: "queued",
		});

		const withoutChange = tool.parseArguments({ sessionId, message: "Keep going." });
		expect(withoutChange).toEqual({ sessionId, message: "Keep going.", changeId: null });

		expect(() => tool.parseArguments({ sessionId: "not-a-uuid", message: "Hi" })).toThrow();
		expect(() => tool.parseArguments({ sessionId, message: "   " })).toThrow();
		expect(() => tool.parseArguments({ sessionId, message: "Hi", changeId: "bad" })).toThrow();
	});

	it("forwards supersedeKey, affectedPaths, and diffStats across Surface tools and parses git numstat output", async () => {
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
		const port = createControlPlaneSurfaceToolsPort({
			async call(method, args) {
				calls.push({ method, args });
				if (method === "qorpera_native_surface_start_session") {
					return { sessionId, explorationId: null };
				}
				return { changeId, seq: 1, openChangeCount: 1 };
			},
		});

		const startTool = createStartSurfaceSessionTool(port);
		const startParsed = startTool.parseArguments({
			surfaceId,
			prompt: "Refresh from upstream main",
			title: "Sync upstream",
			supersedeKey: "GitHub-Sync",
		});
		await startTool.execute(startParsed, toolContext());
		expect(calls[0]).toMatchObject({
			method: "qorpera_native_surface_start_session",
			args: { p_supersede_key: "github-sync" },
		});
		expect(() => startTool.parseArguments({ surfaceId, prompt: "Bad key", supersedeKey: "bad key!" })).toThrow();

		await port.recordChange(
			sessionId,
			{
				title: "Sync commit",
				summary: "Updated app source.",
				parentSha: "1".repeat(40),
				commitSha: "2".repeat(40),
				affectedPaths: ["src/app.tsx", "src/nav.tsx"],
				diffStats: { filesChanged: 2, additions: 14, deletions: 3 },
				supersedeKey: "github-sync",
			},
			toolContext(),
		);
		expect(calls[1]).toMatchObject({
			method: "qorpera_native_surface_record_change",
			args: {
				p_affected_paths: ["src/app.tsx", "src/nav.tsx"],
				p_diff_stats: { filesChanged: 2, additions: 14, deletions: 3 },
				p_supersede_key: "github-sync",
			},
		});

		const patchTool = createStageSurfacePatchTool(sessionId, port);
		const patchParsed = patchTool.parseArguments({
			title: "Refresh metrics",
			summary: "Updated KPIs.",
			ops: [{ op: "write_text", path: "metrics.json", content: "{}" }],
			supersedeKey: "daily-metrics",
		});
		await patchTool.execute(patchParsed, toolContext());
		expect(calls[2]).toMatchObject({
			method: "qorpera_native_surface_record_change",
			args: { p_supersede_key: "daily-metrics" },
		});

		const rawNumstat = "12\t3\tsrc/app.tsx\x00-\t-\tassets/logo.png\x004\t1\tdir/file\twith\ttab.ts\x00";
		expect(parseGitNumstatZ(rawNumstat)).toEqual({
			affectedPaths: ["src/app.tsx", "assets/logo.png", "dir/file\twith\ttab.ts"],
			diffStats: { filesChanged: 3, additions: 16, deletions: 4 },
		});
		expect(parseGitNumstatZ("")).toEqual({
			affectedPaths: [],
			diffStats: { filesChanged: 0, additions: 0, deletions: 0 },
		});
		const overCap = Array.from({ length: 505 }, (_, i) => `1\t0\tf-${i}.ts`).join("\0");
		const capped = parseGitNumstatZ(overCap);
		expect(capped?.affectedPaths).toHaveLength(500);
		expect(capped?.diffStats).toEqual({ filesChanged: 505, additions: 505, deletions: 0 });

		const encoded = Buffer.from(rawNumstat, "utf8").toString("base64");
		expect(decodeChangeDiffOutput(`__QORPERA_CHANGE_DIFF_V1__:${encoded}:__QORPERA_CHANGE_DIFF_END__\n`)).toEqual({
			affectedPaths: ["src/app.tsx", "assets/logo.png", "dir/file\twith\ttab.ts"],
			diffStats: { filesChanged: 3, additions: 16, deletions: 4 },
		});
		expect(decodeChangeDiffOutput("__QORPERA_CHANGE_DIFF_V1__::__QORPERA_CHANGE_DIFF_END__\n")).toEqual({
			affectedPaths: [],
			diffStats: { filesChanged: 0, additions: 0, deletions: 0 },
		});
		expect(decodeChangeDiffOutput(`__QORPERA_CHANGE_DIFF_V1__:${encoded.slice(0, 12)}`)).toBeNull();
		expect(decodeChangeDiffOutput("__QORPERA_CHANGE_DIFF_V1__:not*base64:__QORPERA_CHANGE_DIFF_END__\n")).toBeNull();
	});
});
