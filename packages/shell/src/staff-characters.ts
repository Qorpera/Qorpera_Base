import type { StaffTemplateId } from "./staff-templates.ts";

export const STAFF_CHARACTER_IDS = Object.freeze([
	"pebble",
	"lantern",
	"brain",
	"wisp",
	"halo",
	"ribbon",
	"bloom",
] as const);

export type StaffCharacterId = (typeof STAFF_CHARACTER_IDS)[number];

export const STAFF_CHARACTER_BY_TEMPLATE = Object.freeze({
	"financial-officer": "pebble",
	"marketing-lead": "bloom",
	"product-manager": "lantern",
	"software-developer": "wisp",
	"product-designer": "ribbon",
	"legal-expert": "halo",
	"operations-specialist": "lantern",
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
