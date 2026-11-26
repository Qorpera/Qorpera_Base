import { isUuidAnyCase } from "@qorpera/contracts";

export const CLOUD_COMPANY_RENAME_WAKE_SCHEMA = "qorpera.company-rename-wake/v1";

const WAKE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const KEYS = [
	"schema",
	"renameId",
	"oldName",
	"newName",
	"renamedAt",
	"commitId",
	"visionSeq",
	"renamedByUserId",
] as const;

export interface CloudCompanyRenameWakePayload {
	readonly schema: typeof CLOUD_COMPANY_RENAME_WAKE_SCHEMA;
	readonly renameId: string;
	readonly oldName: string;
	readonly newName: string;
	readonly renamedAt: string;
	readonly commitId: string | null;
	readonly visionSeq: number | null;
	readonly renamedByUserId: string | null;
}

export function parseCompanyRenameWakePayload(value: unknown, sourceId: string): CloudCompanyRenameWakePayload {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid company rename wake");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(record, key))) {
		throw new Error("Invalid company rename wake");
	}
	const visionSeq =
		record.visionSeq === null
			? null
			: typeof record.visionSeq === "number" && Number.isSafeInteger(record.visionSeq) && record.visionSeq >= 1
				? record.visionSeq
				: undefined;
	if (
		record.schema !== CLOUD_COMPANY_RENAME_WAKE_SCHEMA ||
		!isUuidAnyCase(record.renameId) ||
		record.renameId.toLowerCase() !== sourceId.toLowerCase() ||
		typeof record.oldName !== "string" ||
		record.oldName.trim().length === 0 ||
		record.oldName.length > 120 ||
		typeof record.newName !== "string" ||
		record.newName.trim().length === 0 ||
		record.newName.length > 120 ||
		record.oldName === record.newName ||
		typeof record.renamedAt !== "string" ||
		!WAKE_TIME.test(record.renamedAt) ||
		!Number.isFinite(Date.parse(record.renamedAt)) ||
		(record.commitId !== null && !isUuidAnyCase(record.commitId)) ||
		visionSeq === undefined ||
		(record.renamedByUserId !== null && !isUuidAnyCase(record.renamedByUserId))
	) {
		throw new Error("Invalid company rename wake");
	}
	return Object.freeze({
		schema: CLOUD_COMPANY_RENAME_WAKE_SCHEMA,
		renameId: record.renameId,
		oldName: record.oldName,
		newName: record.newName,
		renamedAt: record.renamedAt,
		commitId: record.commitId,
		visionSeq,
		renamedByUserId: record.renamedByUserId,
	});
}

export const COMPANY_RENAME_WAKE_PROTOCOL: readonly string[] = [
	[
		"",
		"# This run: the company was renamed",
		"The company's name changed from wake.payload.oldName to wake.payload.newName. The platform has already updated the company profile and QorperaOS/vision/vision.md's heading, and best-effort synced existing canonical brand fields (identity/company.json, identity/tokens.json, and a matching heading of identity/brief.md). It intentionally did not run a blind find-and-replace across files.",
		"If wake.payload.oldName is 'No name yet', the company just received its first real name rather than replacing an older brand name.",
		"Work through the downstream effects cleanly and contextually:",
		"1. Search company files with company_search for the old name (skip this search when oldName is 'No name yet'). Use judgment: never alter ordinary English/Danish words when the old name is a common word, and leave historical records untouched (past emails, invoices, signed contracts, bank statements, dated memos).",
		"2. Update living internal company state you own (vision prose, reading via update_reading, plans, active notes), and verify canonical brand files (identity/company.json, identity/tokens.json, identity/brief.md) if they exist so none still carry the old name. Record 'Formerly <oldName>' in your notebook with update_memory (when oldName is not 'No name yet') so you still recognize historical references or incoming messages addressed to the old name.",
		"3. Check Identity and active Surfaces (senses.surfaces). Launch focused staged sessions with start_surface_session on Identity (to refresh wordmark/logo lettering, brand copy, and assets carrying the old name) and on any active website, web app, strategy, or studio Surface whose copy, metadata, or visuals reference the old name. Never publish a live website change yourself; stage previewable changes for founder approval. If the company has active coworkers, message only owners whose area needs updates (send_coworker_message with priority true).",
		"4. Check what only a founder can change: email handles/mailboxes (list_hooks — if the company has no email address yet, or wants a new handle matching the new name, raise an ask_member mail_address card with handle options made from the new name, and never remove existing mailboxes without asking so incoming mail is not lost), website .qorpera.site addresses or custom domains (founders can change a website's address from its Address menu), and external website accounts, legal/CVR registration, or bank accounts.",
		"5. When delivery allows, post one concise, scannable update in your thread covering what you updated, which Surface sessions are now staging previews (with [Title](surface:<slug>) links on their own line), and any short remaining founder items.",
	].join("\n"),
];
