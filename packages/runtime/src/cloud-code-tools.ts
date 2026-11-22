import { createHash } from "node:crypto";
import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import {
	type JsonValue,
	parseCloudCodingRepository,
	parseGitHubCodingRepository,
	UUID_PATTERN,
} from "@qorpera/contracts";
import { MAX_CODE_CHECKS_FILE_BYTES, parseCodeChecksText } from "./cloud-code-checks.ts";
import {
	type CloudCompanyCodeDescribed,
	type CloudCompanyCodeHistoryPage,
	type CloudCompanyCodeImport,
	type CloudCompanyCodeImportAsked,
	type CloudCompanyCodeImportLook,
	type CloudCompanyCodeImportSource,
	type CloudCompanyCodeLifecycleAnswer,
	type CloudCompanyCodeQueryAsked,
	type CloudCompanyCodeRefusal,
	type CloudCompanyCodeRepositoryStatus,
	type CloudCompanyCodeRequestV2,
	type CloudCompanyCodeUndo,
	type CloudCompanyFolderClient,
	type CloudCompanyFolderEntry,
	type CloudCompanyFolderRelease,
	cloudCompanyFolderRelease,
} from "./cloud-company-folder-client.ts";
import { CloudCompanyPathNotText } from "./cloud-company-path-gateway.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import { releaseId, unavailable } from "./cloud-folder-file-tools.ts";
import type { CloudNativeToolIdentity } from "./cloud-native-tool-authority.ts";
import {
	type CloudNativeTool,
	CloudToolArgumentRefusal,
	type CloudToolContent,
	type CloudToolContext,
	CloudToolRefusal,
	cloudToolJsonText,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import type { CloudRuntimeToolOperation } from "./cloud-runtime-observability.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

const OPERATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ACTIONS = [
	"status",
	"log",
	"diff",
	"show",
	"branches",
	"merge_preview",
	"history",
	"undo",
	"describe",
	"bring_in",
	"create",
	"archive",
	"unarchive",
	"tag",
	"prune",
] as const;
const READ_ONLY_ACTIONS = new Set<string>(["status", "log", "diff", "show", "branches", "merge_preview", "history"]);
const KEYS = {
	status: ["action", "owner", "name"],
	log: ["action", "owner", "name", "ref", "path", "limit", "since"],
	diff: ["action", "owner", "name", "base", "head", "statOnly", "paths", "maxBytes"],
	show: ["action", "owner", "name", "ref", "path", "maxBytes"],
	branches: ["action", "owner", "name"],
	merge_preview: ["action", "owner", "name", "base", "head"],
	history: ["action", "owner", "name", "state", "workerId", "path", "cursor", "limit"],
	undo: [
		"action",
		"operationKey",
		"owner",
		"name",
		"change",
		"toChange",
		"changes",
		"andLater",
		"dryRun",
		"runChecks",
		"force",
		"reason",
		"notice",
	],
	describe: ["action", "operationKey", "owner", "name", "change", "notice", "picture"],
	bring_in: ["action", "operationKey", "owner", "name", "from", "look"],
	create: ["action", "operationKey", "owner", "name"],
	archive: ["action", "operationKey", "owner", "name", "reason"],
	unarchive: ["action", "operationKey", "owner", "name"],
	tag: ["action", "operationKey", "owner", "name", "mode", "tag", "ref", "message"],
	prune: ["action", "operationKey", "owner", "name", "deleteMergedBranches"],
} as const;
const HISTORY_STATES = ["landed", "reverted", "conflict", "refused", "lost"] as const;
const TAG_MODES = ["create", "list"] as const;
const JSON_RENDER_BYTES = 256 * 1024;
const INCOMING =
	/^code\/_incoming\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?)\/[A-Za-z0-9][A-Za-z0-9._-]{0,92}\.bundle$/;
const INCOMING_BYTES = 1024;
const BRANCH_BYTES = 200;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SINCE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|[+-][0-9]{2}:[0-9]{2})?)?$/;
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const UNDO_LOOK_MS = 2000;
const UNDO_WAIT_MS = 30_000;
const QUERY_WAIT_MS = 15_000;
const SHOWN_PATHS = 10;
const SHOWN_PATH_BYTES = 2000;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_SHOW_BYTES = 128 * 1024;

export const CLOUD_CODE_TOOL_DESCRIPTION = [
	"Look after the company's code kept in Qorpera. Qorpera numbers every change that goes into main and writes its record at code/<owner>/<name>/changes/<number>.md. Change numbers are yours, never the members' words.",
	"Every action takes owner and name. Mutating actions (undo, describe, bring_in, create, archive, unarchive, tag, prune) also take operationKey; read-only actions (status, log, diff, show, branches, merge_preview, history) omit it.",
	"- status: inspect a repository in one SQL call: active/recent coding sessions with claimedPaths, worktrees, recent changes, queue, archive/site state, and checks config.",
	"- log / diff / show / branches / merge_preview: lightweight read-only git inspection without booting a coding VM. Refs accept main, a change number, a 40-char SHA, worker:<id>, tag:<name> or imported:<branch>.",
	"- history: paginated, filterable SQL history of recorded changes (by state, workerId, path, cursor, limit).",
	"- undo: revert one change, a range (change + toChange), a list (changes) or with andLater true. Supports dryRun, runChecks (gate on a prior checks-verified state unless force true), and site-aware revert.",
	"- describe: set a change's customer-facing notice and picture.",
	'- bring_in: bring existing code in from {"github":"owner/name"} or {"file":"code/_incoming/<folder>/<name>.bundle"} (look true only inspects it).',
	"- create / archive / unarchive / tag / prune: initialize an empty repository, archive or unarchive a repository (preserving reads), create or list git tags, or prune archived worktrees and merged worker branches.",
].join("\n");

type CodeRefInput = string | number;

interface CodeStatus {
	readonly action: "status";
	readonly owner: string;
	readonly name: string;
}
interface CodeLog {
	readonly action: "log";
	readonly owner: string;
	readonly name: string;
	readonly ref?: CodeRefInput;
	readonly path?: string;
	readonly limit?: number;
	readonly since?: string;
}
interface CodeDiff {
	readonly action: "diff";
	readonly owner: string;
	readonly name: string;
	readonly base: CodeRefInput;
	readonly head: CodeRefInput;
	readonly statOnly?: boolean;
	readonly paths?: readonly string[];
	readonly maxBytes?: number;
}
interface CodeShow {
	readonly action: "show";
	readonly owner: string;
	readonly name: string;
	readonly ref?: CodeRefInput;
	readonly path: string;
	readonly maxBytes?: number;
}
interface CodeBranches {
	readonly action: "branches";
	readonly owner: string;
	readonly name: string;
}
interface CodeMergePreview {
	readonly action: "merge_preview";
	readonly owner: string;
	readonly name: string;
	readonly base?: CodeRefInput;
	readonly head: CodeRefInput;
}
interface CodeHistory {
	readonly action: "history";
	readonly owner: string;
	readonly name: string;
	readonly state?: (typeof HISTORY_STATES)[number];
	readonly workerId?: string;
	readonly path?: string;
	readonly cursor?: number;
	readonly limit?: number;
}
interface CodeUndo {
	readonly action: "undo";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly change?: number;
	readonly toChange?: number;
	readonly changes?: readonly number[];
	readonly andLater: boolean;
	readonly dryRun: boolean;
	readonly runChecks: boolean;
	readonly force: boolean;
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
interface CodeCreate {
	readonly action: "create";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
}
interface CodeArchive {
	readonly action: "archive";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly reason?: string;
}
interface CodeUnarchive {
	readonly action: "unarchive";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
}
interface CodeTag {
	readonly action: "tag";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly mode: "create" | "list";
	readonly tag?: string;
	readonly ref?: CodeRefInput;
	readonly message?: string;
}
interface CodePrune {
	readonly action: "prune";
	readonly operationKey: string;
	readonly owner: string;
	readonly name: string;
	readonly deleteMergedBranches: boolean;
}
type CodeCall =
	| CodeStatus
	| CodeLog
	| CodeDiff
	| CodeShow
	| CodeBranches
	| CodeMergePreview
	| CodeHistory
	| CodeUndo
	| CodeDescribe
	| CodeBringIn
	| CodeCreate
	| CodeArchive
	| CodeUnarchive
	| CodeTag
	| CodePrune;

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

function branchTaken(name: string): boolean {
	return (
		Buffer.byteLength(name) <= BRANCH_BYTES &&
		BRANCH.test(name) &&
		!name.includes("..") &&
		!name
			.split("/")
			.some((part) => part === "" || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
	);
}

function branch(value: unknown): string {
	const name = typeof value === "string" ? value.trim().replace(/^refs\/heads\//, "") : "";
	if (!branchTaken(name))
		throw new CloudToolArgumentRefusal(
			"from.branch is the name of the branch to bring in as main, of at most 200 bytes: letters, digits, ., _, - and /",
		);
	return name;
}

function source(value: unknown): CloudCompanyCodeImportSource {
	const from =
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	if (
		from === undefined ||
		Object.hasOwn(from, "github") === Object.hasOwn(from, "file") ||
		Object.keys(from).some((key) => !["github", "file", "branch"].includes(key))
	)
		throw new CloudToolArgumentRefusal(
			'from is {"github":"owner/name"} or {"file":"code/_incoming/<folder>/<name>.bundle"}, either with branch',
		);
	if (Object.hasOwn(from, "github")) {
		const project = github(from.github);
		return from.branch === undefined ? { github: project } : { github: project, branch: branch(from.branch) };
	}
	const file = incoming(from.file);
	return from.branch === undefined ? { file } : { file, branch: branch(from.branch) };
}

function parseRepoPath(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value, "utf8") > 1024 ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		/[\u0000-\u001f\u007f]/.test(value) ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new CloudToolArgumentRefusal(`${field} must be a relative repository path of at most 1024 bytes`);
	return value;
}

function parseRef(value: unknown, field: string): CodeRefInput {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value < 1 || value > 999_999_999)
			throw new CloudToolArgumentRefusal(`${field} change number must be a whole number from 1`);
		return value;
	}
	if (typeof value !== "string" || !value.trim() || value.length > 260 || /[\u0000-\u001f\u007f]/.test(value))
		throw new CloudToolArgumentRefusal(
			`${field} must be main, a change number, a 40-char commit SHA, worker:<id>, tag:<name> or imported:<branch>`,
		);
	const trimmed = value.trim();
	if (/^[1-9][0-9]{0,8}$/.test(trimmed)) return Number(trimmed);
	if (
		trimmed === "main" ||
		/^[0-9a-f]{40}$/.test(trimmed) ||
		(trimmed.startsWith("worker:") && UUID_PATTERN.test(trimmed.slice("worker:".length))) ||
		(trimmed.startsWith("tag:") && TAG_PATTERN.test(trimmed.slice("tag:".length)) && !trimmed.includes("..")) ||
		(trimmed.startsWith("imported:") && branchTaken(trimmed.slice("imported:".length)))
	)
		return trimmed;
	throw new CloudToolArgumentRefusal(
		`${field} must be main, a change number, a 40-char commit SHA, worker:<id>, tag:<name> or imported:<branch>`,
	);
}

function parseChangeNumber(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 999_999_999)
		throw new CloudToolArgumentRefusal(
			`${field} is the change's number, a whole number from 1: changes/index.md in the repository's folder lists them`,
		);
	return value as number;
}

function parse(value: unknown): CodeCall {
	const a = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const action = ACTIONS.find((known) => known === a.action);
	if (action === undefined) throw new CloudToolArgumentRefusal(`action must be one of ${ACTIONS.join(", ")}`);
	if (Object.keys(a).some((key) => !(KEYS[action] as readonly string[]).includes(key)))
		throw new CloudToolArgumentRefusal(`${action} takes only ${KEYS[action].join(", ")}`);
	if (!READ_ONLY_ACTIONS.has(action) && (typeof a.operationKey !== "string" || !OPERATION_KEY.test(a.operationKey)))
		throw new CloudToolArgumentRefusal(
			"operationKey is 1 to 96 letters, digits, dots, colons, hyphens and underscores, and starts with a letter or digit",
		);
	try {
		parseCloudCodingRepository({ host: "qorpera", owner: a.owner, name: a.name, baseBranch: "main" });
	} catch {
		throw new CloudToolArgumentRefusal(
			"owner and name are the repository's, as in code/<owner>/<name>/: lowercase, such as owner company and name shop",
		);
	}
	const owner = a.owner as string;
	const name = a.name as string;
	if (action === "status") return { action, owner, name };
	if (action === "branches") return { action, owner, name };
	if (action === "log") {
		if (a.limit !== undefined && (!Number.isSafeInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 100))
			throw new CloudToolArgumentRefusal("limit must be a whole number from 1 to 100");
		if (a.since !== undefined && (typeof a.since !== "string" || !SINCE_PATTERN.test(a.since)))
			throw new CloudToolArgumentRefusal("since must be an ISO date or timestamp like 2026-11-01");
		return {
			action,
			owner,
			name,
			...(a.ref === undefined ? {} : { ref: parseRef(a.ref, "ref") }),
			...(a.path === undefined ? {} : { path: parseRepoPath(a.path, "path") }),
			...(a.limit === undefined ? {} : { limit: a.limit as number }),
			...(a.since === undefined ? {} : { since: a.since as string }),
		};
	}
	if (action === "diff") {
		if (a.base === undefined || a.head === undefined)
			throw new CloudToolArgumentRefusal("diff requires base and head refs or change numbers");
		if (a.statOnly !== undefined && typeof a.statOnly !== "boolean")
			throw new CloudToolArgumentRefusal("statOnly is true or false");
		if (
			a.maxBytes !== undefined &&
			(!Number.isSafeInteger(a.maxBytes) || (a.maxBytes as number) < 1024 || (a.maxBytes as number) > MAX_DIFF_BYTES)
		)
			throw new CloudToolArgumentRefusal(`maxBytes for diff must be a whole number from 1024 to ${MAX_DIFF_BYTES}`);
		let paths: string[] | undefined;
		if (a.paths !== undefined) {
			if (!Array.isArray(a.paths) || a.paths.length > 20)
				throw new CloudToolArgumentRefusal("paths must be a list of at most 20 relative repository paths");
			paths = a.paths.map((p) => parseRepoPath(p, "paths"));
		}
		return {
			action,
			owner,
			name,
			base: parseRef(a.base, "base"),
			head: parseRef(a.head, "head"),
			...(a.statOnly === undefined ? {} : { statOnly: a.statOnly as boolean }),
			...(paths === undefined ? {} : { paths }),
			...(a.maxBytes === undefined ? {} : { maxBytes: a.maxBytes as number }),
		};
	}
	if (action === "show") {
		if (a.path === undefined) throw new CloudToolArgumentRefusal("show requires path");
		if (
			a.maxBytes !== undefined &&
			(!Number.isSafeInteger(a.maxBytes) || (a.maxBytes as number) < 1024 || (a.maxBytes as number) > MAX_SHOW_BYTES)
		)
			throw new CloudToolArgumentRefusal(`maxBytes for show must be a whole number from 1024 to ${MAX_SHOW_BYTES}`);
		return {
			action,
			owner,
			name,
			...(a.ref === undefined ? {} : { ref: parseRef(a.ref, "ref") }),
			path: parseRepoPath(a.path, "path"),
			...(a.maxBytes === undefined ? {} : { maxBytes: a.maxBytes as number }),
		};
	}
	if (action === "merge_preview") {
		if (a.head === undefined) throw new CloudToolArgumentRefusal("merge_preview requires head");
		return {
			action,
			owner,
			name,
			...(a.base === undefined ? {} : { base: parseRef(a.base, "base") }),
			head: parseRef(a.head, "head"),
		};
	}
	if (action === "history") {
		if (a.state !== undefined && !HISTORY_STATES.includes(a.state as (typeof HISTORY_STATES)[number]))
			throw new CloudToolArgumentRefusal(`state must be one of ${HISTORY_STATES.join(", ")}`);
		if (a.workerId !== undefined && (typeof a.workerId !== "string" || !UUID_PATTERN.test(a.workerId)))
			throw new CloudToolArgumentRefusal("workerId must be a valid UUID");
		if (a.cursor !== undefined && (!Number.isSafeInteger(a.cursor) || (a.cursor as number) < 1))
			throw new CloudToolArgumentRefusal("cursor must be a whole number from 1");
		if (a.limit !== undefined && (!Number.isSafeInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 100))
			throw new CloudToolArgumentRefusal("limit must be a whole number from 1 to 100");
		return {
			action,
			owner,
			name,
			...(a.state === undefined ? {} : { state: a.state as (typeof HISTORY_STATES)[number] }),
			...(a.workerId === undefined ? {} : { workerId: a.workerId as string }),
			...(a.path === undefined ? {} : { path: parseRepoPath(a.path, "path") }),
			...(a.cursor === undefined ? {} : { cursor: a.cursor as number }),
			...(a.limit === undefined ? {} : { limit: a.limit as number }),
		};
	}
	const operationKey = a.operationKey as string;
	if (action === "create") return { action, operationKey, owner, name };
	if (action === "unarchive") return { action, operationKey, owner, name };
	if (action === "archive") {
		const reason = line(a.reason, "reason", 500);
		if (reason !== undefined && Buffer.byteLength(reason) > 500)
			throw new CloudToolArgumentRefusal("reason is one line of at most 500 bytes");
		return { action, operationKey, owner, name, ...(reason === undefined ? {} : { reason }) };
	}
	if (action === "tag") {
		if (a.mode !== "create" && a.mode !== "list") throw new CloudToolArgumentRefusal("tag mode must be create or list");
		if (a.mode === "list") {
			if (a.tag !== undefined || a.ref !== undefined || a.message !== undefined)
				throw new CloudToolArgumentRefusal("tag list does not take tag, ref or message");
			return { action, operationKey, owner, name, mode: "list" };
		}
		if (
			typeof a.tag !== "string" ||
			!TAG_PATTERN.test(a.tag) ||
			a.tag.includes("..") ||
			a.tag.includes("//") ||
			a.tag.includes("/.") ||
			a.tag.endsWith("/") ||
			a.tag.endsWith(".") ||
			a.tag.endsWith(".lock")
		)
			throw new CloudToolArgumentRefusal("tag must be a valid git tag name of 1 to 120 characters");
		const message = line(a.message, "message", 1000);
		if (message !== undefined && Buffer.byteLength(message) > 1000)
			throw new CloudToolArgumentRefusal("message is one line of at most 1000 bytes");
		return {
			action,
			operationKey,
			owner,
			name,
			mode: "create",
			tag: a.tag,
			...(a.ref === undefined ? {} : { ref: parseRef(a.ref, "ref") }),
			...(message === undefined ? {} : { message }),
		};
	}
	if (action === "prune") {
		if (a.deleteMergedBranches !== undefined && typeof a.deleteMergedBranches !== "boolean")
			throw new CloudToolArgumentRefusal("deleteMergedBranches is true or false");
		return { action, operationKey, owner, name, deleteMergedBranches: a.deleteMergedBranches === true };
	}
	if (action === "bring_in") {
		if (a.look !== undefined && typeof a.look !== "boolean")
			throw new CloudToolArgumentRefusal("look is true or false");
		return { action, operationKey, owner, name, from: source(a.from), look: a.look === true };
	}
	const notice = line(a.notice, "notice", 200);
	if (action === "undo") {
		const reason = line(a.reason, "reason", 500);
		if (reason === undefined || Buffer.byteLength(reason) > 500)
			throw new CloudToolArgumentRefusal(
				"undo needs reason: why the change is taken out, in one line of at most 500 bytes",
			);
		for (const boolKey of ["andLater", "dryRun", "runChecks", "force"] as const) {
			if (a[boolKey] !== undefined && typeof a[boolKey] !== "boolean")
				throw new CloudToolArgumentRefusal(`${boolKey} is true or false`);
		}
		const andLater = a.andLater === true;
		const dryRun = a.dryRun === true;
		const runChecks = a.runChecks === true;
		const force = a.force === true;
		let change: number | undefined;
		let toChange: number | undefined;
		let changes: number[] | undefined;
		if (a.changes !== undefined) {
			if (a.change !== undefined || a.toChange !== undefined || andLater)
				throw new CloudToolArgumentRefusal("changes cannot be combined with change, toChange or andLater");
			if (!Array.isArray(a.changes) || a.changes.length < 1 || a.changes.length > 50)
				throw new CloudToolArgumentRefusal("changes must be a list of 1 to 50 distinct change numbers");
			changes = a.changes.map((c) => parseChangeNumber(c, "changes"));
			if (new Set(changes).size !== changes.length)
				throw new CloudToolArgumentRefusal("changes must not repeat a change number");
		} else {
			change = parseChangeNumber(a.change, "change");
			if (a.toChange !== undefined) {
				if (andLater) throw new CloudToolArgumentRefusal("toChange cannot be combined with andLater");
				toChange = parseChangeNumber(a.toChange, "toChange");
				if (toChange < change || toChange - change >= 50)
					throw new CloudToolArgumentRefusal("toChange must be at least change and span at most 50 changes");
			}
		}
		return {
			action,
			operationKey,
			owner,
			name,
			...(change === undefined ? {} : { change }),
			...(toChange === undefined ? {} : { toChange }),
			...(changes === undefined ? {} : { changes }),
			andLater,
			dryRun,
			runChecks,
			force,
			reason,
			...(notice === undefined ? {} : { notice }),
		};
	}
	const change = parseChangeNumber(a.change, "change");
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
		operationKey,
		owner,
		name,
		change,
		...(notice === undefined ? {} : { notice }),
		...(picture === undefined ? {} : { picture }),
	};
}

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

function codeMark(code: string | null): string {
	return code !== null && /^[A-Z][A-Z0-9_:]{0,119}$/.test(code) ? ` [code=${code}]` : "";
}

function raised(reason: CloudCompanyCodeRefusal, request: CodeCall): string {
	switch (reason) {
		case "no_repository":
			return `There is no repository ${request.owner}/${request.name} kept in Qorpera yet.`;
		case "no_change":
		case "invalid":
			if (request.action === "bring_in")
				return "The request was not taken as written: check owner, name and from, and call again.";
			if (reason === "no_change" && (request.action === "undo" || request.action === "describe")) {
				const num = request.action === "describe" ? request.change : (request.change ?? request.changes?.[0] ?? 0);
				return `There is no change ${num} in ${request.owner}/${request.name}: code/${request.owner}/${request.name}/changes/index.md lists its changes.`;
			}
			return "The request was not taken as written: check owner, name and parameters, and call again.";
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

function undoRefused(reason: Extract<CloudCompanyCodeUndo, { state: "refused" }>["reason"], request: CodeUndo): string {
	const n = request.change ?? request.changes?.[0] ?? 0;
	const followUp = "send the session a follow-up that puts the old behaviour back";
	switch (reason) {
		case "never_landed":
			return `Change ${n} never went into main, so there is nothing to undo.`;
		case "lost":
			return `Change ${n} is no longer in the repository: a restore went back past it, so there is nothing to undo.`;
		case "restore":
			return `Change ${n} put the repository back from its copy, and that cannot be undone.`;
		case "archived":
			return `Nothing was undone: ${request.owner}/${request.name} is archived.`;
		case "wall":
			if (n === 1)
				return request.andLater
					? `Nothing was undone: change 1 is the code as it came into Qorpera, where its record begins. Undo change 2 with andLater true to take out every change after it, or ${followUp}.`
					: `Change 1 cannot be undone: it is the code as it came into Qorpera, where its record begins. Instead, ${followUp}.`;
			return request.andLater
				? `Nothing was undone: the repository was put back from its copy after change ${n}, and andLater does not reach back past that. Undo change ${n} alone, or ${followUp}.`
				: `Change ${n} cannot be undone: the record does not hold main as it was before it. Instead, ${followUp}.`;
		case "too_many":
			return `Nothing was undone: that would take out too many changes at once. Instead, ${followUp}.`;
		case "busy":
			return `Nothing was undone: another undo, or a restore, is being made in ${request.owner}/${request.name}. Call again with a new operationKey when it is done.`;
		case "no_executor":
			return "Nothing was undone: Qorpera's code service is not running for this company right now. Try again in a few minutes, with a new operationKey.";
		default:
			return raised(reason, request);
	}
}

function formatMessages(messages: readonly string[] | null): string {
	if (!messages || messages.length === 0) return "";
	return ` Details: ${messages.slice(0, 5).join("; ")}.`;
}

function undoEnded(request: CodeUndo, ended: CloudCompanyCodeRequestV2): string {
	const n = request.change ?? request.changes?.[0] ?? 0;
	const folder = `code/${request.owner}/${request.name}`;
	const nothing = `Nothing was undone: main no longer holds what change ${n} did.`;
	const followUp = "send the session a follow-up that puts the old behaviour back";
	if (ended.state === "done" && ended.result === "dry_run") {
		return redactCloudWebhookSecrets(
			cloudToolJsonText(
				{
					schema: "qorpera.code-undo-dry-run/v1",
					owner: request.owner,
					name: request.name,
					...(ended.data as Record<string, JsonValue>),
				},
				JSON_RENDER_BYTES,
			),
		);
	}
	if (ended.state === "done" && ended.result === "undone") {
		const made =
			ended.change === null ? "" : ` This is change ${ended.change}: ${folder}/changes/${ended.change}.md.`;
		const last = ended.change === null ? n : ended.change - 1;
		const siteNote =
			ended.data?.siteReused === true
				? " The prior verified site build was reused for What's new."
				: ended.data?.siteNeedsRebuild === true
					? " The repository has a configured site whose files differ from prior builds: run a follow-up coding turn to rebuild the site."
					: "";
		const subject = request.changes
			? `Changes ${request.changes.join(", ")} are undone.`
			: request.toChange !== undefined && request.change !== undefined
				? `Changes ${request.change} to ${request.toChange} are undone.`
				: request.andLater && last > n
					? `Changes ${n} to ${last} are undone. Main is as it was before change ${n}.`
					: `Change ${n} is undone. Main is as it was without it.`;
		return `${subject}${made}${siteNote} Check ${folder}/main/ before you tell anyone.`;
	}
	if (ended.state === "done" && ended.result === "nothing") return nothing;
	if (ended.state === "refused") {
		const code = ended.code ?? "";
		if (code === "CODE_HOST_UNDO_CONFLICT" && !request.andLater)
			return `Nothing was undone: later changes built on change ${n}${inFiles(ended.paths)}.${formatMessages(ended.messages)} Undo with andLater true and a new operationKey to take out change ${n} and every change after it, or ${followUp}.`;
		if (code === "CODE_HOST_UNDO_CHECKS_REQUIRED" || code === "CODE_HOST_UNDO_CHECKS_FAILED")
			return `Nothing was undone: checks verification blocked the revert.${formatMessages(ended.messages)}${codeMark(ended.code)}`;
		if (code === "CODE_HOST_UNDO_NOT_IN_MAIN" || code === "CODE_HOST_UNDO_UNKNOWN_COMMIT") return nothing;
		if (code.startsWith("CODE_HOST_NAMES_"))
			return `Nothing was undone: the files it would put back have names a repository kept in Qorpera does not take${inFiles(ended.paths)}. Instead, ${followUp}.`;
		return `Nothing was undone. Look at ${folder}/changes/index.md before you try again, with a new operationKey.${codeMark(ended.code)}`;
	}
	return `The undo did not finish. Look at ${folder}/changes/index.md before you try again, with a new operationKey.${codeMark(ended.code)}`;
}

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

function lifecycleRefused(
	reason: Extract<CloudCompanyCodeLifecycleAnswer, { state: "refused" }>["reason"],
	request: CodeCreate | CodeArchive | CodeUnarchive | CodeTag | CodePrune,
): string {
	switch (reason) {
		case "deleting":
			return "Nothing was changed: the company is being deleted.";
		case "github_conflict":
			return `Nothing was created: ${request.owner}/${request.name} is already linked to a GitHub repository.`;
		case "import_in_progress":
			return `Nothing was created: an import into ${request.owner}/${request.name} is already in progress.`;
		case "archived":
			return `Nothing was changed: ${request.owner}/${request.name} is archived.`;
		case "sessions_active":
			return `Nothing was archived: ${request.owner}/${request.name} still has active coding sessions. Archive or finish them first.`;
		case "no_executor":
			return "Qorpera's code service is not running for this company right now. Try again in a few minutes, with a new operationKey.";
		default:
			return raised(reason, request);
	}
}

function queryRefused(
	reason: Extract<CloudCompanyCodeQueryAsked, { state: "refused" }>["reason"],
	request: CodeLog | CodeDiff | CodeShow | CodeBranches | CodeMergePreview,
): string {
	switch (reason) {
		case "no_executor":
			return "Qorpera's code service is not running for this company right now. Try again in a few minutes.";
		case "restoring":
			return `The repository ${request.owner}/${request.name} is currently being restored from a backup; try again shortly.`;
		default:
			return raised(reason, request);
	}
}

function importStop(
	code: string,
	request: CodeBringIn,
	refused: CloudCompanyCodeImportLook["refused"] | undefined,
): string | undefined {
	const project = "github" in request.from ? `github.com/${request.from.github}` : undefined;
	switch (code) {
		case "IMPORT_TOO_LARGE":
			return project === undefined
				? "the file is larger than 256 MB, the most Qorpera brings in from a file"
				: "it is larger than 1 GB, the most Qorpera brings in";
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
			return request.from.branch === undefined
				? "the file has more than one branch and none is clearly its main one: call again with from.branch, the branch to bring in, and a new operationKey"
				: `it has no branch ${JSON.stringify(request.from.branch)}: call again with from.branch set to one it has, or without from.branch, and a new operationKey`;
		case "IMPORT_FILE_NOT_WHOLE":
			return "the file is not a whole git bundle: make it again with git bundle create <file> --all";
		case "IMPORT_FILE_CHANGED":
			return "the file changed after you asked: call again with a new operationKey";
		case "IMPORT_PLACE_HALF_DONE":
			return `an earlier bring-in stopped half way at code/${request.owner}/${request.name}: bring the same code in again, with a new operationKey, to finish it; other code cannot go there until then. If the same code is refused too, tell a member that Qorpera must clear that place first`;
	}
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

function size(bytes: number): string {
	if (bytes < 1024 ** 2) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
	if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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

function lineList(
	lines: NonNullable<CloudCompanyCodeImportLook["lines"]>,
	item: (line: NonNullable<CloudCompanyCodeImportLook["lines"]>["shown"][number]) => string,
): string {
	const named = lines.shown.map(
		(line) => `${line.name === null ? "one whose name is not shown" : JSON.stringify(line.name)} (${item(line)})`,
	);
	const more = lines.count - named.length;
	return named.length ? `: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "";
}

const CANNOT_HOLD = "the company folder cannot hold some of its file names";

function linesLooked(look: CloudCompanyCodeImportLook): { said: string; instead: string } {
	const lines = look.lines;
	if (lines === undefined || lines.count === 0) return { said: "", instead: "" };
	const list = lineList(
		lines,
		(line) =>
			`${count(line.ahead, "change", "changes")} main lacks, ${line.behind} behind main${line.fits === false ? `; ${CANNOT_HOLD}, so it cannot be merged as it is` : ""}`,
	);
	const taken = lines.shown.some((line) => line.name !== null && branchTaken(line.name) && line.fits !== false);
	return {
		said: ` It has ${count(lines.count, "other branch", "other branches")} with work its main branch lacks, which ${lines.count === 1 ? "comes" : "come"} in under refs/qorpera/imported/heads/${list}.`,
		instead: taken
			? " To bring one in as the main branch instead, call bring_in with from.branch set to its name, look false and a new operationKey."
			: "",
	};
}

function linesCame(look: CloudCompanyCodeImportLook, folder: string): string {
	const lines = look.lines;
	if (lines === undefined || lines.count === 0) return "";
	const list = lineList(lines, (line) => `${line.ahead}${line.fits === false ? `; ${CANNOT_HOLD}` : ""}`);
	return ` ${count(lines.count, "other branch", "other branches")} came with it under refs/qorpera/imported/heads/, with ${count(lines.changes, "change", "changes")} main lacks${list}. To bring one into main, have a coding session on ${folder} merge it into its branch (git merge refs/qorpera/imported/heads/<name>), run the checks and finish; changes/1.md lists them.`;
}

function bundleLeft(path: string, file: CloudCompanyCodeImport["file"]): string {
	if (file === undefined || file === null || file.path !== path)
		return ` Qorpera no longer needs the bundle it read from ${path}. Delete that file only if it is still the bundle you made for this; leave any other file there.`;
	return file.version === null
		? ` The file at ${path} is no longer the bundle that was read, or is gone: leave it.`
		: ` Qorpera no longer needs ${path}: it is still the bundle that was read (version ${file.version}). If you made it for this, delete it with company_delete and expectedVersion ${file.version}; that removes only that version.`;
}

function importEnded(request: CodeBringIn, ended: CloudCompanyCodeImport): string {
	const folder = `code/${ended.owner}/${ended.name}`;
	const look = ended.look;
	if (ended.state === "done" && ended.result === "looked") {
		if (look === null) return "It was looked at, but what it found is not there to read.";
		const lines = linesLooked(look);
		return `${lookFacts(look, request)}${lines.said} ${keyLike(look)}${look.why === null ? " To bring it in, call bring_in with look false and a new operationKey." : ""}${lines.instead}`;
	}
	if (ended.state === "done") {
		const record = ended.change === null ? "" : `; change ${ended.change} of its record`;
		const facts =
			look === null
				? `Brought in as ${folder}${record}.`
				: `Brought in as ${folder}: ${count(look.commits, "earlier change", "earlier changes")} on ${look.defaultBranch ?? "its main branch"}, ${count(look.files, "file", "files")}${record}.${linesCame(look, folder)}`;
		const source =
			"github" in request.from
				? " The copy on GitHub stays as it was; Qorpera no longer works on it there."
				: bundleLeft(request.from.file, ended.file);
		return `${facts}${source} Have a coding session add its checks file.${look !== null && look.secrets.found > 0 ? ` ${keyLike(look)}` : ""}`;
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

const IMPORT_STEPS: Readonly<Record<NonNullable<CloudCompanyCodeImport["step"]>, string>> = {
	fetch: "getting it from GitHub",
	read: "reading the file",
	look: "checking it",
	close: "putting it in place",
	"set-aside": "putting it in place",
	build: "putting it in place",
	open: "putting it in place",
};
const IMPORT_WAITS: ReadonlyMap<string, string> = new Map([
	["SESSIONS_BUSY", "until the company's coding sessions are quiet"],
	["SESSIONS_ATTACHED", "until the company's coding sessions are quiet"],
	["SESSIONS_OPEN", "until no coding session works on it on GitHub"],
]);

function importOpen(request: CodeBringIn, seen: CloudCompanyCodeImport | undefined): string {
	const step = seen?.step ? IMPORT_STEPS[seen.step] : "waiting its turn";
	const waits = seen?.waiting
		? `, waiting ${IMPORT_WAITS.get(seen.waiting) ?? "for the company's other code work"}`
		: "";
	return `It is being ${request.look ? "looked at" : "brought in"} (${step}${waits}). Call bring_in again with the same operationKey to see how it went.`;
}

function fitTextFieldJson(
	payload: Record<string, JsonValue>,
	textField?: "content" | "patch",
): string {
	const render = (obj: Record<string, JsonValue>): string | undefined => {
		try {
			const candidate = redactCloudWebhookSecrets(cloudToolJsonText(obj, JSON_RENDER_BYTES));
			return fitsOneResult(candidate) ? candidate : undefined;
		} catch {
			return undefined;
		}
	};
	const whole = render(payload);
	if (whole !== undefined) return whole;
	if (textField && typeof payload[textField] === "string") {
		const raw = payload[textField] as string;
		let low = 0;
		let high = raw.length;
		let best: string | undefined;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const candidate = render({ ...payload, [textField]: raw.slice(0, mid), truncated: true });
			if (candidate !== undefined) {
				best = candidate;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		if (best !== undefined) return best;
	}
	throw new CloudToolRefusal("COMPANY_FILE_ANSWER_TOO_LONG: code response is too long to show in one tool result");
}

export function cloudCodeTools(options: {
	folder: Pick<
		CloudCompanyFolderClient,
		| "requestCodeUndoV2"
		| "codeRequestV2"
		| "codeRepositoryStatus"
		| "codeHistory"
		| "codeQuery"
		| "codeLifecycle"
		| "describeCodeChange"
		| "requestCodeImport"
		| "codeImport"
		| "read"
		| "readText"
		| "release"
	>;
	identity: CloudNativeToolIdentity;
	lookMs?: number;
	waitMs?: number;
}): readonly CloudNativeTool[] {
	const { folder } = options;
	const expected = Object.freeze({ ...options.identity });
	const lookMs = options.lookMs ?? UNDO_LOOK_MS;
	const waitMs = options.waitMs ?? UNDO_WAIT_MS;
	const queryWaitMs = options.waitMs ?? QUERY_WAIT_MS;
	const said = (value: string): CloudToolContent => ({ kind: "text", value });

	const pollCodeRequest = async (
		requestId: string,
		expectedKind: "undo" | "query" | "lifecycle",
		maxWaitMs: number,
		signal: AbortSignal,
	): Promise<CloudCompanyCodeRequestV2 | undefined> => {
		const until = Date.now() + maxWaitMs;
		let step = 0;
		for (let left = maxWaitMs; left > 0; left = until - Date.now()) {
			const pause =
				expectedKind === "undo"
					? Math.min(lookMs, left)
					: step < 3
						? Math.min(lookMs, 500, left)
						: Math.min(lookMs, left);
			step += 1;
			await cloudControlPause(pause, signal);
			let now: CloudCompanyCodeRequestV2 | undefined;
			try {
				now = await folder.codeRequestV2(requestId, signal);
			} catch {
				signal.throwIfAborted();
			}
			if (now && now.kind !== expectedKind) throw new Error("Code request differs");
			if (now && now.state !== "queued" && now.state !== "running") return now;
		}
		return undefined;
	};

	const status = async (request: CodeStatus, context: CloudToolContext): Promise<CloudToolContent> => {
		const signal = context.signal;
		const repoPath = `code/${request.owner}/${request.name}`;
		const checksPath = `${repoPath}/main/.qorpera/checks.json`;
		const readEntries = new Map<string, CloudCompanyFolderRelease>();
		const track = (entry: CloudCompanyFolderEntry | null | undefined): void => {
			if (!entry) return;
			const key = `${entry.path}:${entry.version}`;
			if (!readEntries.has(key)) readEntries.set(key, cloudCompanyFolderRelease(entry));
		};
		const readEntry = async (path: string): Promise<CloudCompanyFolderEntry | null> => {
			try {
				const found = (await folder.read(path, signal)).entry;
				track(found);
				return found;
			} catch (error) {
				return unavailable(error, "read");
			}
		};
		const readTextBounded = async (
			path: string,
			maxBytes: number,
		): Promise<
			| { readonly kind: "ok"; readonly text: string }
			| { readonly kind: "missing" }
			| { readonly kind: "unreadable"; readonly code: string }
		> => {
			try {
				const found = await folder.readText(path, maxBytes, signal);
				if (!found) return { kind: "missing" };
				track(found.entry);
				return { kind: "ok", text: found.text };
			} catch (error) {
				if (error instanceof CloudCompanyPathNotText) {
					const meta = await readEntry(path);
					if (!meta) return { kind: "missing" };
					if (meta.kind !== "file") return { kind: "unreadable", code: "NOT_A_FILE" };
					if (meta.file.bytes > maxBytes) return { kind: "unreadable", code: "TOO_LARGE" };
					return { kind: "unreadable", code: "NOT_UTF8" };
				}
				return unavailable(error, "read");
			}
		};

		const [sqlStatus, repoEntry, mainEntry, checksRead]: [
			CloudCompanyCodeRepositoryStatus,
			CloudCompanyFolderEntry | null,
			CloudCompanyFolderEntry | null,
			Awaited<ReturnType<typeof readTextBounded>>,
		] = await Promise.all([
			folder.codeRepositoryStatus(request.owner, request.name, signal),
			readEntry(repoPath),
			readEntry(`${repoPath}/main`),
			readTextBounded(checksPath, MAX_CODE_CHECKS_FILE_BYTES),
		]);

		if (!sqlStatus.registered && !repoEntry) {
			throw new CloudToolRefusal(
				`There is no repository at ${repoPath}/: list code/ to see the repositories kept here.`,
			);
		}
		if (repoEntry && repoEntry.kind !== "folder") {
			throw new CloudToolRefusal(`${repoPath} is not a repository folder.`);
		}

		let checksSummary: Record<string, JsonValue>;
		if (checksRead.kind === "missing") {
			checksSummary = { present: false, path: checksPath };
		} else if (checksRead.kind === "unreadable") {
			checksSummary = {
				present: true,
				valid: false,
				path: checksPath,
				problems: [
					{
						at: "",
						code: checksRead.code,
						message:
							checksRead.code === "TOO_LARGE"
								? "The checks file is over 16 KiB."
								: checksRead.code === "NOT_A_FILE"
									? "The checks file is not a regular file."
									: "The checks file is not UTF-8 text.",
					},
				],
			};
		} else {
			const parsedChecks = parseCodeChecksText(checksRead.text);
			checksSummary = parsedChecks.ok
				? {
						present: true,
						valid: true,
						path: checksPath,
						mode: parsedChecks.mode,
						totalTimeoutSeconds: parsedChecks.totalTimeoutSeconds,
						checks: parsedChecks.checks.map((entry) => ({
							name: entry.name,
							cwd: entry.cwd,
							timeoutSeconds: entry.timeoutSeconds,
							...(entry.needs !== undefined ? { needs: [...entry.needs] } : {}),
						})),
						site: parsedChecks.site
							? {
									folder: parsedChecks.site.folder,
									name: parsedChecks.site.name,
									title: parsedChecks.site.title,
								}
							: null,
					}
				: {
						present: true,
						valid: false,
						path: checksPath,
						problems: parsedChecks.problems
							.slice(0, 10)
							.map((problem) => ({ at: problem.at, code: problem.code, message: problem.message })),
					};
		}

		const renderStatus = (sessionCount: number, changeCount: number): string =>
			cloudToolJsonText(
				{
					schema: "qorpera.code-status/v1",
					repository: {
						owner: request.owner,
						name: request.name,
						path: repoPath,
						hasMain: mainEntry?.kind === "folder" || sqlStatus.repository.mainSha !== null,
						archived: sqlStatus.repository.archived,
						archivedAt: sqlStatus.repository.archivedAt,
						checksEnabled: sqlStatus.repository.checksEnabled,
						siteEnabled: sqlStatus.repository.siteEnabled,
						lastChange: sqlStatus.repository.lastChange,
						mainSha: sqlStatus.repository.mainSha,
						restoredAt: sqlStatus.repository.restoredAt,
						importedAt: sqlStatus.repository.importedAt,
						restoring: sqlStatus.queue.restoring,
						site: sqlStatus.site as JsonValue,
					},
					sessions: sqlStatus.sessions.slice(0, sessionCount) as unknown as JsonValue,
					sessionsTotal: sqlStatus.sessionsTotal,
					sessionsTruncated: sessionCount < sqlStatus.sessionsTotal,
					changesCount: sqlStatus.changesCount,
					recentChanges: {
						present: sqlStatus.changesCount > 0,
						total: sqlStatus.changesCount,
						changes: sqlStatus.recentChanges.slice(0, changeCount) as unknown as JsonValue,
					},
					queue: sqlStatus.queue as unknown as JsonValue,
					checks: checksSummary,
				},
				JSON_RENDER_BYTES,
			);

		const tryRender = (sc: number, cc: number): string | undefined => {
			try {
				const candidate = redactCloudWebhookSecrets(renderStatus(sc, cc));
				return fitsOneResult(candidate) ? candidate : undefined;
			} catch {
				return undefined;
			}
		};
		let sessionCount = sqlStatus.sessions.length;
		let changeCount = sqlStatus.recentChanges.length;
		let text = tryRender(sessionCount, changeCount);
		while (text === undefined && (sessionCount > 0 || changeCount > 0)) {
			if (sessionCount >= changeCount && sessionCount > 0) sessionCount = Math.floor(sessionCount / 2);
			else changeCount = Math.floor(changeCount / 2);
			text = tryRender(sessionCount, changeCount);
		}
		if (text === undefined) {
			throw new CloudToolRefusal(
				"COMPANY_FILE_ANSWER_TOO_LONG: repository status is too long to show in one tool result",
			);
		}
		context.observation?.update({ outputBytes: Buffer.byteLength(text) });
		const reads = [...readEntries.values()];
		if (reads.length > 0) {
			const outputSha256 = createHash("sha256").update(text, "utf8").digest("hex");
			try {
				await folder.release(releaseId(expected.runId, context.callId, outputSha256), reads, outputSha256, signal);
			} catch (error) {
				unavailable(error, "shown");
			}
		}
		return { kind: "text", value: text };
	};

	const history = async (request: CodeHistory, context: CloudToolContext): Promise<CloudToolContent> => {
		const page: CloudCompanyCodeHistoryPage = await folder.codeHistory(
			{
				owner: request.owner,
				name: request.name,
				...(request.state === undefined ? {} : { state: request.state }),
				...(request.workerId === undefined ? {} : { workerId: request.workerId }),
				...(request.path === undefined ? {} : { path: request.path }),
				...(request.cursor === undefined ? {} : { cursor: request.cursor }),
				...(request.limit === undefined ? {} : { limit: request.limit }),
			},
			context.signal,
		);
		let changeCount = page.changes.length;
		const render = (n: number): string | undefined => {
			try {
				const slice = page.changes.slice(0, n);
				const nextCursor =
					n < page.changes.length ? (slice.at(-1)?.n ?? page.nextCursor) : page.nextCursor;
				const text = redactCloudWebhookSecrets(
					cloudToolJsonText(
						{
							schema: "qorpera.code-history/v1",
							owner: page.owner,
							name: page.name,
							total: page.total,
							changes: slice as unknown as JsonValue,
							nextCursor,
						},
						JSON_RENDER_BYTES,
					),
				);
				return fitsOneResult(text) ? text : undefined;
			} catch {
				return undefined;
			}
		};
		let text = render(changeCount);
		while (text === undefined && changeCount > 0) {
			changeCount = Math.floor(changeCount / 2);
			text = render(changeCount);
		}
		if (text === undefined)
			throw new CloudToolRefusal("COMPANY_FILE_ANSWER_TOO_LONG: history page is too long to show in one result");
		context.observation?.update({ outputBytes: Buffer.byteLength(text) });
		return said(text);
	};

	const runQuery = async (
		request: CodeLog | CodeDiff | CodeShow | CodeBranches | CodeMergePreview,
		context: CloudToolContext,
	): Promise<CloudToolContent> => {
		const payload: Record<string, unknown> =
			request.action === "log"
				? {
						op: "log",
						owner: request.owner,
						name: request.name,
						...(request.ref === undefined ? {} : { ref: request.ref }),
						...(request.path === undefined ? {} : { path: request.path }),
						...(request.limit === undefined ? {} : { limit: request.limit }),
						...(request.since === undefined ? {} : { since: request.since }),
					}
				: request.action === "diff"
					? {
							op: "diff",
							owner: request.owner,
							name: request.name,
							from: request.base,
							to: request.head,
							...(request.statOnly === undefined ? {} : { statOnly: request.statOnly }),
							...(request.paths === undefined ? {} : { paths: [...request.paths] }),
							...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
						}
					: request.action === "show"
						? {
								op: "show",
								owner: request.owner,
								name: request.name,
								...(request.ref === undefined ? {} : { ref: request.ref }),
								path: request.path,
								...(request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }),
							}
						: request.action === "branches"
							? { op: "branches", owner: request.owner, name: request.name }
							: {
									op: "merge_preview",
									owner: request.owner,
									name: request.name,
									...(request.base === undefined ? {} : { base: request.base }),
									head: request.head,
								};
		const asked = await folder.codeQuery(payload, context.signal);
		if (asked.state === "refused") throw new CloudToolRefusal(queryRefused(asked.reason, request));
		const ended = await pollCodeRequest(asked.requestId, "query", queryWaitMs, context.signal);
		if (!ended) {
			return said(
				cloudToolJsonText({
					schema: "qorpera.code-query-pending/v1",
					requestId: asked.requestId,
					action: request.action,
					state: "pending",
					message: "The git query is still running on the code host; call again shortly.",
				}),
			);
		}
		if (ended.state === "refused") {
			throw new CloudToolRefusal(
				`Code query refused${inFiles(ended.paths)}.${formatMessages(ended.messages)}${codeMark(ended.code)}`,
			);
		}
		if (ended.state !== "done" || ended.data === null) {
			throw new CloudToolRefusal(`Code query failed.${codeMark(ended.code)}`);
		}
		const textField = request.action === "show" ? "content" : request.action === "diff" ? "patch" : undefined;
		const text = fitTextFieldJson(
			{
				schema: `qorpera.code-${request.action}/v1`,
				owner: request.owner,
				name: request.name,
				...(ended.data as Record<string, JsonValue>),
			},
			textField,
		);
		context.observation?.update({ outputBytes: Buffer.byteLength(text) });
		return said(text);
	};

	const runLifecycle = async (
		request: CodeCreate | CodeArchive | CodeUnarchive | CodeTag | CodePrune,
		context: CloudToolContext,
	): Promise<CloudToolContent> => {
		const payload: Record<string, unknown> & { readonly operationKey: string } =
			request.action === "create"
				? { operationKey: request.operationKey, op: "create", owner: request.owner, name: request.name }
				: request.action === "unarchive"
					? { operationKey: request.operationKey, op: "unarchive", owner: request.owner, name: request.name }
					: request.action === "archive"
						? {
								operationKey: request.operationKey,
								op: "archive",
								owner: request.owner,
								name: request.name,
								...(request.reason === undefined ? {} : { reason: request.reason }),
							}
						: request.action === "tag"
							? request.mode === "list"
								? {
										operationKey: request.operationKey,
										op: "tag",
										owner: request.owner,
										name: request.name,
										mode: "list",
									}
								: {
										operationKey: request.operationKey,
										op: "tag",
										owner: request.owner,
										name: request.name,
										mode: "create",
										tag: request.tag,
										...(request.ref === undefined ? {} : { target: request.ref }),
										...(request.message === undefined ? {} : { message: request.message }),
									}
							: {
									operationKey: request.operationKey,
									op: "prune",
									owner: request.owner,
									name: request.name,
									deleteMergedBranches: request.deleteMergedBranches,
								};
		const asked = await folder.codeLifecycle(payload, context.signal);
		if (asked.state === "refused") throw new CloudToolRefusal(lifecycleRefused(asked.reason, request));
		if (asked.state === "done") {
			return said(
				cloudToolJsonText({
					schema: "qorpera.code-lifecycle/v1",
					action: request.action,
					state: "done",
					result: asked.result,
					owner: asked.owner,
					name: asked.name,
					archivedAt: asked.archivedAt,
				}),
			);
		}
		if (asked.state === "already") {
			return said(
				cloudToolJsonText({
					schema: "qorpera.code-lifecycle/v1",
					action: request.action,
					state: "already",
					owner: asked.owner,
					name: asked.name,
					...(asked.archivedAt === undefined ? {} : { archivedAt: asked.archivedAt }),
				}),
			);
		}
		const ended = await pollCodeRequest(asked.requestId, "lifecycle", queryWaitMs, context.signal);
		if (!ended) {
			return said(
				cloudToolJsonText({
					schema: "qorpera.code-lifecycle-pending/v1",
					requestId: asked.requestId,
					action: request.action,
					state: "pending",
					message: `The ${request.action} operation is still running; call again with the same operationKey.`,
				}),
			);
		}
		if (ended.state === "refused") {
			throw new CloudToolRefusal(
				`${request.action} refused${inFiles(ended.paths)}.${formatMessages(ended.messages)}${codeMark(ended.code)}`,
			);
		}
		if (ended.state !== "done") {
			throw new CloudToolRefusal(`${request.action} failed.${codeMark(ended.code)}`);
		}
		const text = fitTextFieldJson({
			schema: "qorpera.code-lifecycle/v1",
			action: request.action,
			state: "done",
			result: ended.result ?? "ok",
			owner: request.owner,
			name: request.name,
			...((ended.data ?? {}) as Record<string, JsonValue>),
		});
		context.observation?.update({ outputBytes: Buffer.byteLength(text) });
		return said(text);
	};

	const undo = async (request: CodeUndo, signal: AbortSignal): Promise<CloudToolContent> => {
		const { action: _action, ...asked } = request;
		const answer = await folder.requestCodeUndoV2(asked, signal);
		if (answer.state === "already") {
			const n = request.change ?? request.changes?.[0] ?? 0;
			return said(`Change ${n} is already undone, by change ${answer.undoneBy}.`);
		}
		if (answer.state === "refused") throw new CloudToolRefusal(undoRefused(answer.reason, request));
		const ended = await pollCodeRequest(answer.requestId, "undo", waitMs, signal);
		if (ended) return said(undoEnded(request, ended));
		const n = request.change ?? request.changes?.[0] ?? 0;
		return said(
			`The undo of change ${n} is still being made. Call manage_code undo for it again to see how it went.`,
		);
	};

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

	const refSchema: JsonValue = {
		type: ["string", "integer"],
		description: "main, change number, 40-char SHA, worker:<id>, tag:<name> or imported:<branch>.",
	};

	const code: CloudNativeTool = {
		name: "manage_code" satisfies CloudRuntimeToolOperation,
		source: "runtime",
		description: CLOUD_CODE_TOOL_DESCRIPTION,
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["action", "owner", "name"],
			properties: {
				action: { type: "string", enum: [...ACTIONS] },
				operationKey: {
					type: "string",
					pattern: OPERATION_KEY.source,
					description: "Required for undo, describe, bring_in, create, archive, unarchive, tag and prune.",
				},
				owner: { type: "string", minLength: 1, maxLength: 39 },
				name: { type: "string", minLength: 1, maxLength: 100 },
				change: { type: "integer", minimum: 1 },
				toChange: { type: "integer", minimum: 1, description: "With undo: end of a change range." },
				changes: {
					type: "array",
					minItems: 1,
					maxItems: 50,
					uniqueItems: true,
					items: { type: "integer", minimum: 1 },
					description: "With undo: list of 1 to 50 distinct change numbers.",
				},
				from: {
					type: "object",
					additionalProperties: false,
					properties: {
						github: { type: "string", minLength: 3, maxLength: 200 },
						file: { type: "string", minLength: 1, maxLength: INCOMING_BYTES },
						branch: { type: "string", minLength: 1, maxLength: BRANCH_BYTES },
					},
				},
				look: { type: "boolean" },
				andLater: { type: "boolean" },
				dryRun: { type: "boolean", description: "With undo: preview without moving main." },
				runChecks: {
					type: "boolean",
					description:
						"With undo: require the reverted tree to match a prior checks-verified state (or have no checks); refuses unverified trees unless force is true.",
				},
				force: { type: "boolean", description: "With undo: bypass checks verification gate in an emergency." },
				reason: { type: "string", minLength: 1, maxLength: 500 },
				notice: {
					type: "string",
					minLength: 1,
					maxLength: 200,
					description: "One plain sentence on what a customer will notice, at most 200 characters.",
				},
				picture: {
					type: "string",
					minLength: 1,
					maxLength: 1024,
					description: "Company path to a .png, .jpg, .jpeg or .webp file of at most 4 MB.",
				},
				ref: refSchema,
				base: refSchema,
				head: refSchema,
				path: { type: "string", minLength: 1, maxLength: 1024 },
				paths: {
					type: "array",
					maxItems: 20,
					items: { type: "string", minLength: 1, maxLength: 1024 },
					description: "With diff: up to 20 relative repository paths.",
				},
				statOnly: { type: "boolean" },
				maxBytes: { type: "integer", minimum: 1024, maximum: MAX_SHOW_BYTES },
				limit: { type: "integer", minimum: 1, maximum: 100 },
				since: { type: "string", minLength: 10, maxLength: 40 },
				state: { type: "string", enum: [...HISTORY_STATES] },
				workerId: { type: "string", pattern: UUID_PATTERN.source },
				cursor: { type: "integer", minimum: 1 },
				mode: { type: "string", enum: [...TAG_MODES] },
				tag: { type: "string", minLength: 1, maxLength: 120 },
				message: { type: "string", minLength: 1, maxLength: 1000 },
				deleteMergedBranches: { type: "boolean" },
			},
		},
		parseArguments: (value) => parse(value) as never,
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
			if (request.action === "status") return status(request, context);
			if (request.action === "history") return history(request, context);
			if (
				request.action === "log" ||
				request.action === "diff" ||
				request.action === "show" ||
				request.action === "branches" ||
				request.action === "merge_preview"
			)
				return runQuery(request, context);
			if (
				request.action === "create" ||
				request.action === "archive" ||
				request.action === "unarchive" ||
				request.action === "tag" ||
				request.action === "prune"
			)
				return runLifecycle(request, context);
			if (request.action === "bring_in") return bringIn(request, context.signal);
			return request.action === "undo" ? undo(request, context.signal) : describe(request, context.signal);
		},
	};
	return [code];
}
