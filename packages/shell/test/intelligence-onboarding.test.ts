import { describe, expect, it } from "vitest";
import {
	INTELLIGENCE_PROVIDER_CATALOG,
	intelligenceProvider,
	intelligenceSelectionForProvider,
	isIntelligenceProviderId,
	resolveIntelligenceReadiness,
} from "../src/intelligence-onboarding.ts";

describe("intelligence onboarding", () => {
	it("defines the three supported provider defaults", () => {
		expect(INTELLIGENCE_PROVIDER_CATALOG).toEqual([
			{ id: "openai-codex", name: "OpenAI", product: "GPT", defaultModelId: "gpt-5.5" },
			{ id: "anthropic", name: "Anthropic", product: "Claude", defaultModelId: "claude-opus-4-8" },
			{ id: "xai", name: "xAI", product: "Grok", defaultModelId: "grok-4.5" },
		]);
		expect(intelligenceSelectionForProvider("openai-codex")).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.5",
		});
	});

	it("looks up only supported provider identifiers", () => {
		expect(isIntelligenceProviderId("anthropic")).toBe(true);
		expect(isIntelligenceProviderId("openai")).toBe(false);
		expect(intelligenceProvider("xai")?.product).toBe("Grok");
		expect(intelligenceProvider("unknown")).toBeUndefined();
		expect(intelligenceSelectionForProvider("unknown")).toBeUndefined();
	});

	it("keeps a stored selection when its provider is connected", () => {
		expect(
			resolveIntelligenceReadiness(["anthropic", "xai"], {
				provider: "xai",
				modelId: "grok-custom",
			}),
		).toEqual({
			ready: true,
			selection: { provider: "xai", modelId: "grok-custom" },
			selectionSource: "stored",
			connectedProviderIds: ["anthropic", "xai"],
			requiresChoice: false,
		});
	});

	it("infers the catalog default when exactly one provider is connected", () => {
		expect(
			resolveIntelligenceReadiness(["unrelated", "anthropic"], {
				provider: "xai",
				modelId: "grok-4.5",
			}),
		).toEqual({
			ready: true,
			selection: { provider: "anthropic", modelId: "claude-opus-4-8" },
			selectionSource: "inferred",
			connectedProviderIds: ["anthropic"],
			requiresChoice: false,
		});
	});

	it("requires a choice for ambiguous configured providers", () => {
		expect(resolveIntelligenceReadiness(["xai", "openai-codex"])).toEqual({
			ready: false,
			connectedProviderIds: ["openai-codex", "xai"],
			requiresChoice: true,
		});
	});

	it("is not ready when no supported provider is connected", () => {
		expect(resolveIntelligenceReadiness(["openai", "github-copilot"])).toEqual({
			ready: false,
			connectedProviderIds: [],
			requiresChoice: false,
		});
	});
});
