import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { cloudActionEffect, cloudActionReviewMandate } from "../src/cloud-action-review.ts";
import type { CloudAgentSendReceipt } from "../src/cloud-agent-mouth.ts";
import type { CloudCompanyPathControl } from "../src/cloud-company-path-gateway.ts";
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
} from "../src/cloud-surface-tools.ts";
import { buildSurfaceTurnBrief, SURFACE_STAGED_CODING_INSTRUCTIONS } from "../src/cloud-surface-turn-context.ts";
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
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("coding_record_change");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("direct live projection");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("toggled on or off simultaneously in Preview");
		expect(SURFACE_STAGED_CODING_INSTRUCTIONS).toContain("atomic, self-contained, and conflict-minimizing");
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
		expect(identitySelf).toContain("`identity/voice.md` and `identity/brief.md`");
		expect(identitySelf).toContain(
			"do not hand-edit `identity/tokens.css` or create standalone HTML/CSS showcase pages",
		);
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
			method: "qorpera_native_surface_propose",
			args: {
				p_profile_id: ctx.companyId,
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
		expect(surfaceInstructions).not.toContain("hire_team");
		expect(surfaceInstructions).not.toContain("vision-draft.md");
		expect(surfaceInstructions).not.toContain("company-plan.md");
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
		expect(surfaceMandate).toContain("vision.md and reading.md");
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
				"strategy",
				"reports",
			],
			files: {
				"identity/tokens.json": '{"accent":"#d76f45"}',
				"QorperaOS/surfaces/website/notes/existing.md": "# Existing note\n",
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
				return (name: string, args: JsonValue) =>
					getTool(name).execute(getTool(name).parseArguments(args), f.context);
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
				allowedRoots: ["identity", "QorperaOS/surfaces/identity"],
			});
			const workerOk = await workerCaller("company_write", {
				path: "identity/palette.json",
				operationKey: "worker-write-ok",
				expectedVersion: null,
				text: '{"paper":"#f7f5f2"}',
			});
			expect(JSON.parse(String(workerOk.value)).state).toBe("applied");

			await expect(
				workerCaller("company_write", {
					path: "code/website/index.html",
					operationKey: "worker-write-outside",
					expectedVersion: null,
					text: "<h1>Nope</h1>",
				}),
			).rejects.toThrow(CloudToolRefusal);
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

			const existingIdentity = await f.folder.read("identity/tokens.json", new AbortController().signal);
			expect(existingIdentity.entry).not.toBeNull();
			const workerEditOk = await workerCaller("company_edit", {
				path: "identity/tokens.json",
				operationKey: "worker-edit-ok",
				expectedVersion: existingIdentity.entry!.version,
				oldText: "#d76f45",
				newText: "#c85a32",
			});
			expect(JSON.parse(String(workerEditOk.value)).state).toBe("applied");

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
			]) {
				expect(allOffered.has(stripped)).toBe(false);
			}

			const instructions = evidence.threadParameters.developerInstructions;
			expect(instructions).toContain("# Surfaces & Identity");
			expect(instructions).toContain("Each Surface is a direct live projection");
			expect(instructions).toContain("senses.surfaces");
			expect(instructions).not.toContain("hire_team");
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

			const folderFiles = new Map<string, string>([["identity/tokens.json", '{"accent":"#1f2937"}']]);
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
					dynamicTools: { tools: { name: string }[] }[];
				};
			};
			const offeredNames = evidence.threadParameters.dynamicTools[0].tools.map((tool) => tool.name);
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
});
