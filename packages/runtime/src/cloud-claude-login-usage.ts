export type ClaudeUsageWindowId = "five_hour" | "seven_day" | "seven_day_model";

export interface ClaudeUsageWindow {
	readonly id: ClaudeUsageWindowId;
	readonly label: string;
	readonly usedPercent: number;
	readonly resetAt?: string;
}

export interface ClaudeLoginUsage {
	readonly observedAt: string;
	readonly windows: readonly ClaudeUsageWindow[];
	readonly limitResetAt?: string;
}

export type ClaudeResetKind = "session" | "weekly" | "fable" | "full";

export interface ClaudeResetEntry {
	readonly kind: ClaudeResetKind | null;
	readonly left: number;
	readonly refills: string | null;
	readonly weekStays: string | null;
	readonly useBy: string | null;
	readonly usable: "now" | "at_limit";
}

export interface ClaudeLoginResets {
	readonly observedAt: string;
	readonly entries: readonly ClaudeResetEntry[];
}

export type ClaudeResetOutcome =
	| { readonly outcome: "reset"; readonly left: number | null }
	| { readonly outcome: "failed" }
	| { readonly outcome: "unconfirmed" };

export const CLAUDE_RESET_KINDS: readonly ClaudeResetKind[] = ["session", "weekly", "fable", "full"];
const KIND_WORDS: Readonly<Record<ClaudeResetKind, string>> = {
	session: "5-hour reset",
	weekly: "weekly reset",
	fable: "Fable reset",
	full: "full reset",
};
const COUNT_WORDS: Readonly<Record<ClaudeResetKind, string>> = {
	session: "five-hour reset",
	weekly: "weekly reset",
	fable: "Fable reset",
	full: "full reset",
};
export const CLAUDE_RESET_ARGUMENTS: Readonly<Record<ClaudeResetKind, string>> = {
	session: "5-hour",
	weekly: "weekly",
	fable: "fable",
	full: "full",
};
const MAX_MODEL_WINDOWS = 2;
const MAX_ENTRIES = 4;

function fields(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function percent(value: unknown, scale: number): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const used = Math.round(value * scale * 10) / 10;
	return used >= 0 && used <= 100 ? used : undefined;
}

function instant(value: unknown): string | undefined {
	const milliseconds =
		typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : Number.NaN;
	if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 8_640_000_000_000_000) return undefined;
	return new Date(milliseconds).toISOString();
}

function window(id: ClaudeUsageWindowId, label: string, used: number | undefined, reset: unknown) {
	if (used === undefined) return [];
	const resetAt = instant(reset);
	return [{ id, label, usedPercent: used, ...(resetAt ? { resetAt } : {}) }];
}

export function claudeUsageFromRateLimitInfo(value: unknown, now = new Date()): ClaudeLoginUsage | undefined {
	const info = fields(value);
	const windows = fields(info?.unifiedWindows);
	const five = fields(windows?.five_hour);
	const week = fields(windows?.seven_day);
	const read = [
		...window("five_hour", "5 hours", percent(five?.utilization, 100), five?.resetsAt),
		...window("seven_day", "Weekly", percent(week?.utilization, 100), week?.resetsAt),
	];
	if (!read.length) return undefined;
	const limitResetAt = info?.status === "rejected" ? instant(info.resetsAt) : undefined;
	return { observedAt: now.toISOString(), windows: read, ...(limitResetAt ? { limitResetAt } : {}) };
}

function modelName(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 .-]{0,31}$/.test(value) ? value : undefined;
}

export function claudeUsageFromGetUsage(value: unknown, now = new Date()): ClaudeLoginUsage | undefined {
	const answer = fields(value);
	const limits = fields(answer?.rate_limits);
	if (!limits) return undefined;
	// WHY: get_usage sends five_hour as null while no 5-hour window is open, which is 0 % used.
	const five =
		limits.five_hour === null && answer?.rate_limits_available !== false
			? { utilization: 0 }
			: fields(limits.five_hour);
	const week = fields(limits.seven_day);
	const models: ClaudeUsageWindow[] = [];
	const scoped = Array.isArray(limits.limits) ? limits.limits : [];
	for (const item of scoped) {
		const row = fields(item);
		const name = modelName(fields(fields(row?.scope)?.model)?.display_name);
		if (row?.kind !== "weekly_scoped" || !name || models.some((model) => model.label === `Weekly · ${name}`))
			continue;
		models.push(...window("seven_day_model", `Weekly · ${name}`, percent(row.percent, 1), row.resets_at));
		if (models.length >= MAX_MODEL_WINDOWS) break;
	}
	const read = [
		...window("five_hour", "5 hours", percent(five?.utilization, 1), five?.resets_at),
		...window("seven_day", "Weekly", percent(week?.utilization, 1), week?.resets_at),
		...models,
	];
	return read.length ? { observedAt: now.toISOString(), windows: read } : undefined;
}

export class ClaudeTerminal {
	readonly rows: number;
	readonly cols: number;
	#grid: string[][];
	#row = 0;
	#col = 0;
	#saved: [number, number] = [0, 0];

	constructor(rows: number, cols: number) {
		this.rows = rows;
		this.cols = cols;
		this.#grid = Array.from({ length: rows }, () => this.#blank());
	}

	#blank(): string[] {
		return Array.from({ length: this.cols }, () => " ");
	}

	#lineFeed(): void {
		if (this.#row === this.rows - 1) {
			this.#grid.shift();
			this.#grid.push(this.#blank());
		} else this.#row += 1;
	}

	#put(character: string): void {
		if (this.#col >= this.cols) {
			this.#col = 0;
			this.#lineFeed();
		}
		this.#grid[this.#row]![this.#col] = character;
		this.#col += 1;
	}

	feed(text: string): void {
		let index = 0;
		while (index < text.length) {
			const character = text[index]!;
			if (character === "\x1b") {
				const control = /^\x1b\[([?<>=]?)([0-9;]*)[ -/]*([@-~])/.exec(text.slice(index, index + 64));
				if (control) {
					if (!control[1]) this.#control(control[2] ?? "", control[3]!);
					index += control[0].length;
					continue;
				}
				const command = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(text.slice(index, index + 4096));
				if (command) {
					index += command[0].length;
					continue;
				}
				const next = text[index + 1];
				if (next === "(" || next === ")") {
					index += 3;
					continue;
				}
				if (next === "7") this.#saved = [this.#row, this.#col];
				if (next === "8") [this.#row, this.#col] = this.#saved;
				index += 2;
				continue;
			}
			if (character === "\r") this.#col = 0;
			else if (character === "\n") this.#lineFeed();
			else if (character === "\b") this.#col = Math.max(0, this.#col - 1);
			else if (character === "\t") this.#col = Math.min(this.cols - 1, (Math.floor(this.#col / 8) + 1) * 8);
			else if (character >= " " && character !== "\x7f") this.#put(character);
			index += character.length;
		}
	}

	#control(parameters: string, final: string): void {
		const numbers = parameters ? parameters.split(";").map((part) => Number.parseInt(part || "0", 10)) : [];
		const first = numbers[0] ?? 0;
		const step = Math.max(first, 1);
		const row = (value: number) => Math.min(this.rows - 1, Math.max(0, value));
		const col = (value: number) => Math.min(this.cols - 1, Math.max(0, value));
		if (final === "A") this.#row = row(this.#row - step);
		else if (final === "B") this.#row = row(this.#row + step);
		else if (final === "C") this.#col = col(this.#col + step);
		else if (final === "D") this.#col = col(this.#col - step);
		else if (final === "E") [this.#row, this.#col] = [row(this.#row + step), 0];
		else if (final === "F") [this.#row, this.#col] = [row(this.#row - step), 0];
		else if (final === "G") this.#col = col(step - 1);
		else if (final === "d") this.#row = row(step - 1);
		else if (final === "H" || final === "f")
			[this.#row, this.#col] = [row(Math.max(numbers[0] ?? 1, 1) - 1), col(Math.max(numbers[1] ?? 1, 1) - 1)];
		else if (final === "J") {
			if (first === 0) {
				this.#erase(this.#row, this.#col, this.cols);
				for (let line = this.#row + 1; line < this.rows; line++) this.#grid[line] = this.#blank();
			} else if (first === 1) {
				for (let line = 0; line < this.#row; line++) this.#grid[line] = this.#blank();
				this.#erase(this.#row, 0, this.#col + 1);
			} else this.#grid = Array.from({ length: this.rows }, () => this.#blank());
		} else if (final === "K") {
			if (first === 0) this.#erase(this.#row, this.#col, this.cols);
			else if (first === 1) this.#erase(this.#row, 0, this.#col + 1);
			else this.#grid[this.#row] = this.#blank();
		} else if (final === "S")
			for (let times = 0; times < step; times++) {
				this.#grid.shift();
				this.#grid.push(this.#blank());
			}
	}

	#erase(line: number, from: number, to: number): void {
		const cells = this.#grid[line]!;
		for (let index = Math.max(0, from); index < Math.min(this.cols, to); index++) cells[index] = " ";
	}

	lines(): string[] {
		return this.#grid.map((cells) => cells.join("").trimEnd());
	}
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function claudeScreenDate(text: string, now = new Date()): string | null {
	const match =
		/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:, (\d{1,2})(?::(\d{2}))?(am|pm))?$/.exec(
			text.trim(),
		);
	if (!match) return null;
	const month = MONTHS.indexOf(match[1]!);
	const day = Number(match[2]);
	const hour = match[3] === undefined ? 0 : (Number(match[3]) % 12) + (match[5] === "pm" ? 12 : 0);
	const minute = match[4] === undefined ? 0 : Number(match[4]);
	if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
	for (const year of [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
		const at = Date.UTC(year, month, day, hour, minute);
		if (new Date(at).getUTCDate() !== day) continue;
		if (at >= now.getTime() - 2 * 86_400_000 && at < now.getTime() + 366 * 86_400_000)
			return new Date(at).toISOString();
	}
	return null;
}

function kindOfWords(words: string): ClaudeResetKind | undefined {
	return CLAUDE_RESET_KINDS.find((kind) => KIND_WORDS[kind] === words);
}

function count(text: string): number | undefined {
	if (text === "no") return 0;
	return /^\d{1,3}$/.test(text) ? Number(text) : undefined;
}

export type ClaudeResetScreen =
	| {
			readonly kind: "confirm";
			readonly reset: ClaudeResetKind;
			readonly left: number;
			readonly refills: string | null;
			readonly weekStays: string | null;
			readonly useBy: string | null;
			readonly yesFocused: boolean;
	  }
	| {
			readonly kind: "choose";
			readonly offers: readonly {
				readonly reset: ClaudeResetKind;
				readonly left: number;
				readonly until: string | null;
			}[];
	  }
	| { readonly kind: "answer"; readonly line: string };

function answerLine(lines: readonly string[]): string | undefined {
	for (let index = lines.length - 1; index >= 0; index--) {
		const start = lines[index]!.indexOf("⎿");
		if (start < 0) continue;
		const parts = [lines[index]!.slice(start + 1).trim()];
		for (let next = index + 1; next < lines.length; next++) {
			const line = lines[next]!;
			if (!/^ {5,}\S/.test(line) || line.includes("❯") || line.includes("──")) break;
			parts.push(line.trim());
		}
		return parts.join(" ").replace(/\s+/g, " ");
	}
	return undefined;
}

export function readClaudeResetScreen(lines: readonly string[], now = new Date()): ClaudeResetScreen | undefined {
	const trimmed = lines.map((line) => line.trim());
	const footer = trimmed.lastIndexOf("Enter to confirm · Esc to cancel");
	if (footer >= 0) {
		let titleAt = footer - 1;
		while (
			titleAt >= 0 &&
			!/^Use an? .+\?$/.test(trimmed[titleAt]!) &&
			trimmed[titleAt] !== "Which reset do you want to use?"
		)
			titleAt -= 1;
		if (titleAt < 0) return undefined;
		const body = trimmed.slice(titleAt, footer).filter((line) => line !== "");
		if (body[0] === "Which reset do you want to use?") {
			const offers = [];
			for (const line of body.slice(1)) {
				const offer = /^(?:❯ )?Use an? (.+) \((\d{1,3}) left(?:, until (.+))?\)$/.exec(line);
				const reset = offer ? kindOfWords(offer[1]!) : undefined;
				if (!offer || !reset) return undefined;
				offers.push({ reset, left: Number(offer[2]), until: offer[3] ? claudeScreenDate(offer[3], now) : null });
			}
			return offers.length > 0 && offers.length <= MAX_ENTRIES ? { kind: "choose", offers } : undefined;
		}
		const reset = kindOfWords(/^Use an? (.+)\?$/.exec(body[0]!)?.[1] ?? "");
		if (!reset) return undefined;
		const yes = body.findIndex((line) => line.replace(/^❯ /, "") === `Yes, use my ${KIND_WORDS[reset]}`);
		const no = body.findIndex((line) => line.replace(/^❯ /, "") === "No, keep it");
		if (yes < 0 || no !== yes + 1) return undefined;
		const refill = body.find((line) => line.startsWith("Refills your "));
		const refills = refill ? (/^Refills your (.+?) now(?: · |$)/.exec(refill)?.[1] ?? null) : null;
		const week = refill ? /your weekly reset day stays (.+?)(?: · |$)/.exec(refill)?.[1] : undefined;
		const detail = body
			.map((line) => /^(\d{1,3}|no) (.+?) left(?: · use by (.+))?$/.exec(line))
			.find((match) => match && (match[2] === COUNT_WORDS[reset] || match[2] === `${COUNT_WORDS[reset]}s`));
		const left = detail ? count(detail[1]!) : undefined;
		if (left === undefined) return undefined;
		return {
			kind: "confirm",
			reset,
			left,
			refills,
			weekStays: week ? claudeScreenDate(week, now) : null,
			useBy: detail?.[3] ? claudeScreenDate(detail[3], now) : null,
			yesFocused: body[yes]!.startsWith("❯ "),
		};
	}
	const line = answerLine(lines);
	return line ? { kind: "answer", line } : undefined;
}

export type ClaudeResetAnswer =
	| { readonly kind: "none" }
	| { readonly kind: "saved"; readonly left: number; readonly useBy: string | null }
	| { readonly kind: "reset"; readonly left: number | null }
	| { readonly kind: "failed" }
	| { readonly kind: "unconfirmed" };

const DONE = ["5-hour limit reset", "Fable reset used", "Limits reset", "Weekly limits reset", "Reset used"];

export function claudeResetAnswer(line: string, now = new Date()): ClaudeResetAnswer | undefined {
	if (line === "No reset to use · you're not at a usage limit right now") return { kind: "none" };
	const saved =
		/^You have an? (?:reset|.+ reset) saved for when you reach a usage limit · run \/limit-reset when you do · (\d{1,3}) resets? left(?: · use by (.+))?$/.exec(
			line,
		);
	if (saved)
		return { kind: "saved", left: Number(saved[1]), useBy: saved[2] ? claudeScreenDate(saved[2], now) : null };
	if (/^(?:Couldn't confirm the reset went through|Still couldn't confirm your reset)(?: · |$)/.test(line))
		return { kind: "unconfirmed" };
	if (
		/^Couldn't reset your (?:limits|5-hour limit)(?: right now)? · (?:nothing was used · )?try again/.test(line) ||
		/^No .+ to use · /.test(line) ||
		/^Your .+ can't be used/.test(line)
	)
		return { kind: "failed" };
	const head = line.split(" · ", 1)[0]!;
	if (DONE.includes(head)) {
		const left = /(?:^| · )(?:(\d{1,3})|no) [A-Za-z0-9 -]+? resets? left(?: · |$)/.exec(line);
		const known = left ? (left[1] === undefined ? 0 : Number(left[1])) : null;
		return { kind: "reset", left: /(?:^| · )no [A-Za-z0-9 -]+? resets left/.test(line) ? 0 : known };
	}
	return undefined;
}

export function claudeResetEntry(screen: Extract<ClaudeResetScreen, { kind: "confirm" }>): ClaudeResetEntry {
	return {
		kind: screen.reset,
		left: screen.left,
		refills: screen.refills,
		weekStays: screen.weekStays,
		useBy: screen.useBy,
		usable: "now",
	};
}
