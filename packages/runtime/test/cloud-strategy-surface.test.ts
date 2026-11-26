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
import { extractStrategyInterfaceSummary } from "../src/cloud-surface-turn-context.ts";
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
	it("injects live Company Interfaces into Studio turn briefs (not vision/reading) and attaches strategy-studio skill", async () => {
		let turnBrief = "";
		let instructions = "";
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
				companyInterfaces: {
					interfaces: [
						{
							slug: "strategy",
							title: "Strategy",
							kind: "strategy",
							archetype: "studio",
							sourceKind: "folder",
							folderRoot: "surfaces/strategy",
							folderExists: false,
							repositoryKey: null,
							briefSummary: "Grand plan and unit economics",
							isGlobal: false,
						},
						{
							slug: "identity",
							title: "Identity",
							kind: "identity",
							archetype: "studio",
							sourceKind: "folder",
							folderRoot: "identity",
							folderExists: true,
							repositoryKey: null,
							briefSummary: "Brand and marks",
							isGlobal: false,
						},
						{
							slug: "website",
							title: "Website",
							kind: "website",
							archetype: "live_build",
							sourceKind: "code_repo",
							folderRoot: null,
							repositoryKey: "surfaces/website",
							briefSummary: "Public landing site",
							isGlobal: false,
						},
					],
					strategySummary: "Verdict: Win Copenhagen dealer intake first.",
					identitySummary: "# Brooks\nCalm automotive authority.",
				},
				prompt: "Build our competing plays and stress-test unit economics.",
			},
			{
				folder: {
					async readText() {
						return null;
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

		expect(turnBrief).toContain("## Company Interfaces");
		expect(turnBrief).toContain("`/company/surfaces/strategy` (starter — folder created on first publish)");
		expect(turnBrief).toContain("`/company/identity` — Brand and marks");
		expect(turnBrief).toContain("/company/code/surfaces/website");
		expect(turnBrief).toContain("Win Copenhagen dealer intake first.");
		expect(turnBrief).toContain("Calm automotive authority.");
		expect(turnBrief).not.toContain("## Company Vision");
		expect(turnBrief).not.toContain("## Company Reading");
		expect(instructions).toContain("## Skill: strategy-studio");
		expect(instructions).toContain("economics.json");
		expect(instructions).toContain("plays.json");
		expect(instructions).toContain("hypotheses.json");
		expect(instructions).toContain("landscape.json");
	});

	it("extractStrategyInterfaceSummary parses contract-shaped plays.json (summary, verdict, play.name, play.thesis) and falls back to brief.md", () => {
		const playsJson = JSON.stringify({
			summary: "Copenhagen specialty coffee roasters need predictable wholesale subscriptions.",
			verdict: "Win boutique cafes first; consumer DTC waits until unit economics clear.",
			plays: [
				{
					id: "wholesale-clubs",
					name: "Boutique Cafe Subscriptions",
					thesis: "Weekly standing orders cut CAC by 80% and fill roastery capacity.",
					status: "recommended",
				},
				{
					id: "dtc-pods",
					name: "Consumer Compostable Pods",
					thesis: "High churn and paid social CAC trap until brand awareness exists.",
					status: "parked",
				},
			],
		});
		const summary = extractStrategyInterfaceSummary(playsJson, "Fallback brief text");
		expect(summary).toContain("Summary: Copenhagen specialty coffee roasters");
		expect(summary).toContain("Verdict: Win boutique cafes first");
		expect(summary).toContain("[recommended] Boutique Cafe Subscriptions: Weekly standing orders");
		expect(summary).toContain("[parked] Consumer Compostable Pods: High churn");
		expect(extractStrategyInterfaceSummary("{bad-json", "Fallback brief text")).toBe("Fallback brief text");
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

	it("keeps the Co-Founder's everyday words and teaches the two-line post with its line of Surface links", () => {
		const text = cloudCompanyRuntimeInstructions(
			null,
			false,
			new Set(["propose_surface", "start_surface_session", "company_read", "company_write"]),
		);
		expect(text).toContain("the Co-Founder uses everyday language only");
		expect(text).not.toContain("unless the members themselves use technical terms");
		expect(text).toContain("most updates are one or two plain lines");
		expect(text).toContain("put those Surfaces' links together on a line of their own");
		expect(text).toContain("[Website](surface:website) [Web App](surface:web-app) [Strategy](surface:strategy)");
		expect(text).toContain(
			"repository names, file paths written out in the text, server and IP addresses, machine sizes",
		);
		expect(text).toContain("never format words as code or split a message into numbered sections");
		expect(text).toContain("Link every file you created or updated that matters to the reader");
		const classic = cloudCompanyRuntimeInstructions(null, false);
		expect(classic).toContain("- Link, never paste: files as");
		expect(classic).toContain("Link every file you created or updated that matters to the reader");
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

	it("synthesizes spoken ChatGPT subscription voice clips for studio tour.json beats via narrate_explainer", async () => {
		const stagedOps: unknown[] = [];
		const tool = createNarrateExplainerTool({
			sessionId: randomUUID(),
			folderRoot: "surfaces/strategy",
			voiceModel: "chatgpt-voice",
			voiceName: "cove",
			readStudioText: async (path) =>
				path === "tour.json"
					? JSON.stringify({
							title: "Walkthrough",
							beats: [{ id: "intro", tab: "plan", say: "Start with dealers." }],
						})
					: null,
			stageBytes: async () => ({
				manifestSha256: "c".repeat(64),
				fileSha256: "d".repeat(64),
				bytes: 2400,
				mediaType: "audio/mp4",
			}),
			surfacePatch: {
				stageSurfacePatch: async (_sessionId, input) => {
					stagedOps.push(...input.ops);
					return { changeId: randomUUID(), seq: 1, openChangeCount: 1 };
				},
			},
			synthesizeChatGptVoice: async ({ voiceName, captions }) => {
				expect(voiceName).toBe("cove");
				return {
					clips: captions.map((caption) => ({
						hash: caption.hash,
						audio: new Uint8Array([1, 2, 3]),
						mediaType: "audio/mp4" as const,
						fileExtension: "mp4" as const,
						seconds: 1.8,
					})),
					stopReason: null,
				};
			},
		});

		const result = await tool.execute(
			tool.parseArguments({ scenesPath: "tour.json", title: "Narrate strategy tour" }),
			fakeToolContext(),
		);
		const parsed = JSON.parse(String(result.value)) as Record<string, unknown>;
		expect(parsed.ok).toBe(true);
		expect(parsed.voiceModel).toBe("chatgpt-voice");
		expect(parsed.voiceName).toBe("cove");
		expect(parsed.spokenNow).toBe(1);
		expect(parsed.clipsPath).toBe("voice/clips.json");
		expect(stagedOps.length).toBeGreaterThanOrEqual(2);
	});
});
