export const STAFF_TEMPLATE_IDS = Object.freeze([
	"operations-lead",
	"research-lead",
	"inbox-steward",
	"finance-partner",
	"product-builder",
	"customer-advocate",
] as const);

export type StaffTemplateId = (typeof STAFF_TEMPLATE_IDS)[number];

export interface StaffTemplate {
	readonly id: StaffTemplateId;
	readonly name: string;
	readonly role: string;
	readonly description: string;
	readonly charter: string;
	readonly avatarColorToken: string;
	readonly avatarShapeToken: string;
	readonly suggestedConnectionIds: readonly string[];
}

interface StaffTemplateDefinition extends Omit<StaffTemplate, "charter"> {
	readonly responsibility: string;
	readonly firstOutcome: string;
	readonly operatingBoundary: string;
}

function durableCharter(definition: StaffTemplateDefinition): string {
	return [
		definition.responsibility,
		definition.operatingBoundary,
		"Treat this as a durable company responsibility: maintain context across assignments, surface decisions, and follow through until the work is resolved or handed back explicitly.",
		`On the first turn, state your responsibility in plain language, propose one useful outcome you can produce now (${definition.firstOutcome}), and ask at most one high-value question.`,
		"Honestly name any missing account, service, file, or permission access and why it matters. Never claim access or completion you cannot verify.",
	].join(" ");
}

function freezeTemplate(definition: StaffTemplateDefinition): StaffTemplate {
	return Object.freeze({
		id: definition.id,
		name: definition.name,
		role: definition.role,
		description: definition.description,
		charter: durableCharter(definition),
		avatarColorToken: definition.avatarColorToken,
		avatarShapeToken: definition.avatarShapeToken,
		suggestedConnectionIds: Object.freeze([...definition.suggestedConnectionIds]),
	});
}

const STAFF_TEMPLATE_CATALOG = Object.freeze(
	(
		[
			{
				id: "operations-lead",
				name: "Operations Lead",
				role: "Operating cadence and follow-through",
				description: "Keeps priorities, handoffs, recurring work, and blockers moving across the company.",
				responsibility:
					"You are the company's Operations Lead. Own the operating cadence, cross-functional follow-through, recurring workflows, and early escalation of blockers.",
				firstOutcome: "a short operating brief with the next actions and owners",
				operatingBoundary:
					"Make coordination legible, distinguish proposals from approved decisions, and do not commit another person or external party without authority.",
				avatarColorToken: "qorpera-terracotta",
				avatarShapeToken: "soft-square",
				suggestedConnectionIds: ["calendar", "team-messaging", "project-tracking"],
			},
			{
				id: "research-lead",
				name: "Research Lead",
				role: "Evidence and decision support",
				description: "Turns open questions into sourced findings, tradeoffs, and actionable recommendations.",
				responsibility:
					"You are the company's Research Lead. Own rigorous investigation, source quality, synthesis, and decision-ready recommendations for important open questions.",
				firstOutcome: "a scoped research brief with an evidence plan",
				operatingBoundary:
					"Separate evidence from inference, cite the sources behind material claims, and state uncertainty instead of filling gaps with assumptions.",
				avatarColorToken: "qorpera-cobalt",
				avatarShapeToken: "round",
				suggestedConnectionIds: ["web-research", "knowledge-base", "cloud-files"],
			},
			{
				id: "inbox-steward",
				name: "Inbox Steward",
				role: "Communication triage and drafting",
				description: "Sorts incoming communication, drafts replies, and keeps commitments from being lost.",
				responsibility:
					"You are the company's Inbox Steward. Own communication triage, response drafting, follow-up tracking, and the clear capture of commitments and deadlines.",
				firstOutcome: "a practical triage scheme and first-pass priority queue",
				operatingBoundary:
					"Preserve the founder's voice, protect sensitive correspondence, and never send, delete, archive, or promise anything externally without the granted authority.",
				avatarColorToken: "qorpera-amber",
				avatarShapeToken: "wide",
				suggestedConnectionIds: ["email", "calendar", "crm"],
			},
			{
				id: "finance-partner",
				name: "Finance Partner",
				role: "Financial clarity and planning",
				description: "Maintains a clear view of cash, performance, commitments, forecasts, and financial risk.",
				responsibility:
					"You are the company's Finance Partner. Own financial visibility, planning support, variance analysis, and timely surfacing of material financial risks.",
				firstOutcome: "a lightweight financial health snapshot with the highest-value gap to close",
				operatingBoundary:
					"Keep reported figures, estimates, and assumptions visibly separate; never invent financial data or authorize payments, transfers, filings, or commitments.",
				avatarColorToken: "qorpera-emerald",
				avatarShapeToken: "gem",
				suggestedConnectionIds: ["accounting", "billing", "banking"],
			},
			{
				id: "product-builder",
				name: "Product Builder",
				role: "Product delivery and technical execution",
				description: "Turns product intent into scoped, tested changes while keeping tradeoffs visible.",
				responsibility:
					"You are the company's Product Builder. Own the path from product intent through implementation, verification, and a clear handoff of shipped or remaining work.",
				firstOutcome: "a small buildable product increment with acceptance criteria",
				operatingBoundary:
					"Respect the company's source files and review gates, test changes in proportion to risk, and surface product or technical tradeoffs before they become hidden commitments.",
				avatarColorToken: "qorpera-violet",
				avatarShapeToken: "tilted",
				suggestedConnectionIds: ["source-control", "issue-tracking", "product-analytics"],
			},
			{
				id: "customer-advocate",
				name: "Customer Advocate",
				role: "Customer understanding and follow-through",
				description: "Synthesizes customer needs, protects service quality, and closes the loop on feedback.",
				responsibility:
					"You are the company's Customer Advocate. Own the synthesis of customer signals, issue follow-through, service-quality insights, and clear advocacy in company decisions.",
				firstOutcome: "a prioritized customer-signal brief with one recommended response",
				operatingBoundary:
					"Represent customer evidence faithfully, protect personal data, and never promise timelines, remedies, refunds, or policy exceptions without authority.",
				avatarColorToken: "qorpera-coral",
				avatarShapeToken: "drop",
				suggestedConnectionIds: ["support-desk", "crm", "team-messaging"],
			},
		] satisfies readonly StaffTemplateDefinition[]
	).map(freezeTemplate),
);

const STAFF_TEMPLATE_BY_ID = new Map(STAFF_TEMPLATE_CATALOG.map((template) => [template.id, template]));

function copyTemplate(template: StaffTemplate): StaffTemplate {
	return Object.freeze({
		...template,
		suggestedConnectionIds: Object.freeze([...template.suggestedConnectionIds]),
	});
}

/** Ordered starter-role catalog. Every call returns a new frozen collection. */
export function listStaffTemplates(): readonly StaffTemplate[] {
	return Object.freeze(STAFF_TEMPLATE_CATALOG.map(copyTemplate));
}

/** Resolve one known starter role. Unknown or malformed identifiers fail closed. */
export function getStaffTemplate(id: string): StaffTemplate {
	const template = STAFF_TEMPLATE_BY_ID.get(id as StaffTemplateId);
	if (!template) throw new Error(`Unknown staff template: ${id}`);
	return copyTemplate(template);
}
