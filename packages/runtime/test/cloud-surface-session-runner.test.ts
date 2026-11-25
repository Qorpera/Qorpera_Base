import { randomUUID } from "node:crypto";
import type { SurfaceFolderContents } from "@qorpera/cloud-client/surface-folder-files";
import { describeSurfaceBlocks, starterSurfaceLayout } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import type { CloudNativeCodingDriver, CloudNativeCodingTurnContext } from "../src/cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "../src/cloud-native-provider-host.ts";
import { type CloudToolContext, CloudToolRefusal } from "../src/cloud-native-tool-boundary.ts";
import {
	createControlPlaneSessionCompletionPort,
	createControlPlaneSessionLeaseRenewalPort,
	loadSurfaceIdentityContext,
	loadSurfaceSharedAssets,
	runSurfaceSessionTurn,
	type SurfaceFolderTextReader,
} from "../src/cloud-surface-session-runner.ts";
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

function toolContext(companyId: string = randomUUID()): CloudToolContext {
	return {
		companyId,
		runId: randomUUID(),
		callId: "call_1",
		argumentSha256: "a".repeat(64),
		signal: new AbortController().signal,
	};
}

function makeMemoryReader(files: Record<string, string | Error>): SurfaceFolderTextReader {
	return {
		async readText(path) {
			const hit = files[path];
			if (hit instanceof Error) throw hit;
			if (hit === undefined) return null;
			return { text: hit };
		},
	};
}

describe("cloud surface session runner", () => {
	it("loads global Identity assets best-effort and returns null when empty or missing", async () => {
		const signal = new AbortController().signal;
		const fullReader = makeMemoryReader({
			"identity/brief.md": "  Calm Nordic editorial brand.  ",
			"identity/voice.md": "Warm, direct Danish without hype.",
			"identity/tokens.json": '{"accent":"#d76f45","paper":"#f7f5f2"}',
		});
		const loaded = await loadSurfaceIdentityContext(fullReader, signal);
		expect(loaded).toEqual({
			briefMarkdown: "Calm Nordic editorial brand.",
			voiceSummary: "Warm, direct Danish without hype.",
			tokensJson: '{"accent":"#d76f45","paper":"#f7f5f2"}',
		});

		const partialReader = makeMemoryReader({
			"identity/brief.md": "Quiet product philosophy.",
			"identity/voice.md": new Error("unreadable transient error"),
			"identity/tokens.json": "   ",
		});
		const partial = await loadSurfaceIdentityContext(partialReader, signal);
		expect(partial).toEqual({
			briefMarkdown: "Quiet product philosophy.",
			voiceSummary: null,
			tokensJson: null,
		});

		const emptyReader = makeMemoryReader({
			"identity/brief.md": "   \n  ",
		});
		expect(await loadSurfaceIdentityContext(emptyReader, signal)).toBeNull();
	});

	it("runs folder (Studio) sessions with Identity propagation, stage_surface_patch, and surface_worker confinement", async () => {
		const f = await folderWriterFixture({
			folders: [
				"identity",
				"product",
				"strategy",
				"QorperaOS/surfaces",
				"QorperaOS/surfaces/product-studio",
				"QorperaOS/surfaces/product-studio/notes",
			],
			files: {
				"identity/brief.md": "Quiet Scandinavian hardware brand.",
				"identity/voice.md": "Clear and calm.",
				"identity/tokens.json": '{"accent":"#d76f45"}',
				"QorperaOS/surfaces/product-studio/brief.md": "Showcase tactile headband ergonomics.",
				"product/specs.json": '{"overview":{"weight":"38 g"}}',
			},
		});
		try {
			const sessionId = randomUUID();
			const surfaceId = randomUUID();
			const changeId = randomUUID();
			const stageSurfacePatch = vi.fn().mockResolvedValue({ changeId, seq: 1, openChangeCount: 1 });
			const completeSessionTurn = vi.fn().mockResolvedValue(undefined);

			const result = await runSurfaceSessionTurn(
				{
					sessionId,
					surfaceId,
					companyId: f.identity.companyId,
					surfaceSlug: "product-studio",
					surfaceTitle: "Product Studio",
					sourceKind: "folder",
					folderRoot: "product/",
					explorationVariantLabel: "Warm Linen",
					prompt: "Draft two tactile packaging directions.",
				},
				{
					folderToolsContext: {
						folder: f.folder,
						operations: f.operations(),
						identity: f.identity,
					},
					surfaceTools: { stageSurfacePatch },
					completeSessionTurn,
					async executeTurn(req) {
						expect(req.mode).toBe("folder");
						expect(req.identityContext).toMatchObject({
							briefMarkdown: "Quiet Scandinavian hardware brand.",
							voiceSummary: "Clear and calm.",
							tokensJson: '{"accent":"#d76f45"}',
						});
						expect(req.turnBrief).toContain("## Global Company Identity");
						expect(req.turnBrief).toContain("Folder root: product");
						expect(req.turnBrief).toContain("Exploration direction: Warm Linen");
						expect(req.turnBrief).toContain("## Exploration Direction: Warm Linen");
						expect(req.turnBrief).toContain("Showcase tactile headband ergonomics.");
						expect(req.writableRoots).toEqual(["QorperaOS/surfaces/product-studio/notes"]);
						expect(req.stagedRoots).toEqual(["product"]);
						expect(req.instructions).toContain(
							"Change files in product/ only with stage_surface_patch (write_text, merge_json, delete; paths relative to product/)",
						);
						expect(req.instructions).toContain(
							"Direct file writes are for notes under QorperaOS/surfaces/product-studio/notes/ only;",
						);
						expect(req.instructions).not.toContain("strictly confined");

						const writeTool = req.tools.find((t) => t.name === "company_write")!;
						const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
						expect(writeTool).toBeDefined();
						expect(patchTool).toBeDefined();

						await expect(
							writeTool.execute(
								writeTool.parseArguments({
									path: "product/box.md",
									operationKey: "studio-staged-only-1",
									expectedVersion: null,
									text: "# Linen Box",
								}),
								f.context,
							),
						).rejects.toSatisfy(
							(error: unknown) =>
								error instanceof CloudToolRefusal &&
								error.message.includes("is in this Studio's folder product/") &&
								error.message.includes("Stage this change with stage_surface_patch"),
						);
						const readTool = req.tools.find((t) => t.name === "company_read")!;
						const studioRead = await readTool.execute(
							readTool.parseArguments({ path: "product/specs.json" }),
							f.context,
						);
						expect(String(studioRead.value)).toContain("38 g");

						const allowedNote = await writeTool.execute(
							writeTool.parseArguments({
								path: "QorperaOS/surfaces/product-studio/notes/rationale.md",
								operationKey: "studio-note-1",
								expectedVersion: null,
								text: "# Rationale",
							}),
							f.context,
						);
						expect(JSON.parse(String(allowedNote.value)).state).toBe("applied");

						await expect(
							writeTool.execute(
								writeTool.parseArguments({
									path: "strategy/plan.md",
									operationKey: "studio-blocked-1",
									expectedVersion: null,
									text: "nope",
								}),
								f.context,
							),
						).rejects.toThrow(CloudToolRefusal);

						await expect(
							writeTool.execute(
								writeTool.parseArguments({
									path: "identity/override.md",
									operationKey: "studio-blocked-2",
									expectedVersion: null,
									text: "nope",
								}),
								f.context,
							),
						).rejects.toThrow(CloudToolRefusal);

						await patchTool.execute(
							patchTool.parseArguments({
								title: "Warm linen packaging spec",
								summary: "Adds packaging layout spec and notes.",
								ops: [{ op: "write_text", path: "packaging.md", content: "# Warm Linen" }],
								notePaths: ["QorperaOS/surfaces/product-studio/notes/rationale.md"],
								finishSession: true,
							}),
							f.context,
						);

						return {
							state: "ready",
							replyText: "Staged warm linen packaging direction.",
							notePaths: ["QorperaOS/surfaces/product-studio/notes/rationale.md"],
						};
					},
				},
			);

			expect(stageSurfacePatch).toHaveBeenCalledTimes(1);
			expect(completeSessionTurn).toHaveBeenCalledWith(
				{
					sessionId,
					companyId: f.identity.companyId,
					state: "ready",
					replyText: "Staged warm linen packaging direction.",
					question: null,
					notePaths: ["QorperaOS/surfaces/product-studio/notes/rationale.md"],
					branchHeadSha: null,
				},
				expect.any(AbortSignal),
			);
			expect(result).toMatchObject({
				sessionId,
				sourceKind: "folder",
				state: "ready",
				identityLoaded: true,
				error: null,
			});
		} finally {
			f.run.close();
		}
	});

	it("skips redundant global Identity injection when running the Identity surface itself", async () => {
		const sessionId = randomUUID();
		const completeSessionTurn = vi.fn().mockResolvedValue(undefined);
		const reader = makeMemoryReader({
			"identity/brief.md": "Seed brief.",
			"identity/tokens.json": '{"accent":"#d76f45"}',
		});

		const result = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Explore 3 brand directions.",
			},
			{
				folder: reader,
				surfaceTools: {
					stageSurfacePatch: vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 1, openChangeCount: 1 }),
				},
				completeSessionTurn,
				async executeTurn(req) {
					expect(req.identityContext).toBeNull();
					expect(req.turnBrief).not.toContain("## Global Company Identity");
					expect(req.writableRoots).toEqual(["QorperaOS/surfaces/identity/notes"]);
					expect(req.stagedRoots).toEqual(["identity"]);
					return { state: "ready", replyText: "Identity direction staged." };
				},
			},
		);

		expect(result.identityLoaded).toBe(false);
		expect(result.state).toBe("ready");
	});

	it("runs native_ops sessions with stage_surface_ops_action and read-only folder access", async () => {
		const f = await folderWriterFixture({
			folders: ["identity"],
			files: {
				"identity/voice.md": "Polite, concise Danish.",
			},
		});
		try {
			const sessionId = randomUUID();
			const changeId = randomUUID();
			const stageSurfaceOpsAction = vi.fn().mockResolvedValue({ changeId, seq: 1, openChangeCount: 1 });
			const completeSessionTurn = vi.fn().mockResolvedValue(undefined);

			const result = await runSurfaceSessionTurn(
				{
					sessionId,
					surfaceId: randomUUID(),
					companyId: f.identity.companyId,
					surfaceSlug: "inbox",
					surfaceTitle: "Inbox",
					sourceKind: "native_ops",
					prompt: "Draft a calm reply to supplier inquiry.",
				},
				{
					folderToolsContext: {
						folder: f.folder,
						operations: f.operations(),
						identity: f.identity,
					},
					surfaceTools: { stageSurfaceOpsAction },
					completeSessionTurn,
					async executeTurn(req) {
						expect(req.mode).toBe("native_ops");
						expect(req.turnBrief).toContain("## Global Company Identity");
						expect(req.turnBrief).toContain("Polite, concise Danish.");
						const toolNames = req.tools.map((tool) => tool.name).sort();
						expect(toolNames).toEqual(["company_list", "company_read", "stage_surface_ops_action"]);

						const opsTool = req.tools.find((t) => t.name === "stage_surface_ops_action")!;
						await opsTool.execute(
							opsTool.parseArguments({
								title: "Reply to supplier",
								summary: "Asks for sample lead time.",
								actionKind: "inbox.draft_email",
								actionPayload: { to: "supplier@example.dk", subject: "Leveringstid" },
								finishSession: false,
							}),
							toolContext(f.identity.companyId),
						);

						return {
							state: "needs_input",
							replyText: "Should I include the Q3 volume estimate?",
							question: {
								text: "Include Q3 volume estimate in the draft?",
								options: ["Yes, include 500 units", "No, ask lead time only"],
							},
						};
					},
				},
			);

			expect(stageSurfaceOpsAction).toHaveBeenCalledTimes(1);
			expect(completeSessionTurn).toHaveBeenCalledWith(
				{
					sessionId,
					companyId: f.identity.companyId,
					state: "needs_input",
					replyText: "Should I include the Q3 volume estimate?",
					question: {
						text: "Include Q3 volume estimate in the draft?",
						options: ["Yes, include 500 units", "No, ask lead time only"],
					},
					notePaths: null,
					branchHeadSha: null,
				},
				expect.any(AbortSignal),
			);
			expect(result.state).toBe("needs_input");
			expect(result.identityLoaded).toBe(true);
		} finally {
			f.run.close();
		}
	});

	it("runs code_repo sessions with global Identity propagation, Point-to-Change extraction, and branchHeadSha completion", async () => {
		const sessionId = randomUUID();
		const headSha = "a".repeat(40);
		const recordChange = vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 1, openChangeCount: 1 });
		const completeSessionTurn = vi.fn().mockResolvedValue(undefined);
		const reader = makeMemoryReader({
			"identity/brief.md": "Nordic daylight minimalism.",
			"identity/tokens.json": '{"accent":"#d76f45","paper":"#f7f5f2"}',
			"QorperaOS/surfaces/website/brief.md": "Editorial homepage with Danish preorder flow.",
		});

		const result = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "website",
				surfaceTitle: "Website",
				sourceKind: "code_repo",
				repositoryKey: "surfaces/website",
				explorationVariantLabel: "Aftenlys",
				prompt: "Tighten hero spacing and CTA contrast.",
				originKind: "point_to_change",
				originRef: {
					target: {
						route: "/",
						selector: "section.hero > button.cta",
						textSnippet: "Forudbestil nu",
						tagName: "button",
						componentHint: "HeroCta",
						boundingBox: { x: 40, y: 120, width: 180, height: 44 },
						viewport: { width: 1440, height: 900 },
					},
				},
				conflictPaths: ["src/components/Hero.tsx"],
			},
			{
				folder: reader,
				surfaceTools: { recordChange },
				completeSessionTurn,
				async executeCodeRepoTurn(req) {
					expect(req.binding.identityContext).toEqual({
						briefMarkdown: "Nordic daylight minimalism.",
						voiceSummary: null,
						tokensJson: '{"accent":"#d76f45","paper":"#f7f5f2"}',
					});
					expect(req.binding.repositoryKey).toBe("surfaces/website");
					expect(req.binding.pointToChangeTarget?.selector).toBe("section.hero > button.cta");
					expect(req.binding.conflictPaths).toEqual(["src/components/Hero.tsx"]);
					expect(req.turnBrief).toContain("Repository: code/surfaces/website");
					expect(req.turnBrief).toContain("## Global Company Identity");
					expect(req.turnBrief).toContain("## Surface Brief (QorperaOS/surfaces/website/brief.md)");
					expect(req.turnBrief).toContain("## Point-to-Change Target");
					expect(req.turnBrief).toContain("## Conflict Reconciliation");
					expect(req.instructions).toContain("coding_record_change");

					await req.binding.recordChange(
						sessionId,
						{
							title: "Tighten hero CTA",
							summary: "Increases contrast and spacing.",
							commitSha: headSha,
							dependsOnChangeIds: [],
						},
						toolContext(),
					);

					return {
						state: "ready",
						replyText: "Staged hero CTA contrast update.",
						branchHeadSha: headSha,
					};
				},
			},
		);

		expect(recordChange).toHaveBeenCalledTimes(1);
		expect(completeSessionTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId,
				state: "ready",
				replyText: "Staged hero CTA contrast update.",
				question: null,
				notePaths: null,
				branchHeadSha: headSha,
			}),
			expect.any(AbortSignal),
		);
		expect(result).toMatchObject({
			sessionId,
			sourceKind: "code_repo",
			state: "ready",
			identityLoaded: true,
			branchHeadSha: headSha,
			error: null,
		});
	});

	it("supports delegating code_repo turns to a CloudNativeCodingDriver with surfaceSession attached", async () => {
		const sessionId = randomUUID();
		const headSha = "b".repeat(40);
		const driverExecute = vi.fn<CloudNativeCodingDriver["execute"]>().mockResolvedValue({
			providerSessionId: "prov_1",
			delivery: { messageCount: 0, finalMessageId: null },
		});
		const completeSessionTurn = vi.fn().mockResolvedValue(undefined);

		const result = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "web-app",
				surfaceTitle: "Web App",
				sourceKind: "code_repo",
				repositoryKey: "surfaces/web-app",
				prompt: "Build onboarding step.",
			},
			{
				folder: makeMemoryReader({ "identity/brief.md": "Sharp, calm UI." }),
				surfaceTools: {
					recordChange: vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 1, openChangeCount: 1 }),
				},
				codingDriver: {
					driver: { execute: driverExecute },
					async prepareRequest() {
						return {
							request: {} as NativeCompanyExecutionRequest,
							identityRoot: "/tmp/id",
							context: {} as Omit<CloudNativeCodingTurnContext, "surfaceSession">,
							extractOutcome: () => ({ state: "ready", branchHeadSha: headSha, replyText: "Driver finished." }),
						};
					},
				},
				completeSessionTurn,
			},
		);

		expect(driverExecute).toHaveBeenCalledTimes(1);
		const passedContext = driverExecute.mock.calls[0]?.[3];
		expect(passedContext?.surfaceSession?.sessionId).toBe(sessionId);
		expect(passedContext?.surfaceSession?.identityContext?.briefMarkdown).toBe("Sharp, calm UI.");
		expect(completeSessionTurn).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId, state: "ready", branchHeadSha: headSha }),
			expect.any(AbortSignal),
		);
		expect(result.state).toBe("ready");
	});

	it("completes sessions cleanly as failed when turn execution throws so no session stalls in running", async () => {
		const sessionId = randomUUID();
		const completeSessionTurn = vi.fn().mockResolvedValue(undefined);

		const result = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "website",
				surfaceTitle: "Website",
				sourceKind: "code_repo",
				repositoryKey: "surfaces/website",
				prompt: "Update pricing.",
			},
			{
				surfaceTools: {
					recordChange: vi.fn(),
				},
				completeSessionTurn,
				async executeCodeRepoTurn() {
					throw new Error("Coding VM disconnected mid-build");
				},
			},
		);

		expect(result.state).toBe("failed");
		expect(result.error).toContain("Coding VM disconnected mid-build");
		expect(completeSessionTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId,
				state: "failed",
				replyText: "The surface session could not complete: Coding VM disconnected mid-build",
				question: null,
				notePaths: null,
				branchHeadSha: null,
			}),
			expect.any(AbortSignal),
		);
	});

	it("bridges completeSessionTurn onto qorpera_native_surface_complete_turn via createControlPlaneSessionCompletionPort", async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const profileId = randomUUID();
		const port = createControlPlaneSessionCompletionPort(
			{
				async call(method, args) {
					calls.push({ method, args });
					return {};
				},
			},
			profileId,
		);
		const sessionId = randomUUID();
		await port.completeSessionTurn(
			{
				sessionId,
				state: "ready",
				replyText: "Done",
				question: null,
				notePaths: ["QorperaOS/surfaces/website/notes/a.md"],
				branchHeadSha: "c".repeat(40),
			},
			new AbortController().signal,
		);
		expect(calls).toEqual([
			{
				method: "qorpera_native_surface_complete_turn",
				args: {
					p_profile_id: profileId,
					p_session_id: sessionId,
					p_state: "ready",
					p_reply_text: "Done",
					p_question: null,
					p_note_paths: ["QorperaOS/surfaces/website/notes/a.md"],
					p_branch_head_sha: "c".repeat(40),
				},
			},
		]);
	});

	it("loads all shared Company Files via loadSurfaceSharedAssets and auto-compiles identity/tokens.css when absent", async () => {
		const signal = new AbortController().signal;
		const readerWithoutCss = makeMemoryReader({
			"identity/brief.md": "Quiet Scandinavian craft.",
			"identity/voice.md": "Calm and direct.",
			"identity/tokens.json": JSON.stringify({
				colors: { primary: "#161615", accent: "#d76f45", surface: "#f7f5f2", muted: "#6c6964" },
				typography: { heading: "Instrument Serif", body: "Inter" },
				radius: { md: "12px" },
			}),
			"identity/company.json": '{"name":"Thetaband","email":"hello@thetaband.dk"}',
			"product/specs.json": '{"batteryHours":14,"weightGrams":38}',
			"product/catalog.json": '{"items":[{"sku":"TB-1","priceDkk":1899}]}',
			"identity/logo.svg": "<svg viewBox='0 0 32 32'></svg>",
			"identity/logo-dark.svg": "<svg viewBox='0 0 32 32'><circle/></svg>",
			"identity/wordmark.svg": "<svg viewBox='0 0 120 32'></svg>",
			"identity/wordmark-dark.svg": "<svg viewBox='0 0 120 32'><rect/></svg>",
		});

		const compiled = await loadSurfaceSharedAssets(readerWithoutCss, signal);
		expect(compiled).not.toBeNull();
		expect(compiled?.hasLogoSvg).toBe(true);
		expect(compiled?.hasLogoDarkSvg).toBe(true);
		expect(compiled?.hasWordmarkSvg).toBe(true);
		expect(compiled?.hasWordmarkDarkSvg).toBe(true);
		expect(compiled?.tokensCss).toContain("--q-color-accent: #d76f45;");
		expect(compiled?.tokensCss).toContain("--q-color-primary: #161615;");
		expect(compiled?.tokensCss).toContain("--q-font-heading:");
		expect(compiled?.tokensCss).toContain("--q-radius-md: 12px;");
		expect(compiled?.companyProfileJson).toContain('"Thetaband"');
		expect(compiled?.productSpecsJson).toContain('"batteryHours":14');
		expect(compiled?.productCatalogJson).toContain('"TB-1"');

		const readerWithExplicitCss = makeMemoryReader({
			"identity/tokens.json": '{"accent":"#d76f45"}',
			"identity/tokens.css": ":root {\n\t--q-color-accent: #112233;\n}\n",
		});
		const explicit = await loadSurfaceSharedAssets(readerWithExplicitCss, signal);
		expect(explicit?.tokensCss).toBe(":root {\n\t--q-color-accent: #112233;\n}");
		expect(explicit?.hasLogoSvg).toBe(false);

		expect(await loadSurfaceSharedAssets(makeMemoryReader({}), signal)).toBeNull();
	});

	it("propagates shared assets into downstream and Identity turn briefs during runSurfaceSessionTurn", async () => {
		const reader = makeMemoryReader({
			"identity/brief.md": "Nordic calm.",
			"identity/tokens.json": '{"colors":{"primary":"#161615","accent":"#d76f45","surface":"#f7f5f2"}}',
			"identity/company.json": '{"name":"Thetaband","support":"hej@thetaband.dk"}',
			"product/specs.json": '{"weightGrams":38}',
			"product/catalog.json": '{"items":[{"sku":"TB-1","priceDkk":1899}]}',
			"identity/logo.svg": "<svg></svg>",
			"identity/logo-dark.svg": "<svg><path/></svg>",
			"identity/wordmark.svg": "<svg><g/></svg>",
			"identity/wordmark-dark.svg": "<svg><rect/></svg>",
		});
		const completeSessionTurn = vi.fn().mockResolvedValue(undefined);

		const webResult = await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "website",
				surfaceTitle: "Website",
				sourceKind: "code_repo",
				repositoryKey: "surfaces/website",
				prompt: "Build pricing card.",
			},
			{
				folder: reader,
				surfaceTools: { recordChange: vi.fn() },
				completeSessionTurn,
				async executeCodeRepoTurn(req) {
					expect(req.binding.sharedAssets?.hasLogoSvg).toBe(true);
					expect(req.binding.sharedAssets?.hasLogoDarkSvg).toBe(true);
					expect(req.binding.sharedAssets?.hasWordmarkSvg).toBe(true);
					expect(req.binding.sharedAssets?.hasWordmarkDarkSvg).toBe(true);
					expect(req.binding.sharedAssets?.tokensCss).toContain("--q-color-accent: #d76f45;");
					expect(req.turnBrief).toContain("## Live Shared Company Files");
					expect(req.turnBrief).toContain("qorpera-identity.css");
					expect(req.turnBrief).toContain("var(--q-color-primary)");
					expect(req.turnBrief).toContain("public/qorpera-shared/identity/logo-dark.svg");
					expect(req.turnBrief).toContain("public/qorpera-shared/identity/wordmark.svg");
					expect(req.turnBrief).toContain("public/qorpera-shared/identity/wordmark-dark.svg");
					expect(req.turnBrief).toContain("public/qorpera-shared/product/specs.json");
					expect(req.turnBrief).toContain("public/qorpera-shared/product/catalog.json");
					expect(req.turnBrief).toContain("public/qorpera-shared/identity/company.json");
					expect(req.turnBrief).toContain('"weightGrams":38');
					expect(req.turnBrief).toContain('"TB-1"');
					expect(req.turnBrief).toContain('"hej@thetaband.dk"');
					return { state: "ready", replyText: "Pricing wired to shared files." };
				},
			},
		);
		expect(webResult.sharedAssetsLoaded).toBe(true);

		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Refine accent color.",
			},
			{
				folder: reader,
				surfaceTools: { stageSurfacePatch: vi.fn() },
				completeSessionTurn,
				async executeTurn(req) {
					expect(req.turnBrief).not.toContain("## Global Company Identity");
					expect(req.turnBrief).toContain("## Live Shared Company Files");
					expect(req.turnBrief).toContain("automatically recompile `identity/tokens.css`");
					expect(req.sharedAssets?.hasLogoSvg).toBe(true);
					return { state: "ready", replyText: "Tokens staged." };
				},
			},
		);
	});

	it("renews the session lease throughout a turn that outlives the lease TTL and stops renewing on exit", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const leaseToken = randomUUID();
		const leaseTtlMs = 45;
		let leaseExpiresAt = Date.now() + leaseTtlMs;
		let expiredDuringTurn = false;
		const renewalCalls: { sessionId: string; leaseToken: string; extendSeconds: number }[] = [];

		const renewSessionLease = vi.fn(
			async (input: { readonly sessionId: string; readonly leaseToken: string; readonly extendSeconds: number }) => {
				if (Date.now() > leaseExpiresAt) {
					expiredDuringTurn = true;
					return { renewed: false };
				}
				renewalCalls.push(input);
				leaseExpiresAt = Date.now() + leaseTtlMs;
				return { renewed: true };
			},
		);
		const completeSessionTurn = vi.fn(async (completion: { readonly leaseToken?: string | null }) => {
			if (Date.now() > leaseExpiresAt) {
				expiredDuringTurn = true;
				throw new Error("lease mismatch");
			}
			expect(completion.leaseToken).toBe(leaseToken);
		});

		const result = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Refine design tokens.",
				leaseToken,
			},
			{
				surfaceTools: {
					stageSurfacePatch: vi.fn(),
				},
				renewSessionLease,
				leaseRenewIntervalMs: 15,
				leaseExtendSeconds: 180,
				executeTurn: async () => {
					await new Promise((resolve) => setTimeout(resolve, 130));
					return { state: "ready", replyText: "Completed after long turn." };
				},
				completeSessionTurn,
			},
		);

		expect(result.state).toBe("ready");
		expect(expiredDuringTurn).toBe(false);
		expect(renewalCalls.length).toBeGreaterThanOrEqual(3);
		expect(renewalCalls[0]).toEqual({ sessionId, companyId, leaseToken, extendSeconds: 180 });
		expect(completeSessionTurn).toHaveBeenCalledTimes(1);

		const renewalsAtExit = renewalCalls.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(renewalCalls.length).toBe(renewalsAtExit);

		const rpcCalls: { method: string; args: Record<string, unknown> }[] = [];
		const rpcClient = {
			async call(method: string, args: Record<string, unknown>) {
				rpcCalls.push({ method, args });
				return { renewed: true };
			},
		};
		const renewalPort = createControlPlaneSessionLeaseRenewalPort(rpcClient, companyId);
		const completionPort = createControlPlaneSessionCompletionPort(rpcClient, companyId);
		const signal = new AbortController().signal;
		await expect(
			renewalPort.renewSessionLease({ sessionId, leaseToken, extendSeconds: 300 }, signal),
		).resolves.toEqual({ renewed: true });
		await completionPort.completeSessionTurn(
			{
				sessionId,
				state: "ready",
				replyText: "Done",
				question: null,
				notePaths: null,
				branchHeadSha: null,
				leaseToken,
			},
			signal,
		);
		expect(rpcCalls).toEqual([
			{
				method: "qorpera_native_surface_renew_lease",
				args: {
					p_profile_id: companyId,
					p_session_id: sessionId,
					p_lease_token: leaseToken,
					p_extend_seconds: 300,
				},
			},
			{
				method: "qorpera_native_surface_complete_turn",
				args: {
					p_profile_id: companyId,
					p_session_id: sessionId,
					p_state: "ready",
					p_reply_text: "Done",
					p_question: null,
					p_note_paths: null,
					p_branch_head_sha: null,
					p_lease_token: leaseToken,
				},
			},
		]);
	});

	it("aborts the turn signal and skips completion when lease renewal reports renewed: false, and requires renewSessionLease on leased provider turns", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const leaseToken = randomUUID();
		let observedAbort = false;
		const completeSessionTurn = vi.fn().mockResolvedValue(undefined);
		const renewSessionLease = vi.fn().mockResolvedValue({ renewed: false });

		const result = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Edit tokens",
				leaseToken,
			},
			{
				surfaceTools: { stageSurfacePatch: vi.fn() },
				renewSessionLease,
				leaseRenewIntervalMs: 12,
				executeTurn: async ({ signal }) =>
					new Promise((_, reject) => {
						signal.addEventListener(
							"abort",
							() => {
								observedAbort = true;
								reject(signal.reason ?? new Error("aborted"));
							},
							{ once: true },
						);
					}),
				completeSessionTurn,
			},
		);

		expect(observedAbort).toBe(true);
		expect(result.state).toBe("failed");
		expect(result.error).toContain("lease lost");
		expect(completeSessionTurn).not.toHaveBeenCalled();
	});

	it("stops lease renewal before completion, retries completion without overwriting with failed, handles caller abort cleanly, and reads brief.md in parallel", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const leaseToken = randomUUID();

		let activeReads = 0;
		let maxActiveReads = 0;
		let inCompletion = false;
		let renewalsDuringCompletion = 0;
		let completionAttempts = 0;
		const seenStates: string[] = [];

		const result = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "studio-a",
				surfaceTitle: "Studio A",
				sourceKind: "folder",
				folderRoot: "studio-a",
				prompt: "Refine layout",
				leaseToken,
			},
			{
				folder: {
					async readText(path) {
						activeReads += 1;
						maxActiveReads = Math.max(maxActiveReads, activeReads);
						await new Promise((r) => setTimeout(r, 20));
						activeReads -= 1;
						if (path === "QorperaOS/surfaces/studio-a/brief.md") return { text: "Studio brief" };
						if (path === "identity/tokens.json") return { text: '{"accent":"#d76f45"}' };
						return null;
					},
				},
				surfaceTools: { stageSurfacePatch: vi.fn() },
				leaseRenewIntervalMs: 10,
				completionRetryDelaysMs: [5, 5],
				renewSessionLease: async () => {
					if (inCompletion) {
						renewalsDuringCompletion += 1;
						return { renewed: false };
					}
					return { renewed: true };
				},
				executeTurn: async () => ({ state: "ready", replyText: "Completed turn." }),
				completeSessionTurn: async (completion) => {
					seenStates.push(completion.state);
					inCompletion = true;
					completionAttempts += 1;
					await new Promise((r) => setTimeout(r, 25));
					inCompletion = false;
					if (completionAttempts === 1) {
						throw new Error("transient completion 503");
					}
				},
			},
		);

		expect(result.state).toBe("ready");
		expect(maxActiveReads).toBeGreaterThanOrEqual(2);
		expect(renewalsDuringCompletion).toBe(0);
		expect(seenStates).toEqual(["ready", "ready"]);

		const persistentStates: string[] = [];
		const failedCompletion = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "studio-a",
				surfaceTitle: "Studio A",
				sourceKind: "folder",
				folderRoot: "studio-a",
				prompt: "Refine layout",
			},
			{
				surfaceTools: { stageSurfacePatch: vi.fn() },
				completionRetryDelaysMs: [5],
				executeTurn: async () => ({ state: "ready", replyText: "Done." }),
				completeSessionTurn: async (completion) => {
					persistentStates.push(completion.state);
					throw new Error("database unavailable");
				},
			},
		);
		expect(failedCompletion.state).toBe("failed");
		expect(persistentStates).toEqual(["ready", "ready"]);

		const callerAbort = new AbortController();
		const abortCompletions: string[] = [];
		const abortPromise = runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "studio-a",
				surfaceTitle: "Studio A",
				sourceKind: "folder",
				folderRoot: "studio-a",
				prompt: "Shutdown test",
			},
			{
				signal: callerAbort.signal,
				surfaceTools: { stageSurfacePatch: vi.fn() },
				executeTurn: async ({ signal }) =>
					new Promise((_, reject) => {
						signal.addEventListener("abort", () => reject(new Error("shutdown")), { once: true });
					}),
				completeSessionTurn: async (completion) => {
					abortCompletions.push(completion.state);
				},
			},
		);
		callerAbort.abort(new Error("shutdown"));
		const abortedResult = await abortPromise;
		expect(abortedResult.state).toBe("failed");
		expect(abortCompletions).toEqual([]);

		const swallowed = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "studio-a",
				surfaceTitle: "Studio A",
				sourceKind: "folder",
				folderRoot: "studio-a",
				prompt: "Fail test",
			},
			{
				surfaceTools: { stageSurfacePatch: vi.fn() },
				executeTurn: async () => {
					throw new Error("model error");
				},
				completeSessionTurn: async () => {
					throw new Error("secondary db outage");
				},
			},
		);
		expect(swallowed.state).toBe("failed");
		expect(swallowed.error).toContain("model error");

		let opaqueAttempt = 0;
		const opaqueStates: string[] = [];
		const opaque423 = await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "studio-a",
				surfaceTitle: "Studio A",
				sourceKind: "folder",
				folderRoot: "studio-a",
				prompt: "Opaque 423 retry test",
			},
			{
				surfaceTools: { stageSurfacePatch: vi.fn() },
				completionRetryDelaysMs: [5],
				executeTurn: async () => ({ state: "ready", replyText: "Done." }),
				completeSessionTurn: async (completion) => {
					opaqueStates.push(completion.state);
					opaqueAttempt += 1;
					if (opaqueAttempt === 1) throw new Error("transient 503");
					throw Object.assign(new Error("Request failed with status 423"), { status: 423 });
				},
			},
		);
		expect(opaque423.state).toBe("failed");
		expect(opaqueStates).toEqual(["ready", "ready"]);
	});

	it("threads the interface kind, icon and archetype from a delivered job into the page contract", async () => {
		const seen: Record<string, string> = {};
		const folders: Record<string, SurfaceFolderContents> = {
			"surfaces/thetabands": { files: {}, binaries: {} },
			"surfaces/market-notes": { files: { "surfaces/market-notes/01.report.json": "{}" }, binaries: {} },
			"surfaces/inventory": { files: {}, binaries: {} },
		};
		const deliver = (slug: string, title: string, kind: string, icon: string) =>
			runSurfaceSessionTurn(
				{
					sessionId: randomUUID(),
					surfaceId: randomUUID(),
					companyId: randomUUID(),
					surfaceSlug: slug,
					surfaceTitle: title,
					surfaceArchetype: "studio",
					sourceKind: "folder",
					surfaceKind: kind,
					surfaceIcon: icon,
					surfaceIsGlobal: false,
					folderRoot: `surfaces/${slug}`,
					prompt: "Work on it.",
					leaseToken: randomUUID(),
				},
				{
					surfaceTools: { stageSurfacePatch: vi.fn() },
					readStudioFiles: async (roots) => folders[roots[0] ?? ""] ?? { files: {}, binaries: {} },
					completeSessionTurn: vi.fn().mockResolvedValue(undefined),
					renewSessionLease: vi.fn().mockResolvedValue({ renewed: true }),
					executeTurn: async (req) => {
						seen[slug] = req.instructions;
						return { state: "ready", replyText: "Staged." };
					},
				},
			);

		await deliver("thetabands", "Thetabands", "product", "figure:headband");
		await deliver("market-notes", "Market Notes", "report", "figure:book");
		await deliver("inventory", "Inventory", "database", "figure:can");

		expect(seen.thetabands).toContain(describeSurfaceBlocks());
		expect(seen.thetabands).toContain(JSON.stringify(starterSurfaceLayout("product")));
		expect(seen.thetabands).toContain("breakdowns/<slug>/scenes.js");
		expect(seen.thetabands).toContain("narrate_explainer");
		expect(seen.thetabands).toContain("surfaces/thetabands/");
		expect(seen["market-notes"]).toContain("This interface is a reading page, not drawn from a layout");
		expect(seen["market-notes"]).toContain("bar_chart {heading");
		expect(seen["market-notes"]).not.toContain(describeSurfaceBlocks());
		expect(seen["market-notes"]).not.toContain("layout.json");
		expect(seen.inventory).toContain(JSON.stringify(starterSurfaceLayout("custom")));
		expect(seen.inventory).not.toContain("Product Studio file layout");
		expect(seen.inventory).not.toContain("vendors.json");

		const isolatedLoaded = await loadSurfaceSharedAssets(
			{
				async readText(path) {
					const files: Record<string, string> = {
						"product/specs.json": '{"legacy":true}',
						"surfaces/thetabands/specs.json": '{"weightGrams":44}',
						"surfaces/thetabands/catalog.json": '{"skus":["TB-1"]}',
					};
					return files[path] ?? null;
				},
			},
			new AbortController().signal,
			["surfaces/thetabands"],
		);
		expect(isolatedLoaded?.productSpecsJson).toBe('{"weightGrams":44}');
		expect(isolatedLoaded?.productCatalogJson).toBe('{"skus":["TB-1"]}');
	});

	it("captures exact pre-edit baseFiles on folder patch staging and emits non-interactive instructions for internal reconciliation", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const stagedRequests: unknown[] = [];

		await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Update guide heading",
			},
			{
				folder: {
					async readText(path) {
						if (path === "identity/guide.md") return { text: "# Brand\n\nOriginal copy\n" };
						return null;
					},
				},
				surfaceTools: {
					stageSurfacePatch: async (_sid, req) => {
						stagedRequests.push(req);
						return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
					},
				},
				executeTurn: async (req) => {
					const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const parsed = patchTool.parseArguments({
						title: "Guide update",
						summary: "Updates heading",
						ops: [
							{ op: "write_text", path: "guide.md", content: "# Brand v2\n\nOriginal copy\n" },
							{ op: "write_text", path: "new.md", content: "Brand new\n" },
						],
					});
					await patchTool.execute(parsed, {
						companyId,
						runId: randomUUID(),
						signal: req.signal,
					} as never);
					return { state: "ready", replyText: "Staged" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);

		expect(stagedRequests).toHaveLength(1);
		expect(stagedRequests[0]).toMatchObject({
			baseFiles: {
				"guide.md": "# Brand\n\nOriginal copy\n",
				"new.md": null,
			},
		});

		let seenInstructions = "";
		let seenWritableRoots: readonly string[] = ["unset"];
		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				state: "reconciling",
				isInternal: true,
				prompt: "Silently combine overlapping staged changes",
				conflictPaths: ["identity/guide.md"],
				conflictDetails: [
					{
						changeId: randomUUID(),
						title: "Change 1",
						kind: "folder_patch",
						patchManifest: [{ op: "write_text", path: "identity/guide.md", content: "A" }],
					},
				],
			},
			{
				surfaceTools: { stageSurfacePatch: vi.fn() },
				executeTurn: async (req) => {
					seenInstructions = req.instructions;
					seenWritableRoots = req.writableRoots;
					return { state: "ready", replyText: "Combined" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);

		expect(seenInstructions).toContain("automatic silent reconciliation");
		expect(seenInstructions).toContain("Never ask the founder questions.");
		expect(seenWritableRoots).toEqual([]);
	});

	it("omits unreadable paths from baseFiles instead of storing null and renders full untruncated overlapping ops in folder reconciliation briefs", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const stagedRequests: unknown[] = [];

		await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Rewrite large report and create note",
			},
			{
				folder: {
					async readText(path) {
						if (path === "identity/huge.md") throw new Error("CloudCompanyPathNotText: exceeds 128 KB");
						if (path === "identity/existing.md") return { text: "Existing\n" };
						return null;
					},
				},
				surfaceTools: {
					stageSurfacePatch: async (_sid, req) => {
						stagedRequests.push(req);
						return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
					},
				},
				executeTurn: async (req) => {
					const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const parsed = patchTool.parseArguments({
						title: "Large update",
						summary: "Updates huge and existing",
						ops: [
							{ op: "write_text", path: "huge.md", content: "Updated huge\n" },
							{ op: "write_text", path: "existing.md", content: "Updated existing\n" },
							{ op: "write_text", path: "missing.md", content: "Created\n" },
						],
					});
					await patchTool.execute(parsed, {
						companyId,
						runId: randomUUID(),
						signal: req.signal,
					} as never);
					return { state: "ready", replyText: "Staged" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);

		expect(stagedRequests).toHaveLength(1);
		const captured = (stagedRequests[0] as { baseFiles?: Record<string, string | null> }).baseFiles;
		expect(captured).toEqual({
			"existing.md": "Existing\n",
			"missing.md": null,
		});
		expect(Object.hasOwn(captured ?? {}, "huge.md")).toBe(false);

		const largeMarker = "TAIL_MARKER_24KB_END";
		const largeReport = `${"x".repeat(22_000)}\n${largeMarker}`;
		let seenBrief = "";
		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				sourceKind: "folder",
				folderRoot: "identity",
				state: "reconciling",
				isInternal: true,
				prompt: "Silently combine",
				conflictPaths: ["identity/report.md"],
				conflictDetails: [
					{
						changeId: randomUUID(),
						title: "Change 1",
						kind: "folder_patch",
						affectedPaths: ["identity/report.md", "identity/journey.svg"],
						patchManifest: [
							{ op: "write_text", path: "identity/report.md", content: largeReport },
							{ op: "write_text", path: "identity/journey.svg", content: "<svg>journey</svg>" },
						],
					},
				],
			},
			{
				surfaceTools: { stageSurfacePatch: vi.fn() },
				executeTurn: async (req) => {
					seenBrief = req.turnBrief;
					return { state: "ready", replyText: "Combined" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);

		expect(seenBrief).toContain(largeMarker);
		expect(seenBrief).not.toContain("/* ...truncated... */");
		expect(seenBrief).toContain("Non-conflicting paths (preserved automatically");
		expect(seenBrief).toContain("identity/journey.svg");
	});

	it("wires narrate_explainer with openScenesOps and in-turn stage_surface_patch overlay", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const stagedBatches: { title: string; ops: readonly Record<string, unknown>[] }[] = [];
		const synthesized: { model: string; voiceName: string; text: string }[] = [];
		let capturedInstructions = "";
		let narrateResultText = "";

		await runSurfaceSessionTurn(
			{
				sessionId,
				surfaceId,
				companyId,
				surfaceSlug: "identity",
				surfaceTitle: "Identity",
				surfaceKind: "identity",
				sourceKind: "folder",
				folderRoot: "identity",
				prompt: "Create a narrated UX breakdown video.",
				voiceModel: "gemini-3.8-flash-tts",
				voiceName: "Kore",
				openScenesOps: [
					{
						op: "write_text",
						path: "breakdowns/ux/voice/clips.json",
						content: JSON.stringify({ clips: [{ caption: "deadbeef", file: "deadbeef.wav", seconds: 1.5 }] }),
					},
				],
			},
			{
				folder: {
					async readText() {
						return null;
					},
				},
				surfaceTools: {
					async stageSurfacePatch(_sid, request) {
						stagedBatches.push({
							title: request.title,
							ops: request.ops as unknown as readonly Record<string, unknown>[],
						});
						return {
							changeId: randomUUID(),
							seq: stagedBatches.length,
							openChangeCount: stagedBatches.length,
						};
					},
				},
				narrateExplainer: {
					async stageBytes(bytes, mediaType) {
						return {
							manifestSha256: "a".repeat(64),
							fileSha256: "b".repeat(64),
							bytes: bytes.byteLength,
							mediaType,
						};
					},
					async synthesizeGemini(input) {
						synthesized.push({ model: input.model, voiceName: input.voiceName, text: input.text });
						return {
							audio: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
							mediaType: "audio/wav",
							fileExtension: "wav",
							seconds: 2.25,
							usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 180 },
							spendMicrodollars: 1626,
						};
					},
				},
				async executeTurn(req) {
					capturedInstructions = req.instructions;
					const stageTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const narrateTool = req.tools.find((t) => t.name === "narrate_explainer")!;
					expect(narrateTool).toBeDefined();
					const ctx = {
						companyId,
						runId: randomUUID(),
						agentId: randomUUID(),
						signal: req.signal,
					} as never;
					await stageTool.execute(
						stageTool.parseArguments({
							title: "Add UX breakdown",
							summary: "Staged scenes.js for the buyer and seller journey.",
							ops: [
								{
									op: "write_text",
									path: "breakdowns/ux/scenes.js",
									content: 'V.part("Start"); V.scene((s) => { s.say("Welcome to Brooks."); });',
								},
							],
						}),
						ctx,
					);
					const narrated = await narrateTool.execute(
						narrateTool.parseArguments({
							scenesPath: "breakdowns/ux/scenes.js",
							title: "Narrate UX breakdown",
							summary: "Added Kore voice narration.",
						}),
						ctx,
					);
					narrateResultText = narrated.kind === "text" ? narrated.value : "";
					return { state: "ready", replyText: "Staged and narrated." };
				},
				async completeSessionTurn() {},
			},
		);

		expect(capturedInstructions).toContain("breakdowns/<slug>/scenes.js");
		expect(capturedInstructions).toContain("gemini-3.8-flash-tts (Kore)");
		expect(synthesized).toEqual([{ model: "gemini-3.8-flash-tts", voiceName: "Kore", text: "Welcome to Brooks." }]);
		const parsed = JSON.parse(narrateResultText) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			ok: true,
			state: "spoken",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			spokenNow: 1,
			left: 0,
		});
		expect(stagedBatches).toHaveLength(2);
		expect(stagedBatches[1]?.ops).toEqual([
			{
				op: "write_file",
				path: expect.stringMatching(/^breakdowns\/ux\/voice\/[0-9a-f]{8}\.wav$/),
				file: { manifestSha256: "a".repeat(64), fileSha256: "b".repeat(64), bytes: 4, mediaType: "audio/wav" },
			},
			{
				op: "write_text",
				path: "breakdowns/ux/voice/clips.json",
				content: expect.stringContaining('"seconds": 2.25'),
			},
		]);
	});

	it("allows multiple deliverables in one stage_surface_patch call only for internal reconciliation while still validating report JSON", async () => {
		const surfaceId = randomUUID();
		const companyId = randomUUID();
		const q3Report = JSON.stringify({
			headline: "Q3 Retention",
			sections: [{ id: "summary", heading: "Summary", paragraphs: ["Retention rose to 91%."] }],
		});
		const q4Report = JSON.stringify({
			headline: "Q4 Outlook",
			sections: [{ id: "summary", heading: "Summary", paragraphs: ["Pipeline covers 2.4x target."] }],
		});
		const stagedRequests: unknown[] = [];

		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId,
				companyId,
				surfaceSlug: "reports",
				surfaceTitle: "Reports",
				sourceKind: "folder",
				folderRoot: "surfaces/reports",
				state: "reconciling",
				isInternal: true,
				prompt: "Silently combine overlapping staged reports",
				conflictPaths: ["surfaces/reports/q3.report.json", "surfaces/reports/q4.report.json"],
				conflictDetails: [
					{
						changeId: randomUUID(),
						title: "Change 1",
						kind: "folder_patch",
						patchManifest: [
							{ op: "write_text", path: "surfaces/reports/q3.report.json", content: q3Report },
							{ op: "write_text", path: "surfaces/reports/q4.report.json", content: q4Report },
						],
					},
				],
			},
			{
				surfaceTools: {
					stageSurfacePatch: async (_sid, req) => {
						stagedRequests.push(req);
						return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
					},
				},
				executeTurn: async (req) => {
					const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const ctx = toolContext(companyId);
					const badParsed = patchTool.parseArguments({
						title: "Broken report",
						summary: "Invalid JSON",
						ops: [
							{ op: "write_text", path: "q3.report.json", content: q3Report },
							{ op: "write_text", path: "q4.report.json", content: "{ invalid json" },
						],
					});
					await expect(patchTool.prepare!(badParsed, ctx)).rejects.toBeInstanceOf(CloudToolRefusal);

					const parsed = patchTool.parseArguments({
						title: "Reconciled reports",
						summary: "Combines Q3 and Q4 report edits.",
						ops: [
							{ op: "write_text", path: "q3.report.json", content: q3Report },
							{ op: "write_text", path: "q4.report.json", content: q4Report },
						],
					});
					const prepared = await patchTool.prepare!(parsed, ctx);
					await patchTool.execute(prepared, ctx);
					return { state: "ready", replyText: "Reconciled" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);

		expect(stagedRequests).toHaveLength(1);

		const normalStage = vi.fn().mockResolvedValue({ changeId: randomUUID(), seq: 1, openChangeCount: 1 });
		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId,
				companyId,
				surfaceSlug: "reports",
				surfaceTitle: "Reports",
				sourceKind: "folder",
				folderRoot: "surfaces/reports",
				prompt: "Draft Q3 and Q4 reports",
			},
			{
				surfaceTools: { stageSurfacePatch: normalStage },
				executeTurn: async (req) => {
					const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
					const parsed = patchTool.parseArguments({
						title: "Bundled reports",
						summary: "Attempts to bundle two reports.",
						ops: [
							{ op: "write_text", path: "q3.report.json", content: q3Report },
							{ op: "write_text", path: "q4.report.json", content: q4Report },
						],
					});
					await expect(patchTool.prepare!(parsed, toolContext(companyId))).rejects.toBeInstanceOf(
						CloudToolRefusal,
					);
					return { state: "ready", replyText: "Done" };
				},
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
			},
		);
		expect(normalStage).not.toHaveBeenCalled();
	});
});
