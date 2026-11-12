import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";
import { array, boundedInteger, CloudShapeError, nonEmptyString, oneOf, record, uuid } from "./parse.ts";

/* A member's calls for the company's code kept in Qorpera (migration 20260930720000_code_change_record, own code
 * storage step 2b): which repositories the company has, and, for an owner or admin, a download of one. The code host
 * makes the download as a file in the company folder, under code/<owner>/<name>/downloads/: `files` is the code as it
 * is now in one .zip, `history` the same with its whole history, for a developer. The web then reads that file from
 * the folder, piece by piece (app/views/code-download.ts). The list also names the company's GitHub copies (migration
 * 20260930735000): folders under code/ that hold a project's working copy from GitHub, not code kept in Qorpera. */

export const CODE_DOWNLOAD_KINDS = ["files", "history"] as const;
export type CodeDownloadKind = (typeof CODE_DOWNLOAD_KINDS)[number];

/** A folder file's most bytes (64 pieces of 4 MiB); the code host makes none over 200 MiB. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** One call's deadline. Each is a few index reads; the web asks again every two seconds while it waits. */
const CALL_MS = 15_000;

/** GitHub's own rule for a project, as its owner and name (qorpera_coding_repository_valid, host github.com). */
const GITHUB_PROJECT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export interface CodeRepositories {
	/** The caller may ask for a download: owners and admins. */
	readonly canDownload: boolean;
	readonly repositories: readonly { readonly owner: string; readonly name: string }[];
	/** None on a cloud from before the key, and when the key is not as this version reads it. */
	readonly githubCopies: readonly CodeGitHubCopy[];
}

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

/** The three calls, for one company. */
export interface CodeDownloadCalls {
	list(signal: AbortSignal): Promise<CodeRepositories>;
	/** Asks for a download: the one that is there when the code has not changed since, the one being made, or a new
	 * one. */
	request(owner: string, name: string, file: CodeDownloadKind, signal: AbortSignal): Promise<CodeDownload>;
	read(requestId: string, signal: AbortSignal): Promise<CodeDownload>;
}

export function parseCodeRepositories(value: unknown): CodeRepositories {
	const input = record(value, "code repositories");
	if (input.schema !== "qorpera.code-repositories/v1" || typeof input.canDownload !== "boolean")
		throw new CloudShapeError("code repositories");
	return {
		canDownload: input.canDownload,
		repositories: array(input.repositories, "code repositories").map((entry) => {
			const item = record(entry, "code repository");
			return {
				owner: nonEmptyString(item.owner, "code repository owner", 256),
				name: nonEmptyString(item.name, "code repository name", 256),
			};
		}),
		githubCopies: githubCopies(input.githubCopies),
	};
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
	};
}
