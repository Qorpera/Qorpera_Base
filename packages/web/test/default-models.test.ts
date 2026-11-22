// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultModelsView } from "../src/app/views/settings-default-models.ts";
import {
	createWebDefaultModels,
	DefaultModelsStaleError,
	DefaultModelsUnavailableError,
	type MemberDefaultModels,
	type WebDefaultModels,
} from "../src/cloud/default-models.ts";
import { fixture, profileA, settle, userA } from "./fixtures.ts";

afterEach(() => {
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
		storedConversationModel: null,
		storedCodingModel: null,
		conversationModels: ["gpt-6.2-sol", "gpt-6-astra", "claude-opus-5-5", "claude-fable-5-2", "gemini-4-neon"],
		codingModels: ["claude-opus-5-5", "claude-fable-5-2", "gpt-6.2-sol", "gpt-6-astra"],
		conversationEfforts: {
			"gpt-6.2-sol": ["low", "medium", "high", "xhigh"],
			"gpt-6-astra": ["low", "medium", "high", "xhigh"],
			"claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
			"claude-fable-5-2": ["low", "medium", "high", "xhigh", "max"],
			"gemini-4-neon": ["low", "medium", "high", "xhigh"],
		},
		codingEfforts: {
			"gpt-6.2-sol": ["low", "medium", "high"],
			"gpt-6-astra": ["low", "medium", "high"],
			"claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
			"claude-fable-5-2": ["low", "medium", "high", "xhigh", "max"],
		},
		version: 1,
		...patch,
	};
}

describe("default models transport", () => {
	it("reads, sends partial updates, and maps QRC01 stale and QRC02 unavailable errors", async () => {
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

		await expect(
			client.set({
				conversationModel: "gpt-6.2-sol",
				expectedVersion: 1,
			}),
		).rejects.toBeInstanceOf(DefaultModelsStaleError);

		await expect(
			client.set({
				conversationModel: "gemini-4-neon",
				expectedVersion: 2,
			}),
		).rejects.toBeInstanceOf(DefaultModelsUnavailableError);
	});
});

describe("DefaultModelsView", () => {
	it("sends only changed fields, clamps max effort off Claude, and preserves unavailable stored defaults", async () => {
		let state = sampleDefaults({
			conversationModel: "claude-opus-5-5",
			storedConversationModel: "claude-opus-5-5",
			conversationEffort: "max",
			codingModel: "claude-opus-5-5",
			storedCodingModel: "claude-opus-5-5",
			codingEffort: "max",
		});
		const client: WebDefaultModels = {
			read: vi.fn(async () => state),
			set: vi.fn(async (update) => {
				const conversationModel = update.conversationModel ?? state.conversationModel;
				const codingModel = update.codingModel ?? state.codingModel;
				state = sampleDefaults({
					conversationModel,
					storedConversationModel: update.conversationModel ?? state.storedConversationModel,
					conversationEffort: update.conversationEffort ?? state.conversationEffort,
					codingModel,
					storedCodingModel: update.codingModel ?? state.storedCodingModel,
					codingEffort: update.codingEffort ?? state.codingEffort,
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

		const convModel = view.el.querySelector<HTMLSelectElement>('[data-role="conversation-model"]')!;
		const codingModel = view.el.querySelector<HTMLSelectElement>('[data-role="coding-model"]')!;
		expect(convModel.value).toBe("claude-opus-5-5");
		expect(codingModel.value).toBe("claude-opus-5-5");

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

		controller.abort();
	});

	it("shows unavailable stored models without overwriting them when editing the other control", async () => {
		const state = sampleDefaults({
			conversationModel: "gpt-6.2-sol",
			storedConversationModel: "gemini-4-neon",
			conversationEffort: "high",
			conversationModels: ["gpt-6.2-sol", "gpt-6-astra"],
			codingModel: "gpt-6.2-sol",
			storedCodingModel: null,
			codingEffort: "high",
			codingModels: ["gpt-6.2-sol", "gpt-6-astra"],
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
});
