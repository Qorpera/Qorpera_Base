import { array, record, timestamp, uuid } from "./parse.ts";

/* A company's logo (migration 20260930696000). The official logo is the company folder's QorperaOS/brand/logo.svg, which
 * the company's Branding & Identity agent draws and an owner or admin can replace. Everyone sees it through a PNG drawn
 * from that SVG, a private storage object named <company UUID>/<sha256 of the SVG>.png: members, people invited to the
 * company and friends of its members. A member who may write the folder keeps the PNG current (`publisher`); the answer
 * then also says which SVG the folder holds (`sourceSha256`), so the app knows when its PNG is behind. */

export const COMPANY_LOGO_BUCKET = "qorpera-company-logos";
export const COMPANY_LOGO_PATH = "QorperaOS/brand/logo.svg";
export const COMPANY_BRAND_FOLDER = "QorperaOS/brand";

const OBJECT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{64})\.png$/;

export interface CompanyLogo {
	profileId: string;
	/** The PNG everyone sees, or null while there is none. */
	objectName: string | null;
	updatedAt: string | null;
	/** The caller may keep the PNG current. */
	publisher: boolean;
	/** For a publisher: the sha256 of the folder's logo.svg, or null when the folder holds none. */
	sourceSha256: string | null;
}

export interface CompanyLogoChange {
	/** The PNG this change replaced or took away; the publisher deletes it. */
	previousObjectName?: string;
}

export function companyLogoName(profileId: string, sourceSha256: string): string {
	const name = `${profileId.toLowerCase()}/${sourceSha256}.png`;
	if (!OBJECT_NAME.test(name)) throw new Error("Invalid logo name.");
	return name;
}

export function isCompanyLogoName(value: string, profileId?: string): boolean {
	const match = OBJECT_NAME.exec(value);
	return Boolean(match) && (profileId === undefined || match![1] === profileId.toLowerCase());
}

/** The sha256 of the SVG a PNG was drawn from. */
export function companyLogoSource(objectName: string): string | null {
	return OBJECT_NAME.exec(objectName)?.[2] ?? null;
}

function sha(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

export function parseCompanyLogos(value: unknown): CompanyLogo[] {
	return array(value, "company logos").map((item) => {
		const input = record(item, "company logo");
		const profileId = uuid(input.profile_id, "logo company id");
		const objectName = input.object_name ?? null;
		if (objectName !== null && (typeof objectName !== "string" || !isCompanyLogoName(objectName, profileId)))
			throw new Error("Invalid logo name");
		return {
			profileId,
			objectName,
			updatedAt: input.updated_at == null ? null : timestamp(input.updated_at, "logo time"),
			publisher: input.publisher === true,
			sourceSha256: sha(input.source_sha256, "logo source"),
		};
	});
}

export function parseCompanyLogoChange(value: unknown): CompanyLogoChange {
	const input = record(value, "logo change");
	const previous = input.previous_object_name;
	if (previous === null || previous === undefined) return {};
	if (typeof previous !== "string" || !isCompanyLogoName(previous)) throw new Error("Invalid previous logo name");
	return { previousObjectName: previous };
}
