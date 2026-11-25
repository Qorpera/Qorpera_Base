import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CloudCompanyFolderClient } from "../src/cloud-company-folder-client.ts";
import { cloudFolderFileTools } from "../src/cloud-folder-file-tools.ts";
import { cloudCompanyRuntimeInstructions } from "../src/cloud-native-company-context.ts";
import { CloudToolRefusal } from "../src/cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { CLOUD_PLATFORM_SKILLS, MAX_STUDIO_SKILL_BYTES } from "../src/cloud-platform-skills.ts";
import { createNarrateExplainerTool } from "../src/cloud-surface-narrate-tool.ts";
import { runSurfaceSessionTurn } from "../src/cloud-surface-session-runner.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

function fakeIdentity() {
	return nativeToolAuthorityFixture().authority.identity;
}

function fakeToolContext() {
	return {
		companyId: randomUUID(),
		runId: randomUUID(),
		callId: "call_1",
		argumentSha256: "c".repeat(64),
		signal: new AbortController().signal,
	};
}

describe("strategy surface and custom studio runtime integration", () => {
	it("loads company vision and reading into Studio turn briefs and attaches strategy-studio skill", async () => {
		let turnBrief = "";
		let instructions = "";
		const files: Record<string, string> = {
			"QorperaOS/vision/vision.md": "# Brooks\nPre-market dealer stock matching for serious car buyers.",
			"QorperaOS/vision/reading.md": "Testing dealer-funded access vs buyer subscriptions in Copenhagen.",
		};
		await runSurfaceSessionTurn(
			{
				sessionId: randomUUID(),
				surfaceId: randomUUID(),
				companyId: randomUUID(),
				sourceKind: "folder",
				surfaceSlug: "strategy",
				surfaceTitle: "Strategy",
				surfaceKind: "strategy",
				surfaceIcon: "figure:lighthouse",
				surfaceIsGlobal: false,
				surfaceArchetype: "studio",
				folderRoot: "surfaces/strategy",
				prompt: "Build our competing plays and stress-test unit economics.",
			},
			{
				folder: {
					async readText(path: string) {
						return files[path] ?? null;
					},
				},
				readStudioFiles: async () => ({ files: {}, binaries: {} }),
				surfaceTools: { stageSurfacePatch: vi.fn() },
				completeSessionTurn: vi.fn().mockResolvedValue(undefined),
				async executeTurn(req) {
					turnBrief = req.turnBrief;
					instructions = req.instructions;
					return { state: "ready", replyText: "Done." };
				},
			},
		);

		expect(turnBrief).toContain("## Company Vision (QorperaOS/vision/vision.md)");
		expect(turnBrief).toContain("Pre-market dealer stock matching");
		expect(turnBrief).toContain("## Company Reading (QorperaOS/vision/reading.md)");
		expect(turnBrief).toContain("dealer-funded access");
		expect(instructions).toContain("## Skill: strategy-studio");
		expect(instructions).toContain("economics.json");
		expect(instructions).toContain("plays.json");
		expect(instructions).toContain("hypotheses.json");
		expect(instructions).toContain("landscape.json");
	});

	it("keeps strategy-studio and custom-surface skills under MAX_STUDIO_SKILL_BYTES", () => {
		for (const name of ["strategy-studio", "custom-surface"]) {
			const skill = CLOUD_PLATFORM_SKILLS.get(name);
			expect(skill).toBeDefined();
			expect(Buffer.byteLength(skill!.body)).toBeLessThanOrEqual(MAX_STUDIO_SKILL_BYTES);
		}
	});

	it("blocks legacy apps/ writes in Surface-First mode for both Co-Founder and workers, plus business/company sprawl", async () => {
		const folder = {
			read: vi.fn().mockResolvedValue({ entry: null }),
			readText: vi.fn().mockResolvedValue(null),
			commit: vi.fn(),
		} as unknown as CloudCompanyFolderClient;
		const operations = {
			record: vi.fn(),
		} as unknown as CloudNativeToolOperations;

		const cofounderTools = cloudFolderFileTools({
			folder,
			operations,
			identity: fakeIdentity(),
			surfaceFilePolicy: { mode: "cofounder", allowExplicitMemberDoc: true },
		});
		const cofounderWrite = cofounderTools.find((tool) => tool.name === "company_write")!;
		await expect(
			cofounderWrite.execute(
				cofounderWrite.parseArguments({
					path: "apps/economics-model/index.html",
					operationKey: "op-1",
					expectedVersion: null,
					text: "<html/>",
				}),
				fakeToolContext(),
			),
		).rejects.toBeInstanceOf(CloudToolRefusal);

		const strictCofounderTools = cloudFolderFileTools({
			folder,
			operations,
			identity: fakeIdentity(),
			surfaceFilePolicy: { mode: "cofounder", allowExplicitMemberDoc: false },
		});
		const strictWrite = strictCofounderTools.find((tool) => tool.name === "company_write")!;
		await expect(
			strictWrite.execute(
				strictWrite.parseArguments({
					path: "business/plan.md",
					operationKey: "op-2",
					expectedVersion: null,
					text: "# Plan",
				}),
				fakeToolContext(),
			),
		).rejects.toThrow("SURFACE_FILE_POLICY_REFUSED");

		const workerTools = cloudFolderFileTools({
			folder,
			operations,
			identity: fakeIdentity(),
			surfaceFilePolicy: { mode: "worker" },
		});
		const workerWrite = workerTools.find((tool) => tool.name === "company_write")!;
		await expect(
			workerWrite.execute(
				workerWrite.parseArguments({
					path: "apps/model/app.json",
					operationKey: "op-3",
					expectedVersion: null,
					text: "{}",
				}),
				fakeToolContext(),
			),
		).rejects.toThrow('legacy "apps/" interfaces are retired');
	});

	it("teaches surface:<slug> links instead of app:<name> in Surface-First instructions", () => {
		const text = cloudCompanyRuntimeInstructions(
			null,
			false,
			new Set(["propose_surface", "start_surface_session", "company_read", "company_write"]),
		);
		expect(text).toContain("[Title](surface:<slug>)");
		expect(text).toContain("Strategy Studio surface");
		expect(text).toContain("Custom Studio Surfaces");
		expect(text).not.toContain("apps as [Title](app:<name>)");
	});

	it("synthesizes spoken Gemini TTS clips for studio tour.json beats via narrate_explainer", async () => {
		const stagedOps: unknown[] = [];
		const tool = createNarrateExplainerTool({
			sessionId: randomUUID(),
			folderRoot: "surfaces/strategy",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			readStudioText: async (path) =>
				path === "tour.json"
					? JSON.stringify({
							title: "Walkthrough",
							beats: [
								{
									id: "intro",
									tab: "plan",
									focus: "play:dealer-fee",
									say: { en: "Start with dealers.", da: "Start med forhandlere." },
								},
							],
						})
					: null,
			stageBytes: async () => ({
				manifestSha256: "a".repeat(64),
				fileSha256: "b".repeat(64),
				bytes: 1200,
				mediaType: "audio/wav",
			}),
			surfacePatch: {
				stageSurfacePatch: async (_sessionId, input) => {
					stagedOps.push(...input.ops);
					return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
				},
			},
			synthesizeGemini: async () => ({
				audio: new Uint8Array([1, 2, 3, 4]),
				mediaType: "audio/wav",
				fileExtension: "wav",
				seconds: 2.1,
				usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 20 },
			}),
		});

		const result = await tool.execute(
			tool.parseArguments({ scenesPath: "tour.json", title: "Narrate strategy tour" }),
			fakeToolContext(),
		);
		const parsed = JSON.parse(String(result.value)) as Record<string, unknown>;
		expect(parsed.ok).toBe(true);
		expect(parsed.spokenNow).toBe(2);
		expect(parsed.clipsPath).toBe("voice/clips.json");
		expect(stagedOps.length).toBeGreaterThanOrEqual(3);
	});
});
