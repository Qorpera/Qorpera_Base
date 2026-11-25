import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudClaudePictureLane } from "@qorpera/runtime/cloud-claude-picture-lane";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudPictureFailure, CloudPictureUnavailable } from "@qorpera/runtime/cloud-picture-channel";
import {
	createGeminiImageLane,
	hasCodexLogin,
	resolveRunPictureLane,
	serializePictureLane,
} from "@qorpera/runtime/cloud-run-picture-lane";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";
import { pngFile, pngHeader, pngRows } from "./fixtures/png-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function makeRoot(kind: "codex" | "plan" | "plan-empty" | "none"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "run-picture-lane-"));
	roots.push(root);
	await mkdir(join(root, "codex"), { recursive: true, mode: 0o700 });
	if (kind === "codex") {
		await writeFile(join(root, "codex", "auth.json"), "{}", { mode: 0o600 });
	} else if (kind === "plan" || kind === "plan-empty") {
		await mkdir(join(root, "chatgpt-plan"), { mode: 0o700 });
		if (kind === "plan") {
			await writeFile(join(root, "chatgpt-plan", "access-token"), "plan-access-token", { mode: 0o600 });
		}
	}
	return root;
}

const samplePng = () => pngFile(pngHeader(1, 1, 8, 2), pngRows([[255, 128, 0]]));

describe("cloud-run-picture-lane", () => {
	it("routes preferred Gemini, ChatGPT plan token, primary Codex, lazy side Codex, and Gemini fallback", async () => {
		const codexRoot = await makeRoot("codex");
		const planRoot = await makeRoot("plan");
		const planEmptyRoot = await makeRoot("plan-empty");
		const noneRoot = await makeRoot("none");
		const png = samplePng();

		expect(await hasCodexLogin(codexRoot)).toBe(true);
		expect(await hasCodexLogin(noneRoot)).toBe(false);

		const geminiLane = vi.fn(async () => ({ png }));
		const prefGemini = await resolveRunPictureLane({
			preferredModel: "gemini-3-pro-image",
			identityRoot: codexRoot,
			usesPrimaryCodexSession: true,
			geminiLane,
		});
		expect(prefGemini.attachToCodex).toBe(false);
		expect(prefGemini.channel).toBeDefined();
		await prefGemini.channel!.make({ prompt: "Gemini first" }, new AbortController().signal);
		expect(geminiLane).toHaveBeenCalledTimes(1);

		const planFetch = vi.fn<typeof fetch>(async () =>
			Response.json({
				output: [{ type: "image_generation_call", status: "completed", result: png.toString("base64") }],
			}),
		);
		const planResolved = await resolveRunPictureLane({
			preferredModel: "chatgpt-image",
			identityRoot: planRoot,
			usesPrimaryCodexSession: true,
			geminiLane,
			chatGptPlanFetch: planFetch,
		});
		expect(planResolved.attachToCodex).toBe(false);
		expect(planResolved.channel).toBeDefined();
		const planMade = await planResolved.channel!.make({ prompt: "Plan image" }, new AbortController().signal);
		expect(planMade.png.equals(png)).toBe(true);
		expect(planFetch).toHaveBeenCalledTimes(1);

		const planEmpty = await resolveRunPictureLane({
			preferredModel: "chatgpt-image",
			identityRoot: planEmptyRoot,
			usesPrimaryCodexSession: true,
		});
		expect(planEmpty.channel).toBeUndefined();
		expect(planEmpty.attachToCodex).toBe(false);

		const primaryCodex = await resolveRunPictureLane({
			preferredModel: "chatgpt-image",
			identityRoot: codexRoot,
			usesPrimaryCodexSession: true,
		});
		expect(primaryCodex.channel).toBeDefined();
		expect(primaryCodex.attachToCodex).toBe(true);

		const sideStarted = vi.fn(
			async ({
				pictures,
				light,
				signal,
			}: Parameters<ConstructorParameters<typeof CloudClaudePictureLane>[0]["start"]>[0]) => {
				pictures.attach(async () => ({ png }));
				try {
					await light(signal);
				} finally {
					pictures.attach(undefined);
				}
			},
		);
		const sideLane = new CloudClaudePictureLane({ start: sideStarted, signal: new AbortController().signal });
		const closeSpy = vi.spyOn(sideLane, "close");
		const viaSide = await resolveRunPictureLane({
			preferredModel: "chatgpt-image",
			identityRoot: codexRoot,
			usesPrimaryCodexSession: false,
			startCodexSideLane: async () => sideLane,
		});
		expect(viaSide.attachToCodex).toBe(false);
		expect(viaSide.channel).toBeDefined();
		const sideMade = await viaSide.channel!.make({ prompt: "Side codex image" }, new AbortController().signal);
		expect(sideMade.png.equals(png)).toBe(true);
		await viaSide.close();
		expect(closeSpy).toHaveBeenCalledTimes(1);

		const fallback = await resolveRunPictureLane({
			preferredModel: "chatgpt-image",
			identityRoot: noneRoot,
			usesPrimaryCodexSession: false,
			geminiLane,
			geminiFallbackAllowed: true,
		});
		expect(fallback.attachToCodex).toBe(false);
		expect(fallback.channel).toBeDefined();
		await fallback.channel!.make({ prompt: "Fallback Gemini" }, new AbortController().signal);
		expect(geminiLane).toHaveBeenCalledTimes(2);
	});

	it("opens Gemini key via vault, records usage, enforces spend cap and billing errors, and rejects concurrent calls", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const png = samplePng();
		const rpcCalls: { method: string; args: Record<string, unknown> }[] = [];
		const paths: CloudCompanyPathControl = {
			call: vi.fn(async (method, args) => {
				rpcCalls.push({ method, args: args as Record<string, unknown> });
				if (method === "qorpera_record_gemini_image_usage") {
					return {
						schema: "qorpera.gemini-image-usage/v1",
						spendMonth: "2026-11",
						monthSpendMicrodollars: 100_000_000,
						monthlyCapCents: 10_000,
						capReached: true,
					};
				}
				return {};
			}),
		};
		const vaultFetch = vi.fn<typeof fetch>(async () =>
			Response.json({
				schema: "qorpera.gemini-key-for-run/v1",
				state: "open",
				geminiKeyId: "00000000-0000-4000-8000-000000000099",
				apiKey: `AIza${"A".repeat(35)}`,
				spendMonth: "2026-11",
				monthSpendMicrodollars: 0,
				monthlyCapCents: 10_000,
			}),
		);
		const geminiFetch = vi.fn<typeof fetch>(async () =>
			Response.json({
				candidates: [
					{
						finishReason: "STOP",
						content: { parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] },
					},
				],
				usageMetadata: {
					promptTokenCount: 50,
					candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
				},
			}),
		);

		const lane = createGeminiImageLane({
			binding,
			paths,
			geminiKeys: {
				origin: "https://vault.example",
				runtimeToken: "V".repeat(43),
				companyId: authority.identity.companyId,
				holder: () => "H".repeat(43),
				fetch: vaultFetch,
			},
			fetcher: geminiFetch,
			signal: new AbortController().signal,
		})!;

		const first = await lane({ prompt: "First Gemini image" }, new AbortController().signal);
		expect(first.png.equals(png)).toBe(true);
		expect(rpcCalls[0]?.method).toBe("qorpera_record_gemini_image_usage");
		expect(rpcCalls[0]?.args).toMatchObject({
			p_model: "gemini-3-pro-image",
			p_usage: { inputTokens: 50, cachedTokens: 0, textOutputTokens: 0, imageOutputTokens: 1120 },
		});

		const capError = await lane({ prompt: "After cap" }, new AbortController().signal).catch((err: unknown) => err);
		expect(capError).toBeInstanceOf(CloudPictureFailure);
		expect((capError as CloudPictureFailure).reason).toBe("spend_cap");
		expect(rpcCalls.map((entry) => entry.method)).toContain("qorpera_record_gemini_cap_reached");

		const billingLane = createGeminiImageLane({
			binding,
			paths,
			existingApiKey: "AIzaSyExisting",
			fetcher: vi.fn<typeof fetch>(
				async () =>
					new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION", message: "Billing disabled" } }), {
						status: 402,
					}),
			),
			signal: new AbortController().signal,
		})!;
		const billingErr = await billingLane({ prompt: "Billing fail" }, new AbortController().signal).catch(
			(err: unknown) => err,
		);
		expect(billingErr).toBeInstanceOf(CloudPictureFailure);
		expect((billingErr as CloudPictureFailure).reason).toBe("billing_required");
		expect(rpcCalls.at(-1)).toMatchObject({
			method: "qorpera_record_gemini_key_error",
			args: { p_error_code: "billing_required" },
		});

		const revokedLane = createGeminiImageLane({
			binding,
			paths,
			geminiKeys: {
				origin: "https://vault.example",
				runtimeToken: "V".repeat(43),
				companyId: authority.identity.companyId,
				holder: () => "H".repeat(43),
				fetch: vi.fn<typeof fetch>(async () =>
					Response.json({ schema: "qorpera.gemini-key-for-run/v1", state: "refused", reason: "REVOKED" }),
				),
			},
			signal: new AbortController().signal,
		})!;
		await expect(revokedLane({ prompt: "Revoked" }, new AbortController().signal)).rejects.toBeInstanceOf(
			CloudPictureUnavailable,
		);

		let release!: () => void;
		const serialized = serializePictureLane(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { png };
		});
		const inFlight = serialized({ prompt: "One" }, new AbortController().signal);
		const busyErr = await serialized({ prompt: "Two" }, new AbortController().signal).catch((err: unknown) => err);
		expect(busyErr).toBeInstanceOf(CloudPictureFailure);
		expect((busyErr as CloudPictureFailure).reason).toBe("busy");
		release();
		await inFlight;
	});
});
