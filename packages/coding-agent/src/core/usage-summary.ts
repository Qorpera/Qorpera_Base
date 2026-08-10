import type { Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { canonicalCompanyRoot } from "./company.ts";
import {
	cacheSavingsUsd,
	priceUsage,
	type UsageCostSource,
	type UsagePricing,
	type UsageRateCatalog,
	type UsageTokenTotals,
} from "./usage-pricing.ts";

export interface CompanyUsageWindow {
	sinceDay: string;
	untilDay: string;
	timeZone: string;
}

export interface CompanyUsageProviderTotals {
	provider: string;
	costUsd: number;
	totalTokens: number;
	records: number;
	costShare: number;
	tokenShare: number;
}

export interface CompanyUsageModelTotals {
	provider: string;
	model: string;
	costUsd: number;
	totalTokens: number;
	records: number;
	costShare: number;
}

export interface CompanyUsageDailyProviderTotals {
	provider: string;
	costUsd: number;
	totalTokens: number;
}

export interface CompanyUsageDailyTotals {
	day: string;
	costUsd: number;
	totalTokens: number;
	byProvider: CompanyUsageDailyProviderTotals[];
}

export interface CompanyUsageCoverage {
	scannedSessions: number;
	cachedSessions: number;
	contributingSessions: number;
	unreadableSessions: number;
	malformedLines: number;
	untimedRecords: number;
}

export interface CompanyUsageCostQuality {
	providerReportedShare: number;
	modelPricedShare: number;
	unpricedShare: number;
	cacheSavingsUsd: number;
}

export interface CompanyUsageSummary extends CompanyUsageWindow {
	readAt: string;
	costUsd: number;
	uncachedInputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	records: number;
	sessions: number;
	pricedRecords: number;
	unpricedRecords: number;
	costQuality: CompanyUsageCostQuality;
	pricing: UsagePricing;
	providers: CompanyUsageProviderTotals[];
	models: CompanyUsageModelTotals[];
	daily: CompanyUsageDailyTotals[];
	coverage: CompanyUsageCoverage;
}

interface UsageNumbers extends UsageTokenTotals {
	totalTokens: number;
}

interface CachedUsageRecord extends UsageNumbers {
	timestamp: number;
	provider: string;
	model: string;
	reportedCostUsd: number | null;
}

interface PricedUsageRecord extends CachedUsageRecord {
	day: string;
	costUsd: number;
	costSource: UsageCostSource;
}

interface UsageFileIdentity {
	device: number;
	inode: number;
	birthtimeMs: number;
	size: number;
	mtimeMs: number;
}

interface CachedUsageFile extends UsageFileIdentity {
	records: CachedUsageRecord[];
	malformedLines: number;
	untimedRecords: number;
	minTimestamp: number;
	maxTimestamp: number;
}

interface UsageFileCacheEntry extends UsageFileIdentity {
	value?: CachedUsageFile;
	pending?: Promise<CachedUsageFile>;
}

interface ModelIdentity {
	provider: string;
	model: string;
}

interface MutableTotals {
	costUsd: number;
	totalTokens: number;
	records: number;
}

interface MutableDailyTotals extends MutableTotals {
	byProvider: Map<string, MutableTotals>;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_WINDOW_DAYS = 366;
const MAX_CACHED_TRAIL_DIRECTORIES = 8;
const EVENT_LOOP_YIELD_INTERVAL = 2_000;
const MAX_TIME_ZONE_OFFSET_MS = 14 * 60 * 60 * 1_000;
const usageFileCaches = new Map<string, Map<string, UsageFileCacheEntry>>();

class CompanyUsageStorageError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function validDayValue(day: string): number | undefined {
	if (!DAY_PATTERN.test(day)) return undefined;
	const value = Date.parse(`${day}T00:00:00Z`);
	if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== day) return undefined;
	return value;
}

export function companyUsageWindowError(window: CompanyUsageWindow): string | undefined {
	const since = validDayValue(window.sinceDay);
	const until = validDayValue(window.untilDay);
	if (since === undefined || until === undefined || until < since) return "invalid day range";
	if ((until - since) / 86_400_000 + 1 > MAX_WINDOW_DAYS) return "usage window is too large";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: window.timeZone }).format(0);
	} catch {
		return "invalid time zone";
	}
	return undefined;
}

function dayInTimeZone(timestamp: number, formatter: Intl.DateTimeFormat): string | undefined {
	if (!Number.isFinite(timestamp)) return undefined;
	try {
		const parts = formatter.formatToParts(new Date(timestamp));
		const values = new Map(parts.map((part) => [part.type, part.value]));
		const year = values.get("year");
		const month = values.get("month");
		const day = values.get("day");
		return year && month && day ? `${year}-${month}-${day}` : undefined;
	} catch {
		return undefined;
	}
}

function timestampOf(entry: Record<string, unknown>, payload?: Record<string, unknown>): number | undefined {
	const entryTimestamp = entry.timestamp;
	if (typeof entryTimestamp === "string") {
		const parsed = Date.parse(entryTimestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	const payloadTimestamp = payload?.timestamp;
	if (typeof payloadTimestamp === "number" && Number.isFinite(payloadTimestamp)) return payloadTimestamp;
	if (typeof payloadTimestamp === "string") {
		const parsed = Date.parse(payloadTimestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function usageNumbers(value: unknown): UsageNumbers | undefined {
	const usage = asRecord(value);
	if (!usage) return undefined;
	const uncachedInputTokens = finiteNonNegative(usage.input);
	const outputTokens = finiteNonNegative(usage.output);
	const cachedInputTokens = finiteNonNegative(usage.cacheRead);
	const cacheCreationTokens = finiteNonNegative(usage.cacheWrite);
	const reasoningTokens = Math.min(outputTokens, finiteNonNegative(usage.reasoning));
	const componentTotal = uncachedInputTokens + outputTokens + cachedInputTokens + cacheCreationTokens;
	const reportedTotal = finiteNonNegative(usage.totalTokens);
	const totalTokens = componentTotal > 0 ? componentTotal : reportedTotal;
	if (totalTokens === 0) return undefined;
	return {
		uncachedInputTokens,
		cachedInputTokens,
		cacheCreationTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
	};
}

function nonEmptyString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function assistantIdentity(payload: Record<string, unknown>): ModelIdentity {
	return {
		provider: payload.api === "codex-app-server" ? "codex" : nonEmptyString(payload.provider, "unknown"),
		model: nonEmptyString(payload.responseModel, nonEmptyString(payload.model, "Unknown model")),
	};
}

function modelChangeIdentity(entry: Record<string, unknown>): ModelIdentity | undefined {
	if (entry.type === "model_change") {
		return {
			provider: nonEmptyString(entry.provider, "unknown"),
			model: nonEmptyString(entry.modelId, "Unknown model"),
		};
	}
	if (entry.type !== "message") return undefined;
	const payload = asRecord(entry.message);
	return payload?.role === "assistant" ? assistantIdentity(payload) : undefined;
}

function explicitCostUsd(entry: Record<string, unknown>, payload?: Record<string, unknown>): number | null {
	const value = entry.costUSD ?? payload?.costUSD;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageRecord(
	entry: Record<string, unknown>,
	activeModel: ModelIdentity | undefined,
): CachedUsageRecord | "untimed" | undefined {
	let usage: UsageNumbers | undefined;
	let payload: Record<string, unknown> | undefined;
	let identity: ModelIdentity = activeModel ?? { provider: "qorpera", model: "Summaries" };

	if (entry.type === "message") {
		payload = asRecord(entry.message);
		if (!payload) return undefined;
		if (payload.role === "assistant") {
			usage = usageNumbers(payload.usage);
			identity = assistantIdentity(payload);
		} else if (payload.role === "toolResult") {
			usage = usageNumbers(payload.usage);
			identity = { provider: "tools", model: nonEmptyString(payload.toolName, "Tool execution") };
		} else {
			return undefined;
		}
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		usage = usageNumbers(entry.usage);
	} else {
		return undefined;
	}

	if (!usage) return undefined;
	const timestamp = timestampOf(entry, payload);
	if (timestamp === undefined) return "untimed";
	return {
		...usage,
		timestamp,
		provider: identity.provider,
		model: identity.model,
		reportedCostUsd: explicitCostUsd(entry, payload),
	};
}

function trailCache(trailDir: string): Map<string, UsageFileCacheEntry> {
	const existing = usageFileCaches.get(trailDir);
	if (existing) {
		usageFileCaches.delete(trailDir);
		usageFileCaches.set(trailDir, existing);
		return existing;
	}

	const created = new Map<string, UsageFileCacheEntry>();
	usageFileCaches.set(trailDir, created);
	while (usageFileCaches.size > MAX_CACHED_TRAIL_DIRECTORIES) {
		const oldest = usageFileCaches.keys().next().value;
		if (oldest === undefined) break;
		usageFileCaches.delete(oldest);
	}
	return created;
}

async function parseUsageContent(content: string, identity: UsageFileIdentity): Promise<CachedUsageFile> {
	const records: CachedUsageRecord[] = [];
	let malformedLines = 0;
	let untimedRecords = 0;
	let minTimestamp = Number.POSITIVE_INFINITY;
	let maxTimestamp = Number.NEGATIVE_INFINITY;
	let activeModel: ModelIdentity | undefined;
	const lines = content.split("\n");
	for (const [lineIndex, line] of lines.entries()) {
		if (lineIndex > 0 && lineIndex % EVENT_LOOP_YIELD_INTERVAL === 0) await yieldToEventLoop();
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			const parsed = JSON.parse(line) as unknown;
			const record = asRecord(parsed);
			if (!record) {
				malformedLines += 1;
				continue;
			}
			entry = record;
		} catch {
			// A live session can be observed between the write and newline of its
			// newest record. Ignore that transient suffix instead of diagnosing it.
			if (lineIndex === lines.length - 1 && !content.endsWith("\n")) continue;
			malformedLines += 1;
			continue;
		}

		const record = usageRecord(entry, activeModel);
		activeModel = modelChangeIdentity(entry) ?? activeModel;
		if (record === "untimed") {
			untimedRecords += 1;
			continue;
		}
		if (!record) continue;
		records.push(record);
		minTimestamp = Math.min(minTimestamp, record.timestamp);
		maxTimestamp = Math.max(maxTimestamp, record.timestamp);
	}

	return { ...identity, records, malformedLines, untimedRecords, minTimestamp, maxTimestamp };
}

function normalizedPath(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePhysicalFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameFileVersion(left: Stats, right: Stats): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function identityOf(file: Stats): UsageFileIdentity {
	return {
		device: file.dev,
		inode: file.ino,
		birthtimeMs: file.birthtimeMs,
		size: file.size,
		mtimeMs: file.mtimeMs,
	};
}

function sameIdentity(left: UsageFileIdentity, right: UsageFileIdentity): boolean {
	return (
		left.device === right.device &&
		left.inode === right.inode &&
		left.birthtimeMs === right.birthtimeMs &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs
	);
}

async function physicalTrailDirectory(root: string): Promise<string> {
	const trailDir = join(canonicalCompanyRoot(root), "trail");
	try {
		const [actual, entry] = await Promise.all([realpath(trailDir), lstat(trailDir)]);
		if (normalizedPath(actual) !== normalizedPath(trailDir) || entry.isSymbolicLink() || !entry.isDirectory()) {
			throw new CompanyUsageStorageError("company trail must be one physical directory");
		}
		return actual;
	} catch (error) {
		if (error instanceof CompanyUsageStorageError) throw error;
		throw new CompanyUsageStorageError("company trail is missing or unreadable");
	}
}

async function readAndParseUsageFile(
	handle: FileHandle,
	path: string,
	trailDir: string,
	opened: Stats,
	identity: UsageFileIdentity,
): Promise<CachedUsageFile> {
	try {
		const content = await handle.readFile({ encoding: "utf-8" });
		const [completed, current, actual, trailAfterRead] = await Promise.all([
			handle.stat(),
			stat(path),
			realpath(path),
			realpath(trailDir),
		]);
		if (
			!samePhysicalFile(opened, completed) ||
			!samePhysicalFile(opened, current) ||
			completed.nlink !== 1 ||
			current.nlink !== 1 ||
			normalizedPath(actual) !== normalizedPath(path) ||
			normalizedPath(trailAfterRead) !== normalizedPath(trailDir)
		) {
			throw new CompanyUsageStorageError("company trail changed identity while usage was read");
		}
		if (!sameFileVersion(opened, completed) || !sameFileVersion(opened, current)) {
			throw new Error("usage trail session changed while it was read");
		}
		return await parseUsageContent(content, identity);
	} finally {
		await handle.close();
	}
}

async function loadUsageFile(
	cache: Map<string, UsageFileCacheEntry>,
	file: string,
	trailDir: string,
): Promise<{ file: CachedUsageFile; cached: boolean }> {
	const path = join(trailDir, file);
	const handle = await open(path, "r");
	let handleOwner = true;
	try {
		const opened = await handle.stat();
		const [current, actual, trailAfterOpen] = await Promise.all([stat(path), realpath(path), realpath(trailDir)]);
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			current.nlink !== 1 ||
			!samePhysicalFile(opened, current) ||
			normalizedPath(actual) !== normalizedPath(path) ||
			normalizedPath(trailAfterOpen) !== normalizedPath(trailDir)
		) {
			throw new CompanyUsageStorageError("usage trail session must be one physical file");
		}
		if (!sameFileVersion(opened, current)) throw new Error("usage trail session changed before it was read");
		const identity = identityOf(opened);
		const cached = cache.get(file);
		if (cached && sameIdentity(cached, identity)) {
			if (cached.value) return { file: cached.value, cached: true };
			if (cached.pending) return { file: await cached.pending, cached: true };
		}

		const entry: UsageFileCacheEntry = { ...identity };
		const pending = readAndParseUsageFile(handle, path, trailDir, opened, identity);
		handleOwner = false;
		entry.pending = pending;
		cache.set(file, entry);
		try {
			const value = await pending;
			if (cache.get(file) === entry) {
				entry.value = value;
				entry.pending = undefined;
			}
			return { file: value, cached: false };
		} catch (error) {
			if (cache.get(file) === entry) cache.delete(file);
			throw error;
		}
	} finally {
		if (handleOwner) await handle.close();
	}
}

function mutableTotals(): MutableTotals {
	return { costUsd: 0, totalTokens: 0, records: 0 };
}

function addRecord(totals: MutableTotals, record: PricedUsageRecord): void {
	totals.costUsd += record.costUsd;
	totals.totalTokens += record.totalTokens;
	totals.records += 1;
}

function addToMap(map: Map<string, MutableTotals>, key: string, record: PricedUsageRecord): void {
	let totals = map.get(key);
	if (!totals) {
		totals = mutableTotals();
		map.set(key, totals);
	}
	addRecord(totals, record);
}

/**
 * Aggregate the active company's durable trail. Token counts and attribution
 * come only from that trail; API-equivalent cost is reconstructed against the
 * same LiteLLM rate shape used by T3 Code.
 */
export async function readCompanyUsage(
	root: string,
	window: CompanyUsageWindow,
	rateCatalog: UsageRateCatalog,
): Promise<CompanyUsageSummary> {
	const windowError = companyUsageWindowError(window);
	if (windowError) throw new Error(windowError);
	const dayFormatter = new Intl.DateTimeFormat("en-US", {
		timeZone: window.timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const earliestTimestamp = Date.parse(`${window.sinceDay}T00:00:00Z`) - MAX_TIME_ZONE_OFFSET_MS;
	const latestTimestamp = Date.parse(`${window.untilDay}T00:00:00Z`) + 86_400_000 + MAX_TIME_ZONE_OFFSET_MS;

	const providerTotals = new Map<string, MutableTotals>();
	const modelTotals = new Map<string, MutableTotals>();
	const dailyTotals = new Map<string, MutableDailyTotals>();
	let costUsd = 0;
	let uncachedInputTokens = 0;
	let cachedInputTokens = 0;
	let cacheCreationTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let records = 0;
	let pricedRecords = 0;
	let unpricedRecords = 0;
	let providerReportedRecords = 0;
	let modelPricedRecords = 0;
	let totalCacheSavingsUsd = 0;
	let scannedSessions = 0;
	let cachedSessions = 0;
	let contributingSessions = 0;
	let unreadableSessions = 0;
	let malformedLines = 0;
	let untimedRecords = 0;
	let visitedRecords = 0;

	const trailDir = await physicalTrailDirectory(root);
	const trailEntries = await readdir(trailDir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of trailEntries) {
		if (!entry.name.endsWith(".jsonl")) continue;
		if (!entry.isFile()) {
			throw new CompanyUsageStorageError("usage trail sessions must be physical files");
		}
		files.push(entry.name);
	}
	files.sort();
	const cache = trailCache(trailDir);
	const currentFiles = new Set(files);
	for (const cachedFile of cache.keys()) {
		if (!currentFiles.has(cachedFile)) cache.delete(cachedFile);
	}

	for (const file of files) {
		scannedSessions += 1;
		let usageFile: CachedUsageFile;
		try {
			const loaded = await loadUsageFile(cache, file, trailDir);
			usageFile = loaded.file;
			if (loaded.cached) cachedSessions += 1;
		} catch (error) {
			cache.delete(file);
			if (error instanceof CompanyUsageStorageError) throw error;
			unreadableSessions += 1;
			continue;
		}
		malformedLines += usageFile.malformedLines;
		untimedRecords += usageFile.untimedRecords;
		if (usageFile.maxTimestamp < earliestTimestamp || usageFile.minTimestamp >= latestTimestamp) continue;

		let contributed = false;
		for (const record of usageFile.records) {
			visitedRecords += 1;
			if (visitedRecords % EVENT_LOOP_YIELD_INTERVAL === 0) await yieldToEventLoop();
			if (record.timestamp < earliestTimestamp || record.timestamp >= latestTimestamp) continue;
			const day = dayInTimeZone(record.timestamp, dayFormatter);
			if (!day) {
				untimedRecords += 1;
				continue;
			}
			if (day < window.sinceDay || day > window.untilDay) continue;
			const priced = priceUsage(rateCatalog.rates, record.model, record, record.reportedCostUsd);
			const pricedRecord: PricedUsageRecord = { ...record, day, ...priced };

			contributed = true;
			costUsd += pricedRecord.costUsd;
			uncachedInputTokens += pricedRecord.uncachedInputTokens;
			cachedInputTokens += pricedRecord.cachedInputTokens;
			cacheCreationTokens += pricedRecord.cacheCreationTokens;
			outputTokens += pricedRecord.outputTokens;
			reasoningTokens += pricedRecord.reasoningTokens;
			totalCacheSavingsUsd += cacheSavingsUsd(rateCatalog.rates, pricedRecord.model, pricedRecord);
			records += 1;
			if (pricedRecord.costSource === "unpriced") unpricedRecords += 1;
			else {
				pricedRecords += 1;
				if (pricedRecord.costSource === "providerReported") providerReportedRecords += 1;
				else modelPricedRecords += 1;
			}

			addToMap(providerTotals, pricedRecord.provider, pricedRecord);
			addToMap(modelTotals, `${pricedRecord.provider}\u0000${pricedRecord.model}`, pricedRecord);
			let daily = dailyTotals.get(pricedRecord.day);
			if (!daily) {
				daily = { ...mutableTotals(), byProvider: new Map<string, MutableTotals>() };
				dailyTotals.set(pricedRecord.day, daily);
			}
			addRecord(daily, pricedRecord);
			addToMap(daily.byProvider, pricedRecord.provider, pricedRecord);
		}
		if (contributed) contributingSessions += 1;
	}

	const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;
	const providers = Array.from(providerTotals, ([provider, totals]) => ({
		provider,
		...totals,
		costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
		tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
	})).sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens);
	const models = Array.from(modelTotals, ([key, totals]) => {
		const separator = key.indexOf("\u0000");
		return {
			provider: key.slice(0, separator),
			model: key.slice(separator + 1),
			...totals,
			costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
		};
	}).sort((left, right) => right.costUsd - left.costUsd || right.totalTokens - left.totalTokens);
	const daily = Array.from(dailyTotals, ([day, totals]) => ({
		day,
		costUsd: totals.costUsd,
		totalTokens: totals.totalTokens,
		byProvider: Array.from(totals.byProvider, ([provider, providerDay]) => ({
			provider,
			costUsd: providerDay.costUsd,
			totalTokens: providerDay.totalTokens,
		})).sort((left, right) => left.provider.localeCompare(right.provider)),
	})).sort((left, right) => left.day.localeCompare(right.day));

	return {
		...window,
		readAt: new Date().toISOString(),
		costUsd,
		uncachedInputTokens,
		cachedInputTokens,
		cacheCreationTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
		records,
		sessions: contributingSessions,
		pricedRecords,
		unpricedRecords,
		costQuality: {
			providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
			modelPricedShare: records === 0 ? 0 : modelPricedRecords / records,
			unpricedShare: records === 0 ? 0 : unpricedRecords / records,
			cacheSavingsUsd: totalCacheSavingsUsd,
		},
		pricing: rateCatalog.pricing,
		providers,
		models,
		daily,
		coverage: {
			scannedSessions,
			cachedSessions,
			contributingSessions,
			unreadableSessions,
			malformedLines,
			untimedRecords,
		},
	};
}
