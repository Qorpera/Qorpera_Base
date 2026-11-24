import type { StaffTemplateId } from "./staff-template-ids.ts";

/** The figures an agent can be given, in the order every client shows them and walks them for an agent nobody has
 * dressed yet. */
export const STAFF_CHARACTER_IDS = Object.freeze([
	"planet",
	"acorn",
	"flame",
	"rocket",
	"crown",
	"heart",
	"star",
	"cloud",
	"bolt",
	"mushroom",
	"moon",
	"puzzle",
] as const);

export type StaffCharacterId = (typeof STAFF_CHARACTER_IDS)[number];

/** Figures no client offers any more. An agent file may still name one; every client draws its replacement. */
export const RETIRED_STAFF_CHARACTERS = Object.freeze({
	ghost: "moon",
} as const satisfies Readonly<Record<string, StaffCharacterId>>);

export type RetiredStaffCharacterId = keyof typeof RETIRED_STAFF_CHARACTERS;

export const STAFF_CHARACTER_BY_TEMPLATE = Object.freeze({
	"agent-manager": "crown",
	"financial-officer": "acorn",
	"marketing-lead": "flame",
	"product-manager": "planet",
	"software-developer": "rocket",
	"product-designer": "heart",
	"legal-expert": "moon",
	"operations-specialist": "acorn",
	"research-lead": "planet",
	"costumer-relationist": "heart",
	"outreaching-conversationalist": "flame",
} satisfies Readonly<Record<StaffTemplateId, StaffCharacterId>>);

const STAFF_CHARACTER_ID_SET = new Set<string>(STAFF_CHARACTER_IDS);

export function isStaffCharacterId(value: unknown): value is StaffCharacterId {
	return typeof value === "string" && STAFF_CHARACTER_ID_SET.has(value);
}

/** The figure drawn for a saved one: itself, or a retired figure's replacement. */
export function drawnStaffCharacter(value: unknown): StaffCharacterId | undefined {
	if (isStaffCharacterId(value)) return value;
	return typeof value === "string" && Object.hasOwn(RETIRED_STAFF_CHARACTERS, value)
		? RETIRED_STAFF_CHARACTERS[value as RetiredStaffCharacterId]
		: undefined;
}
