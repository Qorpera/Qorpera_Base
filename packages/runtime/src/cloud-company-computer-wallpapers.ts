import type { StaffCharacterId } from "@qorpera/cloud-client/staff-characters";

/** Guest image assets have stable names and ordering independent of UI avatars. */
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

export const COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER = Object.freeze({
	planet: "folio",
	acorn: "pebble",
	flame: "bloom",
	rocket: "wisp",
	crown: "brain",
	heart: "ribbon",
	ghost: "halo",
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
