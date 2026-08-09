import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

export const LITELLM_RATES_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const RATES_TIMEOUT_MS = 10_000;

export interface UsageTokenTotals {
	uncachedInputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	outputTokens: number;
	reasoningTokens: number;
}

export interface ModelRate {
	inputCostPerToken: number;
	outputCostPerToken: number;
	cacheReadCostPerToken: number;
	cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;
export type UsageCostSource = "providerReported" | "modelPriced" | "unpriced";
export type UsagePricingStatus = "fresh" | "cached" | "unavailable";

export interface UsagePricing {
	status: UsagePricingStatus;
	source: string;
	fetchedAt: string | null;
	knownModels: number;
}

export interface UsageRateCatalog {
	rates: RateTable;
	pricing: UsagePricing;
}

interface LiteLlmEntry {
	input_cost_per_token?: unknown;
	output_cost_per_token?: unknown;
	cache_read_input_token_cost?: unknown;
	cache_creation_input_token_cost?: unknown;
}

interface CachedRates {
	fetchedAtMs: number;
	document: unknown;
}

interface MemoryRates {
	cachePath: string;
	rates: RateTable;
	fetchedAtMs: number | null;
	status: UsagePricingStatus;
}

let memoryRates: MemoryRates | undefined;
let pendingRates: Promise<UsageRateCatalog> | undefined;

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeUsageModelName(model: string): string {
	const trimmed = model.trim().toLowerCase();
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export function parseUsageRateTable(document: unknown): RateTable {
	const table = new Map<string, ModelRate>();
	if (typeof document !== "object" || document === null) return table;

	for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as LiteLlmEntry;
		const input = finiteNumber(entry.input_cost_per_token);
		const output = finiteNumber(entry.output_cost_per_token);
		if (input === null || output === null) continue;
		table.set(normalizeUsageModelName(name), {
			inputCostPerToken: input,
			outputCostPerToken: output,
			cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
			cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
		});
	}
	return table;
}

const UNPRICEABLE_MODELS = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);

export function lookupUsageRate(table: RateTable, model: string): ModelRate | null {
	const normalized = normalizeUsageModelName(model);
	if (!normalized || UNPRICEABLE_MODELS.has(normalized)) return null;
	return table.get(normalized) ?? null;
}

export function priceUsage(
	table: RateTable,
	model: string,
	totals: UsageTokenTotals,
	reportedCostUsd: number | null,
): { costUsd: number; costSource: UsageCostSource } {
	if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
		return { costUsd: reportedCostUsd, costSource: "providerReported" };
	}
	const rate = lookupUsageRate(table, model);
	if (!rate) return { costUsd: 0, costSource: "unpriced" };
	return {
		costUsd:
			totals.uncachedInputTokens * rate.inputCostPerToken +
			totals.cachedInputTokens * rate.cacheReadCostPerToken +
			totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
			totals.outputTokens * rate.outputCostPerToken,
		costSource: "modelPriced",
	};
}

export function cacheSavingsUsd(table: RateTable, model: string, totals: UsageTokenTotals): number {
	const rate = lookupUsageRate(table, model);
	if (!rate) return 0;
	return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken);
}

function asCachedRates(value: unknown): CachedRates | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.fetchedAtMs !== "number" || !Number.isFinite(record.fetchedAtMs)) return undefined;
	return { fetchedAtMs: record.fetchedAtMs, document: record.document };
}

function pricing(memory: MemoryRates): UsageRateCatalog {
	return {
		rates: memory.rates,
		pricing: {
			status: memory.status,
			source: LITELLM_RATES_URL,
			fetchedAt: memory.fetchedAtMs === null ? null : new Date(memory.fetchedAtMs).toISOString(),
			knownModels: memory.rates.size,
		},
	};
}

function loadCachedRates(cachePath: string): MemoryRates | undefined {
	if (!existsSync(cachePath)) return undefined;
	try {
		const cached = asCachedRates(JSON.parse(readFileSync(cachePath, "utf-8")) as unknown);
		if (!cached) return undefined;
		const rates = parseUsageRateTable(cached.document);
		if (rates.size === 0) return undefined;
		return { cachePath, rates, fetchedAtMs: cached.fetchedAtMs, status: "cached" };
	} catch {
		return undefined;
	}
}

async function fetchRateDocument(): Promise<unknown | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RATES_TIMEOUT_MS);
	try {
		const response = await fetch(LITELLM_RATES_URL, { signal: controller.signal });
		if (!response.ok) return undefined;
		return (await response.json()) as unknown;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

async function refreshUsageRateCatalog(cachePath: string): Promise<UsageRateCatalog> {
	const now = Date.now();
	if (!memoryRates || memoryRates.cachePath !== cachePath) {
		memoryRates = loadCachedRates(cachePath) ?? {
			cachePath,
			rates: new Map<string, ModelRate>(),
			fetchedAtMs: null,
			status: "unavailable",
		};
	}
	if (memoryRates.fetchedAtMs !== null && now - memoryRates.fetchedAtMs < RATES_TTL_MS) {
		return pricing(memoryRates);
	}

	const document = await fetchRateDocument();
	if (document === undefined) {
		if (memoryRates.rates.size > 0) memoryRates.status = "cached";
		return pricing(memoryRates);
	}
	const rates = parseUsageRateTable(document);
	if (rates.size === 0) return pricing(memoryRates);

	memoryRates = { cachePath, rates, fetchedAtMs: now, status: "fresh" };
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify({ fetchedAtMs: now, document }), "utf-8");
	} catch {
		// Pricing remains usable in memory when the cache directory is read-only.
	}
	return pricing(memoryRates);
}

export function readUsageRateCatalog(): Promise<UsageRateCatalog> {
	if (!pendingRates) {
		const cachePath = join(getAgentDir(), "usage-model-rates.json");
		pendingRates = refreshUsageRateCatalog(cachePath).finally(() => {
			pendingRates = undefined;
		});
	}
	return pendingRates;
}
