/** What the company's structured files share, whichever parser reads them: the folder's key for a path and the
 * agents' colour names. The state files (./company-state-files.ts, which re-exports these unchanged) and the
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
