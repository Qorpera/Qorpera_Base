/** organization/formation.json as the organization projection accepts it
 * (qorpera_project_organization_document): exactly these six fields, the same
 * schema, formation and Co-Founder, the stage kept or moved one step along
 * COMPANY_FORMATION_STAGES, the revision one more than the file's, and a
 * completed formation stays completed. The Co-Founder's instructions name these
 * keys, and company_write refuses any other formation write before it becomes a
 * proposal, naming the stage the file is at and the one allowed next. The
 * database stays the enforcement point: this only explains its rule early. */
export const COMPANY_FORMATION_SCHEMA = "qorpera.company-formation/v1";
/** In order. The same list as the qorpera_company_formations state check. */
export const COMPANY_FORMATION_STAGES = [
	"source_inventory",
	"discovery",
	"research",
	"vision_proposal",
	"goals_ratified",
	"responsibility_map",
	"operating",
] as const;
export const COMPANY_FORMATION_STATUSES = ["active", "paused", "completed"] as const;

const FORMATION_PATH_KEY = "organization/formation.json";
const FIELDS = ["schema", "formationId", "cofounderStaffAgentId", "state", "status", "revision"] as const;

type CompanyFormationStage = (typeof COMPANY_FORMATION_STAGES)[number];
type CompanyFormationStatus = (typeof COMPANY_FORMATION_STATUSES)[number];
type CompanyFormationDocument = {
	formationId: string;
	cofounderStaffAgentId: string;
	state: CompanyFormationStage;
	status: CompanyFormationStatus;
	revision: number;
};

/** The same key qorpera_company_path_key compares: organization/Formation.json is this file too. */
export function isCompanyFormationPath(path: string): boolean {
	return path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC") === FORMATION_PATH_KEY;
}

function stage(value: unknown): value is CompanyFormationStage {
	return typeof value === "string" && (COMPANY_FORMATION_STAGES as readonly string[]).includes(value);
}

function status(value: unknown): value is CompanyFormationStatus {
	return typeof value === "string" && (COMPANY_FORMATION_STATUSES as readonly string[]).includes(value);
}

function recorded(text: string): CompanyFormationDocument | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const document = value as Record<string, unknown>;
	if (
		document.schema !== COMPANY_FORMATION_SCHEMA ||
		typeof document.formationId !== "string" ||
		typeof document.cofounderStaffAgentId !== "string" ||
		!stage(document.state) ||
		!status(document.status) ||
		!Number.isSafeInteger(document.revision) ||
		(document.revision as number) < 1
	)
		return null;
	return document as CompanyFormationDocument;
}

/** Why the projection would refuse `nextText` over the recorded `currentText`,
 * or null when it would pass or the recorded file cannot be judged here. The
 * reason names only fixed keys and whole numbers, never the written text. */
export function companyFormationWriteRefusal(currentText: string, nextText: string): string | null {
	const current = recorded(currentText);
	if (!current) return null;
	const next = COMPANY_FORMATION_STAGES[COMPANY_FORMATION_STAGES.indexOf(current.state) + 1];
	const refuse = (problem: string) =>
		`${problem}. organization/formation.json is at stage ${current.state}, revision ${current.revision}, status ${current.status}. ` +
		`Write it back with exactly its six fields: schema ${COMPANY_FORMATION_SCHEMA}, formationId and cofounderStaffAgentId unchanged, ` +
		`revision ${current.revision + 1}, state ${next ? `${current.state} or ${next}` : current.state}, ` +
		`status ${current.status === "completed" ? "completed" : COMPANY_FORMATION_STATUSES.join(", ")}.`;
	let value: unknown;
	try {
		value = JSON.parse(nextText);
	} catch {
		return refuse("the text is not JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return refuse("the text is not a JSON object");
	const document = value as Record<string, unknown>;
	if (Object.keys(document).length !== FIELDS.length || !FIELDS.every((field) => Object.hasOwn(document, field)))
		return refuse(`it must have exactly the fields ${FIELDS.join(", ")}`);
	if (document.schema !== COMPANY_FORMATION_SCHEMA) return refuse("the schema changed");
	if (document.formationId !== current.formationId || document.cofounderStaffAgentId !== current.cofounderStaffAgentId)
		return refuse("formationId and cofounderStaffAgentId must stay unchanged");
	if (document.revision !== current.revision + 1) return refuse(`revision must be ${current.revision + 1}`);
	if (document.state !== current.state && document.state !== next)
		return refuse(
			stage(document.state)
				? "the stage moves one step at a time and never back"
				: "state must be one of the formation stage keys",
		);
	if (!status(document.status)) return refuse(`status must be ${COMPANY_FORMATION_STATUSES.join(", ")}`);
	if (current.status === "completed" && document.status !== "completed")
		return refuse("a completed formation stays completed");
	return null;
}
