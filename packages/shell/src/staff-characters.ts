import type { StaffTemplateId } from "./staff-templates.ts";

export const STAFF_CHARACTER_IDS = Object.freeze([
	"pebble",
	"kite",
	"ollie",
	"wisp",
	"palette",
	"sable",
	"bramble",
	"nox",
	"mallow",
	"echo",
] as const);

export type StaffCharacterId = (typeof STAFF_CHARACTER_IDS)[number];

export const STAFF_CHARACTER_BY_TEMPLATE = Object.freeze({
	"financial-officer": "pebble",
	"marketing-lead": "kite",
	"product-manager": "ollie",
	"software-developer": "wisp",
	"product-designer": "palette",
	"legal-expert": "sable",
	"operations-specialist": "bramble",
	"research-lead": "nox",
	"costumer-relationist": "mallow",
	"outreaching-conversationalist": "echo",
} satisfies Readonly<Record<StaffTemplateId, StaffCharacterId>>);

const STAFF_CHARACTER_ID_SET = new Set<string>(STAFF_CHARACTER_IDS);

export function isStaffCharacterId(value: unknown): value is StaffCharacterId {
	return typeof value === "string" && STAFF_CHARACTER_ID_SET.has(value);
}

export function staffCharacterForTemplate(templateId: StaffTemplateId): StaffCharacterId {
	return STAFF_CHARACTER_BY_TEMPLATE[templateId];
}
