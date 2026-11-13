import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, nonEmptyString, oneOf, record, uuid } from "./parse.ts";

/* A member's calls for the company's code kept in Qorpera (migration 20260930720000_code_change_record, own code
 * storage step 2b): which repositories the company has, and, for an owner or admin, a download of one. The code host
 * makes the download as a file in the company folder, under code/<owner>/<name>/downloads/: `files` is the code as it
 * is now in one .zip, `history` the same with its whole history, for a developer. The web then reads that file from
 * the folder, piece by piece (app/views/code-download.ts). The list also names the company's GitHub copies (migration
 * 20260930735000): folders under code/ that hold a project's working copy from GitHub, not code kept in Qorpera. And
 * with migration 20260930736000 an owner or admin brings code in from GitHub (app/views/code-import.ts): the list says
 * what is being brought in, the last one that was not, and per repository where it came from; with migration
 * 20260930741000 also the other lines of work that came with it. */

export const CODE_DOWNLOAD_KINDS = ["files", "history"] as const;
export type CodeDownloadKind = (typeof CODE_DOWNLOAD_KINDS)[number];

/** A folder file's most bytes (64 pieces of 4 MiB); the code host makes none over 200 MiB. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** One call's deadline. Each is a few index reads; the web asks again every two seconds while it waits. */
const CALL_MS = 15_000;

/** GitHub's own rule for a project, as its owner and name (qorpera_coding_repository_valid, host github.com). */
const GITHUB_PROJECT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export interface CodeRepositories {
	/** The caller may ask for a download, and may bring code in: owners and admins. */
	readonly canDownload: boolean;
	readonly repositories: readonly CodeRepository[];
	/** None on a cloud from before the key, and when the key is not as this version reads it. */
	readonly githubCopies: readonly CodeGitHubCopy[];
	/** Absent on a cloud that cannot bring code in (from before its `bringing` key), and when that key is not as
	 * this version reads it: then nothing of the import is offered. */
	readonly imports?: CodeImports;
}

export interface CodeRepository {
	readonly owner: string;
	readonly name: string;
	/** Where it came from, when it was brought in; absent for code that began in Qorpera. */
	readonly imported?: CodeImported;
}

export interface CodeImported {
	readonly from: "github" | "file";
	readonly at: string;
	/** The changes on its main line that came with it; null when the list does not say. */
	readonly earlierChanges: number | null;
	/** The other lines of work that came with it, with changes its main line did not have (migration 20260930741000);
	 * absent when the list does not say, or says there were none. */
	readonly otherWork?: CodeOtherWork;
	/** The number of the repository's last change (the list's `changes`): 1 while nothing has changed since it came
	 * in. Absent when the list does not say. */
	readonly lastChange?: number;
}

export interface CodeOtherWork {
	/** The lines of work, at least 1. */
	readonly lines: number;
	/** The changes on them that the main line did not have, each counted once; at least 1. */
	readonly changes: number;
}

export interface CodeImports {
	/** What is being brought in now (one at a time in a company). */
	readonly bringing: readonly CodeBringing[];
	/** The last one that was refused or failed, in the last 24 hours. */
	readonly last: CodeImportEnd | null;
}

export interface CodeBringing {
	/** Where it lands: code/<owner>/<name>. */
	readonly owner: string;
	readonly name: string;
	/** The project on GitHub (Owner/Name), or null for a file. */
	readonly github: string | null;
	/** How far it is (`fetch`, `read`, `look`, `close`, …); null before it started. */
	readonly step: string | null;
	/** It waits for the company's agents to be done. */
	readonly waiting: boolean;
}

export interface CodeImportEnd {
	readonly owner: string;
	readonly name: string;
	/** Why: the outcome's code, as it came. */
	readonly reason: string;
	/** The project on GitHub (Owner/Name), when the list names where it came from; null otherwise. */
	readonly github: string | null;
	/** It came from a file (an agent's bundle), when the list says so: a file has its own bounds. */
	readonly file?: true;
}

/** The answer to an owner's or admin's ask to bring code in. `queued`: it is on its way (or was already). `refused`:
 * nothing was started, with why. `other`: an answer this version does not know (it was in already, say). */
export type CodeImportAnswer =
	| { readonly state: "queued"; readonly requestId: string }
	| { readonly state: "refused"; readonly reason: string }
	| { readonly state: "other" };

/** A folder code/<owner>/<name> that holds the working copy of a project on GitHub. */
export interface CodeGitHubCopy {
	readonly owner: string;
	readonly name: string;
	/** The project as GitHub spells it, Owner/Name; in lower case it is the folder's owner/name. */
	readonly github: string;
}

/** How a download stands. `refused`: none was started (`too_many`: the company's 20 a day are used; `no_executor`:
 * nothing holds the company's code just now). `failed`: it ended without a file (`too_large`: over 200 MiB; `busy`:
 * it was put off behind coding turns every time; `failed`: anything else, a file that is gone again among it). A
 * reason this version does not know reads as it came. */
export type CodeDownload =
	| CodeDownloadWaiting<"queued">
	| CodeDownloadWaiting<"running">
	| {
			readonly state: "ready";
			readonly requestId: string;
			readonly file: CodeDownloadKind;
			/** The file in the company folder: code/<owner>/<name>/downloads/<name>-<date>.zip, or .bundle. */
			readonly path: string;
			readonly bytes: number;
	  }
	| CodeDownloadEnded<"refused">
	| CodeDownloadEnded<"failed">;

interface CodeDownloadWaiting<State> {
	readonly state: State;
	readonly requestId: string;
	readonly file: CodeDownloadKind;
}

interface CodeDownloadEnded<State> {
	readonly state: State;
	readonly file: CodeDownloadKind;
	readonly reason: string;
}

/** The member's code calls, for one company. */
export interface CodeDownloadCalls {
	list(signal: AbortSignal): Promise<CodeRepositories>;
	/** Asks for a download: the one that is there when the code has not changed since, the one being made, or a new
	 * one. */
	request(owner: string, name: string, file: CodeDownloadKind, signal: AbortSignal): Promise<CodeDownload>;
	read(requestId: string, signal: AbortSignal): Promise<CodeDownload>;
	/** Asks to bring the GitHub project `github` (Owner/Name) in as code/<owner>/<name>. Asked again, it answers the
	 * import already open for it. */
	bringIn(owner: string, name: string, github: string, signal: AbortSignal): Promise<CodeImportAnswer>;
}

export function parseCodeRepositories(value: unknown): CodeRepositories {
	const input = record(value, "code repositories");
	if (input.schema !== "qorpera.code-repositories/v1" || typeof input.canDownload !== "boolean")
		throw new CloudShapeError("code repositories");
	const imports = codeImports(input.bringing, input.lastImport);
	return {
		canDownload: input.canDownload,
		repositories: array(input.repositories, "code repositories").map((entry) => {
			const item = record(entry, "code repository");
			const imported = codeImported(
				item.importedFrom,
				item.importedAt,
				item.earlierChanges,
				item.otherWork,
				item.changes,
			);
			return {
				owner: nonEmptyString(item.owner, "code repository owner", 256),
				name: nonEmptyString(item.name, "code repository name", 256),
				...(imported ? { imported } : {}),
			};
		}),
		githubCopies: githubCopies(input.githubCopies),
		...(imports ? { imports } : {}),
	};
}

/** What is being brought in and the last that was not, or nothing when `bringing` is missing or anything in it is not
 * as expected: the web goes live before the SQL, and then offers nothing of the import. A `lastImport` that is not as
 * expected is left out alone. */
function codeImports(bringing: unknown, last: unknown): CodeImports | null {
	const entries = Array.isArray(bringing) ? bringing.map(codeBringing) : null;
	if (!entries?.every((entry): entry is CodeBringing => entry !== null)) return null;
	return { bringing: entries, last: codeImportEnd(last) };
}

function codeBringing(value: unknown): CodeBringing | null {
	if (!value || typeof value !== "object") return null;
	const { owner, name, from, step, waiting } = value as Record<string, unknown>;
	if (typeof owner !== "string" || !owner || typeof name !== "string" || !name) return null;
	if (step !== null && step !== undefined && typeof step !== "string") return null;
	const source = from && typeof from === "object" ? (from as Record<string, unknown>) : {};
	const github = typeof source.github === "string" && GITHUB_PROJECT.test(source.github) ? source.github : null;
	if (!github && (typeof source.file !== "string" || !source.file)) return null;
	return {
		owner,
		name,
		github,
		step: step || null,
		waiting: waiting === true || (typeof waiting === "string" && !!waiting),
	};
}

function codeImportEnd(value: unknown): CodeImportEnd | null {
	if (!value || typeof value !== "object") return null;
	const { owner, name, reason, from } = value as Record<string, unknown>;
	const named = from && typeof from === "object" ? (from as Record<string, unknown>) : {};
	const github = typeof named.github === "string" && GITHUB_PROJECT.test(named.github) ? named.github : null;
	const file = !github && typeof named.file === "string" && named.file !== "";
	return typeof owner === "string" && owner && typeof name === "string" && name && typeof reason === "string"
		? { owner, name, reason, github, ...(file ? { file: true as const } : {}) }
		: null;
}

/** Where a repository came from, or nothing for code that began here or a key that is not as expected. The other work
 * that came with it and the last change's number are read leniently: one that is not as expected is left out alone. */
function codeImported(
	from: unknown,
	at: unknown,
	earlier: unknown,
	other: unknown,
	last: unknown,
): CodeImported | null {
	if (!from || typeof from !== "object" || typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
	const kind = (from as Record<string, unknown>).kind;
	if (kind !== "github" && kind !== "file") return null;
	const earlierChanges = Number.isSafeInteger(earlier) && (earlier as number) >= 0 ? (earlier as number) : null;
	const otherWork = codeOtherWork(other);
	const lastChange = Number.isSafeInteger(last) && (last as number) >= 1 ? (last as number) : null;
	return {
		from: kind,
		at,
		earlierChanges,
		...(otherWork ? { otherWork } : {}),
		...(lastChange !== null ? { lastChange } : {}),
	};
}

/** `otherWork: {lines, changes}`, each a whole number of at least 1; anything else (null, the key missing on a cloud from
 * before 20260930741000) is none. */
function codeOtherWork(value: unknown): CodeOtherWork | null {
	if (!value || typeof value !== "object") return null;
	const { lines, changes } = value as Record<string, unknown>;
	const counted = (count: unknown): count is number => Number.isSafeInteger(count) && (count as number) >= 1;
	return counted(lines) && counted(changes) ? { lines, changes } : null;
}

export function parseCodeImportAnswer(value: unknown): CodeImportAnswer {
	const input = record(value, "code import");
	if (input.schema !== "qorpera.code-import/v1" || typeof input.state !== "string")
		throw new CloudShapeError("code import");
	if (input.state === "queued") return { state: "queued", requestId: uuid(input.requestId, "code import id") };
	if (input.state === "refused")
		return { state: "refused", reason: typeof input.reason === "string" && input.reason ? input.reason : "failed" };
	return { state: "other" };
}

/** The GitHub copies, or none when the key is missing or anything in it is not as expected: the web goes live before
 * the SQL that adds the key, and Storage then stays as it was. */
function githubCopies(value: unknown): CodeGitHubCopy[] {
	const copies = Array.isArray(value) ? value.map(githubCopy) : [];
	return copies.every((copy): copy is CodeGitHubCopy => copy !== null) ? copies : [];
}

function githubCopy(value: unknown): CodeGitHubCopy | null {
	if (!value || typeof value !== "object") return null;
	const { owner, name, github } = value as Record<string, unknown>;
	if (typeof owner !== "string" || typeof name !== "string" || typeof github !== "string") return null;
	return GITHUB_PROJECT.test(github) && github.toLowerCase() === `${owner}/${name}` ? { owner, name, github } : null;
}

export function parseCodeDownload(value: unknown): CodeDownload {
	const input = record(value, "code download");
	if (input.schema !== "qorpera.code-download/v1") throw new CloudShapeError("code download");
	const file = oneOf(input.file, CODE_DOWNLOAD_KINDS, "code download file");
	const state = oneOf(input.state, ["queued", "running", "ready", "refused", "failed"], "code download state");
	if (state === "refused" || state === "failed")
		return { state, file, reason: typeof input.reason === "string" && input.reason ? input.reason : "failed" };
	const requestId = uuid(input.requestId, "code download id");
	if (state !== "ready") return { state, requestId, file };
	return {
		state,
		requestId,
		file,
		path: nonEmptyString(input.path, "code download path", 4096),
		bytes: boundedInteger(input.bytes, "code download size", 0, MAX_DOWNLOAD_BYTES),
	};
}

export function codeDownloadCalls(cloud: Cloud, profileId: string): CodeDownloadCalls {
	const call = (name: string, args: Record<string, unknown>, signal: AbortSignal) =>
		withCloudDeadline(() => cloud.rpc(name, { p_profile_id: profileId, ...args }), CALL_MS, signal);
	return {
		list: async (signal) => parseCodeRepositories(await call("qorpera_list_code_repositories", {}, signal)),
		request: async (owner, name, file, signal) =>
			parseCodeDownload(
				await call("qorpera_request_code_download", { p_owner: owner, p_name: name, p_file: file }, signal),
			),
		read: async (requestId, signal) =>
			parseCodeDownload(await call("qorpera_code_download", { p_request_id: requestId }, signal)),
		bringIn: async (owner, name, github, signal) =>
			parseCodeImportAnswer(
				await call("qorpera_request_code_import", { p_owner: owner, p_name: name, p_github: github }, signal),
			),
	};
}
