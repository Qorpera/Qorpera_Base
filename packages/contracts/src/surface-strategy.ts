import type { SurfaceEpistemicTier } from "./surface-economics.ts";

export const STRATEGY_PLAY_STATUSES = ["recommended", "active", "exploring", "parked", "rejected"] as const;
export type StrategyPlayStatus = (typeof STRATEGY_PLAY_STATUSES)[number];

export interface StrategyPlay {
	readonly id: string;
	readonly name: string;
	readonly thesis: string;
	readonly status: StrategyPlayStatus;
	readonly revenueModel?: string;
	readonly whoPays?: string;
	readonly unitMargin?: string;
	readonly capacityCeiling?: string;
	readonly moat?: string;
	readonly killRisk?: string;
	readonly nextMove?: string;
	readonly pros?: readonly string[];
	readonly cons?: readonly string[];
	readonly tier?: SurfaceEpistemicTier;
	readonly source?: string;
}

export interface StrategyPlaysDocument {
	readonly summary?: string;
	readonly verdict?: string;
	readonly plays: readonly StrategyPlay[];
}

export const STRATEGY_HYPOTHESIS_STATUSES = ["untested", "testing", "proven", "falsified"] as const;
export type StrategyHypothesisStatus = (typeof STRATEGY_HYPOTHESIS_STATUSES)[number];

export const STRATEGY_HYPOTHESIS_IMPACTS = ["fatal", "high", "medium"] as const;
export type StrategyHypothesisImpact = (typeof STRATEGY_HYPOTHESIS_IMPACTS)[number];

export interface StrategyHypothesis {
	readonly id: string;
	readonly bet: string;
	readonly tier: SurfaceEpistemicTier;
	readonly status: StrategyHypothesisStatus;
	readonly impact: StrategyHypothesisImpact;
	readonly cheapestTest?: string;
	readonly killCriteria?: string;
	readonly evidence?: string;
	readonly source?: string;
	readonly owner?: string;
	readonly playId?: string;
}

export interface StrategyHypothesesDocument {
	readonly summary?: string;
	readonly hypotheses: readonly StrategyHypothesis[];
}

export interface StrategyLandscapeAxes {
	readonly xLabel: string;
	readonly yLabel: string;
	readonly xLow?: string;
	readonly xHigh?: string;
	readonly yLow?: string;
	readonly yHigh?: string;
}

export interface StrategyRival {
	readonly id?: string;
	readonly name: string;
	readonly isUs?: boolean;
	readonly url?: string;
	readonly category?: string;
	readonly positioning?: string;
	readonly pricing?: string;
	readonly target?: string;
	readonly strength?: string;
	readonly weakness?: string;
	readonly ourEdge?: string;
	readonly tier?: SurfaceEpistemicTier;
	readonly source?: string;
	readonly x?: number;
	readonly y?: number;
}

export interface StrategyLandscapeDocument {
	readonly summary?: string;
	readonly wedge?: string;
	readonly axes?: StrategyLandscapeAxes;
	readonly players: readonly StrategyRival[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asTextList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.flatMap((entry) => {
		const text = asText(entry);
		return text ? [text] : [];
	});
	return items.length > 0 ? items : undefined;
}

function asTier(value: unknown): SurfaceEpistemicTier | undefined {
	if (value === "verified" || value === "benchmark" || value === "hypothesis") return value;
	return undefined;
}

function asPlayStatus(value: unknown): StrategyPlayStatus {
	if (
		value === "recommended" ||
		value === "active" ||
		value === "exploring" ||
		value === "parked" ||
		value === "rejected"
	) {
		return value;
	}
	return "exploring";
}

function asHypothesisStatus(value: unknown): StrategyHypothesisStatus {
	if (value === "untested" || value === "testing" || value === "proven" || value === "falsified") return value;
	return "untested";
}

function asHypothesisImpact(value: unknown): StrategyHypothesisImpact {
	if (value === "fatal" || value === "high" || value === "medium") return value;
	return "high";
}

function asCoord(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

function slugId(raw: string, fallback: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return cleaned || fallback;
}

export function parseStrategyPlaysDocument(value: unknown): StrategyPlaysDocument | null {
	const rawList = Array.isArray(value)
		? value
		: isPlainRecord(value) && Array.isArray(value.plays)
			? value.plays
			: null;
	if (!rawList) return null;
	const plays: StrategyPlay[] = [];
	rawList.forEach((item, index) => {
		if (!isPlainRecord(item)) return;
		const name = asText(item.name) ?? asText(item.title);
		const thesis = asText(item.thesis) ?? asText(item.summary);
		if (!name || !thesis) return;
		const id = asText(item.id) ?? slugId(name, `play-${index + 1}`);
		const revenueModel = asText(item.revenueModel);
		const whoPays = asText(item.whoPays);
		const unitMargin = asText(item.unitMargin);
		const capacityCeiling = asText(item.capacityCeiling);
		const moat = asText(item.moat);
		const killRisk = asText(item.killRisk);
		const nextMove = asText(item.nextMove);
		const pros = asTextList(item.pros);
		const cons = asTextList(item.cons);
		const tier = asTier(item.tier);
		const source = asText(item.source);
		plays.push({
			id,
			name,
			thesis,
			status: asPlayStatus(item.status),
			...(revenueModel ? { revenueModel } : {}),
			...(whoPays ? { whoPays } : {}),
			...(unitMargin ? { unitMargin } : {}),
			...(capacityCeiling ? { capacityCeiling } : {}),
			...(moat ? { moat } : {}),
			...(killRisk ? { killRisk } : {}),
			...(nextMove ? { nextMove } : {}),
			...(pros ? { pros } : {}),
			...(cons ? { cons } : {}),
			...(tier ? { tier } : {}),
			...(source ? { source } : {}),
		});
	});
	if (plays.length === 0) return null;
	const summary = isPlainRecord(value) ? asText(value.summary) : undefined;
	const verdict = isPlainRecord(value) ? asText(value.verdict) : undefined;
	return {
		...(summary ? { summary } : {}),
		...(verdict ? { verdict } : {}),
		plays,
	};
}

export function parseStrategyHypothesesDocument(value: unknown): StrategyHypothesesDocument | null {
	const rawList = Array.isArray(value)
		? value
		: isPlainRecord(value) && Array.isArray(value.hypotheses)
			? value.hypotheses
			: isPlainRecord(value) && Array.isArray(value.assumptions)
				? value.assumptions
				: null;
	if (!rawList) return null;
	const hypotheses: StrategyHypothesis[] = [];
	rawList.forEach((item, index) => {
		if (!isPlainRecord(item)) return;
		const bet = asText(item.bet) ?? asText(item.hypothesis) ?? asText(item.claim);
		if (!bet) return;
		const id = asText(item.id) ?? `h-${index + 1}`;
		const cheapestTest = asText(item.cheapestTest) ?? asText(item.test);
		const killCriteria = asText(item.killCriteria);
		const evidence = asText(item.evidence);
		const source = asText(item.source);
		const owner = asText(item.owner);
		const playId = asText(item.playId);
		hypotheses.push({
			id,
			bet,
			tier: asTier(item.tier) ?? "hypothesis",
			status: asHypothesisStatus(item.status),
			impact: asHypothesisImpact(item.impact),
			...(cheapestTest ? { cheapestTest } : {}),
			...(killCriteria ? { killCriteria } : {}),
			...(evidence ? { evidence } : {}),
			...(source ? { source } : {}),
			...(owner ? { owner } : {}),
			...(playId ? { playId } : {}),
		});
	});
	if (hypotheses.length === 0) return null;
	const summary = isPlainRecord(value) ? asText(value.summary) : undefined;
	return {
		...(summary ? { summary } : {}),
		hypotheses,
	};
}

export function parseStrategyLandscapeDocument(value: unknown): StrategyLandscapeDocument | null {
	const rawList = Array.isArray(value)
		? value
		: isPlainRecord(value) && Array.isArray(value.players)
			? value.players
			: isPlainRecord(value) && Array.isArray(value.rivals)
				? value.rivals
				: isPlainRecord(value) && Array.isArray(value.competitors)
					? value.competitors
					: null;
	if (!rawList) return null;
	const players: StrategyRival[] = [];
	rawList.forEach((item, index) => {
		if (!isPlainRecord(item)) return;
		const name = asText(item.name);
		if (!name) return;
		const id = asText(item.id) ?? slugId(name, `rival-${index + 1}`);
		const url = asText(item.url);
		const category = asText(item.category);
		const positioning = asText(item.positioning);
		const pricing = asText(item.pricing);
		const target = asText(item.target);
		const strength = asText(item.strength);
		const weakness = asText(item.weakness);
		const ourEdge = asText(item.ourEdge);
		const tier = asTier(item.tier);
		const source = asText(item.source);
		const x = asCoord(item.x);
		const y = asCoord(item.y);
		players.push({
			id,
			name,
			...(item.isUs === true ? { isUs: true } : {}),
			...(url ? { url } : {}),
			...(category ? { category } : {}),
			...(positioning ? { positioning } : {}),
			...(pricing ? { pricing } : {}),
			...(target ? { target } : {}),
			...(strength ? { strength } : {}),
			...(weakness ? { weakness } : {}),
			...(ourEdge ? { ourEdge } : {}),
			...(tier ? { tier } : {}),
			...(source ? { source } : {}),
			...(x !== undefined ? { x } : {}),
			...(y !== undefined ? { y } : {}),
		});
	});
	if (players.length === 0) return null;
	let axes: StrategyLandscapeAxes | undefined;
	if (isPlainRecord(value) && isPlainRecord(value.axes)) {
		const xLabel = asText(value.axes.xLabel);
		const yLabel = asText(value.axes.yLabel);
		if (xLabel && yLabel) {
			const xLow = asText(value.axes.xLow);
			const xHigh = asText(value.axes.xHigh);
			const yLow = asText(value.axes.yLow);
			const yHigh = asText(value.axes.yHigh);
			axes = {
				xLabel,
				yLabel,
				...(xLow ? { xLow } : {}),
				...(xHigh ? { xHigh } : {}),
				...(yLow ? { yLow } : {}),
				...(yHigh ? { yHigh } : {}),
			};
		}
	}
	const summary = isPlainRecord(value) ? asText(value.summary) : undefined;
	const wedge = isPlainRecord(value) ? asText(value.wedge) : undefined;
	return {
		...(summary ? { summary } : {}),
		...(wedge ? { wedge } : {}),
		...(axes ? { axes } : {}),
		players,
	};
}
