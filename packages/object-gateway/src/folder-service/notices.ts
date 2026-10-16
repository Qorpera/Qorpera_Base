/** A view's notices (F3 4f-2b-2; RUNTIME-FOLDER-COMPANY-MACHINES.md, "How 4f-2 carries the report"): what came of the
 * boundaries no machine asked for, kept for the office's folder helper to ask after. A change set refused whole makes
 * no commit, so the core cannot show it: its notice is the only way the office hears of it. */
import type { Notice, NoticesAnswer } from "./protocol.ts";

/** Notices a view keeps; past this many the oldest go. */
export const NOTICES_KEPT = 32;
/** Paths a refusal's notice names (sorted); its `pathCount` says how many there were. */
export const NOTICE_PATHS = 20;
/** About the most bytes of notices one answer carries; it carries at least one. */
export const NOTICES_PAGE_BYTES = 1024 * 1024;

/** A boundary's report, as far as a notice reads it. */
interface Answered {
	readonly commitId: string | null;
	readonly seq: number | null;
	readonly paths: readonly { readonly path: string; readonly outcome: string; readonly reason?: string }[];
	readonly refused?: Extract<Notice, { refused: unknown }>["refused"];
}

/** The notice of a boundary's report: the change set it committed, or its refusal whole with the paths it refused for
 * that reason; none for a boundary that neither committed nor was refused. */
export function noticeOf(report: Answered, n: number, at: number): Notice | undefined {
	if (report.commitId) return { n, at, commitId: report.commitId, seq: report.seq };
	if (!report.refused) return undefined;
	const refused = new Set<string>();
	for (const entry of report.paths)
		if (entry.outcome === "refused" && entry.reason === report.refused) refused.add(entry.path);
	const paths = [...refused].sort();
	return { n, at, refused: report.refused, paths: paths.slice(0, NOTICE_PATHS), pathCount: paths.length };
}

/** The notices after `from`, oldest first, as one answer carries them: cut before the one that would take their JSON
 * past `budget` bytes, unless it is the first. */
export function pageOfNotices(
	notices: readonly Notice[],
	from: number,
	nonce: string,
	budget = NOTICES_PAGE_BYTES,
): NoticesAnswer {
	const page: Notice[] = [];
	let bytes = 0;
	for (const notice of notices) {
		if (notice.n <= from) continue;
		const size = Buffer.byteLength(JSON.stringify(notice));
		if (page.length > 0 && bytes + size > budget) return { nonce, notices: page, last: page.at(-1)!.n, more: true };
		page.push(notice);
		bytes += size;
	}
	return { nonce, notices: page, last: page.at(-1)?.n ?? from, more: false };
}
