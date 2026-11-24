import { parseStudioPatchOps, type StudioBinaryRef, type StudioPatchOp } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import { captionHash } from "../src/cloud-app-kit-explainer.ts";
import { GeminiCapReachedError } from "../src/cloud-gemini-tool-session.ts";
import type { CloudToolContext } from "../src/cloud-native-tool-boundary.ts";
import { createNarrateExplainerTool, extractExplainerCaptionEntries } from "../src/cloud-surface-narrate-tool.ts";

function fakeContext(): CloudToolContext {
	return {
		callId: "call-1",
		companyId: "11111111-1111-4111-8111-111111111111",
		runId: "22222222-2222-4222-8222-222222222222",
		argumentSha256: "0".repeat(64),
		signal: new AbortController().signal,
	};
}

function parseToolText(result: { readonly kind: string; readonly value: unknown }): Record<string, unknown> {
	expect(result.kind).toBe("text");
	return JSON.parse(String(result.value)) as Record<string, unknown>;
}

describe("cloud-surface-narrate-tool", () => {
	it("extracts deduplicated single-language and bilingual captions", () => {
		const scenes = [
			'V.part({ en: "Start", da: "Start" });',
			"V.scene((s) => {",
			'  s.say({ en: "Buyer sets budget.", da: "Køber sætter budget." });',
			'  s.say("Shared note.");',
			'  s.say("Shared note.");',
			"});",
		].join("\n");
		const entries = extractExplainerCaptionEntries(scenes);
		expect(entries.map((entry) => entry.text)).toEqual([
			"Buyer sets budget.",
			"Køber sætter budget.",
			"Shared note.",
		]);
		expect(entries[0]?.hash).toBe(captionHash("Buyer sets budget."));
	});

	it("synthesizes only missing captions with Gemini TTS and stages write_file ops plus clips.json", async () => {
		const c1 = "Buyer describes what they want.";
		const c2 = "Seller approves confidential match.";
		const h1 = captionHash(c1);
		const h2 = captionHash(c2);
		const scenes = `V.scene((s) => { s.say("${c1}"); s.say("${c2}"); });`;
		const existingClips = JSON.stringify({ clips: [{ caption: h1, file: `${h1}.wav`, seconds: 2.1 }] });

		const stagedCalls: { title: string; ops: readonly StudioPatchOp[] }[] = [];
		const synthesized: { model: string; voiceName: string; text: string }[] = [];
		const tool = createNarrateExplainerTool({
			sessionId: "33333333-3333-4333-8333-333333333333",
			folderRoot: "identity",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			readStudioText: async (path) => {
				if (path === "breakdowns/ux/scenes.js") return scenes;
				if (path === "breakdowns/ux/voice/clips.json") return existingClips;
				return null;
			},
			stageBytes: async (bytes, mediaType) =>
				({
					manifestSha256: "a".repeat(64),
					fileSha256: "b".repeat(64),
					bytes: bytes.byteLength,
					mediaType,
					executable: false,
				}) as StudioBinaryRef,
			surfacePatch: {
				stageSurfacePatch: async (_sessionId, req) => {
					stagedCalls.push({ title: req.title, ops: req.ops });
					return { changeId: "44444444-4444-4444-8444-444444444444", seq: 2, openChangeCount: 2 };
				},
			},
			synthesizeGemini: async ({ model, voiceName, text }) => {
				synthesized.push({ model, voiceName, text });
				return {
					audio: new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0]),
					mediaType: "audio/wav",
					fileExtension: "wav",
					seconds: 3.4,
					usage: { inputTokens: 8, cachedTokens: 0, outputTokens: 120 },
				};
			},
		});

		const result = await tool.execute({ scenesPath: "identity/breakdowns/ux/scenes.js" }, fakeContext());
		const body = parseToolText(result);
		expect(body).toMatchObject({
			ok: true,
			state: "spoken",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			spokenNow: 1,
			reused: 1,
			left: 0,
			total: 2,
		});
		expect(synthesized).toEqual([{ model: "gemini-3.8-flash-tts", voiceName: "Kore", text: c2 }]);
		expect(stagedCalls).toHaveLength(1);
		expect(parseStudioPatchOps(stagedCalls[0]?.ops)).toEqual(stagedCalls[0]?.ops);
		expect(stagedCalls[0]?.ops).toHaveLength(2);
		expect(stagedCalls[0]?.ops[0]).toEqual({
			op: "write_file",
			path: `breakdowns/ux/voice/${h2}.wav`,
			file: {
				manifestSha256: "a".repeat(64),
				fileSha256: "b".repeat(64),
				bytes: 8,
				mediaType: "audio/wav",
			},
		});
		const clipsOp = stagedCalls[0]?.ops[1];
		expect(clipsOp?.op).toBe("write_text");
		if (clipsOp?.op === "write_text") {
			expect(clipsOp.path).toBe("breakdowns/ux/voice/clips.json");
			expect(JSON.parse(clipsOp.content)).toEqual({
				clips: [
					{ caption: h1, file: `${h1}.wav`, seconds: 2.1 },
					{ caption: h2, file: `${h2}.wav`, seconds: 3.4 },
				],
			});
		}
	});

	it("returns a calm unsupported response when the member selected chatgpt-voice in a Studio session", async () => {
		const tool = createNarrateExplainerTool({
			sessionId: "33333333-3333-4333-8333-333333333333",
			folderRoot: "identity",
			voiceModel: "chatgpt-voice",
			voiceName: "juniper",
			readStudioText: async (path) =>
				path === "breakdowns/ux/scenes.js" ? 'V.scene((s) => { s.say("Hi."); });' : null,
			stageBytes: vi.fn(),
			surfacePatch: { stageSurfacePatch: vi.fn() },
		});
		const result = await tool.execute({ scenesPath: "breakdowns/ux/scenes.js" }, fakeContext());
		const body = parseToolText(result);
		expect(body.ok).toBe(false);
		expect(body.state).toBe("unsupported_in_studio");
		expect(body.voiceModel).toBe("chatgpt-voice");
		expect(body.voiceName).toBe("juniper");
	});

	it("reports cap_reached gracefully without throwing", async () => {
		const tool = createNarrateExplainerTool({
			sessionId: "33333333-3333-4333-8333-333333333333",
			folderRoot: "identity",
			voiceModel: "gemini-3.8-flash-lite-tts",
			voiceName: "Puck",
			readStudioText: async (path) =>
				path === "breakdowns/ux/scenes.js" ? 'V.scene((s) => { s.say("Hi."); });' : null,
			stageBytes: vi.fn(),
			surfacePatch: { stageSurfacePatch: vi.fn() },
			synthesizeGemini: async () => {
				throw new GeminiCapReachedError(500, 5_000_000);
			},
		});
		const result = await tool.execute({ scenesPath: "breakdowns/ux/scenes.js" }, fakeContext());
		const body = parseToolText(result);
		expect(body.ok).toBe(false);
		expect(body.state).toBe("cap_reached");
	});

	it("aborts remaining workers on mid-batch error, preserves already-recorded clips, and rethrows when none were recorded", async () => {
		const captions = ["Clip one.", "Clip two.", "Clip three.", "Clip four.", "Clip five."];
		const scenes = `V.scene((s) => { ${captions.map((text) => `s.say("${text}");`).join(" ")} });`;
		const attempted: string[] = [];
		const stagedCalls: { ops: readonly StudioPatchOp[] }[] = [];
		let abortedSiblings = 0;

		const partialTool = createNarrateExplainerTool({
			sessionId: "33333333-3333-4333-8333-333333333333",
			folderRoot: "identity",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			readStudioText: async (path) => (path === "breakdowns/ux/scenes.js" ? scenes : null),
			stageBytes: async (bytes, mediaType) => ({
				manifestSha256: "a".repeat(64),
				fileSha256: "b".repeat(64),
				bytes: bytes.byteLength,
				mediaType,
			}),
			surfacePatch: {
				stageSurfacePatch: async (_sessionId, req) => {
					stagedCalls.push({ ops: req.ops });
					return { changeId: "44444444-4444-4444-8444-444444444444", seq: 2, openChangeCount: 2 };
				},
			},
			synthesizeGemini: async ({ text, signal }) => {
				attempted.push(text);
				if (text === "Clip one.") {
					return {
						audio: new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0]),
						mediaType: "audio/wav",
						fileExtension: "wav",
						seconds: 1.5,
						usage: { inputTokens: 4, cachedTokens: 0, outputTokens: 60 },
					};
				}
				if (text === "Clip two.") {
					await new Promise((resolve) => setTimeout(resolve, 15));
					throw new Error("quota_exhausted");
				}
				return await new Promise((_, reject) => {
					signal.addEventListener(
						"abort",
						() => {
							abortedSiblings += 1;
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				});
			},
		});

		const partialResult = await partialTool.execute({ scenesPath: "breakdowns/ux/scenes.js" }, fakeContext());
		const partialBody = parseToolText(partialResult);
		expect(partialBody).toMatchObject({
			ok: true,
			state: "partly_spoken",
			spokenNow: 1,
			reused: 0,
			left: 4,
			total: 5,
			error: "quota_exhausted",
		});
		expect(abortedSiblings).toBe(2);
		expect(attempted).not.toContain("Clip five.");
		expect(stagedCalls).toHaveLength(1);
		expect(stagedCalls[0]?.ops).toHaveLength(2);

		const failAllTool = createNarrateExplainerTool({
			sessionId: "33333333-3333-4333-8333-333333333333",
			folderRoot: "identity",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Kore",
			readStudioText: async (path) =>
				path === "breakdowns/ux/scenes.js" ? 'V.scene((s) => { s.say("Only."); });' : null,
			stageBytes: vi.fn(),
			surfacePatch: { stageSurfacePatch: vi.fn() },
			synthesizeGemini: async () => {
				throw new Error("daily quota exhausted");
			},
		});
		await expect(failAllTool.execute({ scenesPath: "breakdowns/ux/scenes.js" }, fakeContext())).rejects.toThrow(
			"daily quota exhausted",
		);
	});
});
