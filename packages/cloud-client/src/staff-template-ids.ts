export const STAFF_TEMPLATE_IDS = Object.freeze([
	"agent-manager",
	"financial-officer",
	"marketing-lead",
	"product-manager",
	"software-developer",
	"product-designer",
	"legal-expert",
	"operations-specialist",
	"research-lead",
	"costumer-relationist",
	"outreaching-conversationalist",
] as const);

export type StaffTemplateId = (typeof STAFF_TEMPLATE_IDS)[number];
