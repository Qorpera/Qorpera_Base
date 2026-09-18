import type { StaffTemplateId } from "./staff-template-ids.ts";

export const STAFF_CHARACTER_IDS = Object.freeze([
	"planet",
	"acorn",
	"flame",
	"rocket",
	"crown",
	"heart",
	"ghost",
] as const);

export type StaffCharacterId = (typeof STAFF_CHARACTER_IDS)[number];

export const STAFF_CHARACTER_BY_TEMPLATE = Object.freeze({
	"agent-manager": "crown",
	"financial-officer": "acorn",
	"marketing-lead": "flame",
	"product-manager": "planet",
	"software-developer": "rocket",
	"product-designer": "heart",
	"legal-expert": "ghost",
	"operations-specialist": "acorn",
	"research-lead": "planet",
	"costumer-relationist": "heart",
	"outreaching-conversationalist": "flame",
} satisfies Readonly<Record<StaffTemplateId, StaffCharacterId>>);

const STAFF_CHARACTER_ID_SET = new Set<string>(STAFF_CHARACTER_IDS);

export function isStaffCharacterId(value: unknown): value is StaffCharacterId {
	return typeof value === "string" && STAFF_CHARACTER_ID_SET.has(value);
}

export function staffCharacterForTemplate(templateId: StaffTemplateId): StaffCharacterId {
	return STAFF_CHARACTER_BY_TEMPLATE[templateId];
}
