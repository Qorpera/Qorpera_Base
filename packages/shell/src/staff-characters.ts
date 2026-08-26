import type { StaffTemplateId } from "./staff-templates.ts";

export const STAFF_CHARACTER_IDS = Object.freeze([
	"pebble",
	"folio",
	"brain",
	"wisp",
	"halo",
	"ribbon",
	"bloom",
] as const);

export type StaffCharacterId = (typeof STAFF_CHARACTER_IDS)[number];

export const STAFF_CHARACTER_BY_TEMPLATE = Object.freeze({
	"agent-manager": "brain",
	"financial-officer": "pebble",
	"marketing-lead": "bloom",
	"product-manager": "folio",
	"software-developer": "wisp",
	"product-designer": "ribbon",
	"legal-expert": "halo",
	"operations-specialist": "pebble",
	"research-lead": "brain",
	"costumer-relationist": "bloom",
	"outreaching-conversationalist": "ribbon",
} satisfies Readonly<Record<StaffTemplateId, StaffCharacterId>>);

const STAFF_CHARACTER_ID_SET = new Set<string>(STAFF_CHARACTER_IDS);

export function isStaffCharacterId(value: unknown): value is StaffCharacterId {
	return typeof value === "string" && STAFF_CHARACTER_ID_SET.has(value);
}

export function staffCharacterForTemplate(templateId: StaffTemplateId): StaffCharacterId {
	return STAFF_CHARACTER_BY_TEMPLATE[templateId];
}

/** The renderer's character derivation, shared so other surfaces (the
 * Company Computer's per-screen wallpaper) resolve the same creature the
 * shell shows: template mapping first, else a stable hash of the identity
 * so every machine and tomorrow's session agree without writes. */
export function staffCharacterForIdentity(templateId: string | undefined, identity: string): StaffCharacterId {
	if (templateId && templateId in STAFF_CHARACTER_BY_TEMPLATE) {
		return STAFF_CHARACTER_BY_TEMPLATE[templateId as StaffTemplateId];
	}
	let seed = 0;
	for (const character of identity) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
	return STAFF_CHARACTER_IDS[seed % STAFF_CHARACTER_IDS.length] as StaffCharacterId;
}
