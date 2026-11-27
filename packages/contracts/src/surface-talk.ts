export const SURFACE_TALK_FILE = "talk.json";
export const SURFACE_TALKS_DEFAULT_MATCH = "talks/*/talk.json";
export const SURFACE_TALK_MAX_MINUTES = 15;
export const SURFACE_TALK_SAY_WORDS = [12, 45] as const;
export const SURFACE_TALK_POINTS = [3, 7] as const;
export const SURFACE_TALK_ASKS_MAX = 3;
export const SURFACE_TALK_CHAPTERS_MAX = 24;
export const SURFACE_TALK_CHAPTER_PICTURES = [2, 8] as const;
export const SURFACE_TALK_ANSWER_WORDS = 35;

export const SURFACE_TALK_TONES = ["paper", "tint", "deep", "brand", "stone"] as const;
export type SurfaceTalkTone = (typeof SURFACE_TALK_TONES)[number];

export const SURFACE_TALK_KINDS = [
	"title",
	"statement",
	"quote",
	"number",
	"bars",
	"split",
	"ring",
	"meter",
	"versus",
	"steps",
	"marks",
	"matrix",
	"open",
	"timeline",
	"art",
] as const;
export type SurfaceTalkKind = (typeof SURFACE_TALK_KINDS)[number];

export const SURFACE_TALK_BORDERS = ["money", "rivals", "plan", "tests", "law"] as const;
export type SurfaceTalkBorder = (typeof SURFACE_TALK_BORDERS)[number];

export const SURFACE_TALK_STARTER_IDS = ["exists", "works", "feel", "found", "blocks", "guesses", "next"] as const;
export type SurfaceTalkStarterId = (typeof SURFACE_TALK_STARTER_IDS)[number];

export interface SurfaceTalkStarter {
	readonly id: SurfaceTalkStarterId;
	readonly name: string;
	readonly question: string;
	readonly has: string;
	readonly not: string;
	readonly never: readonly SurfaceTalkBorder[];
}

export const SURFACE_TALK_STARTERS: readonly SurfaceTalkStarter[] = [
	{
		id: "exists",
		name: "Why it exists",
		question: "Why does the company exist?",
		has: "The problem, who has it, what changes for them, what the company believes",
		not: "Prices, rivals, the plan, the tests",
		never: ["money", "rivals", "plan", "tests"],
	},
	{
		id: "works",
		name: "Why it can work",
		question: "Why would this work as a business?",
		has: "The few claims that must all hold, and what backs each",
		not: "The steps of the plan, a catalogue of products",
		never: ["plan"],
	},
	{
		id: "feel",
		name: "How it should feel",
		question: "What should using it feel like, and why do we think so?",
		has: "The ideas about the experience, and the reasoning behind each",
		not: "Money, suppliers, the law",
		never: ["money", "law"],
	},
	{
		id: "found",
		name: "What we found",
		question: "What do we know now that we did not know before?",
		has: "What research found, and what each finding changed",
		not: "Guesses and hopes",
		never: [],
	},
	{
		id: "blocks",
		name: "What stands in the way",
		question: "What can stop us?",
		has: "The obstacles, the worst first, and what each would cost",
		not: "How each gets tested",
		never: ["tests"],
	},
	{
		id: "guesses",
		name: "What we are still guessing",
		question: "What are we still guessing, and how do we find out?",
		has: "Each guess in plain words, what would prove it, what would end it",
		not: "Why the company exists",
		never: [],
	},
	{
		id: "next",
		name: "What we do next",
		question: "What happens next, and what does it buy?",
		has: "The steps in order, what each costs, what is known afterwards",
		not: "Why the company exists, the case for the business",
		never: [],
	},
];

export const SURFACE_TALK_FOOTINGS = ["research", "bets", "plan", "unchecked"] as const;
export type SurfaceTalkFooting = (typeof SURFACE_TALK_FOOTINGS)[number];

export type SurfaceTalkSource =
	| { readonly kind: "yours" }
	| { readonly kind: "plan" }
	| { readonly kind: "post"; readonly path: string }
	| { readonly kind: "bet"; readonly claim: string }
	| { readonly kind: "unchecked"; readonly what: string };

interface PictureBase {
	readonly say: string;
	readonly from: readonly SurfaceTalkSource[];
	readonly tone?: SurfaceTalkTone;
}

export interface SurfaceTalkBar {
	readonly label: string;
	readonly value: number;
	readonly show?: string;
	readonly dim?: boolean;
}

export interface SurfaceTalkMeterMark {
	readonly value: number;
	readonly label: string;
}

export interface SurfaceTalkVersusSide {
	readonly title: string;
	readonly big?: string;
	readonly lines: readonly string[];
}

export type SurfaceTalkStepState = "now" | "next" | "later";
export type SurfaceTalkMark = "yes" | "part" | "no" | "open";
export type SurfaceTalkCell = "y" | "p" | "n" | "q";

export type SurfaceTalkPictureBody =
	| { readonly kind: "title"; readonly kicker: string; readonly title: string; readonly sub?: string }
	| { readonly kind: "statement"; readonly text: string; readonly sub?: string }
	| { readonly kind: "quote"; readonly text: string; readonly by: string }
	| {
			readonly kind: "number";
			readonly value: string;
			readonly unit?: string;
			readonly label: string;
			readonly sub?: string;
	  }
	| {
			readonly kind: "bars";
			readonly title?: string;
			readonly unit: string;
			readonly items: readonly SurfaceTalkBar[];
			readonly line?: SurfaceTalkMeterMark;
			readonly max?: number;
	  }
	| {
			readonly kind: "split";
			readonly title?: string;
			readonly total: number;
			readonly unit: string;
			readonly parts: readonly { readonly label: string; readonly value: number }[];
	  }
	| {
			readonly kind: "ring";
			readonly percent: number;
			readonly big: string;
			readonly label: string;
			readonly sub?: string;
	  }
	| {
			readonly kind: "meter";
			readonly title: string;
			readonly unit: string;
			readonly max: number;
			readonly pass: SurfaceTalkMeterMark;
			readonly stop: SurfaceTalkMeterMark;
			readonly higherIsBetter: boolean;
	  }
	| {
			readonly kind: "versus";
			readonly left: SurfaceTalkVersusSide;
			readonly right: SurfaceTalkVersusSide;
			readonly verdict?: string;
	  }
	| {
			readonly kind: "steps";
			readonly items: readonly {
				readonly title: string;
				readonly lines: readonly string[];
				readonly state: SurfaceTalkStepState;
			}[];
	  }
	| {
			readonly kind: "marks";
			readonly title?: string;
			readonly items: readonly {
				readonly mark: SurfaceTalkMark;
				readonly label: string;
				readonly note?: string;
			}[];
	  }
	| {
			readonly kind: "matrix";
			readonly cols: readonly string[];
			readonly rows: readonly {
				readonly label: string;
				readonly cells: readonly SurfaceTalkCell[];
				readonly us?: boolean;
			}[];
	  }
	| { readonly kind: "open"; readonly items: readonly { readonly label: string; readonly needs: string }[] }
	| { readonly kind: "timeline"; readonly items: readonly { readonly when: string; readonly label: string }[] }
	| { readonly kind: "art"; readonly src: string; readonly alt: string };

export type SurfaceTalkPicture = SurfaceTalkPictureBody & PictureBase;

export interface SurfaceTalkChapter {
	readonly title: string;
	readonly points: readonly number[];
	readonly pictures: readonly SurfaceTalkPicture[];
}

export interface SurfaceTalkPoint {
	readonly text: string;
	readonly from: string;
}

export interface SurfaceTalkLeftOut {
	readonly what: string;
	readonly goesTo: string;
}

export interface SurfaceTalkListen {
	readonly day: string;
	readonly heard: string;
	readonly lines: number;
	readonly marked: number;
}

export type SurfaceTalkState = "asks" | "points" | "made";

export interface SurfaceTalk {
	readonly state: SurfaceTalkState;
	readonly starter?: SurfaceTalkStarterId;
	readonly title: string;
	readonly sub?: string;
	readonly question: string;
	readonly has: string;
	readonly not: string;
	readonly asks: readonly string[];
	readonly found: readonly string[];
	readonly missing?: string;
	readonly answer?: string;
	readonly points: readonly SurfaceTalkPoint[];
	readonly leftOut: readonly SurfaceTalkLeftOut[];
	readonly agreed?: string;
	readonly tone: SurfaceTalkTone;
	readonly whyThisLength?: string;
	readonly chapters: readonly SurfaceTalkChapter[];
	readonly listen?: SurfaceTalkListen;
	readonly cover?: number;
}

export interface SurfaceTalkCheckOptions {
	readonly now?: Date;
	readonly rivals?: readonly string[];
}

export interface SurfaceTalkRead {
	readonly talk?: SurfaceTalk;
	readonly problems: readonly string[];
}

export const SURFACE_TALK_FORMAT = `A talk file (talks/<name>/${SURFACE_TALK_FILE}) is a narrated talk the founders watch: chapters of pictures, each with one spoken line shown as its caption. It is in one of three states, by what it holds. Waiting for the founder's words: {"starter"?,"title","sub"?,"question","asks":["<1-${SURFACE_TALK_ASKS_MAX} open questions for the founder>"],"found":["<what the vision gave>"],"missing":"<what it did not>"}. Points for the founder's yes: add "answer" (one sentence, <=${SURFACE_TALK_ANSWER_WORDS} words), "points":[{"text","from":"<where it comes from, e.g. Your vision>"}] (${SURFACE_TALK_POINTS[0]}-${SURFACE_TALK_POINTS[1]}, in order) and "leftOut":[{"what","goesTo"}]; no "chapters" yet. Made: add "agreed":"YYYY-MM-DD" (the day the founder said yes to the points), "tone", "whyThisLength", "chapters":[{"title","points":[<indexes of the points it carries, from 0>],"pictures":[...]}], "listen":{"day":"YYYY-MM-DD","heard":"<the answer as the cold listener said it back>","lines":<lines heard>,"marked":<lines marked>} and no "asks". "starter" is one of ${SURFACE_TALK_STARTER_IDS.join(", ")}; a talk without one names its own "has" (what is in it) and "not" (what never is). title <=6 words, sub <=20. A chapter has ${SURFACE_TALK_CHAPTER_PICTURES[0]}-${SURFACE_TALK_CHAPTER_PICTURES[1]} pictures and opens with a title picture; every point is carried by a chapter. Every picture has "kind", "say" (the spoken line, ${SURFACE_TALK_SAY_WORDS[0]}-${SURFACE_TALK_SAY_WORDS[1]} words, written for the ear), "from" (what it rests on, 1 or more of "yours", "plan", "post:<path of a *.report.json>", "bet:<what the bet claims>", "unchecked:<a figure no post has checked>") and "tone"? (${SURFACE_TALK_TONES.join(", ")}; brand colours come from the company's Identity). Kinds and their fields (w = words, c = characters, ? optional): title {kicker <=4w, title <=8w, sub? <=12w}; statement {text <=16w, sub? <=14w}, at most one picture in five; quote {text <=14w, by <=4w}; number {value <=8c, unit? <=6c, label <=9w, sub? <=12w}; bars {title? <=8w, unit, items: 2-9 of {label <=4w, value, show?, dim?}, line? {value, label <=6w}, max?}; split {title? <=8w, total, unit, parts: 2-6 of {label <=4w, value}} whose values sum to total; ring {percent 0-100, big <=7c, label <=8w, sub? <=12w}; meter {title <=9w, unit, max, pass {value, label <=4w}, stop {value, label <=4w}, higherIsBetter}; versus {left, right: {title <=4w, big? <=10c, lines: <=3 of <=8w}, verdict? <=10w}; steps {items: 2-4 of {title <=4w, lines: <=2 of <=6w, state: now|next|later}}; marks {title? <=8w, items: 2-7 of {mark: yes|part|no|open, label <=6w, note? <=8w}}; matrix {cols: 2-7 of <=3w, rows: 2-6 of {label <=3w, cells: one of y p n q per column, us?}}; open {items: 2-4 of {label <=3w, needs <=4w}}; timeline {items: 2-6 of {when <=3w, label <=6w}}; art {src: a picture file in this folder, alt}, each file once. A picture runs max(7, words/2.5 + 2.6) seconds and a talk at most ${SURFACE_TALK_MAX_MINUTES} minutes; there is no shortest length. Nothing shown or spoken is a code number (B3, bet 3, post 6), a page or tab name, or a phrase like "the Strategy says"; a starter talk stays inside its borders. A talk is written whole (write_text), never merged. Its voice is recorded with narrate_explainer on this file, only when the founder asks.`;

const PICTURE_FILE = /\.(?:png|jpe?g|webp|gif|avif|svg)$/i;
const REPORT_FILE = /\.report\.json$/i;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const DRAWN_KINDS: ReadonlySet<SurfaceTalkKind> = new Set([
	"bars",
	"split",
	"ring",
	"meter",
	"matrix",
	"versus",
	"art",
	"number",
	"steps",
	"marks",
	"open",
	"timeline",
]);

const SPOKEN_BANNED: readonly (readonly [RegExp, string])[] = [
	[/—| – /, "a dash aside"],
	[/\blet's\b/i, '"let\'s"'],
	[/\bworth noting\b/i, '"worth noting"'],
	[/\b(?:CAC|MOQ|SDK|OEM|B2C)\b/, "an abbreviation the listener was never told"],
	[/\bgame-changer\b/i, "a hype word"],
	[/\bleverag(?:e|es|ed|ing)\b/i, "a hype word"],
];

const CODE_PATTERNS: readonly (readonly [RegExp, string])[] = [
	[/\b[A-Z]\d{1,2}\b/, "a code number"],
	[/\b(?:bet|post|hypothesis|play|source|talk)\s+(?:no\.?\s*)?#?\d/i, "a code number"],
	[/#\d/, "a code number"],
	[/\btabs?\b/i, "a page or tab name"],
	[/\b[Tt]he (?:Strategy|Identity|Analytics)\b|\bStrategy's\b/, "a page or tab name"],
	[/\bresearch posts?\b/i, "a page or tab name"],
	[/\bfact sheet\b/i, "a page or tab name"],
	[/\b(?:this|the|our) interface\b/i, "a page or tab name"],
];

const BORDER_WORDS: Readonly<Record<SurfaceTalkBorder, string>> = {
	money: "prices or money",
	rivals: "a rival",
	plan: "the steps of the plan",
	tests: "the tests",
	law: "the law",
};

const BORDER_PATTERNS: Readonly<Record<Exclude<SurfaceTalkBorder, "rivals">, readonly RegExp[]>> = {
	money: [
		/[$€£]\s?\d/,
		/\d[\d.,]*\s?(?:kr|dkk|sek|nok|eur|usd|gbp)\b/i,
		/\b(?:kr|kroner|kronor|euros?|dollars?)\b/i,
		/\b(?:price[sd]?|pricing|cheap(?:er|est)?|discounts?)\b/i,
	],
	plan: [/\b(?:step|phase|stage)\s+(?:\d|one|two|three|four)\b/i, /\broadmaps?\b/i, /\bmilestones?\b/i],
	tests: [/\b(?:tests?|tested|testing|pilots?|experiments?)\b/i],
	law: [/\b(?:laws?|legal(?:ly)?|lawyers?|regulat(?:or|ors|ion|ions|ed|ory)|compliance)\b/i],
};

type Bag = Record<string, unknown>;

interface Check {
	readonly problems: string[];
}

function isBag(value: unknown): value is Bag {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wordCount(text: string): number {
	const trimmed = text.trim();
	return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function shown(text: string): string {
	return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function line(check: Check, where: string, bag: Bag, key: string, required: boolean): string | undefined {
	const value = bag[key];
	if (value === undefined || value === null || value === "") {
		if (required) check.problems.push(`${where}: "${key}" is missing`);
		return undefined;
	}
	if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
		check.problems.push(`${where}: "${key}" must be one line of text`);
		return undefined;
	}
	return value.trim();
}

function words(check: Check, where: string, bag: Bag, key: string, max: number, required = true): string | undefined {
	const text = line(check, where, bag, key, required);
	if (text !== undefined && wordCount(text) > max)
		check.problems.push(`${where}: "${key}" is ${wordCount(text)} words, at most ${max}: "${shown(text)}"`);
	return text;
}

function chars(check: Check, where: string, bag: Bag, key: string, max: number, required = true): string | undefined {
	const text = line(check, where, bag, key, required);
	if (text !== undefined && text.length > max)
		check.problems.push(`${where}: "${key}" is ${text.length} characters, at most ${max}: "${shown(text)}"`);
	return text;
}

function amount(check: Check, where: string, bag: Bag, key: string, required = true): number | undefined {
	const value = bag[key];
	if (value === undefined) {
		if (required) check.problems.push(`${where}: the number "${key}" is missing`);
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		check.problems.push(`${where}: "${key}" must be a number`);
		return undefined;
	}
	return value;
}

function items(check: Check, where: string, bag: Bag, key: string, min: number, max: number): readonly unknown[] {
	const value = bag[key];
	if (!Array.isArray(value)) {
		check.problems.push(`${where}: "${key}" must be a list of ${min} to ${max}`);
		return [];
	}
	if (value.length < min || value.length > max)
		check.problems.push(`${where}: "${key}" has ${value.length} entries, must be ${min} to ${max}`);
	return value;
}

function bags(check: Check, where: string, bag: Bag, key: string, min: number, max: number): readonly Bag[] {
	return items(check, where, bag, key, min, max).flatMap((entry, index) => {
		if (isBag(entry)) return [entry];
		check.problems.push(`${where}: ${key}[${index}] must be an object`);
		return [];
	});
}

function calendarDay(check: Check, where: string, bag: Bag, key: string, now: Date): string | undefined {
	const value = bag[key];
	const match = typeof value === "string" ? CALENDAR_DAY.exec(value) : null;
	if (!match) {
		check.problems.push(`${where}: "${key}" must be a day written YYYY-MM-DD`);
		return undefined;
	}
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		check.problems.push(`${where}: "${key}" is not a real day`);
		return undefined;
	}
	if (match[0] > new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10)) {
		check.problems.push(`${where}: "${key}" is a day that has not come yet`);
		return undefined;
	}
	return match[0];
}

function folderPath(check: Check, where: string, key: string, value: unknown, file: RegExp, what: string): string {
	const path = typeof value === "string" ? value.trim() : "";
	const body = path.startsWith("/") ? path.slice(1) : path;
	const clean =
		path !== "" &&
		path.length <= 300 &&
		!/[\r\n\\\0]/.test(path) &&
		body.split("/").every((part) => part !== "" && part !== "." && part !== "..");
	if (!clean || !file.test(path)) {
		check.problems.push(`${where}: "${key}" must be the path of ${what}`);
		return "";
	}
	return path;
}

function optional<K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
}

function parseSource(check: Check, where: string, value: unknown): SurfaceTalkSource | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	if (text === "yours" || text === "plan") return { kind: text };
	const colon = text.indexOf(":");
	const kind = colon > 0 ? text.slice(0, colon) : "";
	const rest = colon > 0 ? text.slice(colon + 1).trim() : "";
	if (kind === "post") {
		const path = folderPath(check, where, "from", rest, REPORT_FILE, "a *.report.json");
		return path === "" ? undefined : { kind: "post", path };
	}
	if ((kind === "bet" || kind === "unchecked") && rest !== "" && !/[\r\n]/.test(rest)) {
		if (wordCount(rest) > 10)
			check.problems.push(`${where}: "from" names a ${kind} in more than 10 words: "${shown(rest)}"`);
		return kind === "bet" ? { kind, claim: rest } : { kind, what: rest };
	}
	check.problems.push(
		`${where}: "from" holds ${JSON.stringify(shown(text))}; use "yours", "plan", "post:<path>", "bet:<what it claims>" or "unchecked:<what>"`,
	);
	return undefined;
}

function meterMark(check: Check, where: string, bag: Bag, key: string, labelWords: number): SurfaceTalkMeterMark {
	const mark = bag[key];
	if (!isBag(mark)) {
		check.problems.push(`${where}: "${key}" must be {value, label}`);
		return { value: 0, label: "" };
	}
	return {
		value: amount(check, `${where} ${key}`, mark, "value") ?? 0,
		label: words(check, `${where} ${key}`, mark, "label", labelWords) ?? "",
	};
}

function versusSide(check: Check, where: string, bag: Bag, key: string): SurfaceTalkVersusSide {
	const side = bag[key];
	if (!isBag(side)) {
		check.problems.push(`${where}: "${key}" must be {title, big?, lines}`);
		return { title: "", lines: [] };
	}
	const at = `${where} ${key}`;
	const big = chars(check, at, side, "big", 10, false);
	return {
		title: words(check, at, side, "title", 4) ?? "",
		...optional("big", big),
		lines: shortLines(check, at, side, 3, 8),
	};
}

function shortLines(check: Check, where: string, bag: Bag, max: number, maxWords: number): string[] {
	if (bag.lines === undefined) return [];
	return items(check, where, bag, "lines", 0, max).flatMap((entry, index) => {
		const text = words(check, where, { [`lines[${index}]`]: entry }, `lines[${index}]`, maxWords);
		return text === undefined ? [] : [text];
	});
}

function parseBody(check: Check, where: string, bag: Bag, kind: SurfaceTalkKind): SurfaceTalkPictureBody {
	switch (kind) {
		case "title": {
			const sub = words(check, where, bag, "sub", 12, false);
			return {
				kind,
				kicker: words(check, where, bag, "kicker", 4) ?? "",
				title: words(check, where, bag, "title", 8) ?? "",
				...optional("sub", sub),
			};
		}
		case "statement": {
			const sub = words(check, where, bag, "sub", 14, false);
			return { kind, text: words(check, where, bag, "text", 16) ?? "", ...optional("sub", sub) };
		}
		case "quote":
			return { kind, text: words(check, where, bag, "text", 14) ?? "", by: words(check, where, bag, "by", 4) ?? "" };
		case "number": {
			const unit = chars(check, where, bag, "unit", 6, false);
			const sub = words(check, where, bag, "sub", 12, false);
			return {
				kind,
				value: chars(check, where, bag, "value", 8) ?? "",
				...optional("unit", unit),
				label: words(check, where, bag, "label", 9) ?? "",
				...optional("sub", sub),
			};
		}
		case "bars": {
			const title = words(check, where, bag, "title", 8, false);
			const bars = bags(check, where, bag, "items", 2, 9).map((item): SurfaceTalkBar => {
				const value = amount(check, where, item, "value") ?? 0;
				if (value < 0) check.problems.push(`${where}: a bar's value is below 0; bars are drawn from 0`);
				const show = chars(check, where, item, "show", 16, false);
				return {
					label: words(check, where, item, "label", 4) ?? "",
					value,
					...optional("show", show),
					...(item.dim === true ? { dim: true } : {}),
				};
			});
			const max = amount(check, where, bag, "max", false);
			return {
				kind,
				...optional("title", title),
				unit: chars(check, where, bag, "unit", 14) ?? "",
				items: bars,
				...(bag.line === undefined ? {} : { line: meterMark(check, where, bag, "line", 6) }),
				...optional("max", max),
			};
		}
		case "split": {
			const title = words(check, where, bag, "title", 8, false);
			const total = amount(check, where, bag, "total") ?? 0;
			const parts = bags(check, where, bag, "parts", 2, 6).map((part) => ({
				label: words(check, where, part, "label", 4) ?? "",
				value: amount(check, where, part, "value") ?? 0,
			}));
			const sum = parts.reduce((all, part) => all + part.value, 0);
			if (total <= 0 || parts.some((part) => part.value <= 0))
				check.problems.push(`${where}: a split's total and parts must be above 0`);
			else if (Math.abs(sum - total) > 0.5)
				check.problems.push(`${where}: the parts sum to ${sum}, the total says ${total}`);
			return { kind, ...optional("title", title), total, unit: chars(check, where, bag, "unit", 14) ?? "", parts };
		}
		case "ring": {
			const percent = amount(check, where, bag, "percent") ?? 0;
			if (percent < 0 || percent > 100) check.problems.push(`${where}: "percent" must be 0 to 100`);
			const sub = words(check, where, bag, "sub", 12, false);
			return {
				kind,
				percent,
				big: chars(check, where, bag, "big", 7) ?? "",
				label: words(check, where, bag, "label", 8) ?? "",
				...optional("sub", sub),
			};
		}
		case "meter": {
			const max = amount(check, where, bag, "max") ?? 0;
			const pass = meterMark(check, where, bag, "pass", 4);
			const stop = meterMark(check, where, bag, "stop", 4);
			if (max <= 0) check.problems.push(`${where}: "max" must be above 0`);
			else
				for (const [name, mark] of [
					["pass", pass],
					["stop", stop],
				] as const)
					if (mark.value < 0 || mark.value > max)
						check.problems.push(`${where}: ${name}.value ${mark.value} is outside 0 to ${max}`);
			if (typeof bag.higherIsBetter !== "boolean")
				check.problems.push(`${where}: "higherIsBetter" must be true or false`);
			return {
				kind,
				title: words(check, where, bag, "title", 9) ?? "",
				unit: chars(check, where, bag, "unit", 14) ?? "",
				max,
				pass,
				stop,
				higherIsBetter: bag.higherIsBetter === true,
			};
		}
		case "versus": {
			const verdict = words(check, where, bag, "verdict", 10, false);
			return {
				kind,
				left: versusSide(check, where, bag, "left"),
				right: versusSide(check, where, bag, "right"),
				...optional("verdict", verdict),
			};
		}
		case "steps":
			return {
				kind,
				items: bags(check, where, bag, "items", 2, 4).map((item) => {
					const state = item.state;
					if (state !== "now" && state !== "next" && state !== "later")
						check.problems.push(`${where}: a step's "state" must be now, next or later`);
					return {
						title: words(check, where, item, "title", 4) ?? "",
						lines: shortLines(check, where, item, 2, 6),
						state: state === "next" || state === "later" ? state : "now",
					};
				}),
			};
		case "marks": {
			const title = words(check, where, bag, "title", 8, false);
			return {
				kind,
				...optional("title", title),
				items: bags(check, where, bag, "items", 2, 7).map((item) => {
					const mark = item.mark;
					if (mark !== "yes" && mark !== "part" && mark !== "no" && mark !== "open")
						check.problems.push(`${where}: a "mark" must be yes, part, no or open`);
					const note = words(check, where, item, "note", 8, false);
					return {
						mark: mark === "part" || mark === "no" || mark === "open" ? mark : "yes",
						label: words(check, where, item, "label", 6) ?? "",
						...optional("note", note),
					};
				}),
			};
		}
		case "matrix": {
			const cols = items(check, where, bag, "cols", 2, 7).flatMap((entry, index) => {
				const text = words(check, where, { [`cols[${index}]`]: entry }, `cols[${index}]`, 3);
				return text === undefined ? [] : [text];
			});
			return {
				kind,
				cols,
				rows: bags(check, where, bag, "rows", 2, 6).map((row) => {
					const cells = typeof row.cells === "string" ? row.cells : "";
					if (cells.length !== cols.length || !/^[ypnq]*$/.test(cells))
						check.problems.push(
							`${where}: a row's "cells" must be ${cols.length} letters of y, p, n or q, one per column`,
						);
					return {
						label: words(check, where, row, "label", 3) ?? "",
						cells: [...cells].filter((cell): cell is SurfaceTalkCell => /^[ypnq]$/.test(cell)),
						...(row.us === true ? { us: true } : {}),
					};
				}),
			};
		}
		case "open":
			return {
				kind,
				items: bags(check, where, bag, "items", 2, 4).map((item) => ({
					label: words(check, where, item, "label", 3) ?? "",
					needs: words(check, where, item, "needs", 4) ?? "",
				})),
			};
		case "timeline":
			return {
				kind,
				items: bags(check, where, bag, "items", 2, 6).map((item) => ({
					when: words(check, where, item, "when", 3) ?? "",
					label: words(check, where, item, "label", 6) ?? "",
				})),
			};
		case "art":
			return {
				kind,
				src: folderPath(
					check,
					where,
					"src",
					bag.src,
					PICTURE_FILE,
					"a picture file (png, jpg, webp, gif, avif or svg)",
				),
				alt: chars(check, where, bag, "alt", 160) ?? "",
			};
	}
}

function shownTexts(value: unknown, key: string, out: string[]): void {
	if (key === "kind" || key === "tone" || key === "state" || key === "mark" || key === "cells" || key === "src")
		return;
	if (typeof value === "string") {
		if (key !== "from" || !value.trim().startsWith("post:")) out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) shownTexts(entry, key, out);
		return;
	}
	if (isBag(value)) for (const [name, entry] of Object.entries(value)) shownTexts(entry, name, out);
}

function checkWording(
	check: Check,
	where: string,
	bag: Bag,
	starter: SurfaceTalkStarter | undefined,
	rivals: readonly RegExp[],
): void {
	const texts: string[] = [];
	shownTexts(bag, "", texts);
	const seen = new Set<string>();
	const report = (key: string, problem: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		check.problems.push(`${where}: ${problem}`);
	};
	for (const text of texts) {
		for (const [pattern, what] of CODE_PATTERNS) {
			const found = pattern.exec(text);
			if (found) report(what, `${what} is shown or spoken ("${found[0]}"); say the thing itself`);
		}
		for (const border of starter?.never ?? []) {
			const patterns = border === "rivals" ? rivals : BORDER_PATTERNS[border];
			const found = patterns.map((pattern) => pattern.exec(text)).find((match) => match !== null);
			if (found)
				report(
					border,
					`outside this talk's borders: ${BORDER_WORDS[border]} ("${found[0]}") never belongs in "${starter?.name}"`,
				);
		}
	}
}

function parsePicture(
	check: Check,
	where: string,
	value: unknown,
	starter: SurfaceTalkStarter | undefined,
	rivals: readonly RegExp[],
): SurfaceTalkPicture | undefined {
	if (!isBag(value)) {
		check.problems.push(`${where}: must be an object with a kind`);
		return undefined;
	}
	const kind = value.kind;
	if (typeof kind !== "string" || !(SURFACE_TALK_KINDS as readonly string[]).includes(kind)) {
		check.problems.push(`${where}: "kind" must be one of ${SURFACE_TALK_KINDS.join(", ")}`);
		return undefined;
	}
	const say = line(check, where, value, "say", true) ?? "";
	const count = wordCount(say);
	if (say !== "" && (count < SURFACE_TALK_SAY_WORDS[0] || count > SURFACE_TALK_SAY_WORDS[1]))
		check.problems.push(
			`${where}: "say" is ${count} words, must be ${SURFACE_TALK_SAY_WORDS[0]} to ${SURFACE_TALK_SAY_WORDS[1]}`,
		);
	for (const [pattern, what] of SPOKEN_BANNED)
		if (pattern.test(say)) check.problems.push(`${where}: "say" holds ${what}; say it plainly`);
	const from = items(check, where, value, "from", 1, 8).flatMap((entry) => {
		const source = parseSource(check, where, entry);
		return source ? [source] : [];
	});
	const tone = value.tone;
	if (tone !== undefined && !(SURFACE_TALK_TONES as readonly unknown[]).includes(tone))
		check.problems.push(`${where}: "tone" must be one of ${SURFACE_TALK_TONES.join(", ")}`);
	checkWording(check, where, value, starter, rivals);
	return {
		...parseBody(check, where, value, kind as SurfaceTalkKind),
		say,
		from,
		...((SURFACE_TALK_TONES as readonly unknown[]).includes(tone) ? { tone: tone as SurfaceTalkTone } : {}),
	};
}

function parsePoints(check: Check, bag: Bag): SurfaceTalkPoint[] {
	return bags(check, "talk", bag, "points", SURFACE_TALK_POINTS[0], SURFACE_TALK_POINTS[1]).map((point, index) => ({
		text: words(check, `point ${index + 1}`, point, "text", 45) ?? "",
		from: words(check, `point ${index + 1}`, point, "from", 10) ?? "",
	}));
}

function parseListen(check: Check, bag: Bag, now: Date): SurfaceTalkListen | undefined {
	const listen = bag.listen;
	if (!isBag(listen)) {
		check.problems.push(
			'talk: a talk with pictures needs "listen": a second agent that has read nothing hears only the title, the question and the spoken lines before the founder sees it (read_skill talk-listen)',
		);
		return undefined;
	}
	const day = calendarDay(check, "listen", listen, "day", now);
	const heard = words(check, "listen", listen, "heard", 60);
	const lines = amount(check, "listen", listen, "lines");
	const marked = amount(check, "listen", listen, "marked");
	if (lines === undefined || marked === undefined || day === undefined || heard === undefined) return undefined;
	if (!Number.isInteger(lines) || !Number.isInteger(marked) || lines < 1 || marked < 0 || marked > lines) {
		check.problems.push('listen: "lines" and "marked" must be whole numbers, with marked no more than lines');
		return undefined;
	}
	if (marked * 10 > lines)
		check.problems.push(
			`listen: ${marked} of ${lines} lines were marked, more than one in ten: fix what was marked and listen again with a fresh listener`,
		);
	return { day, heard, lines, marked };
}

function rivalPatterns(names: readonly string[] | undefined): RegExp[] {
	return (names ?? []).flatMap((name) => {
		const trimmed = name.trim();
		if (trimmed.length < 2) return [];
		const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
		return [new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu")];
	});
}

export function surfaceTalkPictureSeconds(say: string): number {
	return Math.max(7, wordCount(say) / 2.5 + 2.6);
}

export function surfaceTalkSeconds(talk: SurfaceTalk): number {
	return talk.chapters.reduce(
		(all, chapter) =>
			all + chapter.pictures.reduce((sum, picture) => sum + surfaceTalkPictureSeconds(picture.say), 0),
		0,
	);
}

export function surfaceTalkSpokenLines(talk: SurfaceTalk): string[] {
	return talk.chapters.flatMap((chapter) => chapter.pictures.map((picture) => picture.say));
}

export function surfaceTalkPictureFooting(picture: SurfaceTalkPicture): SurfaceTalkFooting {
	const kinds = new Set(picture.from.map((source) => source.kind));
	if (kinds.has("unchecked")) return "unchecked";
	if (kinds.has("bet")) return "bets";
	return kinds.has("yours") || kinds.has("plan") || !kinds.has("post") ? "plan" : "research";
}

export function surfaceTalkFooting(talk: SurfaceTalk): Readonly<Record<SurfaceTalkFooting, number>> {
	const footing = { research: 0, bets: 0, plan: 0, unchecked: 0 };
	for (const chapter of talk.chapters)
		for (const picture of chapter.pictures) footing[surfaceTalkPictureFooting(picture)] += 1;
	return footing;
}

export function surfaceTalkCover(talk: SurfaceTalk): SurfaceTalkPicture | undefined {
	const pictures = talk.chapters.flatMap((chapter) => chapter.pictures);
	if (talk.cover !== undefined) return pictures[talk.cover - 1] ?? pictures[0];
	return pictures.find((picture) => DRAWN_KINDS.has(picture.kind)) ?? pictures[0];
}

export function surfaceTalkPosts(talk: SurfaceTalk): string[] {
	const paths = new Set<string>();
	for (const chapter of talk.chapters)
		for (const picture of chapter.pictures)
			for (const source of picture.from) if (source.kind === "post") paths.add(source.path);
	return [...paths];
}

export function surfaceTalkStarter(id: SurfaceTalkStarterId | undefined): SurfaceTalkStarter | undefined {
	return id === undefined ? undefined : SURFACE_TALK_STARTERS.find((starter) => starter.id === id);
}

export function readSurfaceTalk(value: unknown, options: SurfaceTalkCheckOptions = {}): SurfaceTalkRead {
	const check: Check = { problems: [] };
	if (!isBag(value)) return { problems: ["talk: must be a JSON object"] };
	const now = options.now ?? new Date();
	const rivals = rivalPatterns(options.rivals);

	let starter: SurfaceTalkStarter | undefined;
	if (value.starter !== undefined) {
		starter = SURFACE_TALK_STARTERS.find((entry) => entry.id === value.starter);
		if (!starter) check.problems.push(`talk: "starter" must be one of ${SURFACE_TALK_STARTER_IDS.join(", ")}`);
	}
	const title = words(check, "talk", value, "title", 6) ?? "";
	const sub = words(check, "talk", value, "sub", 20, false);
	const question = words(check, "talk", value, "question", 30) ?? "";
	if (question !== "" && (!question.endsWith("?") || question.indexOf("?") !== question.length - 1))
		check.problems.push('talk: "question" must be one question, ending in its only ?');
	let has = starter?.has ?? "";
	let not = starter?.not ?? "";
	if (starter) {
		if (value.has !== undefined || value.not !== undefined)
			check.problems.push('talk: a starter talk takes no "has" or "not"; its borders are fixed');
	} else if (value.starter === undefined) {
		has = words(check, "talk", value, "has", 25) ?? "";
		not = words(check, "talk", value, "not", 25) ?? "";
	}

	const made = value.chapters !== undefined;
	const pointed = made || value.points !== undefined;
	const state: SurfaceTalkState = made ? "made" : pointed ? "points" : "asks";

	const asks =
		value.asks === undefined && pointed
			? []
			: items(check, "talk", value, "asks", pointed ? 0 : 1, SURFACE_TALK_ASKS_MAX).flatMap((entry, index) => {
					const ask = words(check, "talk", { [`asks[${index}]`]: entry }, `asks[${index}]`, 30);
					if (ask !== undefined && !ask.endsWith("?"))
						check.problems.push(`talk: asks[${index}] must be an open question ending in ?`);
					return ask === undefined ? [] : [ask];
				});
	if (made && asks.length > 0)
		check.problems.push(
			'talk: a talk with pictures holds no "asks": what the founder has not answered is asked before a picture is drawn, or left out',
		);
	const found =
		value.found === undefined
			? []
			: items(check, "talk", value, "found", 0, 8).flatMap((entry, index) => {
					const text = words(check, "talk", { [`found[${index}]`]: entry }, `found[${index}]`, 40);
					return text === undefined ? [] : [text];
				});
	const missing = words(check, "talk", value, "missing", 40, false);

	let answer: string | undefined;
	let points: SurfaceTalkPoint[] = [];
	let leftOut: SurfaceTalkLeftOut[] = [];
	if (pointed) {
		answer = words(check, "talk", value, "answer", SURFACE_TALK_ANSWER_WORDS);
		points = parsePoints(check, value);
		leftOut = bags(check, "talk", value, "leftOut", 0, 12).map((entry, index) => ({
			what: words(check, `leftOut[${index}]`, entry, "what", 20) ?? "",
			goesTo: words(check, `leftOut[${index}]`, entry, "goesTo", 20) ?? "",
		}));
	}

	let tone: SurfaceTalkTone = "paper";
	if (value.tone !== undefined || made) {
		if ((SURFACE_TALK_TONES as readonly unknown[]).includes(value.tone)) tone = value.tone as SurfaceTalkTone;
		else check.problems.push(`talk: "tone" must be one of ${SURFACE_TALK_TONES.join(", ")}`);
	}

	let agreed: string | undefined;
	let whyThisLength: string | undefined;
	let listen: SurfaceTalkListen | undefined;
	let cover: number | undefined;
	const chapters: SurfaceTalkChapter[] = [];
	if (made) {
		if (value.agreed === undefined)
			check.problems.push(
				'talk: a talk with pictures needs "agreed": the day the founder said yes to its points. Show the points first and wait for that yes',
			);
		else agreed = calendarDay(check, "talk", value, "agreed", now);
		whyThisLength = words(check, "talk", value, "whyThisLength", 40);
		const carried = new Set<number>();
		const arts = new Set<string>();
		let pictures = 0;
		let statements = 0;
		let seconds = 0;
		bags(check, "talk", value, "chapters", 1, SURFACE_TALK_CHAPTERS_MAX).forEach((chapter, at) => {
			const where = `chapter ${at + 1}`;
			const chapterTitle = words(check, where, chapter, "title", 6) ?? "";
			const indexes = items(check, where, chapter, "points", 1, SURFACE_TALK_POINTS[1]).flatMap((entry) => {
				if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < points.length) {
					carried.add(entry);
					return [entry];
				}
				check.problems.push(`${where}: "points" holds ${JSON.stringify(entry)}, not the index of a point`);
				return [];
			});
			const drawn = items(
				check,
				where,
				chapter,
				"pictures",
				SURFACE_TALK_CHAPTER_PICTURES[0],
				SURFACE_TALK_CHAPTER_PICTURES[1],
			).flatMap((entry, index) => {
				const picture = parsePicture(check, `${where} picture ${index + 1}`, entry, starter, rivals);
				if (!picture) return [];
				pictures += 1;
				seconds += surfaceTalkPictureSeconds(picture.say);
				if (picture.kind === "statement") statements += 1;
				if (picture.kind === "art" && picture.src !== "") {
					if (arts.has(picture.src.toLowerCase()))
						check.problems.push(`${where} picture ${index + 1}: this picture file is used twice in the talk`);
					arts.add(picture.src.toLowerCase());
				}
				return [picture];
			});
			if (drawn.length > 0 && drawn[0]?.kind !== "title")
				check.problems.push(`${where}: must open with a title picture`);
			chapters.push({ title: chapterTitle, points: indexes, pictures: drawn });
		});
		const uncarried = points.map((_, index) => index).filter((index) => !carried.has(index));
		if (uncarried.length > 0)
			check.problems.push(
				`talk: no chapter carries point ${uncarried.map((index) => index + 1).join(", ")}; every point is carried by a chapter`,
			);
		if (pictures > 0 && statements * 5 > pictures)
			check.problems.push(
				`talk: ${statements} of ${pictures} pictures are statements; at most one in five, the rest draw a shape`,
			);
		if (seconds > SURFACE_TALK_MAX_MINUTES * 60)
			check.problems.push(
				`talk: runs ${(seconds / 60).toFixed(1)} minutes, at most ${SURFACE_TALK_MAX_MINUTES}; past that it is two talks`,
			);
		listen = parseListen(check, value, now);
		if (listen && agreed && listen.day < agreed)
			check.problems.push("listen: the cold listen is dated before the founder's yes to the points");
		if (value.cover !== undefined) {
			if (
				typeof value.cover === "number" &&
				Number.isInteger(value.cover) &&
				value.cover >= 1 &&
				value.cover <= pictures
			)
				cover = value.cover;
			else check.problems.push(`talk: "cover" must be the number of a picture, 1 to ${pictures}`);
		}
	}
	checkWording(
		check,
		"talk",
		{
			title: value.title,
			sub: value.sub,
			answer: value.answer,
			points: value.points,
			whyThisLength: value.whyThisLength,
		},
		starter,
		rivals,
	);

	if (check.problems.length > 0) return { problems: check.problems };
	return {
		talk: {
			state,
			...(starter ? { starter: starter.id } : {}),
			title,
			...optional("sub", sub),
			question,
			has,
			not,
			asks,
			found,
			...optional("missing", missing),
			...optional("answer", answer),
			points,
			leftOut,
			...optional("agreed", agreed),
			tone,
			...optional("whyThisLength", whyThisLength),
			chapters,
			...optional("listen", listen),
			...optional("cover", cover),
		},
		problems: [],
	};
}
