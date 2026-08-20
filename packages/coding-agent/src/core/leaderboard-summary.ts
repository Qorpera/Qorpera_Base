import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { canonicalCompanyRoot } from "./company.ts";
import { isPublicSessionGroup } from "./session-visibility.ts";
import { type CompanyUsageWindow, companyUsageWindowError } from "./usage-summary.ts";

/**
 * Leaderboard activity: per-staff working time, completed autonomous runs, and
 * founder requests, derived from the same durable trail the session catalog and
 * usage summary already read. Nothing here is a second source of truth — a
 * trail entry either exists with a host-stamped timestamp or it does not count.
 */

export interface LeaderboardStaffActivity {
	staffAgentId: string;
	/** Clustered active working time within the window (see WORK_GAP_MS). */
	activeMs: number;
	/** Autonomous runs that reached a verified successful terminal state. */
	tasksDone: number;
	/** Attended founder inputs addressed to this agent's sessions. */
	requests: number;
	/** Sessions with at least one in-window work entry. */
	sessions: number;
}

export interface LeaderboardCoverage {
	scannedSessions: number;
	cachedSessions: number;
	unreadableSessions: number;
	/** Public sessions with activity but no staff identity (legacy trails). */
	unattributedSessions: number;
}

export interface CompanyLeaderboardActivity extends CompanyUsageWindow {
	readAt: string;
	/** Company totals, so a leading row never implies more than it is. */
	totals: { activeMs: number; tasksDone: number; requests: number };
	staff: LeaderboardStaffActivity[];
	coverage: LeaderboardCoverage;
}

/** Work separated by more than this gap belongs to different activity bursts.
 * Within a burst, request→work and work→work segments count as agent working
 * time; work→request segments are founder thinking/typing time and never
 * count. */
const WORK_GAP_MS = 5 * 60_000;
const MAX_CACHED_COMPANIES = 8;
const EVENT_LOOP_YIELD_INTERVAL = 2_000;

interface TimelinePoint {
	timestampMs: number;
	kind: "request" | "work";
}

interface ParsedLeaderboardTrail {
	staffAgentId?: string;
	publicGroup: boolean;
	autonomous: boolean;
	/** Attended founder inputs (host-stamped qorpera_kernel_input entries). */
	requestTimestamps: number[];
	/** Assistant and tool-result entry timestamps: evidence of agent work. */
	workTimestamps: number[];
	/** When an autonomous run reached verified success, if it did. */
	succeededAtMs?: number;
}

interface LeaderboardFileIdentity {
	inode: number;
	size: number;
	mtimeMs: number;
}

interface LeaderboardFileCacheEntry extends LeaderboardFileIdentity {
	value?: ParsedLeaderboardTrail;
	pending?: Promise<ParsedLeaderboardTrail>;
}

const leaderboardFileCaches = new Map<string, Map<string, LeaderboardFileCacheEntry>>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function entryTimestampMs(entry: Record<string, unknown>, payload?: Record<string, unknown>): number | undefined {
	const own = entry.timestamp;
	if (typeof own === "string") {
		const parsed = Date.parse(own);
		if (Number.isFinite(parsed)) return parsed;
	}
	const inner = payload?.timestamp;
	if (typeof inner === "number" && Number.isFinite(inner)) return inner;
	if (typeof inner === "string") {
		const parsed = Date.parse(inner);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function parseLeaderboardTrail(content: string): Promise<ParsedLeaderboardTrail> {
	const parsed: ParsedLeaderboardTrail = {
		publicGroup: true,
		autonomous: false,
		requestTimestamps: [],
		workTimestamps: [],
	};
	// Verified success mirrors the session catalog: a completed kernel intent
	// plus an assistant turn that stopped on its own.
	let lastAssistantStopReason: string | undefined;
	let intentStatus: string | undefined;
	let terminalAtMs: number | undefined;
	const lines = content.split("\n");
	for (const [lineIndex, line] of lines.entries()) {
		if (lineIndex > 0 && lineIndex % EVENT_LOOP_YIELD_INTERVAL === 0) await yieldToEventLoop();
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			const record = asRecord(JSON.parse(line) as unknown);
			if (!record) continue;
			entry = record;
		} catch {
			// Foreign or torn lines never block activity accounting.
			continue;
		}

		if (entry.type === "session") {
			const authority = asRecord(entry.qorpera);
			if (typeof authority?.staffAgentId === "string") parsed.staffAgentId = authority.staffAgentId;
			if (authority?.autonomous === true) parsed.autonomous = true;
			if (!isPublicSessionGroup(typeof authority?.group === "string" ? authority.group : undefined)) {
				parsed.publicGroup = false;
			}
			continue;
		}
		if (entry.type === "custom" && entry.customType === "qorpera_kernel_input") {
			const data = asRecord(entry.data);
			const timestamp = entryTimestampMs(entry);
			// Only attended inputs are founder requests; kernel-authored frames
			// (staff intros, wakes) carry attended: false.
			if (data?.attended === true && timestamp !== undefined) parsed.requestTimestamps.push(timestamp);
			continue;
		}
		if (entry.type === "custom" && entry.customType === "qorpera_kernel_model_request") {
			const data = asRecord(entry.data);
			if (data?.event !== "intent" || typeof data.status !== "string") continue;
			intentStatus = data.status;
			const timestamp = entryTimestampMs(entry);
			if (timestamp !== undefined && ["completed", "failed", "aborted"].includes(data.status)) {
				terminalAtMs = timestamp;
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const payload = asRecord(entry.message);
		if (!payload) continue;
		if (payload.role !== "assistant" && payload.role !== "toolResult") continue;
		const timestamp = entryTimestampMs(entry, payload);
		if (timestamp !== undefined) parsed.workTimestamps.push(timestamp);
		if (payload.role === "assistant" && typeof payload.stopReason === "string") {
			lastAssistantStopReason = payload.stopReason;
			if (payload.stopReason !== "toolUse" && timestamp !== undefined) terminalAtMs = timestamp;
		}
	}
	parsed.requestTimestamps.sort((left, right) => left - right);
	parsed.workTimestamps.sort((left, right) => left - right);
	if (parsed.autonomous && intentStatus === "completed" && lastAssistantStopReason === "stop") {
		parsed.succeededAtMs = terminalAtMs ?? parsed.workTimestamps.at(-1);
	}
	return parsed;
}

function companyCache(root: string): Map<string, LeaderboardFileCacheEntry> {
	const existing = leaderboardFileCaches.get(root);
	if (existing) {
		leaderboardFileCaches.delete(root);
		leaderboardFileCaches.set(root, existing);
		return existing;
	}
	const created = new Map<string, LeaderboardFileCacheEntry>();
	leaderboardFileCaches.set(root, created);
	while (leaderboardFileCaches.size > MAX_CACHED_COMPANIES) {
		const oldest = leaderboardFileCaches.keys().next().value;
		if (oldest === undefined) break;
		leaderboardFileCaches.delete(oldest);
	}
	return created;
}

async function loadLeaderboardTrail(
	cache: Map<string, LeaderboardFileCacheEntry>,
	trailDir: string,
	file: string,
): Promise<{ trail: ParsedLeaderboardTrail; cached: boolean }> {
	const path = join(trailDir, file);
	const current = await stat(path);
	if (!current.isFile()) throw new Error("trail session must be a file");
	const identity: LeaderboardFileIdentity = { inode: current.ino, size: current.size, mtimeMs: current.mtimeMs };
	const existing = cache.get(file);
	if (
		existing &&
		existing.inode === identity.inode &&
		existing.size === identity.size &&
		existing.mtimeMs === identity.mtimeMs
	) {
		if (existing.value) return { trail: existing.value, cached: true };
		if (existing.pending) return { trail: await existing.pending, cached: true };
	}

	const entry: LeaderboardFileCacheEntry = { ...identity };
	const pending = (async () => {
		const handle = await open(path, "r");
		try {
			return await parseLeaderboardTrail(await handle.readFile({ encoding: "utf-8" }));
		} finally {
			await handle.close();
		}
	})();
	entry.pending = pending;
	cache.set(file, entry);
	try {
		const value = await pending;
		if (cache.get(file) === entry) {
			entry.value = value;
			entry.pending = undefined;
		}
		return { trail: value, cached: false };
	} catch (error) {
		if (cache.get(file) === entry) cache.delete(file);
		throw error;
	}
}

function windowDayFormatter(timeZone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

function dayOf(timestampMs: number, formatter: Intl.DateTimeFormat): string | undefined {
	if (!Number.isFinite(timestampMs)) return undefined;
	try {
		const parts = formatter.formatToParts(new Date(timestampMs));
		const values = new Map(parts.map((part) => [part.type, part.value]));
		const year = values.get("year");
		const month = values.get("month");
		const day = values.get("day");
		return year && month && day ? `${year}-${month}-${day}` : undefined;
	} catch {
		return undefined;
	}
}

/** Active working time: walk the merged request/work timeline and count the
 * segments that end in observed work. Bounding each segment by WORK_GAP_MS
 * keeps an idle overnight trail from billing the hours nobody worked. */
function activeMsWithinWindow(
	points: TimelinePoint[],
	formatter: Intl.DateTimeFormat,
	window: CompanyUsageWindow,
): number {
	const inWindow = (timestampMs: number): boolean => {
		const day = dayOf(timestampMs, formatter);
		return day !== undefined && day >= window.sinceDay && day <= window.untilDay;
	};
	let total = 0;
	for (let index = 1; index < points.length; index += 1) {
		const previous = points[index - 1];
		const point = points[index];
		if (point.kind !== "work") continue;
		const gap = point.timestampMs - previous.timestampMs;
		if (gap <= 0 || gap > WORK_GAP_MS) continue;
		if (!inWindow(point.timestampMs) || !inWindow(previous.timestampMs)) continue;
		total += gap;
	}
	return total;
}

function mergedTimeline(trail: ParsedLeaderboardTrail): TimelinePoint[] {
	const points: TimelinePoint[] = [
		...trail.requestTimestamps.map((timestampMs) => ({ timestampMs, kind: "request" as const })),
		...trail.workTimestamps.map((timestampMs) => ({ timestampMs, kind: "work" as const })),
	];
	return points.sort((left, right) => left.timestampMs - right.timestampMs);
}

export async function readCompanyLeaderboardActivity(
	root: string,
	window: CompanyUsageWindow,
): Promise<CompanyLeaderboardActivity> {
	const windowError = companyUsageWindowError(window);
	if (windowError) throw new Error(windowError);
	const canonicalRoot = canonicalCompanyRoot(root);
	const trailDir = join(canonicalRoot, "trail");
	const formatter = windowDayFormatter(window.timeZone);
	const inWindow = (timestampMs: number): boolean => {
		const day = dayOf(timestampMs, formatter);
		return day !== undefined && day >= window.sinceDay && day <= window.untilDay;
	};
	let files: string[];
	try {
		files = (await readdir(trailDir, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map((entry) => entry.name)
			.sort();
	} catch {
		files = [];
	}
	const cache = companyCache(canonicalRoot);
	const present = new Set(files);
	for (const cachedFile of cache.keys()) {
		if (!present.has(cachedFile)) cache.delete(cachedFile);
	}

	const staffTotals = new Map<string, Omit<LeaderboardStaffActivity, "staffAgentId">>();
	const coverage: LeaderboardCoverage = {
		scannedSessions: 0,
		cachedSessions: 0,
		unreadableSessions: 0,
		unattributedSessions: 0,
	};

	for (const file of files) {
		coverage.scannedSessions += 1;
		let trail: ParsedLeaderboardTrail;
		try {
			const loaded = await loadLeaderboardTrail(cache, trailDir, file);
			trail = loaded.trail;
			if (loaded.cached) coverage.cachedSessions += 1;
		} catch {
			coverage.unreadableSessions += 1;
			continue;
		}
		if (!trail.publicGroup) continue;
		const requests = trail.requestTimestamps.filter(inWindow).length;
		const activeMs = activeMsWithinWindow(mergedTimeline(trail), formatter, window);
		const worked = trail.workTimestamps.some(inWindow);
		const tasksDone = trail.succeededAtMs !== undefined && inWindow(trail.succeededAtMs) ? 1 : 0;
		if (!worked && activeMs === 0 && requests === 0 && tasksDone === 0) continue;
		if (!trail.staffAgentId) {
			coverage.unattributedSessions += 1;
			continue;
		}
		const totals = staffTotals.get(trail.staffAgentId) ?? { activeMs: 0, tasksDone: 0, requests: 0, sessions: 0 };
		totals.activeMs += activeMs;
		totals.tasksDone += tasksDone;
		totals.requests += requests;
		if (worked) totals.sessions += 1;
		staffTotals.set(trail.staffAgentId, totals);
	}

	const staff = Array.from(staffTotals, ([staffAgentId, totals]) => ({ staffAgentId, ...totals })).sort(
		(left, right) => right.activeMs - left.activeMs || left.staffAgentId.localeCompare(right.staffAgentId),
	);
	return {
		...window,
		readAt: new Date().toISOString(),
		totals: {
			activeMs: staff.reduce((sum, entry) => sum + entry.activeMs, 0),
			tasksDone: staff.reduce((sum, entry) => sum + entry.tasksDone, 0),
			requests: staff.reduce((sum, entry) => sum + entry.requests, 0),
		},
		staff,
		coverage,
	};
}
