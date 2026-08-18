import type { RuntimeModelSelection } from "./runtime-model.ts";

export const INTELLIGENCE_PROVIDER_CATALOG = [
	{
		id: "openai-codex",
		name: "OpenAI",
		product: "GPT",
		defaultModelId: "gpt-5.5",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		product: "Claude",
		defaultModelId: "claude-opus-4-8",
	},
	{
		id: "xai",
		name: "xAI",
		product: "Grok",
		defaultModelId: "grok-4.5",
	},
] as const;

export type IntelligenceProviderId = (typeof INTELLIGENCE_PROVIDER_CATALOG)[number]["id"];

export type IntelligenceProviderDefinition = (typeof INTELLIGENCE_PROVIDER_CATALOG)[number];

export interface IntelligenceReadiness {
	ready: boolean;
	selection?: RuntimeModelSelection;
	selectionSource?: "stored" | "inferred";
	connectedProviderIds: IntelligenceProviderId[];
	requiresChoice: boolean;
}

export function isIntelligenceProviderId(value: string): value is IntelligenceProviderId {
	return INTELLIGENCE_PROVIDER_CATALOG.some((provider) => provider.id === value);
}

export function intelligenceProvider(providerId: string): IntelligenceProviderDefinition | undefined {
	return INTELLIGENCE_PROVIDER_CATALOG.find((provider) => provider.id === providerId);
}

export function intelligenceSelectionForProvider(providerId: string): RuntimeModelSelection | undefined {
	const provider = intelligenceProvider(providerId);
	return provider ? { provider: provider.id, modelId: provider.defaultModelId } : undefined;
}

/**
 * Resolve onboarding without storage or provider-runtime side effects.
 *
 * A stored selection wins while its target provider remains connected. When
 * exactly one supported provider is connected, its catalog default is the
 * unambiguous inferred selection. Multiple connected providers require an
 * explicit founder choice unless a stored selection already disambiguates
 * them. Unknown providers are outside the first-run intelligence contract.
 */
export function resolveIntelligenceReadiness(
	connectedProviderIds: Iterable<string>,
	storedSelection?: RuntimeModelSelection,
): IntelligenceReadiness {
	const connected = new Set(connectedProviderIds);
	const supportedConnected = INTELLIGENCE_PROVIDER_CATALOG.flatMap((provider) =>
		connected.has(provider.id) ? [provider.id] : [],
	);
	if (
		storedSelection &&
		isIntelligenceProviderId(storedSelection.provider) &&
		connected.has(storedSelection.provider)
	) {
		return {
			ready: true,
			selection: { ...storedSelection },
			selectionSource: "stored",
			connectedProviderIds: supportedConnected,
			requiresChoice: false,
		};
	}
	if (supportedConnected.length === 1) {
		return {
			ready: true,
			selection: intelligenceSelectionForProvider(supportedConnected[0]),
			selectionSource: "inferred",
			connectedProviderIds: supportedConnected,
			requiresChoice: false,
		};
	}
	return {
		ready: false,
		connectedProviderIds: supportedConnected,
		requiresChoice: supportedConnected.length > 1,
	};
}
