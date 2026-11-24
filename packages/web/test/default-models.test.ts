// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultModelsView } from "../src/app/views/settings-default-models.ts";
import {
	CHATGPT_VOICE_PROFILES,
	createWebDefaultModels,
	DefaultModelsStaleError,
	DefaultModelsUnavailableError,
	GEMINI_VOICE_PROFILES,
	type MemberDefaultModels,
	parseMemberDefaultModels,
	type WebDefaultModels,
} from "../src/cloud/default-models.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { fixture, profileA, settle, userA } from "./fixtures.ts";

afterEach(() => {
	setLanguagePreference("en");
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function sampleDefaults(patch: Partial<MemberDefaultModels> = {}): MemberDefaultModels {
	return {
		conversationModel: "gpt-6.2-sol",
		conversationEffort: "low",
		codingModel: "claude-opus-5-5",
		codingEffort: "high",
		voiceModel: "gemini-3.8-flash-tts",
		voiceName: "Charon",
		storedConversationModel: null,
		storedCodingModel: null,
		storedVoiceModel: null,
		storedVoiceName: null,
		conversationModels: ["gpt-6.2-sol", "gpt-6-astra", "gemini-4-neon"],
		codingModels: ["claude-opus-5-5", "claude-fable-5-2", "gpt-6.2-sol", "gpt-6-astra"],
		voiceModels: ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "chatgpt-voice"],
		conversationEfforts: {
			"gpt-6.2-sol": ["low", "medium", "high", "xhigh"],
			"gpt-6-astra": ["low", "medium", "high", "xhigh"],
			"gemini-4-neon": ["low", "medium", "high", "xhigh"],
		},
		codingEfforts: {
			"gpt-6.2-sol": ["low", "medium", "high"],
			"gpt-6-astra": ["low", "medium", "high"],
			"claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
			"claude-fable-5-2": ["low", "medium", "high", "xhigh", "max"],
		},
		voiceProfiles: {
			"gemini-3.8-flash-tts": GEMINI_VOICE_PROFILES,
			"gemini-3.8-flash-lite-tts": GEMINI_VOICE_PROFILES,
			"chatgpt-voice": CHATGPT_VOICE_PROFILES,
		},
		version: 1,
		...patch,
	};
}

describe("default models transport", () => {
	it("reads, sends partial updates including voice, and maps QRC01 stale and QRC02 unavailable errors", async () => {
		const f = fixture();
		let step = 0;
		const sentBodies: Record<string, unknown>[] = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (url.endsWith("/rpc/qorpera_get_member_default_models")) {
				expect(body).toEqual({ p_profile_id: profileA.profileId.toLowerCase() });
				return Response.json({ schema: "qorpera.member-default-models/v1", ...sampleDefaults() });
			}
			if (url.endsWith("/rpc/qorpera_set_member_default_models")) {
				sentBodies.push(body);
				step += 1;
				if (step === 1) {
					return Response.json({
						schema: "qorpera.member-default-models/v1",
						...sampleDefaults({
							conversationModel: "gemini-4-neon",
							storedConversationModel: "gemini-4-neon",
							conversationEffort: "high",
							codingModel: "gpt-6-astra",
							storedCodingModel: "gpt-6-astra",
							codingEffort: "medium",
							version: 2,
						}),
					});
				}
				if (step === 2) {
					return Response.json({
						schema: "qorpera.member-default-models/v1",
						...sampleDefaults({
							voiceModel: "gemini-3.8-flash-lite-tts",
							voiceName: "Kore",
							storedVoiceModel: "gemini-3.8-flash-lite-tts",
							storedVoiceName: "Kore",
							version: 3,
						}),
					});
				}
				if (step === 3) {
					return Response.json({ code: "QRC01", message: "stale" }, { status: 409 });
				}
				return Response.json({ code: "QRC02", message: "missing provider" }, { status: 403 });
			}
			throw new Error(`Unexpected url: ${url}`);
		}) as unknown as typeof fetch;

		const client = createWebDefaultModels(
			f.cloud,
			profileA.profileId,
			userA.id,
			new AbortController().signal,
			() => undefined,
			fetchImpl,
		);
		const initial = await client.read();
		expect(initial.conversationModel).toBe("gpt-6.2-sol");
		expect(initial.codingModel).toBe("claude-opus-5-5");
		expect(initial.voiceModel).toBe("gemini-3.8-flash-tts");
		expect(initial.voiceName).toBe("Charon");
		expect(initial.codingEfforts["gpt-6-astra"]).toEqual(["low", "medium", "high"]);

		const updated = await client.set({
			conversationModel: "gemini-4-neon",
			conversationEffort: "high",
			expectedVersion: 1,
		});
		expect(sentBodies[0]).toEqual({
			p_profile_id: profileA.profileId.toLowerCase(),
			p_conversation_model: "gemini-4-neon",
			p_conversation_effort: "high",
			p_coding_model: null,
			p_coding_effort: null,
			p_expected_version: 1,
		});
		expect(updated.conversationModel).toBe("gemini-4-neon");
		expect(updated.storedConversationModel).toBe("gemini-4-neon");
		expect(updated.version).toBe(2);

		const voiceUpdated = await client.set({
			voiceModel: "gemini-3.8-flash-lite-tts",
			voiceName: "Kore",
			expectedVersion: 2,
		});
		expect(sentBodies[1]).toEqual({
			p_profile_id: profileA.profileId.toLowerCase(),
			p_conversation_model: null,
			p_conversation_effort: null,
			p_coding_model: null,
			p_coding_effort: null,
			p_expected_version: 2,
			p_voice_model: "gemini-3.8-flash-lite-tts",
			p_voice_name: "Kore",
		});
		expect(voiceUpdated.voiceModel).toBe("gemini-3.8-flash-lite-tts");
		expect(voiceUpdated.voiceName).toBe("Kore");
		expect(voiceUpdated.version).toBe(3);

		await expect(
			client.set({
				conversationModel: "gpt-6.2-sol",
				expectedVersion: 1,
			}),
		).rejects.toBeInstanceOf(DefaultModelsStaleError);

		await expect(
			client.set({
				conversationModel: "gemini-4-neon",
				expectedVersion: 3,
			}),
		).rejects.toBeInstanceOf(DefaultModelsUnavailableError);
	});

	it("rejects payloads missing voice fields", () => {
		expect(() =>
			parseMemberDefaultModels({
				schema: "qorpera.member-default-models/v1",
				conversationModel: "gpt-6.2-sol",
				conversationEffort: "low",
				codingModel: "gpt-6.2-sol",
				codingEffort: "high",
				storedConversationModel: null,
				storedCodingModel: null,
				conversationModels: ["gpt-6.2-sol"],
				codingModels: ["gpt-6.2-sol"],
				conversationEfforts: { "gpt-6.2-sol": ["low", "medium", "high"] },
				codingEfforts: { "gpt-6.2-sol": ["low", "medium", "high"] },
				version: 0,
			}),
		).toThrow();
	});
});

describe("DefaultModelsView", () => {
	it("excludes Claude from conversational options, clamps max coding effort off Claude, sends only changed fields, and switches voice model and profile", async () => {
		let state = sampleDefaults({
			conversationModel: "gpt-6.2-sol",
			storedConversationModel: null,
			conversationEffort: "high",
			conversationModels: ["gpt-6.2-sol", "gpt-6-astra", "claude-opus-5-5", "claude-fable-5-2", "gemini-4-neon"],
			codingModel: "claude-opus-5-5",
			storedCodingModel: "claude-opus-5-5",
			codingEffort: "max",
			voiceModel: "gemini-3.8-flash-tts",
			voiceName: "Charon",
		});
		const client: WebDefaultModels = {
			read: vi.fn(async () => state),
			set: vi.fn(async (update) => {
				const conversationModel = update.conversationModel ?? state.conversationModel;
				const codingModel = update.codingModel ?? state.codingModel;
				const voiceModel = update.voiceModel ?? state.voiceModel;
				const voiceName = update.voiceName ?? state.voiceName;
				state = sampleDefaults({
					conversationModel,
					storedConversationModel: update.conversationModel ?? state.storedConversationModel,
					conversationEffort: update.conversationEffort ?? state.conversationEffort,
					codingModel,
					storedCodingModel: update.codingModel ?? state.storedCodingModel,
					codingEffort: update.codingEffort ?? state.codingEffort,
					voiceModel,
					voiceName,
					storedVoiceModel: update.voiceModel ?? state.storedVoiceModel,
					storedVoiceName: update.voiceName ?? state.storedVoiceName,
					version: update.expectedVersion + 1,
				});
				return state;
			}),
		};
		const controller = new AbortController();
		const view = new DefaultModelsView(client, controller.signal);
		document.body.append(view.el);
		await settle();

		expect(view.el.textContent).toContain("Default models");
		expect(view.el.textContent).toContain("Conversational");
		expect(view.el.textContent).toContain("Coding & working");
		expect(view.el.textContent).toContain("Voice");

		const rows = [...view.el.querySelectorAll(".default-model-row strong")].map((node) => node.textContent);
		expect(rows).toEqual(["Conversational", "Coding & working", "Voice"]);

		const convModel = view.el.querySelector<HTMLSelectElement>('[data-role="conversation-model"]')!;
		const codingModel = view.el.querySelector<HTMLSelectElement>('[data-role="coding-model"]')!;
		const voiceModel = view.el.querySelector<HTMLSelectElement>('[data-role="voice-model"]')!;
		const voiceName = view.el.querySelector<HTMLSelectElement>('[data-role="voice-name"]')!;
		expect([...convModel.options].map((opt) => opt.value)).toEqual(["gpt-6.2-sol", "gpt-6-astra", "gemini-4-neon"]);
		expect([...codingModel.options].map((opt) => opt.value)).toEqual([
			"claude-opus-5-5",
			"claude-fable-5-2",
			"gpt-6.2-sol",
			"gpt-6-astra",
		]);
		expect(convModel.value).toBe("gpt-6.2-sol");
		expect(codingModel.value).toBe("claude-opus-5-5");
		expect(voiceModel.value).toBe("gemini-3.8-flash-tts");
		expect(voiceName.value).toBe("Charon");
		expect(voiceName.options.length).toBe(30);

		convModel.value = "gemini-4-neon";
		convModel.dispatchEvent(new Event("change"));
		await settle();
		expect(client.set).toHaveBeenLastCalledWith(
			{
				conversationModel: "gemini-4-neon",
				expectedVersion: 1,
			},
			expect.any(AbortSignal),
		);
		expect(view.el.textContent).toContain("Default models saved.");

		const codingModelAfter = view.el.querySelector<HTMLSelectElement>('[data-role="coding-model"]')!;
		codingModelAfter.value = "gpt-6-astra";
		codingModelAfter.dispatchEvent(new Event("change"));
		await settle();
		expect(client.set).toHaveBeenLastCalledWith(
			{
				codingModel: "gpt-6-astra",
				codingEffort: "high",
				expectedVersion: 2,
			},
			expect.any(AbortSignal),
		);

		const codingEffortAfter = view.el.querySelector<HTMLSelectElement>('[data-role="coding-effort"]')!;
		expect([...codingEffortAfter.options].map((opt) => opt.value)).toEqual(["low", "medium", "high"]);
		codingEffortAfter.value = "medium";
		codingEffortAfter.dispatchEvent(new Event("change"));
		await settle();
		expect(client.set).toHaveBeenLastCalledWith(
			{
				codingEffort: "medium",
				expectedVersion: 3,
			},
			expect.any(AbortSignal),
		);

		const voiceNameAfter = view.el.querySelector<HTMLSelectElement>('[data-role="voice-name"]')!;
		voiceNameAfter.value = "Kore";
		voiceNameAfter.dispatchEvent(new Event("change"));
		await settle();
		expect(client.set).toHaveBeenLastCalledWith(
			{
				voiceModel: "gemini-3.8-flash-tts",
				voiceName: "Kore",
				expectedVersion: 4,
			},
			expect.any(AbortSignal),
		);

		const voiceModelAfter = view.el.querySelector<HTMLSelectElement>('[data-role="voice-model"]')!;
		voiceModelAfter.value = "chatgpt-voice";
		voiceModelAfter.dispatchEvent(new Event("change"));
		await settle();
		expect(client.set).toHaveBeenLastCalledWith(
			{
				voiceModel: "chatgpt-voice",
				voiceName: "cove",
				expectedVersion: 5,
			},
			expect.any(AbortSignal),
		);

		const chatgptVoices = view.el.querySelector<HTMLSelectElement>('[data-role="voice-name"]')!;
		expect([...chatgptVoices.options].map((opt) => opt.value)).toEqual([...CHATGPT_VOICE_PROFILES]);

		controller.abort();
	});

	it("marks a legacy stored Claude conversational model unavailable and clamps max effort when switching off it", async () => {
		const state = sampleDefaults({
			conversationModel: "claude-opus-5-5",
			storedConversationModel: "claude-opus-5-5",
			conversationEffort: "max",
			conversationModels: ["gpt-6.2-sol", "gpt-6-astra", "claude-opus-5-5", "gemini-4-neon"],
		});
		const client: WebDefaultModels = {
			read: vi.fn(async () => state),
			set: vi.fn(async () =>
				sampleDefaults({
					conversationModel: "gemini-4-neon",
					storedConversationModel: "gemini-4-neon",
					conversationEffort: "xhigh",
					version: 2,
				}),
			),
		};
		const controller = new AbortController();
		const view = new DefaultModelsView(client, controller.signal);
		document.body.append(view.el);
		await settle();

		const convModel = view.el.querySelector<HTMLSelectElement>('[data-role="conversation-model"]')!;
		expect(convModel.value).toBe("claude-opus-5-5");
		expect(convModel.selectedOptions[0]?.disabled).toBe(true);
		expect(convModel.selectedOptions[0]?.textContent).toBe("Opus 5.5 (unavailable here)");
		const convEffort = view.el.querySelector<HTMLSelectElement>('[data-role="conversation-effort"]')!;
		expect([...convEffort.options].map((opt) => opt.value)).toEqual(["low", "medium", "high", "xhigh"]);

		convModel.value = "gemini-4-neon";
		convModel.dispatchEvent(new Event("change"));
		await settle();
		expect(client.set).toHaveBeenLastCalledWith(
			{
				conversationModel: "gemini-4-neon",
				conversationEffort: "xhigh",
				expectedVersion: 1,
			},
			expect.any(AbortSignal),
		);
		controller.abort();
	});

	it("shows unavailable stored models without overwriting them when editing another control", async () => {
		const state = sampleDefaults({
			conversationModel: "gpt-6.2-sol",
			storedConversationModel: "gemini-4-neon",
			conversationEffort: "high",
			conversationModels: ["gpt-6.2-sol", "gpt-6-astra"],
			codingModel: "gpt-6.2-sol",
			storedCodingModel: null,
			codingEffort: "high",
			codingModels: ["gpt-6.2-sol", "gpt-6-astra"],
			voiceModel: "chatgpt-voice",
			voiceName: "cove",
			storedVoiceModel: "gemini-3.8-flash-tts",
			storedVoiceName: "Kore",
			voiceModels: ["chatgpt-voice"],
			version: 4,
		});
		const client: WebDefaultModels = {
			read: vi.fn(async () => state),
			set: vi.fn(async () => ({ ...state, codingEffort: "medium" as const, version: 5 })),
		};
		const controller = new AbortController();
		const view = new DefaultModelsView(client, controller.signal);
		document.body.append(view.el);
		await settle();

		const convModel = view.el.querySelector<HTMLSelectElement>('[data-role="conversation-model"]')!;
		expect(convModel.value).toBe("gemini-4-neon");
		expect(convModel.selectedOptions[0]?.disabled).toBe(true);
		expect(convModel.selectedOptions[0]?.textContent).toBe("Gemini 4 Neon (unavailable here)");

		const voiceModel = view.el.querySelector<HTMLSelectElement>('[data-role="voice-model"]')!;
		expect(voiceModel.value).toBe("gemini-3.8-flash-tts");
		expect(voiceModel.selectedOptions[0]?.disabled).toBe(true);
		expect(voiceModel.selectedOptions[0]?.textContent).toBe("Gemini 3.8 Flash TTS (unavailable here)");

		const voiceName = view.el.querySelector<HTMLSelectElement>('[data-role="voice-name"]')!;
		expect(voiceName.value).toBe("Kore");

		const codingEffort = view.el.querySelector<HTMLSelectElement>('[data-role="coding-effort"]')!;
		codingEffort.value = "medium";
		codingEffort.dispatchEvent(new Event("change"));
		await settle();
		expect(client.set).toHaveBeenLastCalledWith(
			{
				codingEffort: "medium",
				expectedVersion: 4,
			},
			expect.any(AbortSignal),
		);
		controller.abort();
	});

	it("refreshes when a save hits stale version or unavailable provider", async () => {
		const state = sampleDefaults();
		const client: WebDefaultModels = {
			read: vi.fn(async () => state),
			set: vi
				.fn()
				.mockRejectedValueOnce(new DefaultModelsStaleError())
				.mockRejectedValueOnce(new DefaultModelsUnavailableError()),
		};
		const controller = new AbortController();
		const view = new DefaultModelsView(client, controller.signal);
		document.body.append(view.el);
		await settle();

		const convModel = view.el.querySelector<HTMLSelectElement>('[data-role="conversation-model"]')!;
		convModel.value = "gemini-4-neon";
		convModel.dispatchEvent(new Event("change"));
		await settle();
		expect(view.el.textContent).toContain("Default models changed elsewhere.");
		expect(client.read).toHaveBeenCalledTimes(2);

		const convModelRetry = view.el.querySelector<HTMLSelectElement>('[data-role="conversation-model"]')!;
		convModelRetry.value = "gemini-4-neon";
		convModelRetry.dispatchEvent(new Event("change"));
		await settle();
		expect(view.el.textContent).toContain("Connect that subscription below before choosing it as a default.");
		expect(client.read).toHaveBeenCalledTimes(3);

		controller.abort();
	});

	it("translates Gemini voice profile tone descriptors in Danish", async () => {
		setLanguagePreference("da");
		const state = sampleDefaults();
		const client: WebDefaultModels = {
			read: vi.fn(async () => state),
			set: vi.fn(async () => state),
		};
		const controller = new AbortController();
		const view = new DefaultModelsView(client, controller.signal);
		document.body.append(view.el);
		await settle();

		const voiceName = view.el.querySelector<HTMLSelectElement>('[data-role="voice-name"]')!;
		const labels = [...voiceName.options].map((option) => option.textContent);
		expect(labels).toContain("Charon — Informativ");
		expect(labels).toContain("Kore — Bestemt");
		expect(labels).toContain("Sulafat — Varm");
		controller.abort();
	});
});
