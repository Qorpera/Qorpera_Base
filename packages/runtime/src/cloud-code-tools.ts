import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { parseCloudCodingRepository, parseGitHubCodingRepository } from "@qorpera/contracts";
import type {
	CloudCompanyCodeDescribed,
	CloudCompanyCodeImport,
	CloudCompanyCodeImportAsked,
	CloudCompanyCodeImportLook,
	CloudCompanyCodeImportSource,
	CloudCompanyCodeRefusal,
	CloudCompanyCodeRequest,
	CloudCompanyCodeUndo,
	CloudCompanyFolderClient,
} from "./cloud-company-folder-client.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	CloudToolRefusal,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";

/*
 * `manage_code` (own code storage, step 2b; migration 20260930720000): what an agent does about the changes in the
 * company's code kept in Qorpera. Every change that goes into a repository's main code is a numbered row with a record
 * file, code/<owner>/<name>/changes/<n>.md.
 *
 * - undo: asks for one change to be taken out of main (`qorpera_folder_request_code_undo`), which adds a request the
 *   coding executor picks up within seconds. The tool then looks at the request every 2 s for at most 30 s
 *   (`qorpera_folder_code_request`) and says in words how it went. A request still open after that is said so: the same
 *   call again finds it and goes on waiting.
 * - describe: says what a customer will notice of a change, or gives a picture of it
 *   (`qorpera_folder_describe_code_change`).
 * - bring_in (step 6, migration 20260930736000; STEP6-IMPORT-BUILD.md section 6): asks for existing code, from GitHub
 *   or from a git bundle an agent wrote under code/_incoming/, to come in with its history as a new repository
 *   (`qorpera_folder_request_code_import`). The coding executor fetches it, looks at it and, unless `look` asked only
 *   for that, builds the repository. The tool looks at the request (`qorpera_folder_code_import`) as at an undo's and
 *   says what the look found and how it ended, or how far it got.
 *
 * All three are run effects under the run's own receipt, keyed by the operation key. An agent's own company run has
 * the tool, never a worker's. None is reviewed (`cloudActionEffect`): an undo puts main back to a state it had, as a
 * recorded change that can itself be undone, and an import makes a new repository and changes nothing on GitHub.
 *
 * What SQL refused before anything was asked is the tool's refusal (the model reads `REFUSED:` and why). Once a request
 * is the executor's, the tool only answers: what the code host then refused is an answer too, since it names files of
 * the repository, which are the repository's own bytes.
 */

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ACTIONS = ["undo", "describe", "bring_in"] as const;
const KEYS = {
	undo: ["action", "operationKey", "owner", "name", "change", "andLater", "reason", "notice"],
	describe: ["action", "operationKey", "owner", "name", "change", "notice", "picture"],
	bring_in: ["action", "operationKey", "owner", "name", "from", "look"],
} as const;
/** A git bundle an agent wrote for bring_in, as a company path, and the most bytes of its path: exactly the path
 * `qorpera_code_import_from_valid` takes (20260930736000, as the executor's `codeImportIncomingPathValid`), so a path
 * SQL would refuse is refused here in words. The folder is not git's own `repo.git`, and no part holds `..`. */
const INCOMING =
	/^code\/_incoming\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?)\/[A-Za-z0-9][A-Za-z0-9._-]{0,92}\.bundle$/;
const INCOMING_BYTES = 1024;
/** The most bytes of a branch to bring in: the record keeps at most 200 (20260930736000). */
const BRANCH_BYTES = 200;
/** A branch to bring in as SQL takes it (a session's base branch, `qorpera_coding_repository_valid`): letters, digits,
 * `.`, `_`, `-` and `/`, starting with a letter or a digit; no `..`; no part empty, starting or ending with `.`, or
 * ending in `.lock`. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** How often an undo's request is looked at, and for how long: the executor claims requests every 5 s, and an undo's job
 * is a handful of git commands. */
const UNDO_LOOK_MS = 2000;
const UNDO_WAIT_MS = 30_000;
/** The files of a refused undo one answer names; the rest are counted. */
const SHOWN_PATHS = 10;
const SHOWN_PATH_BYTES = 2000;

export const CLOUD_CODE_TOOL_DESCRIPTION =
	"Look after the company's code kept in Qorpera. Qorpera numbers every change that goes into a repository's main code and writes its record at code/<owner>/<name>/changes/<number>.md. " +
	"Actions: undo, describe, bring_in. Each needs operationKey, owner and name; undo and describe also need change (the number). " +
	"undo puts main back as it was without that change, as a new change of its own: nothing is lost, and an undo can be undone. Give reason in one line, and notice when customers will see the undo. When later changes built on it, nothing happens and you are told the files: then undo with andLater true, which takes out that change and every change after it, or send the session a follow-up. After an undo, check main before you tell anyone. " +
	"describe sets the change's notice (one plain sentence on what a customer will notice) and picture (a .png, .jpg, .jpeg or .webp file of at most 4 MB that shows it, in a part of the company folder everyone can read). What you leave out stays as it is. " +
	'bring_in brings existing code in with its history, as a new repository code/<owner>/<name>/ (lowercase): from {"github":"owner/name"}, or from {"file":"code/_incoming/<folder>/<name>.bundle"}, a git bundle of at most 256 MB made on a machine (from a zip: git init, add, commit, then git bundle create with --all). look true only reads it: size, history, who changed it lately, what stops it, files with key-like strings. It takes minutes: call again with the same operationKey, and tell members it shows in Storage when it is in. Replace keys it found where you can, and ask a member once for the rest. ' +
	"After a result you did not see, call again with the same operationKey. Change numbers are yours, never the members' words.";

interface CodeUndo {
	readonly action: "undo";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly change: number;
	readonly andLater: boolean;
	readonly reason: string;
	readonly notice?: string;
}
interface CodeDescribe {
	readonly action: "describe";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly change: number;
	readonly notice?: string;
	readonly picture?: string;
}
interface CodeBringIn {
	readonly action: "bring_in";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly from: CloudCompanyCodeImportSource;
	readonly look: boolean;
}
type CodeCall = CodeUndo | CodeDescribe | CodeBringIn;

/** One line of text within its bound, trimmed; an empty one is one left out. */
function line(value: unknown, field: string, characters: number): string | undefined {
	const text = typeof value === "string" ? value.trim() : value;
	if (text === undefined || text === "") return undefined;
	if (
		typeof text !== "string" ||
		Array.from(text).length > characters ||
		/[\u0000-\u001f\u007f]/.test(text) ||
		Buffer.from(text).toString("utf8") !== text
	)
		throw new CloudToolArgumentRefusal(`${field} is one line of at most ${characters} characters`);
	return text;
}

/** A GitHub project as `Owner/Name`, also from its address (github.com/Owner/Name, with https:// or .git). */
function github(value: unknown): string {
	const parts = (typeof value === "string" ? value.trim() : "")
		.replace(/^(?:https:\/\/)?(?:www\.)?github\.com\//i, "")
		.replace(/(?:\.git)?\/?$/i, "")
		.split("/");
	try {
		if (parts.length !== 2) throw new Error("INVALID_CODING_REPOSITORY");
		parseGitHubCodingRepository({ host: "github.com", owner: parts[0], name: parts[1], baseBranch: "main" });
	} catch {
		throw new CloudToolArgumentRefusal("from.github is a GitHub project's owner/name, such as acme/shop");
	}
	return parts.join("/");
}

/** A git bundle under code/_incoming/ as a company path; a machine's own path to it (/company/…) is read as one. */
function incoming(value: unknown): string {
	let path: string | undefined;
	try {
		path = parseCloudCompanyPath(typeof value === "string" ? value.trim().replace(/^\/company\//, "") : value);
	} catch {
		path = undefined;
	}
	const folder = path === undefined ? undefined : INCOMING.exec(path)?.[1];
	if (
		path === undefined ||
		Buffer.byteLength(path) > INCOMING_BYTES ||
		folder === undefined ||
		path.includes("..") ||
		folder.toLowerCase() === "repo.git"
	)
		throw new CloudToolArgumentRefusal(
			"from.file is the company path of a git bundle, code/_incoming/<folder>/<name>.bundle, of at most 1024 bytes: the folder and the name of letters, digits, ., _ and -, each starting with a letter or a digit",
		);
	return path;
}

/** The branch of a bundle to bring in, when the file names it: a branch's name, refs/heads/ left out. */
function branch(value: unknown): string {
	const name = typeof value === "string" ? value.trim().replace(/^refs\/heads\//, "") : "";
	if (
		Buffer.byteLength(name) > BRANCH_BYTES ||
		!BRANCH.test(name) ||
		name.includes("..") ||
		name
			.split("/")
			.some((part) => part === "" || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
	)
		throw new CloudToolArgumentRefusal(
			"from.branch is the name of the file's branch to bring in, of at most 200 bytes: letters, digits, ., _, - and /",
		);
	return name;
}

/** Where bring_in takes the code from: exactly one of github and file, and branch only with a file. */
function source(value: unknown): CloudCompanyCodeImportSource {
	const from =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (
		from === undefined ||
		Object.hasOwn(from, "github") === Object.hasOwn(from, "file") ||
		Object.keys(from).some((key) => !["github", "file", "branch"].includes(key)) ||
		(Object.hasOwn(from, "github") && Object.hasOwn(from, "branch"))
	)
		throw new CloudToolArgumentRefusal(
			'from is {"github":"owner/name"} or {"file":"code/_incoming/<folder>/<name>.bundle"}, with branch only for a file',
		);
	if (Object.hasOwn(from, "github")) return { github: github(from.github) };
	const file = incoming(from.file);
	return from.branch === undefined ? { file } : { file, branch: branch(from.branch) };
}

function parse(value: unknown): CodeCall {
	const a = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const action = ACTIONS.find((known) => known === a.action);
	if (action === undefined) throw new CloudToolArgumentRefusal("action is undo, describe or bring_in");
	if (Object.keys(a).some((key) => !(KEYS[action] as readonly string[]).includes(key)))
		throw new CloudToolArgumentRefusal(`${action} takes only ${KEYS[action].join(", ")}`);
	if (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey))
		throw new CloudToolArgumentRefusal(
			"operationKey is 1 to 96 letters, digits, dots, colons, hyphens and underscores, and starts with a letter or digit",
		);
	try {
		// The repository's folder, code/<owner>/<name>/, by the rule its coding sessions were started under.
		parseCloudCodingRepository({ host: "qorpera", owner: a.owner, name: a.name, baseBranch: "main" });
	} catch {
		throw new CloudToolArgumentRefusal(
			"owner and name are the repository's, as in code/<owner>/<name>/: lowercase, such as owner company and name shop",
		);
	}
	if (action === "bring_in") {
		if (a.look !== undefined && typeof a.look !== "boolean")
			throw new CloudToolArgumentRefusal("look is true or false");
		return {
			action,
			operationKey: a.operationKey,
			owner: a.owner as string,
			name: a.name as string,
			from: source(a.from),
			look: a.look === true,
		};
	}
	if (!Number.isSafeInteger(a.change) || (a.change as number) < 1 || (a.change as number) > 999_999_999)
		throw new CloudToolArgumentRefusal(
			"change is the change's number, a whole number from 1: changes/index.md in the repository's folder lists them",
		);
	const shared = {
		operationKey: a.operationKey,
		owner: a.owner as string,
		name: a.name as string,
		change: a.change as number,
	};
	const notice = line(a.notice, "notice", 200);
	if (action === "undo") {
		const reason = line(a.reason, "reason", 500);
		if (reason === undefined || Buffer.byteLength(reason) > 500)
			throw new CloudToolArgumentRefusal(
				"undo needs reason: why the change is taken out, in one line of at most 500 bytes",
			);
		if (a.andLater !== undefined && typeof a.andLater !== "boolean")
			throw new CloudToolArgumentRefusal("andLater is true or false");
		return { action, ...shared, andLater: a.andLater === true, reason, ...(notice === undefined ? {} : { notice }) };
	}
	let picture: string | undefined;
	if (a.picture !== undefined && a.picture !== "") {
		try {
			picture = parseCloudCompanyPath(a.picture);
		} catch {
			picture = undefined;
		}
		if (picture === undefined || Buffer.byteLength(picture) > 1024 || !/\.(png|jpe?g|webp)$/i.test(picture))
			throw new CloudToolArgumentRefusal(
				"picture is the company path of a .png, .jpg, .jpeg or .webp file, such as product/screens/new-price.png: not a machine path, and at most 1024 bytes",
			);
	}
	if (notice === undefined && picture === undefined)
		throw new CloudToolArgumentRefusal("describe needs notice, picture or both");
	return {
		action,
		...shared,
		...(notice === undefined ? {} : { notice }),
		...(picture === undefined ? {} : { picture }),
	};
}

/** The files a refusal named, as an answer shows them: each quoted as JSON, so a name can pass for no words of the
 * answer, the first few only, and the rest counted, with `others` it did not name. */
function inFiles(paths: readonly string[] | null, others = 0): string {
	const all = paths ?? [];
	const shown: string[] = [];
	let bytes = 0;
	for (const path of all) {
		const quoted = JSON.stringify(path);
		bytes += Buffer.byteLength(quoted);
		if (shown.length === SHOWN_PATHS || bytes > SHOWN_PATH_BYTES) break;
		shown.push(quoted);
	}
	const total = all.length + others;
	if (!shown.length) return total ? `, in ${total} ${total === 1 ? "file" : "files"}` : "";
	return `, in ${shown.join(", ")}${total > shown.length ? ` and ${total - shown.length} more` : ""}`;
}

/** The code of a failure or of a refusal with no words of its own, for whoever looks into it. */
function codeMark(code: string | null): string {
	return code !== null && /^[A-Z][A-Z0-9_:]{0,119}$/.test(code) ? ` [code=${code}]` : "";
}

/** Why SQL raised instead of taking the call: nothing was asked and nothing was saved. */
function raised(reason: CloudCompanyCodeRefusal, request: CodeCall): string {
	switch (reason) {
		case "no_change":
		case "invalid":
			if (request.action === "bring_in")
				return "The request was not taken as written: check owner, name and from, and call again.";
			return reason === "no_change"
				? `There is no change ${request.change} in ${request.owner}/${request.name}: code/${request.owner}/${request.name}/changes/index.md lists its changes.`
				: "The request was not taken as written: check owner, name, change and the texts, and call again.";
		case "key_reused":
			return "That operationKey was used for a different request: use a new one.";
		case "authority":
			return "Only an agent's own run looks after the company's code, never a worker's.";
		case "acknowledgement":
			return "This conversation needs your first reply before any work: answer the member, then call again.";
		case "final":
			return "This run already sent its final reply, so it starts no more work.";
		case "paused":
			return "The company's work is paused, so nothing can be changed now.";
	}
}

/** Why no undo was asked for, in words the agent can pass on. */
function undoRefused(reason: Extract<CloudCompanyCodeUndo, { state: "refused" }>["reason"], request: CodeUndo): string {
	const n = request.change;
	const followUp = "send the session a follow-up that puts the old behaviour back";
	switch (reason) {
		case "never_landed":
			return `Change ${n} never went into main, so there is nothing to undo.`;
		case "lost":
			return `Change ${n} is no longer in the repository: a restore went back past it, so there is nothing to undo.`;
		case "restore":
			return `Change ${n} put the repository back from its copy, and that cannot be undone.`;
		case "wall":
			// Change 1 of code brought in is where its record begins (its main before is unknown), with andLater too
			// (finding 28 of build6/PRE-IMPORT-SQL-BROKER.md): no restore is in it.
			if (n === 1)
				return request.andLater
					? `Nothing was undone: change 1 is the code as it came into Qorpera, where its record begins. Undo change 2 with andLater true to take out every change after it, or ${followUp}.`
					: `Change 1 cannot be undone: it is the code as it came into Qorpera, where its record begins. Instead, ${followUp}.`;
			return request.andLater
				? `Nothing was undone: the repository was put back from its copy after change ${n}, and andLater does not reach back past that. Undo change ${n} alone, or ${followUp}.`
				: `Change ${n} cannot be undone: the record does not hold main as it was before it. Instead, ${followUp}.`;
		case "too_many":
			return `Nothing was undone: that would take out more than 500 changes at once. Instead, ${followUp}.`;
		// The answer is kept under the call's operation key, so a later try needs a new one. The other undo may be of this
		// very change with the other scope (alone, where this call says andLater, or the other way round): the kernel
		// hands a call the open request only when it is the same undo, so what this call reports is what it asked for.
		case "busy":
			return `Nothing was undone: another undo, or a restore, is being made in ${request.owner}/${request.name}. Call again with a new operationKey when it is done.`;
		case "no_executor":
			return "Nothing was undone: Qorpera's code service is not running for this company right now. Try again in a few minutes, with a new operationKey.";
		default:
			return raised(reason, request);
	}
}

/** How an undo's request ended, in words the agent can pass on. */
function undoEnded(request: CodeUndo, ended: CloudCompanyCodeRequest): string {
	const n = request.change;
	const folder = `code/${request.owner}/${request.name}`;
	const nothing = `Nothing was undone: main no longer holds what change ${n} did.`;
	const followUp = "send the session a follow-up that puts the old behaviour back";
	if (ended.state === "done" && ended.result === "undone") {
		// The undo is a change of its own, numbered after the changes it took out.
		const made =
			ended.change === null ? "" : ` This is change ${ended.change}: ${folder}/changes/${ended.change}.md.`;
		const last = ended.change === null ? n : ended.change - 1;
		return `${
			request.andLater && last > n
				? `Changes ${n} to ${last} are undone. Main is as it was before change ${n}.`
				: `Change ${n} is undone. Main is as it was without it.`
		}${made} Check ${folder}/main/ before you tell anyone.`;
	}
	if (ended.state === "done" && ended.result === "nothing") return nothing;
	// This request's answer is kept under its operation key: another try, or the same undo with andLater, needs a new one.
	if (ended.state === "refused") {
		const code = ended.code ?? "";
		if (code === "CODE_HOST_UNDO_CONFLICT" && !request.andLater)
			return `Nothing was undone: later changes built on change ${n}${inFiles(ended.paths)}. Undo with andLater true and a new operationKey to take out change ${n} and every change after it, or ${followUp}.`;
		// The change's commits are not in main, or not in the repository any more.
		if (code === "CODE_HOST_UNDO_NOT_IN_MAIN" || code === "CODE_HOST_UNDO_UNKNOWN_COMMIT") return nothing;
		if (code.startsWith("CODE_HOST_NAMES_"))
			return `Nothing was undone: the files it would put back have names a repository kept in Qorpera does not take${inFiles(ended.paths)}. Instead, ${followUp}.`;
		return `Nothing was undone. Look at ${folder}/changes/index.md before you try again, with a new operationKey.${codeMark(ended.code)}`;
	}
	return `The undo did not finish. Look at ${folder}/changes/index.md before you try again, with a new operationKey.${codeMark(ended.code)}`;
}

/** Why a change's description was not saved. */
function describeRefused(
	reason: Extract<CloudCompanyCodeDescribed, { state: "refused" }>["reason"],
	request: CodeDescribe,
): string {
	switch (reason) {
		case "missing":
			return "Nothing was saved: there is no file at the picture's path in the company folder.";
		case "not_a_file":
			return "Nothing was saved: the picture's path is a folder, not a file.";
		case "too_large":
			return "Nothing was saved: the picture is larger than 4 MB. Give a smaller one.";
		case "not_a_picture":
			return "Nothing was saved: the picture's name must end in .png, .jpg, .jpeg or .webp.";
		case "not_shared":
			return "Nothing was saved: the picture must be in a part of the company folder every member and agent can read, not in a private folder.";
		default:
			return raised(reason, request);
	}
}

/** Why no import was asked for, in words the agent can pass on. */
function importRefused(
	reason: Extract<CloudCompanyCodeImportAsked, { state: "refused" }>["reason"],
	request: CodeBringIn,
): string {
	const again = "then call again with a new operationKey";
	switch (reason) {
		case "kept_here":
			return `Nothing was brought in: code/${request.owner}/${request.name}/ is already a repository kept here. Give another owner or name, with a new operationKey.`;
		case "already_here":
			return "Nothing was brought in: this code was brought in before. Find it under code/ and work on it there.";
		case "busy":
			return "Nothing was brought in: other code is being brought in for this company right now. Call again with a new operationKey when it is in.";
		case "sessions_open":
			return `Nothing was brought in: coding sessions still work on this code on GitHub. When their work is done, archive them with manage_worker, action archive (another agent's sessions are that agent's to archive), ${again}.`;
		case "no_executor":
			return "Nothing was brought in: Qorpera's code service is not running for this company right now. Try again in a few minutes, with a new operationKey.";
		case "file_missing":
			return `Nothing was brought in: there is no file at ${"file" in request.from ? request.from.file : "from.file"}. Write the bundle there on a machine first, ${again}.`;
		case "deleting":
			return "Nothing was brought in: the company is being deleted.";
		default:
			return raised(reason, request);
	}
}

/** What stops an import, by the executor's code (part C1's `CODE_IMPORT_REFUSALS`, the code host's name rules and the
 * history's two families), as the end of a sentence, with the paths the look named; undefined for a code with no
 * words. */
function importStop(
	code: string,
	request: CodeBringIn,
	refused: CloudCompanyCodeImportLook["refused"] | undefined,
): string | undefined {
	const project = "github" in request.from ? `github.com/${request.from.github}` : undefined;
	switch (code) {
		case "IMPORT_TOO_LARGE":
			// A file's bound is the folder's 256 MB (part B refuses a larger one before it copies it), GitHub's 1 GB.
			return project === undefined
				? "the file is larger than 256 MB, the most Qorpera brings in from a file"
				: "it is larger than 1 GB, the most Qorpera brings in";
		// The code host's own: the restore-shaped bundle would be over the store's 2 GB (part B's look).
		case "CODE_HOST_BUNDLE_TOO_LARGE":
			return "it is larger than 1 GB, the most Qorpera brings in";
		case "IMPORT_SOURCE_REFUSED":
			return project === undefined
				? undefined
				: `GitHub did not let Qorpera read ${project}: check the address, and that the company's GitHub connection can see it`;
		case "IMPORT_SOURCE_MOVED":
			return project === undefined
				? undefined
				: `GitHub says ${project} has moved: call again with its new address and a new operationKey`;
		case "IMPORT_USES_LFS":
			return "it keeps large files outside the code (Git LFS), and Qorpera can't bring those in yet";
		case "IMPORT_USES_SUBMODULES":
			return "it is made of other projects (git submodules), and Qorpera can't bring those in yet";
		case "IMPORT_SOURCE_EMPTY":
			return "it is empty: there is nothing to bring in";
		case "IMPORT_SHA256_REPOSITORY":
			return "it uses git's newer SHA-256 format, which Qorpera can't bring in yet";
		case "IMPORT_TOO_MANY_REFS":
			return "it has more branches and tags than Qorpera can read";
		case "IMPORT_BRANCH_NAME":
			return "its main branch has a name Qorpera can't keep: longer than 200 bytes, or one that looks like a key";
		case "IMPORT_BRANCH_UNKNOWN":
			return "the file has more than one branch and none is clearly its main one: call again with from.branch, the branch to bring in, and a new operationKey";
		case "IMPORT_FILE_NOT_WHOLE":
			return "the file is not a whole git bundle: make it again with git bundle create <file> --all";
		case "IMPORT_FILE_CHANGED":
			return "the file changed after you asked: call again with a new operationKey";
		// The place holds an earlier import's half-done snapshot (part C3): only that code finishes it.
		case "IMPORT_PLACE_HALF_DONE":
			return `an earlier bring-in stopped half way at code/${request.owner}/${request.name}: bring the same code in again, with a new operationKey, to finish it; other code cannot go there until then. If the same code is refused too, tell a member that Qorpera must clear that place first`;
	}
	// git's check: an error is damage (IMPORT_HISTORY_DAMAGED, with its message id or not), a warning names its id.
	if (code === "IMPORT_HISTORY_DAMAGED" || code.startsWith("IMPORT_HISTORY_DAMAGED_"))
		return "its history has damage Qorpera can't take in";
	if (code.startsWith("IMPORT_HISTORY_")) return "its history has old git objects Qorpera can't take in yet";
	const named = refused?.code === code ? refused.paths.filter((path): path is string => path !== null) : [];
	const files = inFiles(named, refused?.code === code ? refused.more + refused.paths.length - named.length : 0);
	if (code === "IMPORT_TOO_MANY_FILES" || code.startsWith("CODE_HOST_NAMES_"))
		return `it has more files, or file names, than a repository kept in Qorpera can take${files}`;
	if (code === "CODE_HOST_FILE_TOO_LARGE")
		return `it has a file larger than a repository kept in Qorpera can take (256 MB)${files}`;
	return undefined;
}

/** A size as an answer gives it. */
function size(bytes: number): string {
	if (bytes < 1024 ** 2) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
	if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The key scan's kinds in words (part C1's `CODE_IMPORT_KEY_KINDS`). */
const KEY_KINDS: Readonly<Record<CloudCompanyCodeImportLook["secrets"]["shown"][number]["kind"], string>> = {
	aws: "an AWS key",
	github: "a GitHub token",
	stripe: "a live Stripe key",
	slack: "a Slack token",
	google: "a Google API key",
	"private-key": "a private key",
	resend: "a Resend key",
	openai: "an OpenAI key",
	anthropic: "an Anthropic key",
	"env-file": "a .env file",
};

/** What the look found, in one or two lines: its size and history, and whether it fits. */
function lookFacts(look: CloudCompanyCodeImportLook, request: CodeBringIn): string {
	const span = look.firstAt && look.lastAt ? ` from ${look.firstAt.slice(0, 10)} to ${look.lastAt.slice(0, 10)}` : "";
	const people =
		look.authors30d === 0
			? "no one but the company's agents changed it in the last 30 days"
			: `${count(look.authors30d, "person", "people")} other than the company's agents changed it in the last 30 days`;
	const stop = look.why === null ? undefined : importStop(look.why, request, look.refused);
	return `${size(look.bytes)}, ${count(look.commits, "change", "changes")}${span}, ${people}, ${count(look.files, "file", "files")}; ${
		look.why === null
			? "it fits."
			: `it does not fit: ${stop ?? "Qorpera cannot take it in"}.${stop ? "" : codeMark(look.why)}`
	}`;
}

/** The strings that look like keys, by kind and file, "still in the code" when main holds them; none said too. */
function keyLike(look: CloudCompanyCodeImportLook): string {
	const { found, shown, scan } = look.secrets;
	const partly = scan.all ? "" : " It could not read every file.";
	if (found === 0) return `It found no strings that look like keys.${partly}`;
	const named = shown
		.slice(0, SHOWN_PATHS)
		.map(
			(hit) =>
				`${KEY_KINDS[hit.kind]} in ${hit.path === null ? "a file whose name is not shown" : JSON.stringify(hit.path)}${hit.inMain ? " (still in the code)" : ""}`,
		);
	const more = found - named.length;
	return `${named.length ? `Strings that look like keys: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : `${count(found, "string looks", "strings look")} like keys`}.${partly}`;
}

/** How an import's request ended, in words the agent can pass on. */
function importEnded(request: CodeBringIn, ended: CloudCompanyCodeImport): string {
	const folder = `code/${ended.owner}/${ended.name}`;
	const look = ended.look;
	if (ended.state === "done" && ended.result === "looked")
		return look === null
			? "It was looked at, but what it found is not there to read."
			: `${lookFacts(look, request)} ${keyLike(look)}${look.why === null ? " To bring it in, call bring_in with look false and a new operationKey." : ""}`;
	if (ended.state === "done") {
		const record = ended.change === null ? "" : `; change ${ended.change} of its record`;
		const facts =
			look === null
				? `Brought in as ${folder}${record}.`
				: `Brought in as ${folder}: ${count(look.commits, "earlier change", "earlier changes")} on ${look.defaultBranch ?? "its main branch"}, ${count(look.files, "file", "files")}${record}.`;
		return `${facts}${"github" in request.from ? " The copy on GitHub stays as it was; Qorpera no longer works on it there." : ""} Have a coding session add its checks file.${look !== null && look.secrets.found > 0 ? ` ${keyLike(look)}` : ""}`;
	}
	if (ended.state === "refused") {
		const stop = ended.code === null ? undefined : importStop(ended.code, request, look?.refused);
		return stop === undefined
			? `Nothing was brought in: Qorpera could not take this code in.${codeMark(ended.code)}`
			: `Nothing was brought in: ${stop}.`;
	}
	const done = request.look ? "looked at" : "brought in";
	if (ended.code?.endsWith(":PLACE_AS_BEFORE"))
		return `It could not be ${done} just now, and ${folder}/ is as it was. Try again with a new operationKey.${codeMark(ended.code)}`;
	if (ended.code === "DID_NOT_FINISH")
		return `It did not finish. Call bring_in again for the same code with a new operationKey: it goes on from where this one stopped.${codeMark(ended.code)}`;
	return `It could not be ${done} just now. Try again with a new operationKey.${codeMark(ended.code)}`;
}

/** The step an import is at, and what it waits for, in words. */
const IMPORT_STEPS: Readonly<Record<NonNullable<CloudCompanyCodeImport["step"]>, string>> = {
	fetch: "getting it from GitHub",
	read: "reading the file",
	look: "checking it",
	close: "putting it in place",
	"set-aside": "putting it in place",
	build: "putting it in place",
	open: "putting it in place",
	tidy: "tidying up",
};
const IMPORT_WAITS: ReadonlyMap<string, string> = new Map([
	["SESSIONS_BUSY", "until the company's coding sessions are quiet"],
	["SESSIONS_ATTACHED", "until the company's coding sessions are quiet"],
	["SESSIONS_OPEN", "until no coding session works on it on GitHub"],
]);

/** An import still open when the tool stops waiting: where it is, and that the same call again goes on. */
function importOpen(request: CodeBringIn, seen: CloudCompanyCodeImport | undefined): string {
	const step = seen?.step ? IMPORT_STEPS[seen.step] : "waiting its turn";
	const waits = seen?.waiting
		? `, waiting ${IMPORT_WAITS.get(seen.waiting) ?? "for the company's other code work"}`
		: "";
	return `It is being ${request.look ? "looked at" : "brought in"} (${step}${waits}). Call bring_in again with the same operationKey to see how it went.`;
}

/** The company's code kept in Qorpera, for an agent's own company run: `manage_code`. */
export function cloudCodeTools(options: {
	folder: Pick<
		CloudCompanyFolderClient,
		"requestCodeUndo" | "codeRequest" | "describeCodeChange" | "requestCodeImport" | "codeImport"
	>;
	identity: CloudNativeToolIdentity;
	/** The pause between looks at an undo's or an import's request and how long the tool waits for it, when not 2 s and
	 * 30 s. */
	lookMs?: number;
	waitMs?: number;
}): readonly CloudNativeTool[] {
	const { folder } = options;
	const expected = Object.freeze({ ...options.identity });
	const lookMs = options.lookMs ?? UNDO_LOOK_MS;
	const waitMs = options.waitMs ?? UNDO_WAIT_MS;
	const said = (value: string): CloudToolContent => ({ kind: "text", value });

	const undo = async (request: CodeUndo, signal: AbortSignal): Promise<CloudToolContent> => {
		const { action: _action, ...asked } = request;
		const answer = await folder.requestCodeUndo(asked, signal);
		if (answer.state === "already")
			return said(`Change ${request.change} is already undone, by change ${answer.undoneBy}.`);
		if (answer.state === "refused") throw new CloudToolRefusal(undoRefused(answer.reason, request));
		// The request is the executor's now. From here the tool only looks and says what it saw: a look that fails is
		// only a failed look, and the next one comes after the pause.
		const until = Date.now() + waitMs;
		for (let left = waitMs; left > 0; left = until - Date.now()) {
			await cloudControlPause(Math.min(lookMs, left), signal);
			let now: CloudCompanyCodeRequest | undefined;
			try {
				now = await folder.codeRequest(answer.requestId, signal);
			} catch {
				signal.throwIfAborted();
			}
			if (now && now.kind !== "undo") throw new Error("Code request differs");
			if (now && now.state !== "queued" && now.state !== "running") return said(undoEnded(request, now));
		}
		return said(
			`The undo of change ${request.change} is still being made. Call manage_code undo for it again to see how it went.`,
		);
	};

	// As an undo: once the request is the executor's, the tool only looks and says what it saw. An import takes minutes,
	// so most calls end with where it is, and the same call again (the kernel answers the same request) goes on.
	const bringIn = async (request: CodeBringIn, signal: AbortSignal): Promise<CloudToolContent> => {
		const { action: _action, ...asked } = request;
		const answer = await folder.requestCodeImport(asked, signal);
		if (answer.state === "refused") throw new CloudToolRefusal(importRefused(answer.reason, request));
		let seen: CloudCompanyCodeImport | undefined;
		const until = Date.now() + waitMs;
		for (let left = waitMs; left > 0; left = until - Date.now()) {
			await cloudControlPause(Math.min(lookMs, left), signal);
			let now: CloudCompanyCodeImport | undefined;
			try {
				now = await folder.codeImport(answer.requestId, signal);
			} catch {
				signal.throwIfAborted();
			}
			if (now && (now.owner !== request.owner || now.name !== request.name)) throw new Error("Code import differs");
			if (now && now.state !== "queued" && now.state !== "running") return said(importEnded(request, now));
			seen = now ?? seen;
		}
		return said(importOpen(request, seen));
	};

	const describe = async (request: CodeDescribe, signal: AbortSignal): Promise<CloudToolContent> => {
		const { action: _action, ...asked } = request;
		const answer = await folder.describeCodeChange(asked, signal);
		if (answer.state === "refused") throw new CloudToolRefusal(describeRefused(answer.reason, request));
		return said(
			`Saved: change ${request.change} has ${answer.notice === null ? "no notice yet" : "its notice"} and ${answer.picture ? "its picture" : "no picture yet"}. Its record, code/${request.owner}/${request.name}/changes/${request.change}.md, shows that within a minute.`,
		);
	};

	const code: CloudNativeTool = {
		name: "manage_code" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_CODE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action", "operationKey", "owner", "name"],
			properties: {
				action: { type: "string", enum: [...ACTIONS] },
				operationKey: { type: "string", pattern: OPERATION_KEY.source },
				owner: { type: "string", minLength: 1, maxLength: 39 },
				name: { type: "string", minLength: 1, maxLength: 100 },
				change: { type: "integer", minimum: 1 },
				from: {
					type: "object",
					additionalProperties: false,
					properties: {
						github: { type: "string", minLength: 3, maxLength: 200 },
						file: { type: "string", minLength: 1, maxLength: INCOMING_BYTES },
						branch: {
							type: "string",
							minLength: 1,
							maxLength: BRANCH_BYTES,
							description: "Only for a file whose main branch is not clear: the branch to bring in.",
						},
					},
				},
				look: { type: "boolean" },
				andLater: { type: "boolean" },
				reason: { type: "string", minLength: 1, maxLength: 500 },
				notice: { type: "string", minLength: 1, maxLength: 200 },
				picture: {
					type: "string",
					minLength: 1,
					maxLength: 1024,
					description: "Its path in the company folder, such as product/screens/new-price.png.",
				},
			},
		},
		parseArguments: (value) => parse(value) as never,
		// An undo the code host refused, or one that found nothing to take out, changed nothing: main was not as an undo
		// of that change needs it.
		refused: (content) =>
			content.kind === "text" && content.value.startsWith("Nothing was undone") ? "stale_version" : undefined,
		async execute(value, context) {
			if (
				context.runId !== expected.runId ||
				context.companyId !== expected.companyId ||
				!context.identity ||
				Object.entries(expected).some(
					([name, held]) => context.identity![name as keyof CloudNativeToolIdentity] !== held,
				)
			)
				throw new Error("Code tool identity differs");
			context.signal.throwIfAborted();
			const request = value as unknown as CodeCall;
			if (request.action === "bring_in") return bringIn(request, context.signal);
			return request.action === "undo" ? undo(request, context.signal) : describe(request, context.signal);
		},
	};
	return [code];
}
