/** What the company's structured files share, whichever parser reads them: the folder's key for a path, the
 * QorperaOS root every structured path is under, and the agents' colour names. The state files (./company-state-files.ts, which re-exports these unchanged) and the
 * interface files (./interfaces.ts) both import from here, so neither imports the other's module for them and
 * company-state-files can dispatch to the interface parser without a cycle. Browser-safe. */

import { folderKey } from "@qorpera/contracts";

export const AGENT_COLOURS = Object.freeze([
	"charcoal",
	"brown",
	"coral",
	"orange",
	"gold",
	"green",
	"teal",
	"blue",
	"purple",
	"pink",
	"gray",
] as const);

export type AgentColour = (typeof AGENT_COLOURS)[number];

/** The folder's key for a path, as the database computes it (`qorpera_folder_key`, 20260928120000; see
 * @qorpera/contracts' folderKey). Two spellings with one key are one path. */
export function companyPathKey(path: string): string {
	return folderKey(path);
}

/** The folder at the top of the Company File that holds the platform's own folders: vision/, agents/ (with groups/ and
 * sections.md), rules/, connections/, skills/, contacts/, human-tasks/, interfaces/ and tables/ (Jonas, 21 October
 * 2026: "you want to have clear view of what's about the platform and what's about the company"). It is written
 * exactly so, and is seeded and never moved or deleted. The company's own work and code/ stay at the top. The database
 * keeps the same name (`qorpera_os_relative`, 20260930534000). */
export const QORPERA_OS_ROOT = "QorperaOS";
/** The root folder's key, as the database keys it. */
export const QORPERA_OS_KEY = "qorperaos";

/** A platform path, from the part below the root: `osPath("vision/vision.md")` is `QorperaOS/vision/vision.md`, and
 * `osPath("")` the root itself. */
export function osPath(relative: string): string {
	return relative === "" ? QORPERA_OS_ROOT : `${QORPERA_OS_ROOT}/${relative}`;
}

/** The part of a path or a key below the root, as written: `agents/co-founder` for `QorperaOS/agents/co-founder` and for
 * `qorperaos/agents/co-founder`, "" for the root itself, and null for anything outside it. The root is matched by its
 * key, as the folder finds it; only the part below it carries the case rule (contract 5.6). */
export function osRelative(path: string): string | null {
	const slash = path.indexOf("/");
	if (folderKey(slash < 0 ? path : path.slice(0, slash)) !== QORPERA_OS_KEY) return null;
	return slash < 0 ? "" : path.slice(slash + 1);
}
