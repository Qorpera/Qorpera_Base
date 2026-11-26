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
import {
	buildCompanyInterfacesSection,
	extractAnalyticsNumbersSummary,
	extractStrategyInterfaceSummary,
	loadCompanyInterfacesContext,
} from "../src/cloud-surface-turn-context.ts";
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

	it("probes Studio folder existence in loadCompanyInterfacesContext, enforces 16-root cap, and propagates aborts", async () => {
		const listed: string[] = [];
		const folderClient = {
			readText: vi.fn(async () => null),
			list: vi.fn(async (parent: string, options: { limit?: number }) => {
				expect(options.limit).toBe(1);
				listed.push(parent);
				if (parent === "surfaces/populated") return { entries: [{ path: "surfaces/populated/layout.json" }] };
				if (parent === "surfaces/errored") throw new Error("transient failure");
				return { entries: [] };
			}),
		};
		const getFolder = vi.fn(() => folderClient);
		const extraFolders = Array.from({ length: 15 }, (_, index) => ({
			slug: `room-${index}`,
			title: `Room ${index}`,
			kind: "custom",
			archetype: "studio",
			sourceKind: "folder",
			folderRoot: `surfaces/room-${index}`,
			repositoryKey: null,
			briefSummary: null,
			isGlobal: false,
		}));
		const raw = {
			schema: "qorpera.company-interfaces/v1",
			interfaces: [
				{
					slug: "populated",
					title: "Populated",
					kind: "custom",
					archetype: "studio",
					sourceKind: "folder",
					folderRoot: "surfaces/populated",
					repositoryKey: null,
					briefSummary: "Has published files",
					isGlobal: false,
				},
				{
					slug: "empty",
					title: "Empty",
					kind: "custom",
					archetype: "studio",
					sourceKind: "folder",
					folderRoot: "surfaces/empty",
					repositoryKey: null,
					briefSummary: null,
					isGlobal: false,
				},
				{
					slug: "errored",
					title: "Errored",
					kind: "custom",
					archetype: "studio",
					sourceKind: "folder",
					folderRoot: "surfaces/errored",
					repositoryKey: null,
					briefSummary: null,
					isGlobal: false,
				},
				...extraFolders,
			],
		};

		const loaded = await loadCompanyInterfacesContext(raw, getFolder, new AbortController().signal);
		expect(getFolder).toHaveBeenCalledTimes(1);
		expect(listed).toHaveLength(16);
		expect(listed).not.toContain("surfaces/room-13");
		expect(listed).not.toContain("surfaces/room-14");
		expect(loaded?.interfaces.find((item) => item.slug === "populated")?.folderExists).toBe(true);
		expect(loaded?.interfaces.find((item) => item.slug === "empty")?.folderExists).toBe(false);
		expect(loaded?.interfaces.find((item) => item.slug === "errored")?.folderExists).toBeUndefined();
		expect(loaded?.interfaces.find((item) => item.slug === "room-14")?.folderExists).toBeUndefined();

		const section = buildCompanyInterfacesSection(loaded);
		expect(section).toContain("`/company/surfaces/populated` — Has published files");
		expect(section).toContain("`/company/surfaces/empty` (starter — folder created on first publish)");
		expect(section).not.toContain("`/company/surfaces/errored` (starter");

		const abortController = new AbortController();
		const abortErr = new Error("aborted");
		const abortingFolder = {
			readText: vi.fn(async () => null),
			list: vi.fn(async () => {
				abortController.abort(abortErr);
				throw abortErr;
			}),
		};
		await expect(
			loadCompanyInterfacesContext(
				{
					schema: "qorpera.company-interfaces/v1",
					interfaces: [
						{
							slug: "empty",
							title: "Empty",
							kind: "custom",
							archetype: "studio",
							sourceKind: "folder",
							folderRoot: "surfaces/empty",
							repositoryKey: null,
							briefSummary: null,
							isGlobal: false,
						},
					],
				},
				() => abortingFolder,
				abortController.signal,
			),
		).rejects.toThrow("aborted");
	});

	it("gives a Strategy session Analytics' numbers (name, what it counts, question, unit), and no other session", async () => {
		const studio = (slug: string, kind: string) => ({
			slug,
			title: slug,
			kind,
			archetype: "studio",
			sourceKind: "folder",
			folderRoot: `surfaces/${slug}`,
			repositoryKey: null,
			briefSummary: null,
			isGlobal: false,
		});
		const metrics = {
			metrics: [
				{
					name: "Money in",
					counts: "Card payments that went through",
					leaves_out: "Refunds, VAT",
					question: "qorpera/orders-days",
					unit: "kr.",
				},
				{ name: "Visits", counts: "Visits to the shop", question: "qorpera/site-days" },
				{ counts: "a number with no name is left out" },
				...Array.from({ length: 20 }, (_, index) => ({ name: `Extra ${index}` })),
			],
		};
		const read: string[] = [];
		const folder = {
			readText: vi.fn(async (path: string) => {
				read.push(path);
				return path === "surfaces/numbers/metrics.json" ? { text: JSON.stringify(metrics) } : null;
			}),
		};
		const loaded = await loadCompanyInterfacesContext(
			{
				schema: "qorpera.company-interfaces/v1",
				interfaces: [
					studio("strategy", "strategy"),
					studio("numbers", "dashboard"),
					studio("field-notes", "custom"),
				],
			},
			() => folder,
			new AbortController().signal,
		);
		expect(read).toContain("surfaces/numbers/metrics.json");
		expect(loaded?.analyticsSummary?.folderRoot).toBe("surfaces/numbers");
		const strategy = buildCompanyInterfacesSection(loaded, { currentSlug: "strategy" }) ?? "";
		expect(strategy).toContain("### Analytics Numbers (`/company/surfaces/numbers/metrics.json`)");
		expect(strategy).toContain("read each with data_query by its question");
		expect(strategy).toContain("- Money in: Card payments that went through (question qorpera/orders-days, kr.)");
		expect(strategy).toContain("- Visits: Visits to the shop (question qorpera/site-days)");
		expect(strategy).not.toContain("a number with no name");
		expect(strategy).toContain("- Extra 13");
		expect(strategy).not.toContain("- Extra 14");
		expect(buildCompanyInterfacesSection(loaded, { currentSlug: "field-notes" })).not.toContain("Analytics Numbers");
		expect(buildCompanyInterfacesSection(loaded)).not.toContain("Analytics Numbers");
		expect(extractAnalyticsNumbersSummary("{")).toBeNull();
		expect(extractAnalyticsNumbersSummary('{"metrics":{}}')).toBeNull();
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
