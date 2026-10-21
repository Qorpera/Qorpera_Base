import {
	CLOUD_MEMBER_FOLDER_PAGE,
	type CloudMemberFolderClient,
	type CloudMemberFolderEntry,
	type CloudMemberFolderUnit,
	type CloudMemberFolderUnitResult,
} from "@qorpera/cloud-client/cloud-member-folder";
import {
	COMPANY_STATE_FILE_MAX_BYTES,
	type CompanyStateFile,
	freeCompanyStateName,
	parseCompanyStateFile,
} from "@qorpera/cloud-client/company-state-files";

/*
 * A member's changes to a folder-v2 company's state files (folder core C4, P34a-2;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §5): the web's agent and group chat editors write
 * `QorperaOS/agents/<handle>/agent.md` and `QorperaOS/agents/groups/<handle>/group.md` through the member commit route,
 * as the member. Each file is checked with the shared parser before it is sent, so a member sees a problem without a
 * round trip; the core and its hook decide the rest. Concurrency is the path's version: a write names the version it
 * read, a folder delete names the folder's version and the seq it was read at.
 */

/** What these writers need of the member's folder client. */
export type WebMemberFolder = Pick<CloudMemberFolderClient, "read" | "list" | "readFile" | "stateFolders" | "commit">;

/** The core answered that this change set was not saved (refused, denied, or a conflict another try does not
 * resolve): nothing was written, so the same change may be corrected and sent as a new one. */
export class WebCompanyFolderRejectedError extends Error {
	readonly outcome: CloudMemberFolderUnitResult["outcome"];
	readonly reason: string | null;
	/** The file's or the hook's problems, in English (§5), for a view to show under its own words. */
	readonly problems: readonly string[];
	constructor(
		message: string,
		result: Pick<CloudMemberFolderUnitResult, "outcome" | "reason">,
		problems: readonly string[] = [],
	) {
		super(message);
		this.name = "WebCompanyFolderRejectedError";
		this.outcome = result.outcome;
		this.reason = result.reason;
		this.problems = problems;
	}
}

/** A folder listing page; a company's agents or group chats fit in a few. */
const LIST_PAGE = CLOUD_MEMBER_FOLDER_PAGE;
const MAX_LISTED = 10_000;
/** Tries of a new folder whose name turned out to be taken (by another writer since the listing). */
const CREATE_TRIES = 3;
/** Retries of a write or a delete when something changed under it between the read and the commit. */
const RETRIES = 3;

/** A path's parent folder. */
export function parentPath(path: string): string {
	return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/** The names under a folder, in lowercase, every page. */
export async function folderNames(folder: WebMemberFolder, parent: string, signal: AbortSignal): Promise<Set<string>> {
	const names = new Set<string>();
	let after: string | null = null;
	let listed = 0;
	for (;;) {
		const page = await folder.list(parent, after, LIST_PAGE, signal);
		for (const entry of page.entries) names.add((entry.path.split("/").at(-1) ?? "").toLowerCase());
		listed += page.entries.length;
		if (page.next === null) return names;
		if (listed >= MAX_LISTED) throw new Error("The company folder lists too many entries here");
		after = page.next;
	}
}

/** A state file's entry and text, decoded as strict UTF-8 (a byte-order mark kept, so a rewrite keeps every other
 * byte); null when the path is gone. */
export async function readStateFile(
	folder: WebMemberFolder,
	path: string,
	signal: AbortSignal,
): Promise<{ entry: CloudMemberFolderEntry; text: string } | null> {
	const read = await folder.read(path, signal);
	if (!read.entry) return null;
	if (read.entry.kind !== "file" || !read.entry.file || read.entry.file.bytes > COMPANY_STATE_FILE_MAX_BYTES)
		throw new Error(`${path} is not a company state file`);
	const bytes = await folder.readFile(read.entry.file, signal, COMPANY_STATE_FILE_MAX_BYTES);
	return { entry: read.entry, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
}

/** A state file's parse when it is one and has no problems, else its problems' messages. */
export function parseStateFile(
	path: string,
	text: string,
): { ok: true; file: CompanyStateFile } | { ok: false; problems: string[] } {
	const parsed = parseCompanyStateFile(path, text);
	if (!parsed) return { ok: false, problems: [`${path} is not a company state file`] };
	return parsed.ok ? { ok: true, file: parsed.file } : { ok: false, problems: parsed.problems.map((p) => p.message) };
}

/** `failure`, with the problems' messages after it when there are some. */
export function withProblems(failure: string, problems: readonly string[]): string {
	const listed = problems.map((problem) => problem.trim()).filter(Boolean);
	return listed.length ? `${failure.replace(/[.\s]+$/, "")}: ${listed.join("; ")}.` : failure;
}

/** The error for a unit that was not saved. Members' changes are never reviewed, so `waiting_for_review` is not
 * expected; it is not a refusal either, so it is a plain error. */
export function unsaved(result: CloudMemberFolderUnitResult, failure: string): Error {
	if (result.outcome === "waiting_for_review") return new Error(failure);
	const problems = result.problems.map((problem) => problem.message);
	return new WebCompanyFolderRejectedError(withProblems(failure, problems), result, problems);
}

/** A refusal before anything is sent: the file's own problems. */
export function invalid(failure: string, problems: readonly string[]): WebCompanyFolderRejectedError {
	return new WebCompanyFolderRejectedError(
		withProblems(failure, problems),
		{ outcome: "refused", reason: "invalid" },
		problems,
	);
}

/** The settled outcome of a one-unit change set. A refused or conflicting unit is an answer, never an exception. */
export async function commitUnit(
	folder: WebMemberFolder,
	operationKey: string,
	unit: CloudMemberFolderUnit,
	signal: AbortSignal,
): Promise<CloudMemberFolderUnitResult> {
	const answer = await folder.commit(operationKey, [unit], signal);
	const result = answer.units[0];
	if (!result) throw new Error("The company folder answered no change");
	return result;
}

/** A body after a file's settings block, laid out as the platform's writers lay it out: the closing `---` line, then
 * the trimmed text and one line break (nothing for an empty text). The settings block keeps every byte. */
export function withStateBody(text: string, body: string): string {
	const lines = text.split("\n");
	const bare = (line: string | undefined) => (line ?? "").replace(/^﻿/, "").replace(/\r$/, "");
	const close = bare(lines[0]) === "---" ? lines.findIndex((line, index) => index > 0 && bare(line) === "---") : -1;
	if (close < 0) throw new Error("The file has no settings block");
	return `${lines.slice(0, close + 1).join("\n")}\n${body.trim() ? `${body.trim()}\n` : ""}`;
}

export interface WebStateFolderCreation {
	/** Where the folder goes: `QorperaOS/agents` or `QorperaOS/agents/groups`. */
	readonly parent: string;
	/** The display name its handle comes from (`freeCompanyStateName`), and the handle when none is left of it. */
	readonly name: string;
	readonly fallback: string;
	/** Handles no folder here may take. */
	readonly reserved?: readonly string[];
	/** The change set's key for a handle. The same key with the same contents replays the same change set, so a retry
	 * after a lost answer never creates a second folder; another handle is another change set. */
	readonly key: (handle: string) => string;
	readonly contents: Extract<CloudMemberFolderUnit, { op: "new_folder" }>["contents"];
	/** The plain message when it is not saved. */
	readonly failure: string;
}

/** Creates a state folder under a handle free in the member's listing. Another writer can take a free handle after the
 * listing: `exists` then takes the next handle, with a new key, at most three tries in all. (A folder the member may not
 * read is usually closed to their writes too, so the core answers `denied` there, before `exists`.) Answers the
 * folder's path. */
export async function createStateFolder(
	folder: WebMemberFolder,
	creation: WebStateFolderCreation,
	signal: AbortSignal,
	check: () => void,
): Promise<string> {
	const taken = await folderNames(folder, creation.parent, signal);
	check();
	for (const name of creation.reserved ?? []) taken.add(name);
	for (let attempt = 1; ; attempt++) {
		const handle = freeCompanyStateName(creation.name, creation.fallback, taken);
		const path = `${creation.parent}/${handle}`;
		const problems = creation.contents.flatMap((item) => {
			if (item.kind !== "file") return [];
			const parsed = parseCompanyStateFile(`${path}/${item.path}`, item.text);
			return parsed && !parsed.ok ? parsed.problems.map((problem) => problem.message) : [];
		});
		if (problems.length) throw invalid(creation.failure, problems);
		const result = await commitUnit(
			folder,
			creation.key(handle),
			{ op: "new_folder", path, contents: creation.contents },
			signal,
		);
		check();
		if (result.outcome === "saved") return path;
		if (result.outcome === "conflict" && result.reason === "exists" && attempt < CREATE_TRIES) {
			taken.add(handle);
			continue;
		}
		throw unsaved(result, creation.failure);
	}
}

/** Rewrites a state file from what it holds now. `locate` finds its path (null: it is gone); `rewrite` makes the new
 * text from the current one, or null to write nothing. The write names the version it read; when the file changed in
 * between, it is read and rewritten again, at most three more times. Answers whether it wrote. */
export async function rewriteStateFile(
	folder: WebMemberFolder,
	options: {
		readonly locate: () => Promise<string | null>;
		readonly rewrite: (text: string, path: string) => string | null;
		readonly key: () => string;
		readonly gone: string;
		readonly failure: string;
		/** `true` just before the write is sent (from then on, a failure may leave it written); `false` when its answer
		 * says it was not saved. */
		readonly sent?: (sending: boolean) => void;
	},
	signal: AbortSignal,
	check: () => void,
): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		const path = await options.locate();
		check();
		const current = path === null ? null : await readStateFile(folder, path, signal);
		check();
		if (path === null || current === null) throw new Error(options.gone);
		const text = options.rewrite(current.text, path);
		if (text === null) return false;
		const parsed = parseStateFile(path, text);
		if (!parsed.ok) throw invalid(options.failure, parsed.problems);
		options.sent?.(true);
		const result = await commitUnit(
			folder,
			options.key(),
			{ op: "write", path, text, expectedVersion: current.entry.version },
			signal,
		);
		if (result.outcome !== "saved" && result.outcome !== "waiting_for_review") options.sent?.(false);
		check();
		if (result.outcome === "saved") return true;
		if (result.outcome === "conflict" && result.reason === "version_changed" && attempt < RETRIES) continue;
		throw unsaved(result, options.failure);
	}
}

/** Deletes a state folder with everything in it. The delete names the folder's version and the seq of the same read,
 * so the core refuses it when something under the folder changed since (`unseen_change`); an active agent's runs write
 * under its folder often, so it reads again and retries, at most three times. A folder already gone is deleted. */
export async function deleteStateFolder(
	folder: WebMemberFolder,
	options: {
		readonly locate: () => Promise<string | null>;
		readonly key: () => string;
		readonly failure: string;
	},
	signal: AbortSignal,
	check: () => void,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		const path = await options.locate();
		check();
		if (path === null) return;
		const read = await folder.read(path, signal);
		check();
		if (!read.entry) return;
		if (read.entry.kind !== "folder") throw new Error(options.failure);
		const result = await commitUnit(
			folder,
			options.key(),
			{ op: "delete", path, expectedVersion: read.entry.version, asOfSeq: read.asOfSeq },
			signal,
		);
		check();
		if (result.outcome === "saved" || (result.outcome === "conflict" && result.reason === "missing")) return;
		if (
			result.outcome === "conflict" &&
			(result.reason === "unseen_change" || result.reason === "version_changed") &&
			attempt < RETRIES
		)
			continue;
		throw unsaved(result, options.failure);
	}
}
