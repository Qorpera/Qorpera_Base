import { WireValueError } from "./wire-values.ts";

export const SURFACE_REPORT_CLAIMS_MAX = 5;
export const SURFACE_REPORT_CLAIM_CHARS = 240;
export const SURFACE_REPORT_THEME_CHARS = 60;
export const SURFACE_REPORT_SOURCES_MAX = 200;
export const SURFACE_REPORT_SOURCE_NUMBER_MAX = 999;
export const SURFACE_REPORT_CHANGES_MAX = 12;
export const SURFACE_REPORT_METHOD_MAX = 12;
export const SURFACE_REPORT_NOT_FOUND_MAX = 40;
export const SURFACE_REPORT_RELATED_MAX = 8;

export const SURFACE_REPORT_RESEARCH_KEYS = ["question", "shortAnswer", "sources", "method", "notFound"] as const;

export const SURFACE_REPORT_FORMAT = `A report file (*.report.json) is {"category","headline","subtitle","author","date","readingTime","keyMetrics":[{"label","value","delta"}],"sections":[{"id","kicker","heading","paragraphs":["..."],"blocks":[...]}]}. Section blocks: bar_chart {heading, subtitle, max, items:[{label, value, display, note, highlight}]}; line_chart {heading, subtitle, xLabels, series:[{name, color, values}]}; table {heading, caption, columns, rows, highlightRow}; callout {tone:"thesis"|"decision"|"tradeoff", heading, body, bullets}; quote {text, attribution}; figure {heading, caption, panels:[{label, heading, body, accent}]}. A research post is a report file that also names the one "question" it answers; it then needs "theme", "shortAnswer", "sources", "method" and "notFound", and may carry "cover", "changes" and "related": {"question":"<one question, ending in ?>","theme":"<the theme it belongs to>","cover":{"src":"<a picture in this folder>","alt"},"shortAnswer":["<1-${SURFACE_REPORT_CLAIMS_MAX} claims, one sentence each>"],"changes":[{"page","line","now":"<what that line says now>"}],"sources":[{"n":1,"title","publisher","url","opened":"YYYY-MM-DD","backs":"<the line it backs, in the source's own figures>","kind":"<e.g. maker's own page>","checked":"YYYY-MM-DD"}],"method":["<how the answer was found>"],"notFound":[{"what","note":"<what would close it>"}],"related":["<path of another *.report.json>"]}. A source mark is [n], or [n, m], after the sentence a source backs, anywhere in the post's text; every mark needs its source. "opened" is the day the writer read the source, "checked" the day a second reader opened it again: a post is refused while a source has no "checked", and "question", "shortAnswer", "sources", "method" and "notFound" are written whole (write_text), never merged. A merge_json carries no source mark and never removes "theme".`;

export interface SurfaceReportCover {
	readonly src: string;
	readonly alt: string;
}

export interface SurfaceReportChange {
	readonly page: string;
	readonly line: string;
	readonly now: string;
}

export interface SurfaceReportSource {
	readonly n: number;
	readonly title: string;
	readonly publisher: string;
	readonly url: string;
	readonly opened: string;
	readonly backs: string;
	readonly kind?: string;
	readonly checked: string;
}

export interface SurfaceReportNotFound {
	readonly what: string;
	readonly note?: string;
}

export interface SurfaceReportEvidence {
	readonly question?: string;
	readonly theme?: string;
	readonly cover?: SurfaceReportCover;
	readonly shortAnswer?: readonly string[];
	readonly changes?: readonly SurfaceReportChange[];
	readonly sources?: readonly SurfaceReportSource[];
	readonly method?: readonly string[];
	readonly notFound?: readonly SurfaceReportNotFound[];
	readonly related?: readonly string[];
}

export interface SurfaceReportEvidenceOptions {
	readonly path?: string;
	readonly now?: Date;
}

const COVER_FILE = /\.(?:png|jpe?g|webp|gif|avif|svg)$/i;
const REPORT_FILE = /\.report\.json$/i;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SOURCE_MARK = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;
const UNMARKED_KEYS: ReadonlySet<string> = new Set(["sources", "cover", "related"]);
const DAY_MS = 86_400_000;

function fail(label: string, problem: string): never {
	throw new WireValueError(label, problem);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, label: string, maxChars: number, oneLine = true): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (trimmed === "") fail(label, "must be a non-empty string");
	if (trimmed.length > maxChars) fail(label, `is longer than ${maxChars} chars`);
	if (oneLine && /[\r\n]/.test(trimmed)) fail(label, "must be one line");
	return trimmed;
}

function webLink(value: unknown, label: string): string {
	const link = text(value, label, 2000);
	let host = "";
	try {
		const url = new URL(link);
		if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
	} catch {}
	if (/\s/.test(link) || !host.includes(".")) fail(label, "must be the http or https link the source was opened at");
	return link;
}

function list(value: unknown, label: string, min: number, max: number): readonly unknown[] {
	if (!Array.isArray(value)) fail(label, "must be an array");
	if (value.length < min) fail(label, min === 1 ? "must not be empty" : `needs at least ${min} entries`);
	if (value.length > max) fail(label, `has more than ${max} entries`);
	return value;
}

function folderPath(value: unknown, label: string): string {
	const path = text(value, label, 300);
	const body = path.startsWith("/") ? path.slice(1) : path;
	if (body.includes("\\") || body.includes("\0")) fail(label, "has a backslash or NUL");
	for (const segment of body.split("/")) {
		if (segment === "") fail(label, "has an empty part; write a/b, never a//b or a trailing /");
		if (segment === "." || segment === "..") fail(label, "may not use . or ..");
	}
	return path;
}

function calendarDay(value: unknown, label: string): string {
	const match = typeof value === "string" ? CALENDAR_DAY.exec(value) : null;
	if (!match) fail(label, "must be a day written YYYY-MM-DD");
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
		fail(label, "is not a real day");
	return match[0];
}

function parseCover(value: unknown): SurfaceReportCover {
	if (!isPlainObject(value)) fail("cover", 'must be {"src","alt"}');
	const src = folderPath(value.src, "cover.src");
	if (!COVER_FILE.test(src)) fail("cover.src", "must be a picture file (png, jpg, webp, gif, avif or svg)");
	return { src, alt: text(value.alt, "cover.alt", 200) };
}

function parseChanges(value: unknown): SurfaceReportChange[] {
	return list(value, "changes", 0, SURFACE_REPORT_CHANGES_MAX).map((entry, index) => {
		const label = `changes[${index}]`;
		if (!isPlainObject(entry)) fail(label, 'must be {"page","line","now"}');
		return {
			page: text(entry.page, `${label}.page`, 60),
			line: text(entry.line, `${label}.line`, 120),
			now: text(entry.now, `${label}.now`, 400),
		};
	});
}

function parseSources(value: unknown, now: Date): SurfaceReportSource[] {
	const latest = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
	const seen = new Set<number>();
	return list(value, "sources", 0, SURFACE_REPORT_SOURCES_MAX).map((entry, index) => {
		const label = `sources[${index}]`;
		if (!isPlainObject(entry)) fail(label, "must be an object");
		const n = entry.n;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > SURFACE_REPORT_SOURCE_NUMBER_MAX)
			fail(`${label}.n`, `must be a whole number from 1 to ${SURFACE_REPORT_SOURCE_NUMBER_MAX}`);
		if (seen.has(n)) fail(`${label}.n`, `repeats ${n}; every source has its own number`);
		seen.add(n);
		const url = webLink(entry.url, `${label}.url`);
		const opened = calendarDay(entry.opened, `${label}.opened`);
		if (entry.checked === undefined)
			fail(
				label,
				'has no "checked" day: a second reader opens every source again before a post is staged, and only their result sets it (read_skill research-check)',
			);
		const checked = calendarDay(entry.checked, `${label}.checked`);
		if (checked < opened) fail(`${label}.checked`, "is before the day the source was opened");
		if (checked > latest) fail(`${label}.checked`, "is a day that has not come yet");
		return {
			n,
			title: text(entry.title, `${label}.title`, 200),
			publisher: text(entry.publisher, `${label}.publisher`, 200),
			url,
			opened,
			backs: text(entry.backs, `${label}.backs`, 600),
			...(entry.kind === undefined ? {} : { kind: text(entry.kind, `${label}.kind`, 80) }),
			checked,
		};
	});
}

function parseNotFound(value: unknown): SurfaceReportNotFound[] {
	return list(value, "notFound", 0, SURFACE_REPORT_NOT_FOUND_MAX).map((entry, index) => {
		const label = `notFound[${index}]`;
		if (!isPlainObject(entry)) fail(label, 'must be {"what","note"}');
		return {
			what: text(entry.what, `${label}.what`, 240),
			...(entry.note === undefined ? {} : { note: text(entry.note, `${label}.note`, 400) }),
		};
	});
}

function parseRelated(value: unknown, ownPath: string | undefined): string[] {
	const key = (path: string) => path.replace(/^\/+/, "").toLowerCase();
	const seen = new Set<string>();
	return list(value, "related", 0, SURFACE_REPORT_RELATED_MAX).map((entry, index) => {
		const label = `related[${index}]`;
		const path = folderPath(entry, label);
		if (!REPORT_FILE.test(path)) fail(label, "must be the path of another *.report.json");
		if (ownPath !== undefined && key(path) === key(ownPath)) fail(label, "is this post itself");
		if (seen.has(key(path))) fail(label, "repeats a post already listed");
		seen.add(key(path));
		return path;
	});
}

function checkSourceMarks(value: unknown, label: string, known: ReadonlySet<number>): void {
	if (typeof value === "string") {
		for (const mark of value.matchAll(SOURCE_MARK)) {
			for (const part of (mark[1] as string).split(",")) {
				const n = Number(part.trim());
				if (!known.has(n)) fail(label, `marks source [${n}], which is not in sources`);
			}
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			checkSourceMarks(entry, `${label}[${index}]`, known);
		});
		return;
	}
	if (isPlainObject(value))
		for (const [key, entry] of Object.entries(value)) checkSourceMarks(entry, `${label}.${key}`, known);
}

function hasSourceMark(value: unknown): boolean {
	if (typeof value === "string") return value.search(SOURCE_MARK) >= 0;
	if (Array.isArray(value)) return value.some(hasSourceMark);
	return isPlainObject(value) && Object.values(value).some(hasSourceMark);
}

export function surfaceReportMarkedKey(report: Readonly<Record<string, unknown>>): string | undefined {
	return Object.keys(report).find((key) => !UNMARKED_KEYS.has(key) && hasSourceMark(report[key]));
}

export function parseSurfaceReportEvidence(
	report: Readonly<Record<string, unknown>>,
	options: SurfaceReportEvidenceOptions = {},
): SurfaceReportEvidence {
	const question =
		report.question === undefined ? undefined : text(report.question, "question", SURFACE_REPORT_CLAIM_CHARS);
	if (question !== undefined && (!question.endsWith("?") || question.indexOf("?") !== question.length - 1))
		fail("question", "must be one question, ending in its only ?");
	const theme = report.theme === undefined ? undefined : text(report.theme, "theme", SURFACE_REPORT_THEME_CHARS);
	const cover = report.cover === undefined ? undefined : parseCover(report.cover);
	const shortAnswer =
		report.shortAnswer === undefined
			? undefined
			: list(report.shortAnswer, "shortAnswer", 1, SURFACE_REPORT_CLAIMS_MAX).map((claim, index) =>
					text(claim, `shortAnswer[${index}]`, SURFACE_REPORT_CLAIM_CHARS),
				);
	const changes = report.changes === undefined ? undefined : parseChanges(report.changes);
	const sources = report.sources === undefined ? undefined : parseSources(report.sources, options.now ?? new Date());
	const method =
		report.method === undefined
			? undefined
			: list(report.method, "method", 1, SURFACE_REPORT_METHOD_MAX).map((paragraph, index) =>
					text(paragraph, `method[${index}]`, 2000, false),
				);
	const notFound = report.notFound === undefined ? undefined : parseNotFound(report.notFound);
	const related = report.related === undefined ? undefined : parseRelated(report.related, options.path);

	if (question !== undefined) {
		for (const [key, part] of Object.entries({ theme, shortAnswer, sources, method, notFound }))
			if (part === undefined)
				fail(key, 'is missing: a post that names its "question" is a research post and needs it');
		if (sources?.length === 0 && notFound?.length === 0)
			fail("sources", "is empty and so is notFound: a research post rests on sources or says what was not found");
	}
	if (sources !== undefined) {
		const known = new Set(sources.map((source) => source.n));
		for (const [key, part] of Object.entries(report)) if (!UNMARKED_KEYS.has(key)) checkSourceMarks(part, key, known);
	}
	return {
		...(question === undefined ? {} : { question }),
		...(theme === undefined ? {} : { theme }),
		...(cover === undefined ? {} : { cover }),
		...(shortAnswer === undefined ? {} : { shortAnswer }),
		...(changes === undefined ? {} : { changes }),
		...(sources === undefined ? {} : { sources }),
		...(method === undefined ? {} : { method }),
		...(notFound === undefined ? {} : { notFound }),
		...(related === undefined ? {} : { related }),
	};
}
