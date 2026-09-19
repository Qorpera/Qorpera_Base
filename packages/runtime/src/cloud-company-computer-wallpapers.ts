import type { StaffCharacterId } from "@qorpera/cloud-client/staff-characters";

/**
 * Guest image assets keep the file names every installed office image already
 * carries. The names are historical; the figure drawn in each file is one of the
 * current avatars (see `deploy/lxd-company-computer-guest/backdrops-source`).
 */
export const COMPANY_COMPUTER_WALLPAPER_IDS = Object.freeze([
	"pebble",
	"folio",
	"brain",
	"wisp",
	"halo",
	"ribbon",
	"bloom",
] as const);

export type CompanyComputerWallpaperId = (typeof COMPANY_COMPUTER_WALLPAPER_IDS)[number];

/**
 * Which installed file draws which avatar. This follows the traced figure inside
 * each template, not the old template-to-name table: `brain.html` holds the
 * planet silhouette, `folio.html` the acorn, and so on. A regression test pins
 * every entry to the baked avatar path so the two cannot drift apart again.
 */
export const COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER = Object.freeze({
	planet: "brain",
	acorn: "folio",
	flame: "ribbon",
	rocket: "pebble",
	crown: "halo",
	heart: "bloom",
	ghost: "wisp",
} satisfies Readonly<Record<StaffCharacterId, CompanyComputerWallpaperId>>);

/** Hourly frames follow the image name with the two-digit local hour. */
export const COMPANY_COMPUTER_SCREEN_HOURS = Object.freeze(
	Array.from({ length: 24 }, (_value, hour) => String(hour).padStart(2, "0")),
);

export const COMPANY_COMPUTER_WALLPAPER_FILES = Object.freeze(
	COMPANY_COMPUTER_WALLPAPER_IDS.flatMap((id) => [
		`qorpera-screen-${id}.png`,
		...COMPANY_COMPUTER_SCREEN_HOURS.map((hour) => `qorpera-screen-${id}-${hour}.png`),
	]).sort(),
);
