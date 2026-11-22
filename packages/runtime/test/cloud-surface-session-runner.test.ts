import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CloudNativeCodingDriver, CloudNativeCodingTurnContext } from "../src/cloud-native-coding-runtime.ts";
import type { NativeCompanyExecutionRequest } from "../src/cloud-native-provider-host.ts";
import { type CloudToolContext, CloudToolRefusal } from "../src/cloud-native-tool-boundary.ts";
import {
	createControlPlaneSessionCompletionPort,
	loadSurfaceIdentityContext,
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
						expect(req.allowedRoots).toEqual(["product", "QorperaOS/surfaces/product-studio/notes"]);

						const writeTool = req.tools.find((t) => t.name === "company_write")!;
						const patchTool = req.tools.find((t) => t.name === "stage_surface_patch")!;
						expect(writeTool).toBeDefined();
						expect(patchTool).toBeDefined();

						const allowedWrite = await writeTool.execute(
							writeTool.parseArguments({
								path: "product/box.md",
								operationKey: "studio-ok-1",
								expectedVersion: null,
								text: "# Linen Box",
							}),
							f.context,
						);
						expect(JSON.parse(String(allowedWrite.value)).state).toBe("applied");

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
					expect(req.allowedRoots).toEqual(["identity", "QorperaOS/surfaces/identity/notes"]);
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
			{
				sessionId,
				state: "ready",
				replyText: "Staged hero CTA contrast update.",
				question: null,
				notePaths: null,
				branchHeadSha: headSha,
			},
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
			{
				sessionId,
				state: "failed",
				replyText: "The surface session could not complete: Coding VM disconnected mid-build",
				question: null,
				notePaths: null,
				branchHeadSha: null,
			},
			expect.any(AbortSignal),
		);
	});

	it("bridges completeSessionTurn onto qorpera_surface_complete_session_turn via createControlPlaneSessionCompletionPort", async () => {
		const calls: { method: string; args: Record<string, unknown> }[] = [];
		const port = createControlPlaneSessionCompletionPort({
			async call(method, args) {
				calls.push({ method, args });
				return {};
			},
		});
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
				method: "qorpera_surface_complete_session_turn",
				args: {
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
});
