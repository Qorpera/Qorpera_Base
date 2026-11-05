import { companyPathKey, osPath, osRelative } from "./company-state-shared.ts";

/* An agent's wall (Jonas, 5 November 2026: "a poster or wall of updates kept within rules, instead of many new
 * messages"): what the agent has done, with links, what it is working on, and what waits on a member, kept in place in
 * `QorperaOS/agents/<handle>/wall.md`. The agent keeps it with `update_wall`, and the web pins it above the agent's
 * thread. It is an ordinary file of the folder, so a member may edit it too; the write tools refuse a wall that breaks
 * the rules below. This module is the format both sides read. Browser-safe.
 *
 *     # Wall
 *
 *     ## Waits on you
 *     - Pick a shop name. My pick is Båndklar. [The names](folder:research/shop-names.md)
 *
 *     ## Working on
 *     - Checking five shops' prices
 *
 *     ## Done
 *     - 2026-11-05: Team hired
 *
 * An item is one line of Markdown, links included (`folder:` for a file, `app:` for an interface app). A done item
 * starts with the day it was done, newest first. */

export const WALL_FILE = "wall.md";
export const WALL_MAX_BYTES = 16 * 1024;
/** One item, in characters. */
export const WALL_ITEM_MAX_CHARS = 240;
export const WALL_WAITING_MAX = 6;
export const WALL_WORKING_MAX = 6;
/** Done items a wall keeps; the writer drops the oldest past it. */
export const WALL_DONE_MAX = 40;
/** Done items newer than this many days show on the poster; older ones fold into Earlier. */
export const WALL_RECENT_DAYS = 7;

export type WallPart = "waiting" | "working" | "done";

/** The parts' headings, as written and read (in any case). */
export const WALL_HEADINGS: Readonly<Record<WallPart, string>> = Object.freeze({
	waiting: "Waits on you",
	working: "Working on",
	done: "Done",
});

const LIMITS: Readonly<Record<WallPart, number>> = {
	waiting: WALL_WAITING_MAX,
	working: WALL_WORKING_MAX,
	done: WALL_DONE_MAX,
};

export interface WallDone {
	/** `YYYY-MM-DD`. */
	readonly day: string;
	readonly text: string;
}

export interface Wall {
	readonly waiting: readonly string[];
	readonly working: readonly string[];
	/** Newest first. */
	readonly done: readonly WallDone[];
}

export interface WallProblem {
	readonly line: number;
	readonly message: string;
}

/** The wall as read, and what breaks its rules. A wall with problems still holds every item that reads, for the web. */
export interface WallParse {
	readonly wall: Wall;
	readonly problems: readonly WallProblem[];
}

export const EMPTY_WALL: Wall = Object.freeze({ waiting: [], working: [], done: [] });

/** The wall file of the agent whose folder is `QorperaOS/agents/<handle>/`. */
export function wallPath(handle: string): string {
	return osPath(`agents/${handle}/${WALL_FILE}`);
}

/** The agent folder name a wall path is in (as written), or null when the path is no agent's wall. */
export function wallHandle(path: string): string | null {
	const below = osRelative(companyPathKey(path));
	if (below === null) return null;
	const parts = below.split("/");
	if (parts.length !== 3 || parts[0] !== "agents" || parts[2] !== WALL_FILE) return null;
	if (parts[1] === "groups" || parts[1] === "sections.md") return null;
	return path.split("/").at(-2) ?? null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a `YYYY-MM-DD` names a real day. */
export function isWallDay(value: string): boolean {
	const match = DAY.exec(value);
	if (!match) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** An item's text as kept: one line, runs of spaces as one, or a problem in plain words. */
export function wallItemProblem(text: string): string | null {
	if (/[\0-\x1f\x7f]/.test(text)) return "an item is one line, with no tabs or control characters";
	const trimmed = text.trim();
	if (!trimmed) return "an item is empty";
	if ([...trimmed].length > WALL_ITEM_MAX_CHARS)
		return `an item is at most ${WALL_ITEM_MAX_CHARS} characters: put the rest in a file and link it`;
	return null;
}

export function wallItemText(text: string): string {
	return text.trim().replace(/ {2,}/g, " ");
}

/** Reads a wall. Text outside the three parts (the title, a note under it) is the file's own and is not read. */
export function parseWall(text: string): WallParse {
	const problems: WallProblem[] = [];
	const parts: { waiting: string[]; working: string[]; done: WallDone[] } = { waiting: [], working: [], done: [] };
	if (new TextEncoder().encode(text).length > WALL_MAX_BYTES)
		problems.push({ line: 1, message: `a wall is at most ${WALL_MAX_BYTES / 1024} KiB` });
	let part: WallPart | null = null;
	const headings = Object.entries(WALL_HEADINGS) as [WallPart, string][];
	const seen = new Set<WallPart>();
	text.split("\n").forEach((raw, index) => {
		const line = raw.replace(/\r$/, "");
		const at = index + 1;
		const heading = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
		if (heading) {
			const name = (heading[1] ?? "").toLowerCase();
			const found = headings.find(([, words]) => words.toLowerCase() === name);
			if (!found) {
				problems.push({
					line: at,
					message: `a wall has the parts ${headings.map(([, words]) => `"## ${words}"`).join(", ")} (found "${line.trim()}")`,
				});
				part = null;
				return;
			}
			if (seen.has(found[0])) problems.push({ line: at, message: `"## ${found[1]}" is written twice` });
			seen.add(found[0]);
			part = found[0];
			return;
		}
		if (part === null || !line.trim()) return;
		const item = /^[ \t]*[-*][ \t]+(.*)$/.exec(line);
		if (!item) {
			problems.push({ line: at, message: 'each line under a part is an item, starting with "- "' });
			return;
		}
		let words = item[1] ?? "";
		let day: string | null = null;
		if (part === "done") {
			const dated = /^(\d{4}-\d{2}-\d{2}):[ \t]+(.*)$/.exec(words);
			if (!dated || !isWallDay(dated[1] ?? "")) {
				problems.push({
					line: at,
					message: 'a done item starts with the day it was done, as "- 2026-11-05: Team hired"',
				});
				return;
			}
			day = dated[1] ?? null;
			words = dated[2] ?? "";
		}
		const problem = wallItemProblem(words);
		if (problem) {
			problems.push({ line: at, message: problem });
			return;
		}
		if (part === "done") parts.done.push({ day: day as string, text: wallItemText(words) });
		else parts[part].push(wallItemText(words));
	});
	for (const [name, words] of headings)
		if (parts[name].length > LIMITS[name])
			problems.push({ line: 1, message: `"${words}" holds at most ${LIMITS[name]} items` });
	for (let index = 1; index < parts.done.length; index++)
		if ((parts.done[index]?.day ?? "") > (parts.done[index - 1]?.day ?? "")) {
			problems.push({ line: 1, message: "done items go newest first" });
			break;
		}
	return { wall: parts, problems };
}

/** The wall as the writer keeps it: the three parts in order, every item on its own line. */
export function renderWall(wall: Wall): string {
	const out = ["# Wall"];
	const part = (name: WallPart, lines: readonly string[]) => {
		out.push("", `## ${WALL_HEADINGS[name]}`);
		for (const line of lines) out.push(`- ${line}`);
	};
	part("waiting", wall.waiting);
	part("working", wall.working);
	part(
		"done",
		wall.done.map((item) => `${item.day}: ${item.text}`),
	);
	return `${out.join("\n")}\n`;
}

/** The done items to show and those folded into Earlier: older than {@link WALL_RECENT_DAYS} days before `today`
 * (`YYYY-MM-DD`). */
export function foldWallDone(
	done: readonly WallDone[],
	today: string,
): { readonly recent: readonly WallDone[]; readonly earlier: readonly WallDone[] } {
	const from = new Date(`${today}T00:00:00Z`);
	from.setUTCDate(from.getUTCDate() - WALL_RECENT_DAYS);
	const cut = from.toISOString().slice(0, 10);
	return { recent: done.filter((item) => item.day > cut), earlier: done.filter((item) => item.day <= cut) };
}
