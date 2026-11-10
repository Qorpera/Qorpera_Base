import type { RetiredStaffCharacterId, StaffCharacterId } from "@qorpera/cloud-client/staff-characters";

/**
 * The backdrops every installed guest image carries, under the file names they
 * have always had. The names are historical; the figure drawn in each file is an
 * avatar (see `deploy/lxd-company-computer-guest/backdrops-source`).
 */
export const COMPANY_COMPUTER_FIRST_WALLPAPER_IDS = Object.freeze([
	"pebble",
	"folio",
	"brain",
	"wisp",
	"halo",
	"ribbon",
	"bloom",
] as const);

export type CompanyComputerFirstWallpaperId = (typeof COMPANY_COMPUTER_FIRST_WALLPAPER_IDS)[number];

/**
 * Every backdrop a guest image is packaged with. The six added in November
 * 2026 are named for the figure they draw, and only an image built since then
 * has them.
 */
export const COMPANY_COMPUTER_WALLPAPER_IDS = Object.freeze([
	...COMPANY_COMPUTER_FIRST_WALLPAPER_IDS,
	"star",
	"cloud",
	"bolt",
	"mushroom",
	"moon",
	"puzzle",
] as const);

export type CompanyComputerWallpaperId = (typeof COMPANY_COMPUTER_WALLPAPER_IDS)[number];

/**
 * Which installed file draws which avatar. This follows the traced figure inside
 * each template, not the old template-to-name table: `brain.html` holds the
 * planet silhouette, `folio.html` the acorn, and so on. A regression test pins
 * every entry to the baked avatar path so the two cannot drift apart again.
 *
 * The ghost is retired and drawn as the moon. Its file is in every image, and
 * stands in for the moon on an image built before the moon had a backdrop.
 */
export const COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER = Object.freeze({
	planet: "brain",
	acorn: "folio",
	flame: "ribbon",
	rocket: "pebble",
	crown: "halo",
	heart: "bloom",
	star: "star",
	cloud: "cloud",
	bolt: "bolt",
	mushroom: "mushroom",
	moon: "moon",
	puzzle: "puzzle",
	ghost: "wisp",
} satisfies Readonly<Record<StaffCharacterId | RetiredStaffCharacterId, CompanyComputerWallpaperId>>);

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
