/** A company's network rules, `QorperaOS/rules/network.toml` (RUNTIME-AGENT-EXIT.md §10, E8): which names the agent exit
 * refuses for the company's machines, and whether they reach only listed names. Owners and admins write it; the
 * platform projects it to every node. A company without the file is open. Browser-safe.
 *
 * ```toml
 * mode = "open"                                     # or "only-listed"
 * block = ["casino.example", "*.torrents.example"]  # refused in both modes
 * allow = ["github.com"]                            # the only names reached in "only-listed"
 * ```
 *
 * A name covers itself and every name under it; `*.` in front covers only the names under it. A blocked name stays
 * refused when it is also covered by `allow`. `allow` does nothing in "open", so a list is kept while the mode
 * changes. */

import { osPath } from "./company-state-shared.ts";
import type { InterfaceProblem } from "./interfaces.ts";
import { parseTomlSubset, TomlSubsetError } from "./toml-subset.ts";

export const NETWORK_RULES_PATH = osPath("rules/network.toml");
export const NETWORK_RULES_MODES = Object.freeze(["open", "only-listed"] as const);
export type NetworkRulesMode = (typeof NETWORK_RULES_MODES)[number];
/** The most names one list holds. */
export const NETWORK_RULES_MAX_NAMES = 1000;
const MAX_BYTES = 64 * 1024;
const MAX_PROBLEMS = 50;

/** A name as the exit's resolver matches it: lowercase labels of 1–63 letters, digits and inner hyphens, at most 253
 * characters, and `*.` in front for the names under it alone. The last label is never all digits, so an address is
 * not read as a name. The database checks the same (SQL `qorpera_company_network_rules_name_valid`). */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const NAME = new RegExp(`^(?:\\*\\.)?(?:${LABEL}\\.)*${LABEL}$`);
const LAST_LABEL_DIGITS = /(?:^|\.)[0-9]+$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const encoder = new TextEncoder();

export interface NetworkRulesFile {
	readonly kind: "network-rules";
	readonly mode: NetworkRulesMode;
	/** Names the company's machines never reach, as written. */
	readonly block: readonly string[];
	/** The names reached in "only-listed", as written. */
	readonly allow: readonly string[];
}

export type NetworkRulesParseResult =
	| { readonly ok: true; readonly file: NetworkRulesFile; readonly problems: readonly [] }
	| { readonly ok: false; readonly file: null; readonly problems: readonly InterfaceProblem[] };

/** Whether `value` is a name a list may hold. */
export function isNetworkRulesName(value: string): boolean {
	const name = value.startsWith("*.") ? value.slice(2) : value;
	return name.length <= 253 && NAME.test(value) && !LAST_LABEL_DIGITS.test(name);
}

/** Why a list entry is not a name, in the words a person fixes it by. */
function nameProblem(value: string): string {
	const shown = clip(value);
	if (value === "") return "An empty text is not a name.";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes("/"))
		return `"${shown}": write the name alone, without https:// or a path.`;
	if (value !== value.toLowerCase() && isNetworkRulesName(value.toLowerCase()))
		return `"${shown}": write the name in lowercase, as "${clip(value.toLowerCase())}".`;
	if (value.endsWith(".") && isNetworkRulesName(value.slice(0, -1)))
		return `"${shown}": write the name without the dot at the end.`;
	if (value.slice(value.startsWith("*.") ? 2 : 0).includes("*"))
		return `"${shown}": a * stands only at the very front, as "*.example.com".`;
	const name = value.startsWith("*.") ? value.slice(2) : value;
	if (LAST_LABEL_DIGITS.test(name) && NAME.test(value))
		return `"${shown}" is an address. The rules list names; a site's addresses change.`;
	return `"${shown}" is not a name. Names are lowercase letters, digits, hyphens and dots, as "example.com".`;
}

/** Reads `QorperaOS/rules/network.toml`. Checks everything the file says by itself; the database checks the parse's shape
 * again and keeps the rules the nodes read. */
export function parseNetworkRulesFile(text: string): NetworkRulesParseResult {
	const problems: InterfaceProblem[] = [];
	// Problems past the cap, counted for the closing "and K more problems" with the first one's code, as the state
	// files and interfaces report them.
	let dropped = 0;
	let droppedCode: InterfaceProblem["code"] | null = null;
	const add = (line: number | null, key: string | null, code: InterfaceProblem["code"], message: string) => {
		if (problems.length < MAX_PROBLEMS) problems.push({ line, key, code, message });
		else {
			dropped++;
			droppedCode ??= code;
		}
	};
	const refused = (): NetworkRulesParseResult => {
		const list = [...problems];
		if (dropped > 0 && droppedCode)
			list.push({
				line: null,
				key: null,
				code: droppedCode,
				message: `and ${dropped} more ${dropped === 1 ? "problem" : "problems"}`,
			});
		return { ok: false, file: null, problems: list };
	};
	if (encoder.encode(text).length > MAX_BYTES) {
		add(null, null, "too_large", `The file is larger than ${MAX_BYTES / 1024} KiB.`);
		return refused();
	}
	if (LONE_SURROGATE.test(text) || text.includes("\ufeff")) {
		add(null, null, "encoding", "The file must be UTF-8 text without a byte order mark.");
		return refused();
	}
	let document: ReturnType<typeof parseTomlSubset>;
	try {
		document = parseTomlSubset(text);
	} catch (error) {
		if (!(error instanceof TomlSubsetError)) throw error;
		add(error.line, null, "toml", error.message);
		return refused();
	}
	const bag = document.value;
	const line = (key: string) => document.lines.get(key) ?? null;
	for (const key of Object.keys(bag))
		if (key !== "mode" && key !== "block" && key !== "allow")
			add(line(key), clip(key), "unknown_key", `"${clip(key)}" is not a key here. Allowed: mode, block, allow.`);
	let mode: NetworkRulesMode = "open";
	if (bag.mode !== undefined) {
		if (typeof bag.mode === "string" && (NETWORK_RULES_MODES as readonly string[]).includes(bag.mode))
			mode = bag.mode as NetworkRulesMode;
		else add(line("mode"), "mode", "bad_value", `mode must be one of: ${NETWORK_RULES_MODES.join(", ")}.`);
	}
	const list = (key: "block" | "allow"): string[] => {
		const items = bag[key];
		if (items === undefined) return [];
		if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
			add(line(key), key, "bad_value", `${key} must be a list of names in quotes, as ["example.com"].`);
			return [];
		}
		if (items.length > NETWORK_RULES_MAX_NAMES) {
			add(
				line(key),
				key,
				"too_large",
				`${key} takes at most ${NETWORK_RULES_MAX_NAMES} names, not ${items.length}.`,
			);
			return [];
		}
		const seen = new Set<string>();
		items.forEach((item, index) => {
			if (!isNetworkRulesName(item)) add(line(key), `${key}[${index}]`, "bad_value", nameProblem(item));
			else if (seen.has(item))
				add(line(key), `${key}[${index}]`, "duplicate", `${key} lists "${clip(item)}" twice.`);
			seen.add(item);
		});
		return items as string[];
	};
	const block = list("block");
	const allow = list("allow");
	const blocked = new Set(block);
	allow.forEach((name, index) => {
		if (blocked.has(name) && isNetworkRulesName(name))
			add(
				line("allow"),
				`allow[${index}]`,
				"duplicate",
				`"${clip(name)}" is both blocked and allowed. Keep it in one list.`,
			);
	});
	if (problems.length > 0) return refused();
	return { ok: true, file: { kind: "network-rules", mode, block, allow }, problems: [] };
}

function clip(value: string): string {
	return [...value].length > 60 ? `${[...value].slice(0, 57).join("")}…` : value;
}
