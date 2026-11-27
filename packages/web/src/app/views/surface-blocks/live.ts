import type { CloudMemberDataAnswer, CloudMemberDataQuestion } from "@qorpera/cloud-client/cloud-member-data";
import {
	parseSurfaceChartDocument,
	SURFACE_ASK_CHART_KINDS,
	type SurfaceAskChartKind,
	type SurfaceAskSource,
	type SurfaceChartDocument,
	splitSurfaceAsk,
	surfaceAskPreviousParams,
} from "@qorpera/contracts";
import { phrase, presentationLocale, t, timeZoneOption } from "../../../ui/preferences.ts";
import type { CompanyLiveSource } from "../../interface-apps.ts";

const MAX_CATEGORIES = 120;
const MAX_POINTS = 240;
const MAX_SERIES = 16;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const CODE_TEXT = /^0\d/;
const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
const LOCAL_HOUR = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
const ZONED_HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MONTH_TEXT = /^(\d{4})-(\d{2})$/;
const WHOLE_FROM = 100;
const GROUPED_FROM = 10_000;
const MAX_CELL_DECIMALS = 2;
const MAX_WRITTEN_DECIMALS = 20;

const QORPERA_CODES: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>> = {
	"money-now": {
		state: {
			none: phrase("Not connected"),
			waiting: phrase("Waiting"),
			current: phrase("Up to date"),
			paused: phrase("Paused"),
		},
	},
	"money-kinds": {
		direction: { in: phrase("Money in"), out: phrase("Money out") },
		kind: {
			all: phrase("All"),
			salaries: phrase("Salaries"),
			taxes: phrase("Taxes and VAT"),
			rent: phrase("Rent"),
			utilities: phrase("Utilities"),
			subscriptions: phrase("Subscriptions"),
			fees: phrase("Card and app fees"),
			other: phrase("Other"),
		},
	},
	"orders-now": {
		stripe: { none: phrase("Not connected"), live: phrase("Live"), waiting: phrase("Waiting") },
	},
	"orders-states": {
		state: {
			paid: phrase("Paid"),
			packed: phrase("Packed"),
			on_the_way: phrase("On the way"),
			delivered: phrase("Delivered"),
			cancelled: phrase("Cancelled"),
			failed: phrase("Failed"),
		},
	},
	"orders-sources": {
		source: { stripe: phrase("Card payments"), added: phrase("Added by hand") },
	},
};

export interface SurfaceLiveHosts {
	readonly numbers?: CompanyLiveSource | undefined;
	readonly data?: CompanyLiveSource | undefined;
}

export type SurfaceAskState =
	| { readonly state: "loading" }
	| { readonly state: "answered"; readonly answer: CloudMemberDataAnswer }
	| { readonly state: "refused" }
	| { readonly state: "unconnected" }
	| { readonly state: "unavailable" };

export interface SurfaceAskHandle {
	readonly key: string;
	readonly state: SurfaceAskState;
	follow(update: (state: SurfaceAskState) => void, signal: AbortSignal): void;
}

export function askQuestion(source: SurfaceAskSource): CloudMemberDataQuestion | undefined {
	const split = splitSurfaceAsk(source.ask);
	return split ? { database: split.database, question: split.question, params: source.params ?? {} } : undefined;
}

export function askKey(asked: CloudMemberDataQuestion): string {
	return JSON.stringify([
		asked.database,
		asked.question,
		Object.keys(asked.params)
			.sort()
			.map((name) => [name, asked.params[name]]),
	]);
}

export function isRefusal(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const status = (error as { readonly status?: unknown }).status;
	return status === 404 || /\bNo question \S+ that you may read\b/i.test(error.message);
}

export function isUnconnected(error: unknown): boolean {
	return error instanceof Error && /^Not connected\b/.test(error.message.trim());
}

export function codeWords(source: Pick<SurfaceAskSource, "ask">, column: string, value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const split = splitSurfaceAsk(source.ask);
	if (split?.database !== "qorpera") return undefined;
	const words = QORPERA_CODES[split.question]?.[column];
	return words && Object.hasOwn(words, value) ? t(words[value]!) : undefined;
}

export function answerRecords(answer: CloudMemberDataAnswer): Record<string, unknown>[] {
	return answer.rows.map((row) => Object.fromEntries(answer.columns.map((column, index) => [column, row[index]])));
}

export function answerNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && NUMBER_TEXT.test(value.trim())) {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function pickFigure(answer: CloudMemberDataAnswer, column: string): unknown {
	const at = answer.columns.indexOf(column);
	const row = answer.rows.at(-1);
	return at < 0 || !row ? undefined : row[at];
}

export function lastRecord(answer: CloudMemberDataAnswer): Record<string, unknown> | undefined {
	return answerRecords(answer).at(-1);
}

function numberText(number: number, grouping: boolean, fractions: number, least = 0): string {
	return new Intl.NumberFormat(presentationLocale(), {
		minimumFractionDigits: least,
		maximumFractionDigits: fractions,
		useGrouping: grouping,
	}).format(number);
}

export function figureText(value: unknown): string | undefined {
	if (typeof value === "string" && CODE_TEXT.test(value.trim())) return value;
	const number = answerNumber(value);
	if (number !== null) return numberText(number, true, Math.abs(number) >= WHOLE_FROM ? 0 : 2);
	if (typeof value === "string") return value.trim() === "" ? undefined : value;
	if (typeof value === "boolean") return String(value);
	return undefined;
}

export interface TableColumnText {
	readonly texts: readonly (string | undefined)[];
	readonly numeric: boolean;
}

interface CellNumber {
	readonly value: number;
	readonly decimals: number | undefined;
	readonly written?: string;
}

function cellNumber(value: unknown, readsText: boolean): CellNumber | undefined {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return undefined;
		if (Number.isInteger(value)) return { value, decimals: 0 };
		return { value, decimals: /\.(\d+)$/.exec(String(value))?.[1]?.length };
	}
	if (!readsText || typeof value !== "string") return undefined;
	const text = value.trim();
	if (CODE_TEXT.test(text) || !NUMBER_TEXT.test(text)) return undefined;
	return { value: Number(text), decimals: text.split(".")[1]?.length ?? 0, written: value };
}

function isBlank(value: unknown): boolean {
	return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

// WHY: a file's column keeps every digit the agent wrote (padded, never rounded); only live answers round to 2.
export function columnTexts(values: readonly unknown[], live: boolean): TableColumnText {
	const numbers = values.map((value) => cellNumber(value, live));
	const numeric = numbers.some(Boolean) && values.every((value, at) => numbers[at] !== undefined || isBlank(value));
	const cap = live ? MAX_CELL_DECIMALS : MAX_WRITTEN_DECIMALS;
	let decimals = 0;
	let grouped = false;
	for (const number of numbers) {
		if (!number) continue;
		if (number.decimals === undefined && !live) return { numeric, texts: values.map(() => undefined) };
		decimals = Math.max(decimals, Math.min(number.decimals ?? cap, cap));
		if (number.written === undefined && Math.abs(number.value) >= GROUPED_FROM) grouped = true;
	}
	return {
		numeric,
		texts: numbers.map((number) => {
			if (!number) return undefined;
			if (decimals > 0) return numberText(number.value, true, decimals, decimals);
			if (!live) return String(number.value);
			if (number.written === undefined) return numberText(number.value, grouped, 0);
			return grouped && Number.isSafeInteger(number.value) ? numberText(number.value, true, 0) : number.written;
		}),
	};
}

export function withUnit(text: string, unit: string | undefined): string {
	return unit ? `${text} ${unit}` : text;
}

export function answerAge(answer: CloudMemberDataAnswer): string | undefined {
	const at = new Date(answer.asOf);
	if (Number.isNaN(at.getTime())) return undefined;
	const time = at.toLocaleString(presentationLocale(), {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		...timeZoneOption(),
	});
	return t("As of {time}", { time });
}

interface HourText {
	readonly day: string;
	readonly time: string;
}

function hourOf(value: string): HourText | undefined {
	const local = LOCAL_HOUR.exec(value);
	if (local) return { day: local[1]!, time: local[2]! };
	if (!ZONED_HOUR.test(value)) return undefined;
	const at = new Date(value);
	if (Number.isNaN(at.getTime())) return undefined;
	const zone = timeZoneOption();
	const parts = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		...zone,
	}).formatToParts(at);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
	return { day: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

function dayLabel(day: string): string {
	const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
	return date.toLocaleDateString(presentationLocale(), { day: "numeric", month: "short", timeZone: "UTC" });
}

function hourLabels(keys: readonly string[]): string[] | undefined {
	if (keys.every((key) => key.slice(11, 16) === "00:00")) return undefined;
	const hours = keys.map(hourOf);
	if (hours.length === 0 || hours.some((hour) => hour === undefined)) return undefined;
	return hours.map((hour, at) => {
		const { day, time } = hour!;
		if (at > 0 && hours[at - 1]!.day === day) return time;
		return time === "00:00" ? dayLabel(day) : `${dayLabel(day)} ${time}`;
	});
}

function categoryText(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const day = DAY_TEXT.exec(value);
	if (day) return dayLabel(`${day[1]}-${day[2]}-${day[3]}`);
	const month = MONTH_TEXT.exec(value);
	if (month) {
		const date = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1));
		return date.toLocaleDateString(presentationLocale(), { month: "short", year: "numeric", timeZone: "UTC" });
	}
	return value.trim().slice(0, 64);
}

function isTimeText(value: unknown): value is string {
	return typeof value === "string" && (DAY_TEXT.test(value) || MONTH_TEXT.test(value));
}

export function seriesTitle(column: string): string {
	const spaced = column
		.replace(/[-_]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : column;
}

export interface SurfaceAskDays {
	readonly first: string;
	readonly last: string;
	readonly count: number;
}

export interface SurfaceAskChart {
	readonly doc: SurfaceChartDocument;
	readonly keys: readonly string[];
	readonly categoryKeys: readonly string[];
	readonly days?: SurfaceAskDays;
}

function chartKind(value: unknown): SurfaceAskChartKind {
	return typeof value === "string" && (SURFACE_ASK_CHART_KINDS as readonly string[]).includes(value)
		? (value as SurfaceAskChartKind)
		: "line";
}

export function answerChart(answer: CloudMemberDataAnswer, source: SurfaceAskSource): SurfaceAskChart | null {
	const x = source.x;
	if (x === undefined || source.y === undefined) return null;
	const ys = typeof source.y === "string" ? [source.y] : [...source.y];
	const kind = chartKind(source.kind);
	const records = answerRecords(answer).filter((row) => categoryText(row[x]) !== undefined);
	const raw: string[] = [];
	for (const row of records) {
		const key = String(row[x]);
		if (!raw.includes(key)) raw.push(key);
	}
	const timed = raw.length > 0 && raw.every(isTimeText);
	const ordered = timed ? [...raw].sort() : raw;
	const kept = timed ? ordered.slice(-MAX_CATEGORIES) : ordered.slice(0, MAX_CATEGORIES);
	const index = new Map(kept.map((key, at) => [key, at]));
	const lines: { key: string; name: string; data: (number | null)[] }[] = [];
	const lineOf = (key: string, name: string) => {
		let line = lines.find((item) => item.key === key);
		if (!line && lines.length < MAX_SERIES) {
			line = { key, name, data: kept.map(() => null) };
			lines.push(line);
		}
		return line;
	};
	const split = source.series !== undefined && ys.length === 1 ? source.series : undefined;
	const named = (name: string) => (source.estimate === true ? t("{name} (estimate)", { name }) : name);
	for (const y of ys) if (!split) lineOf(y, named(seriesTitle(y)));
	for (const row of records) {
		const at = index.get(String(row[x]));
		if (at === undefined) continue;
		if (split) {
			const value = row[split];
			const key = value === null || value === undefined ? "" : String(value);
			const line = lineOf(key, named(key === "" ? "–" : (codeWords(source, split, value) ?? key).slice(0, 80)));
			if (line) line.data[at] = answerNumber(row[ys[0]!]);
		} else {
			for (const y of ys) {
				const line = lineOf(y, named(seriesTitle(y)));
				if (line) line.data[at] = answerNumber(row[y]);
			}
		}
	}
	const shown = kind === "pie" || kind === "funnel" ? lines.slice(0, 1) : lines;
	if (kept.length === 0 || shown.length === 0) return null;
	if (!shown.some((line) => line.data.some((value) => value !== null))) return null;
	const hours = hourLabels(kept);
	const doc = parseSurfaceChartDocument({
		kind,
		categories: hours ?? kept.map((key) => codeWords(source, x, key) ?? categoryText(key)),
		series: shown.map((line) => ({
			name: line.name,
			data: line.data.slice(-MAX_POINTS),
			...(source.estimate === true ? { estimate: true } : {}),
		})),
		...(source.stacked === true && (kind === "bar" || kind === "area" || kind === "line") ? { stacked: true } : {}),
		...(source.unit !== undefined ? { unit: source.unit } : {}),
		...(kind === "area" || kind === "line" ? { smooth: true } : {}),
	});
	if (!doc) return null;
	const dayKeys = kept.map((key) => (hours ? undefined : DAY_TEXT.exec(key)?.slice(1, 4).join("-")));
	const first = dayKeys[0];
	const last = dayKeys.at(-1);
	const days =
		first && last && dayKeys.every((key) => key !== undefined) ? { first, last, count: kept.length } : undefined;
	return { doc, keys: shown.map((line) => line.key), categoryKeys: kept, ...(days ? { days } : {}) };
}

export function previousSource(source: SurfaceAskSource, days: SurfaceAskDays | undefined): SurfaceAskSource | null {
	if (source.against !== "previous" || !days) return null;
	const params = surfaceAskPreviousParams(source, days.first, days.last);
	if (!params) return null;
	return { ...source, params };
}

export function withPrevious(
	current: SurfaceAskChart,
	previous: SurfaceAskChart | null,
	name: string,
): SurfaceChartDocument {
	const line = previous?.doc.series?.[0];
	const series = current.doc.series ?? [];
	if (!line || series.length >= MAX_SERIES || current.doc.kind === "pie" || current.doc.kind === "funnel") {
		return current.doc;
	}
	const length = current.doc.categories?.length ?? series[0]?.data.length ?? 0;
	const data = Array.from({ length }, (_, at) => {
		const point = line.data[at];
		return typeof point === "number" ? point : null;
	});
	return { ...current.doc, series: [...series, { name, data }] };
}

interface AskEntry {
	readonly key: string;
	readonly asked: CloudMemberDataQuestion;
	readonly source: CompanyLiveSource | undefined;
	state: SurfaceAskState;
	started: boolean;
	watch: number | undefined;
	readonly parent: string | undefined;
	readonly followers: Set<(state: SurfaceAskState) => void>;
}

const UNAVAILABLE: SurfaceAskState = { state: "unavailable" };
const UNCONNECTED: SurfaceAskState = { state: "unconnected" };
const LOADING: SurfaceAskState = { state: "loading" };

export class SurfaceAsks {
	readonly #hosts: SurfaceLiveHosts;
	readonly #page = new AbortController();
	readonly #entries = new Map<string, AskEntry>();

	constructor(hosts: SurfaceLiveHosts, signal: AbortSignal) {
		this.#hosts = hosts;
		if (signal.aborted) this.#page.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#page.signal });
	}

	handle(source: SurfaceAskSource, parent?: string): SurfaceAskHandle {
		const entry = this.#entry(source, parent);
		return {
			key: entry.key,
			state: entry.state,
			follow: (update, signal) => {
				if (signal.aborted) return;
				entry.followers.add(update);
				signal.addEventListener("abort", () => entry.followers.delete(update), { once: true });
				update(entry.state);
				this.#start(entry);
			},
		};
	}

	keep(keys: ReadonlySet<string>): void {
		for (const [key, entry] of this.#entries) {
			if (keys.has(key) || (entry.parent !== undefined && keys.has(entry.parent))) continue;
			this.#entries.delete(key);
			entry.followers.clear();
			if (entry.watch !== undefined) entry.source?.unwatch(this.#page.signal, entry.watch);
		}
	}

	dispose(): void {
		for (const entry of this.#entries.values()) entry.followers.clear();
		this.#entries.clear();
		this.#page.abort();
	}

	#entry(source: SurfaceAskSource, parent: string | undefined): AskEntry {
		const asked = askQuestion(source);
		const key = asked ? askKey(asked) : `!${source.ask}`;
		const known = this.#entries.get(key);
		if (known?.started && known.source && (known.state === UNAVAILABLE || known.state === UNCONNECTED)) {
			known.started = false;
			this.#set(known, LOADING);
		}
		if (known) return known;
		if (parent !== undefined) {
			for (const [other, entry] of this.#entries) {
				if (entry.parent === parent) this.#entries.delete(other);
			}
		}
		const host = asked?.database === "qorpera" ? this.#hosts.numbers : this.#hosts.data;
		const entry: AskEntry = {
			key,
			asked: asked ?? { database: "", question: "", params: {} },
			source: asked ? host : undefined,
			state: asked && host && !this.#page.signal.aborted ? LOADING : UNAVAILABLE,
			started: false,
			watch: undefined,
			parent,
			followers: new Set(),
		};
		this.#entries.set(key, entry);
		return entry;
	}

	#set(entry: AskEntry, state: SurfaceAskState): void {
		if (this.#entries.get(entry.key) !== entry) return;
		entry.state = state;
		for (const update of [...entry.followers]) update(state);
	}

	#start(entry: AskEntry): void {
		if (entry.started || entry.state.state !== "loading" || !entry.source) return;
		entry.started = true;
		const source = entry.source;
		const page = this.#page.signal;
		const failed = (error: unknown) => {
			if (page.aborted) return;
			this.#set(entry, isRefusal(error) ? { state: "refused" } : isUnconnected(error) ? UNCONNECTED : UNAVAILABLE);
		};
		if (entry.parent !== undefined) {
			source.query(entry.asked, page).then((answer) => this.#set(entry, { state: "answered", answer }), failed);
			return;
		}
		source
			.watch(page, entry.asked, (_watch, answer) => this.#set(entry, { state: "answered", answer }))
			.then(
				({ watch, answer }) => {
					if (this.#entries.get(entry.key) !== entry) {
						source.unwatch(page, watch);
						return;
					}
					entry.watch = watch;
					this.#set(entry, { state: "answered", answer });
				},
				(error: unknown) => {
					if (page.aborted) return;
					if (isRefusal(error) || isUnconnected(error)) {
						failed(error);
						return;
					}
					source
						.query(entry.asked, page)
						.then((answer) => this.#set(entry, { state: "answered", answer }), failed);
				},
			);
	}
}
