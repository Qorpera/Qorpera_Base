export const MAX_CODE_CHECKS_FILE_BYTES = 16 * 1024;
export const MAX_CODE_CHECKS = 20;
export const CODE_CHECK_DEFAULT_SECONDS = 600;
export const CODE_CHECK_MIN_SECONDS = 10;
export const CODE_CHECK_MAX_SECONDS = 1800;
const PREVIEW_DEFAULT_SECONDS = 180;
const PREVIEW_MAX_SECONDS = 600;
export const CODE_CHECKS_CRITICAL_PATH_SECONDS = 3600;
export const CODE_CHECKS_TOTAL_CPU_SECONDS = 7200;
export const MAX_CODE_CHECK_RUN_BYTES = 4096;
export const MAX_CODE_CHECK_CWD_BYTES = 300;
export const MAX_PARALLEL_CHECKS = 4;
export const MIN_PARALLEL_CHECKS = 1;
export const MAX_PARALLEL_CHECKS_LIMIT = 8;
export const MAX_CHECK_RETRIES = 2;
export const MAX_CHECK_CACHES = 8;
export const MAX_CHECK_CACHE_PATHS = 16;
export const MAX_CHECK_CACHE_RESTORE_KEYS = 8;
export const MAX_CHECK_CACHE_KEY_BYTES = 128;
export const MAX_CHECK_CACHE_HASH_CALLS = 4;
export const MAX_CHECK_PATHS = 64;
export const MAX_CHECK_ENV_ENTRIES = 64;
export const MAX_CHECK_ENV_VALUE_BYTES = 4096;
export const MAX_CHECK_SECRETS = 64;
export const MAX_CHECK_ARTIFACT_PATHS = 16;
export const MAX_FAILED_TESTS = 25;
export const CODE_CHECK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export const CODE_SITE_NAME_RULE =
	"A site's name is 3 to 48 characters of a to z, 0 to 9 and single hyphens, starts and ends with a letter or digit, does not end in -preview, does not contain qorpera, and is not a reserved name (such as app, api, mail, shop, login).";

export const CODE_SITE_RESERVED_NAMES =
	"api app www admin assets static qorpera login signin signup robots favicon sites site well-known help support status mail functions auth rest storage realtime objects inbox send screens edge coding noreply staging dev test preview next docs blog news account accounts billing pay payments checkout secure security sso id oauth my dashboard console portal cdn media files download downloads smtp imap pop mx autoconfig autodiscover abuse postmaster hostmaster webmaster ns1 ns2 vpn git code data db ws live screen desktop computer health metrics tunnel gateway relay hooks webhooks events invite invites join team teams company companies members cofounder agent agents chat email webmail calendar ftp m mobile wiki shop store home root system internal private public demo beta";

const SITE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const RESERVED_SITE_NAME_SET = /* @__PURE__ */ new Set(/* @__PURE__ */ CODE_SITE_RESERVED_NAMES.split(" "));
const MAX_SITE_TITLE_CHARS = 120;
const MAX_JSON_DEPTH = 32;
const UNKNOWN_KEY_MESSAGE = "This key is not in the checks file's schema.";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CACHE_KEY_STATIC_PATTERN = /^[A-Za-z0-9._:-]*$/;
const CACHE_HASH_TOKEN = /(?:\$\{hash\('([^']*)'\)\}|hash\('([^']*)'\))/g;

const RESERVED_ENV_PREFIXES: readonly string[] = /* @__PURE__ */ Object.freeze([
	"QORPERA_",
	"LD_",
	"DYLD_",
	"GIT_",
	"BASH_",
	"SSH_",
	"SUDO_",
	"XDG_",
	"DBUS_",
	"DOCKER_",
	"SYSTEMD_",
]);

const RESERVED_ENV_NAMES = /* @__PURE__ */ new Set<string>([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"CI",
	"IFS",
	"ENV",
	"PROMPT_COMMAND",
	"CDPATH",
	"GLOBIGNORE",
	"NODE_OPTIONS",
	"NODE_PATH",
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"PERL5OPT",
	"RUBYOPT",
	"CLASSPATH",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"npm_config_cache",
	"npm_config_store_dir",
	"pnpm_config_store_dir",
	"PIP_CACHE_DIR",
	"UV_CACHE_DIR",
	"PLAYWRIGHT_BROWSERS_PATH",
	"PLAYWRIGHT_SKIP_BROWSER_GC",
	"CARGO_HOME",
	"GOMODCACHE",
	"GOCACHE",
	"BUN_INSTALL_CACHE_DIR",
	"TURBO_CACHE_DIR",
	"SCCACHE_DIR",
]);

const JSON_ESCAPES = /* @__PURE__ */ new Map<string, string>([
	['"', '"'],
	["\\", "\\"],
	["/", "/"],
	["b", "\b"],
	["f", "\f"],
	["n", "\n"],
	["r", "\r"],
	["t", "\t"],
]);

const JSON_LITERALS: readonly [string, boolean | null][] = /* @__PURE__ */ Object.freeze([
	["true", true],
	["false", false],
	["null", null],
]);

const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

export interface CodeCheckCache {
	readonly key: string;
	readonly paths: readonly string[];
	readonly restoreKeys?: readonly string[];
}

export type CodeCheckArtifactWhen = "on_failure" | "always";
export type CodeCheckArtifactFormat = "junit" | "tap" | "vitest-json" | "raw";

export interface CodeCheckArtifacts {
	readonly paths: readonly string[];
	readonly when: CodeCheckArtifactWhen;
	readonly format: CodeCheckArtifactFormat;
}

export interface CodeCheck {
	readonly name: string;
	readonly run: string;
	readonly timeoutSeconds: number;
	readonly cwd: string;
	readonly needs?: readonly string[];
	readonly exclusive?: boolean;
	readonly retries?: number;
	readonly paths?: readonly string[];
	readonly pathsIgnore?: readonly string[];
	readonly alwaysRun?: boolean;
	readonly env?: Readonly<Record<string, string>>;
	readonly secrets?: readonly string[];
	readonly artifacts?: CodeCheckArtifacts;
}

export type CodeSiteKind = "static" | "server" | "hybrid";

export interface CodeSiteRecipe {
	readonly folder: string;
	readonly name: string | null;
	readonly title: string | null;
	readonly kind?: CodeSiteKind;
	readonly dockerfile?: string | null;
	readonly port?: number;
	readonly healthPath?: string;
	readonly idleTimeoutSec?: number;
	readonly memoryMb?: number;
	readonly vcpuLimit?: number;
	readonly spaFallback?: string | null;
}

export interface CodePreviewRecipe {
	readonly run: string;
	readonly folder: string | null;
	readonly cwd: string;
	readonly timeoutSeconds: number;
}

export type CodeSurfaceGate = "none" | "stage";

export interface CodeChecksProblem {
	readonly at: string;
	readonly code: string;
	readonly message: string;
}

export interface ParsedCodeChecksOk {
	readonly ok: true;
	readonly checks: readonly CodeCheck[];
	readonly criticalPathSeconds: number;
	readonly totalTimeoutSeconds: number;
	readonly mode: "sequential" | "dag";
	readonly site: CodeSiteRecipe | null;
	readonly preview?: CodePreviewRecipe;
	readonly surfaceGate?: CodeSurfaceGate;
	readonly maxParallel?: number;
	readonly failFast?: boolean;
	readonly caches?: readonly CodeCheckCache[];
}

export type ParsedCodeChecks =
	| ParsedCodeChecksOk
	| { readonly ok: false; readonly problems: readonly CodeChecksProblem[] };

export interface FailedTestCase {
	readonly suite?: string;
	readonly name: string;
	readonly file?: string;
	readonly line?: number;
	readonly message?: string;
}

class ChecksJsonSyntaxError extends Error {
	readonly index: number;

	constructor(index: number, message: string) {
		super(message);
		this.index = index;
	}
}

type Refuse = (at: string, code: string, message: string) => void;

function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function pointer(at: string, key: string | number): string {
	return `${at}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isControlPoint(point: number): boolean {
	return point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029;
}

export function isCodeCheckEnvNameAllowed(name: string): boolean {
	if (!ENV_NAME_PATTERN.test(name)) return false;
	if (RESERVED_ENV_NAMES.has(name)) return false;
	for (const prefix of RESERVED_ENV_PREFIXES) {
		if (name.startsWith(prefix)) return false;
	}
	return true;
}

export function isCodeCheckSecretNameAllowed(name: string): boolean {
	return ENV_NAME_PATTERN.test(name) && !name.startsWith("QORPERA_");
}

export function isCodeCheckFolder(folder: string): boolean {
	if (folder === ".") return true;
	if (folder === "" || utf8Bytes(folder) > MAX_CODE_CHECK_CWD_BYTES) return false;
	for (let index = 0; index < folder.length; index++) {
		const code = folder.charCodeAt(index);
		if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
	}
	return folder.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function isWorkspaceRelativePath(path: string, allowGlobs: boolean): boolean {
	if (path === "" || path === "." || utf8Bytes(path) > MAX_CODE_CHECK_CWD_BYTES) return false;
	if (path.startsWith("/") || path.endsWith("/")) return false;
	for (const char of path) {
		const point = char.codePointAt(0) as number;
		if (isControlPoint(point) || char === "\\") return false;
	}
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) {
		return false;
	}
	if (!allowGlobs && /[*?[\]{}]/.test(path)) return false;
	if (allowGlobs) {
		let braceDepth = 0;
		for (const char of path) {
			if (char === "{") {
				braceDepth++;
				if (braceDepth > 1) return false;
			} else if (char === "}") {
				braceDepth--;
				if (braceDepth < 0) return false;
			}
		}
		if (braceDepth !== 0) return false;
	}
	return true;
}

export function isCacheKeyTemplateValid(template: string): boolean {
	if (template === "" || utf8Bytes(template) > MAX_CHECK_CACHE_KEY_BYTES) return false;
	if (template === "." || template === ".." || template.startsWith(".")) return false;
	for (const char of template) {
		if (isControlPoint(char.codePointAt(0) as number)) return false;
	}
	CACHE_HASH_TOKEN.lastIndex = 0;
	let cursor = 0;
	let calls = 0;
	for (;;) {
		const match = CACHE_HASH_TOKEN.exec(template);
		if (!match) break;
		calls++;
		if (calls > MAX_CHECK_CACHE_HASH_CALLS) return false;
		const staticPart = template.slice(cursor, match.index);
		if (!CACHE_KEY_STATIC_PATTERN.test(staticPart)) return false;
		const filePath = match[1] ?? match[2] ?? "";
		if (!isWorkspaceRelativePath(filePath, false)) return false;
		cursor = match.index + match[0].length;
	}
	const trailing = template.slice(cursor);
	return CACHE_KEY_STATIC_PATTERN.test(trailing);
}

export function isCodeSiteFolderValid(folder: string): boolean {
	if (folder === ".") return true;
	if (folder === "" || utf8Bytes(folder) > MAX_CODE_CHECK_CWD_BYTES) return false;
	for (const char of folder) {
		if (isControlPoint(char.codePointAt(0) as number) || char === "\\") return false;
	}
	return folder.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function codeSiteNameRefusalText(name: string): string | null {
	let broken: string;
	if (!SITE_NAME_PATTERN.test(name)) broken = "";
	else if (name.includes("--")) broken = " This one has two hyphens in a row.";
	else if (name.endsWith("-preview")) broken = " This one ends in -preview.";
	else if (name.includes("qorpera")) broken = " This one contains qorpera.";
	else if (RESERVED_SITE_NAME_SET.has(name)) broken = " This one is a reserved name.";
	else return null;
	return `${CODE_SITE_NAME_RULE}${broken} Pick another, or leave name out.`;
}

export function isCodeSiteTitleValid(title: string): boolean {
	const chars = Array.from(title);
	if (chars.length < 1 || chars.length > MAX_SITE_TITLE_CHARS) return false;
	if (title.startsWith(" ") || title.endsWith(" ")) return false;
	for (const char of chars) {
		if (isControlPoint(char.codePointAt(0) as number)) return false;
	}
	return true;
}

function parseChecksJson(text: string): unknown {
	let i = 0;
	const fail = (message: string) => new ChecksJsonSyntaxError(i, message);
	const skipSpace = (): void => {
		for (;;) {
			const c = text[i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
			else if (c === "/" && text[i + 1] === "/") {
				while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
			} else if (c === "/" && text[i + 1] === "*") {
				const end = text.indexOf("*/", i + 2);
				if (end < 0) throw fail("A comment is never closed.");
				i = end + 2;
			} else return;
		}
	};
	const readString = (): string => {
		i++;
		let out = "";
		let from = i;
		for (;;) {
			if (i >= text.length) throw fail("A string is never closed.");
			const c = text.charCodeAt(i);
			if (c === 0x22) break;
			if (c < 0x20) throw fail("A string holds a control character; write it as an escape.");
			if (c !== 0x5c) {
				i++;
				continue;
			}
			out += text.slice(from, i);
			const letter = text.charAt(i + 1);
			const simple = JSON_ESCAPES.get(letter);
			if (simple !== undefined) {
				out += simple;
				i += 2;
			} else if (letter === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
				out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
				i += 6;
			} else throw fail("A string holds an escape JSON doesn't have.");
			from = i;
		}
		out += text.slice(from, i);
		if (LONE_SURROGATE.test(out)) throw fail("A string holds half of a UTF-16 surrogate pair.");
		i++;
		return out;
	};
	const readValue = (depth: number): unknown => {
		skipSpace();
		const c = text[i];
		if (c === "{" || c === "[") {
			if (depth === MAX_JSON_DEPTH) throw fail(`The file nests deeper than ${MAX_JSON_DEPTH} levels.`);
			i++;
			return c === "{" ? readObject(depth + 1) : readArray(depth + 1);
		}
		if (c === '"') return readString();
		for (const [word, literal] of JSON_LITERALS) {
			if (text.startsWith(word, i)) {
				i += word.length;
				return literal;
			}
		}
		JSON_NUMBER.lastIndex = i;
		const number = JSON_NUMBER.exec(text);
		if (!number) throw fail(i < text.length ? "Expected a value." : "The file ends where a value was expected.");
		const n = Number(number[0]);
		if (!Number.isFinite(n)) throw fail("A number is too large.");
		i = JSON_NUMBER.lastIndex;
		return n;
	};
	const readObject = (depth: number): Record<string, unknown> => {
		const out: Record<string, unknown> = Object.create(null);
		skipSpace();
		if (text[i] === "}") {
			i++;
			return out;
		}
		for (;;) {
			skipSpace();
			if (text[i] !== '"') throw fail("Expected a key in double quotes.");
			const keyAt = i;
			const key = readString();
			if (key in out) {
				i = keyAt;
				throw fail(`The key ${JSON.stringify(key)} appears twice.`);
			}
			skipSpace();
			if (text[i] !== ":") throw fail("Expected ':' after a key.");
			i++;
			out[key] = readValue(depth);
			skipSpace();
			if (text[i] === "}") {
				i++;
				return out;
			}
			if (text[i] !== ",") throw fail("Expected ',' or '}'.");
			i++;
			skipSpace();
			if (text[i] === "}") throw fail("A comma before '}': this file allows no trailing commas.");
		}
	};
	const readArray = (depth: number): unknown[] => {
		const out: unknown[] = [];
		skipSpace();
		if (text[i] === "]") {
			i++;
			return out;
		}
		for (;;) {
			out.push(readValue(depth));
			skipSpace();
			if (text[i] === "]") {
				i++;
				return out;
			}
			if (text[i] !== ",") throw fail("Expected ',' or ']'.");
			i++;
			skipSpace();
			if (text[i] === "]") throw fail("A comma before ']': this file allows no trailing commas.");
		}
	};
	const root = readValue(0);
	skipSpace();
	if (i < text.length) throw fail("Text follows the value.");
	return root;
}

function isValidHealthPath(field: string): boolean {
	if (field.length < 1 || field.length > 256 || !field.startsWith("/")) return false;
	for (const ch of field) {
		const code = ch.codePointAt(0) as number;
		if (code <= 0x20 || code === 0x7f || /\s/.test(ch)) return false;
	}
	return true;
}

function parseSite(value: unknown, at: string, refuse: Refuse): CodeSiteRecipe | null {
	if (!isObject(value)) {
		refuse(at, "WRONG_TYPE", "Must be an object.");
		return null;
	}
	let folder: string | null = null;
	let name: string | null = null;
	let title: string | null = null;
	let kind: CodeSiteKind | undefined;
	let dockerfile: string | null | undefined;
	let port: number | undefined;
	let healthPath: string | undefined;
	let idleTimeoutSec: number | undefined;
	let memoryMb: number | undefined;
	let vcpuLimit: number | undefined;
	let spaFallback: string | null | undefined;
	for (const [key, field] of Object.entries(value)) {
		const fieldAt = pointer(at, key);
		if (key === "folder" || key === "name" || key === "title") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (key === "folder") {
				if (isCodeSiteFolderValid(field)) folder = field;
				else
					refuse(
						fieldAt,
						"INVALID_PATH",
						'Must be "." or a folder of the repository: a relative path without . or .. parts, at most 300 bytes.',
					);
			} else if (key === "name") {
				const refused = codeSiteNameRefusalText(field);
				if (refused === null) name = field;
				else refuse(fieldAt, "INVALID_VALUE", refused);
			} else if (field.startsWith(" ") || field.endsWith(" "))
				refuse(fieldAt, "SITE_TITLE", "Must not start or end with a space.");
			else if (isCodeSiteTitleValid(field)) title = field;
			else refuse(fieldAt, "INVALID_VALUE", "Must be 1 to 120 characters on one line.");
		} else if (key === "kind") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (field === "static" || field === "server" || field === "hybrid") kind = field;
			else refuse(fieldAt, "INVALID_VALUE", 'Must be "static", "server", or "hybrid".');
		} else if (key === "dockerfile") {
			if (field === null) dockerfile = null;
			else if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (field !== "." && isCodeSiteFolderValid(field)) dockerfile = field;
			else refuse(fieldAt, "INVALID_PATH", "Must be a relative file path without . or .. parts, at most 300 bytes.");
		} else if (key === "port") {
			if (typeof field !== "number" || !Number.isInteger(field) || field < 1 || field > 65535)
				refuse(fieldAt, "INVALID_VALUE", "Must be a whole port number from 1 to 65535.");
			else port = field;
		} else if (key === "healthPath") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (!isValidHealthPath(field))
				refuse(fieldAt, "INVALID_VALUE", "Must start with / and contain 1 to 256 non-space characters.");
			else healthPath = field;
		} else if (key === "idleTimeoutSec") {
			if (typeof field !== "number" || !Number.isInteger(field) || field < 0 || field > 86400)
				refuse(fieldAt, "INVALID_VALUE", "Must be a whole number of seconds from 0 to 86400.");
			else idleTimeoutSec = field;
		} else if (key === "memoryMb") {
			if (typeof field !== "number" || !Number.isInteger(field) || field < 64 || field > 8192)
				refuse(fieldAt, "INVALID_VALUE", "Must be a whole number of megabytes from 64 to 8192.");
			else memoryMb = field;
		} else if (key === "vcpuLimit") {
			if (typeof field !== "number" || !Number.isFinite(field) || field < 0.25 || field > 8)
				refuse(fieldAt, "INVALID_VALUE", "Must be a number from 0.25 to 8.");
			else vcpuLimit = field;
		} else if (key === "spaFallback") {
			if (field === null) spaFallback = null;
			else if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (field !== "." && field.length <= 512 && isCodeSiteFolderValid(field)) spaFallback = field;
			else refuse(fieldAt, "INVALID_PATH", "Must be a relative path such as index.html without . or .. parts.");
		} else {
			refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
		}
	}
	const effectiveKind = kind ?? "static";
	if (!("folder" in value)) {
		if (effectiveKind === "server") folder = ".";
		else refuse(at, "MISSING_KEY", "Needs folder.");
	}
	if (folder === null) return null;
	return {
		folder,
		name,
		title,
		...(kind !== undefined ? { kind } : {}),
		...(dockerfile !== undefined ? { dockerfile } : {}),
		...(port !== undefined ? { port } : {}),
		...(healthPath !== undefined ? { healthPath } : {}),
		...(idleTimeoutSec !== undefined ? { idleTimeoutSec } : {}),
		...(memoryMb !== undefined ? { memoryMb } : {}),
		...(vcpuLimit !== undefined ? { vcpuLimit } : {}),
		...(spaFallback !== undefined ? { spaFallback } : {}),
	};
}

function parsePreview(value: unknown, at: string, refuse: Refuse): CodePreviewRecipe | undefined {
	if (!isObject(value)) {
		refuse(at, "WRONG_TYPE", "Must be an object.");
		return undefined;
	}
	let run: string | null = null;
	let folder: string | null = null;
	let cwd = ".";
	let timeoutSeconds = PREVIEW_DEFAULT_SECONDS;
	for (const [key, field] of Object.entries(value)) {
		const fieldAt = pointer(at, key);
		if (key === "run") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (field.trim() === "" || utf8Bytes(field) > MAX_CODE_CHECK_RUN_BYTES || field.includes("\0"))
				refuse(
					fieldAt,
					"INVALID_VALUE",
					`Must be 1 to ${MAX_CODE_CHECK_RUN_BYTES} bytes, without a NUL character.`,
				);
			else run = field;
		} else if (key === "folder") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (isCodeSiteFolderValid(field)) folder = field;
			else
				refuse(
					fieldAt,
					"INVALID_PATH",
					'Must be "." or a folder of the repository: a relative path without . or .. parts, at most 300 bytes.',
				);
		} else if (key === "cwd") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (!isCodeCheckFolder(field))
				refuse(
					fieldAt,
					"INVALID_PATH",
					`Must be a folder of the repository: a relative path without . or .. parts, at most ${MAX_CODE_CHECK_CWD_BYTES} bytes.`,
				);
			else cwd = field;
		} else if (key === "timeoutSeconds") {
			if (
				typeof field !== "number" ||
				!Number.isInteger(field) ||
				field < CODE_CHECK_MIN_SECONDS ||
				field > PREVIEW_MAX_SECONDS
			)
				refuse(
					fieldAt,
					"INVALID_VALUE",
					`Must be a whole number of seconds from ${CODE_CHECK_MIN_SECONDS} to ${PREVIEW_MAX_SECONDS}.`,
				);
			else timeoutSeconds = field;
		} else {
			refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
		}
	}
	if (!("run" in value)) refuse(at, "MISSING_KEY", "Needs run.");
	return run === null ? undefined : { run, folder, cwd, timeoutSeconds };
}

function parseCaches(value: unknown, at: string, refuse: Refuse): CodeCheckCache[] {
	if (!Array.isArray(value)) {
		refuse(at, "WRONG_TYPE", "Must be an array.");
		return [];
	}
	if (value.length > MAX_CHECK_CACHES) {
		refuse(at, "INVALID_VALUE", `Must hold at most ${MAX_CHECK_CACHES} caches.`);
	}
	const caches: CodeCheckCache[] = [];
	const seenKeys = new Set<string>();
	for (const [index, item] of value.entries()) {
		const itemAt = pointer(at, index);
		if (!isObject(item)) {
			refuse(itemAt, "WRONG_TYPE", "Must be an object.");
			continue;
		}
		let key: string | null = null;
		let paths: string[] | null = null;
		let restoreKeys: string[] | undefined;
		for (const [fieldKey, field] of Object.entries(item)) {
			const fieldAt = pointer(itemAt, fieldKey);
			if (fieldKey === "key") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (!isCacheKeyTemplateValid(field))
					refuse(
						fieldAt,
						"INVALID_VALUE",
						`Must be 1 to ${MAX_CHECK_CACHE_KEY_BYTES} bytes of letters, digits, '.', '_', ':', '-', or hash('<file>').`,
					);
				else if (seenKeys.has(field)) refuse(fieldAt, "DUPLICATE", `The cache key "${field}" is given twice.`);
				else {
					seenKeys.add(field);
					key = field;
				}
			} else if (fieldKey === "paths") {
				if (!Array.isArray(field)) refuse(fieldAt, "WRONG_TYPE", "Must be an array.");
				else {
					if (field.length < 1 || field.length > MAX_CHECK_CACHE_PATHS)
						refuse(fieldAt, "INVALID_VALUE", `Must hold 1 to ${MAX_CHECK_CACHE_PATHS} paths.`);
					const list: string[] = [];
					const seen = new Set<string>();
					for (const [pathIndex, entry] of field.entries()) {
						const pathAt = pointer(fieldAt, pathIndex);
						if (typeof entry !== "string") refuse(pathAt, "WRONG_TYPE", "Must be a string.");
						else if (!isWorkspaceRelativePath(entry, false) || entry.split("/")[0]?.toLowerCase() === ".qorpera")
							refuse(
								pathAt,
								"INVALID_PATH",
								"Must be a relative path inside the repository without '.', '..', '.git', '.qorpera' or glob characters.",
							);
						else if (seen.has(entry)) refuse(pathAt, "DUPLICATE", `The path "${entry}" is listed twice.`);
						else {
							seen.add(entry);
							list.push(entry);
						}
					}
					paths = list;
				}
			} else if (fieldKey === "restoreKeys") {
				if (!Array.isArray(field)) refuse(fieldAt, "WRONG_TYPE", "Must be an array.");
				else {
					if (field.length > MAX_CHECK_CACHE_RESTORE_KEYS)
						refuse(fieldAt, "INVALID_VALUE", `Must hold at most ${MAX_CHECK_CACHE_RESTORE_KEYS} restore keys.`);
					const list: string[] = [];
					const seen = new Set<string>();
					for (const [rkIndex, entry] of field.entries()) {
						const rkAt = pointer(fieldAt, rkIndex);
						if (typeof entry !== "string") refuse(rkAt, "WRONG_TYPE", "Must be a string.");
						else if (!isCacheKeyTemplateValid(entry))
							refuse(
								rkAt,
								"INVALID_VALUE",
								`Must be 1 to ${MAX_CHECK_CACHE_KEY_BYTES} bytes of letters, digits, '.', '_', ':', '-', or hash('<file>').`,
							);
						else if (seen.has(entry)) refuse(rkAt, "DUPLICATE", `The restore key "${entry}" is listed twice.`);
						else {
							seen.add(entry);
							list.push(entry);
						}
					}
					restoreKeys = list;
				}
			} else refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
		}
		if (!("key" in item)) refuse(itemAt, "MISSING_KEY", "Needs key.");
		if (!("paths" in item)) refuse(itemAt, "MISSING_KEY", "Needs paths.");
		if (key !== null && paths !== null) {
			caches.push(restoreKeys === undefined ? { key, paths } : { key, paths, restoreKeys });
		}
	}
	return caches;
}

function parseGlobList(value: unknown, at: string, refuse: Refuse): string[] | undefined {
	if (!Array.isArray(value)) {
		refuse(at, "WRONG_TYPE", "Must be an array.");
		return undefined;
	}
	if (value.length < 1 || value.length > MAX_CHECK_PATHS) {
		refuse(at, "INVALID_VALUE", `Must hold 1 to ${MAX_CHECK_PATHS} path patterns.`);
	}
	const list: string[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const entryAt = pointer(at, index);
		if (typeof entry !== "string") refuse(entryAt, "WRONG_TYPE", "Must be a string.");
		else if (!isWorkspaceRelativePath(entry, true))
			refuse(
				entryAt,
				"INVALID_PATH",
				"Must be a relative repository path pattern without '.', '..', '.git' or '\\'.",
			);
		else if (seen.has(entry)) refuse(entryAt, "DUPLICATE", `The pattern "${entry}" is listed twice.`);
		else {
			seen.add(entry);
			list.push(entry);
		}
	}
	return list;
}

function parseEnvMap(value: unknown, at: string, refuse: Refuse): Record<string, string> | undefined {
	if (!isObject(value)) {
		refuse(at, "WRONG_TYPE", "Must be an object.");
		return undefined;
	}
	const entries = Object.entries(value);
	if (entries.length > MAX_CHECK_ENV_ENTRIES) {
		refuse(at, "INVALID_VALUE", `Must hold at most ${MAX_CHECK_ENV_ENTRIES} environment variables.`);
	}
	const out: Record<string, string> = {};
	for (const [key, field] of entries) {
		const fieldAt = pointer(at, key);
		if (!isCodeCheckEnvNameAllowed(key)) {
			refuse(
				fieldAt,
				"INVALID_VALUE",
				"Must be a valid non-reserved environment variable name (not QORPERA_*, GIT_*, LD_*, PATH, HOME, CI or host/cache variables).",
			);
			continue;
		}
		if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
		else if (field.includes("\0") || utf8Bytes(field) > MAX_CHECK_ENV_VALUE_BYTES)
			refuse(fieldAt, "INVALID_VALUE", `Must be at most ${MAX_CHECK_ENV_VALUE_BYTES} bytes without NUL.`);
		else out[key] = field;
	}
	return out;
}

function parseSecretsList(value: unknown, at: string, refuse: Refuse): string[] | undefined {
	if (!Array.isArray(value)) {
		refuse(at, "WRONG_TYPE", "Must be an array.");
		return undefined;
	}
	if (value.length > MAX_CHECK_SECRETS) {
		refuse(at, "INVALID_VALUE", `Must hold at most ${MAX_CHECK_SECRETS} secret names.`);
	}
	const list: string[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const entryAt = pointer(at, index);
		if (typeof entry !== "string") refuse(entryAt, "WRONG_TYPE", "Must be a string.");
		else if (!isCodeCheckSecretNameAllowed(entry))
			refuse(entryAt, "INVALID_VALUE", "Must be a valid non-QORPERA_ secret variable name.");
		else if (seen.has(entry)) refuse(entryAt, "DUPLICATE", `The secret "${entry}" is listed twice.`);
		else {
			seen.add(entry);
			list.push(entry);
		}
	}
	return list;
}

function parseArtifacts(value: unknown, at: string, refuse: Refuse): CodeCheckArtifacts | undefined {
	if (!isObject(value)) {
		refuse(at, "WRONG_TYPE", "Must be an object.");
		return undefined;
	}
	let paths: string[] | null = null;
	let when: CodeCheckArtifactWhen = "on_failure";
	let format: CodeCheckArtifactFormat = "raw";
	for (const [key, field] of Object.entries(value)) {
		const fieldAt = pointer(at, key);
		if (key === "paths") {
			if (!Array.isArray(field)) refuse(fieldAt, "WRONG_TYPE", "Must be an array.");
			else {
				if (field.length < 1 || field.length > MAX_CHECK_ARTIFACT_PATHS)
					refuse(fieldAt, "INVALID_VALUE", `Must hold 1 to ${MAX_CHECK_ARTIFACT_PATHS} artifact paths.`);
				const list: string[] = [];
				const seen = new Set<string>();
				for (const [pathIndex, entry] of field.entries()) {
					const pathAt = pointer(fieldAt, pathIndex);
					if (typeof entry !== "string") refuse(pathAt, "WRONG_TYPE", "Must be a string.");
					else if (!isWorkspaceRelativePath(entry, true))
						refuse(
							pathAt,
							"INVALID_PATH",
							"Must be a relative path pattern inside the repository without '.', '..', '.git' or '\\'.",
						);
					else if (seen.has(entry)) refuse(pathAt, "DUPLICATE", `The artifact path "${entry}" is listed twice.`);
					else {
						seen.add(entry);
						list.push(entry);
					}
				}
				paths = list;
			}
		} else if (key === "when") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (field !== "on_failure" && field !== "always")
				refuse(fieldAt, "INVALID_VALUE", 'Must be "on_failure" or "always".');
			else when = field;
		} else if (key === "format") {
			if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
			else if (field !== "junit" && field !== "tap" && field !== "vitest-json" && field !== "raw")
				refuse(fieldAt, "INVALID_VALUE", 'Must be "junit", "tap", "vitest-json" or "raw".');
			else format = field;
		} else refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
	}
	if (!("paths" in value)) refuse(at, "MISSING_KEY", "Needs paths.");
	return paths === null ? undefined : { paths, when, format };
}

function findCheckCycle(edges: ReadonlyMap<string, readonly string[]>): string[] | null {
	const state = new Map<string, 1 | 2>();
	const stack: string[] = [];
	const visit = (node: string): string[] | null => {
		state.set(node, 1);
		stack.push(node);
		for (const dep of edges.get(node) ?? []) {
			const seen = state.get(dep);
			if (seen === 1) return [...stack.slice(stack.indexOf(dep)), dep];
			if (seen === undefined) {
				const cycle = visit(dep);
				if (cycle !== null) return cycle;
			}
		}
		stack.pop();
		state.set(node, 2);
		return null;
	};
	for (const name of edges.keys()) {
		if (state.has(name)) continue;
		const cycle = visit(name);
		if (cycle !== null) return cycle;
	}
	return null;
}

function computeCriticalPathFromGraph(
	durations: ReadonlyMap<string, number>,
	edges: ReadonlyMap<string, readonly string[]>,
): number {
	const memo = new Map<string, number>();
	const visit = (node: string): number => {
		const cached = memo.get(node);
		if (cached !== undefined) return cached;
		let depMax = 0;
		for (const dep of edges.get(node) ?? []) {
			depMax = Math.max(depMax, visit(dep));
		}
		const total = (durations.get(node) ?? 0) + depMax;
		memo.set(node, total);
		return total;
	};
	let longest = 0;
	for (const node of durations.keys()) {
		longest = Math.max(longest, visit(node));
	}
	return longest;
}

function parseChecksArray(
	value: unknown,
	at: string,
	refuse: Refuse,
): { checks: CodeCheck[]; criticalPathSeconds: number; totalTimeoutSeconds: number } {
	if (!Array.isArray(value)) {
		refuse(at, "WRONG_TYPE", "Must be an array.");
		return { checks: [], criticalPathSeconds: 0, totalTimeoutSeconds: 0 };
	}
	if (value.length < 1 || value.length > MAX_CODE_CHECKS)
		refuse(at, "INVALID_VALUE", `Must hold 1 to ${MAX_CODE_CHECKS} checks.`);
	const checks: CodeCheck[] = [];
	const parsed: {
		name: string | null;
		effectiveSeconds: number;
		hasNeeds: boolean;
		needs: readonly { name: string; at: string }[];
	}[] = [];
	const names = new Set<string>();
	let total = 0;
	for (const [index, item] of value.entries()) {
		const itemAt = pointer(at, index);
		if (!isObject(item)) {
			refuse(itemAt, "WRONG_TYPE", "Must be an object.");
			continue;
		}
		let name: string | null = null;
		let run: string | null = null;
		let timeoutSeconds = CODE_CHECK_DEFAULT_SECONDS;
		let cwd = ".";
		let needs: string[] | undefined;
		let exclusive: boolean | undefined;
		let retries: number | undefined;
		let paths: string[] | undefined;
		let pathsIgnore: string[] | undefined;
		let alwaysRun: boolean | undefined;
		let env: Record<string, string> | undefined;
		let secrets: string[] | undefined;
		let artifacts: CodeCheckArtifacts | undefined;
		const needsEntries: { name: string; at: string }[] = [];
		for (const [key, field] of Object.entries(item)) {
			const fieldAt = pointer(itemAt, key);
			if (key === "name") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (!CODE_CHECK_NAME_PATTERN.test(field))
					refuse(
						fieldAt,
						"INVALID_VALUE",
						"Must be 1 to 40 of a-z, 0-9, '.', '_' and '-', starting with a letter or a digit.",
					);
				else if (names.has(field)) refuse(fieldAt, "DUPLICATE", `The name "${field}" is given twice.`);
				else {
					names.add(field);
					name = field;
				}
			} else if (key === "run") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (field === "" || utf8Bytes(field) > MAX_CODE_CHECK_RUN_BYTES || field.includes("\0"))
					refuse(
						fieldAt,
						"INVALID_VALUE",
						`Must be 1 to ${MAX_CODE_CHECK_RUN_BYTES} bytes, without a NUL character.`,
					);
				else run = field;
			} else if (key === "timeoutSeconds") {
				if (
					typeof field !== "number" ||
					!Number.isInteger(field) ||
					field < CODE_CHECK_MIN_SECONDS ||
					field > CODE_CHECK_MAX_SECONDS
				)
					refuse(
						fieldAt,
						"INVALID_VALUE",
						`Must be a whole number of seconds from ${CODE_CHECK_MIN_SECONDS} to ${CODE_CHECK_MAX_SECONDS}.`,
					);
				else timeoutSeconds = field;
			} else if (key === "cwd") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (!isCodeCheckFolder(field))
					refuse(
						fieldAt,
						"INVALID_PATH",
						`Must be a folder of the repository: a relative path without . or .. parts, at most ${MAX_CODE_CHECK_CWD_BYTES} bytes.`,
					);
				else cwd = field;
			} else if (key === "needs") {
				if (!Array.isArray(field)) refuse(fieldAt, "WRONG_TYPE", "Must be an array.");
				else {
					const listed: string[] = [];
					const seen = new Set<string>();
					for (const [depIndex, dep] of field.entries()) {
						const depAt = pointer(fieldAt, depIndex);
						if (typeof dep !== "string") refuse(depAt, "WRONG_TYPE", "Must be a string.");
						else if (!CODE_CHECK_NAME_PATTERN.test(dep))
							refuse(
								depAt,
								"INVALID_VALUE",
								"Must be 1 to 40 of a-z, 0-9, '.', '_' and '-', starting with a letter or a digit.",
							);
						else if (seen.has(dep)) refuse(depAt, "DUPLICATE", `The check "${dep}" is listed twice in needs.`);
						else {
							seen.add(dep);
							listed.push(dep);
							needsEntries.push({ name: dep, at: depAt });
						}
					}
					needs = listed;
				}
			} else if (key === "exclusive") {
				if (typeof field !== "boolean") refuse(fieldAt, "WRONG_TYPE", "Must be a boolean.");
				else exclusive = field;
			} else if (key === "retries") {
				if (typeof field !== "number") refuse(fieldAt, "WRONG_TYPE", "Must be an integer from 0 to 2.");
				else if (!Number.isInteger(field) || field < 0 || field > MAX_CHECK_RETRIES)
					refuse(fieldAt, "INVALID_VALUE", `Must be a whole number from 0 to ${MAX_CHECK_RETRIES}.`);
				else retries = field;
			} else if (key === "paths") {
				paths = parseGlobList(field, fieldAt, refuse);
			} else if (key === "pathsIgnore") {
				pathsIgnore = parseGlobList(field, fieldAt, refuse);
			} else if (key === "alwaysRun") {
				if (typeof field !== "boolean") refuse(fieldAt, "WRONG_TYPE", "Must be a boolean.");
				else alwaysRun = field;
			} else if (key === "env") {
				env = parseEnvMap(field, fieldAt, refuse);
			} else if (key === "secrets") {
				secrets = parseSecretsList(field, fieldAt, refuse);
			} else if (key === "artifacts") {
				artifacts = parseArtifacts(field, fieldAt, refuse);
			} else refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
		}
		if (!("name" in item)) refuse(itemAt, "MISSING_KEY", "Needs name.");
		if (!("run" in item)) refuse(itemAt, "MISSING_KEY", "Needs run.");
		const effectiveSeconds = timeoutSeconds * (1 + (retries ?? 0));
		total += effectiveSeconds;
		parsed.push({ name, effectiveSeconds, hasNeeds: "needs" in item, needs: needsEntries });
		if (name !== null && run !== null) {
			checks.push({
				name,
				run,
				timeoutSeconds,
				cwd,
				...(needs !== undefined ? { needs } : {}),
				...(exclusive !== undefined ? { exclusive } : {}),
				...(retries !== undefined ? { retries } : {}),
				...(paths !== undefined ? { paths } : {}),
				...(pathsIgnore !== undefined ? { pathsIgnore } : {}),
				...(alwaysRun !== undefined ? { alwaysRun } : {}),
				...(env !== undefined ? { env } : {}),
				...(secrets !== undefined ? { secrets } : {}),
				...(artifacts !== undefined ? { artifacts } : {}),
			});
		}
	}
	const edges = new Map<string, string[]>();
	const durations = new Map<string, number>();
	for (const entry of parsed) {
		const validDeps: string[] = [];
		for (const dep of entry.needs) {
			if (entry.name !== null && dep.name === entry.name)
				refuse(dep.at, "INVALID_VALUE", `The check "${dep.name}" cannot depend on itself.`);
			else if (!names.has(dep.name)) refuse(dep.at, "INVALID_VALUE", `No check is named "${dep.name}".`);
			else validDeps.push(dep.name);
		}
		if (entry.name !== null) {
			edges.set(entry.name, validDeps);
			durations.set(entry.name, entry.effectiveSeconds);
		}
	}
	const cycle = findCheckCycle(edges);
	if (cycle !== null) refuse(at, "CYCLE", `The checks form a dependency cycle: ${cycle.join(" -> ")}.`);
	const isDag = parsed.some((entry) => entry.hasNeeds);
	const criticalPathSeconds = !isDag || cycle !== null ? total : computeCriticalPathFromGraph(durations, edges);
	if (criticalPathSeconds > CODE_CHECKS_CRITICAL_PATH_SECONDS) {
		refuse(
			at,
			"TOO_LONG",
			isDag
				? `The DAG critical-path time limit is ${criticalPathSeconds} s; checks may take at most ${CODE_CHECKS_CRITICAL_PATH_SECONDS} s.`
				: `The time limits add up to ${total} s; all checks together may take at most ${CODE_CHECKS_CRITICAL_PATH_SECONDS} s.`,
		);
	} else if (total > CODE_CHECKS_TOTAL_CPU_SECONDS) {
		refuse(
			at,
			"TOO_LONG",
			`The time limits add up to ${total} s; total check CPU time may be at most ${CODE_CHECKS_TOTAL_CPU_SECONDS} s.`,
		);
	}
	return { checks, criticalPathSeconds, totalTimeoutSeconds: total };
}

function parseRootText(source: string, refuse: Refuse): ParsedCodeChecksOk | null {
	let root: unknown;
	try {
		root = parseChecksJson(source);
	} catch (error) {
		if (!(error instanceof ChecksJsonSyntaxError)) throw error;
		const before = source.slice(0, error.index);
		const line = before.split("\n").length;
		const column = error.index - before.lastIndexOf("\n");
		refuse("", "SYNTAX", `Line ${line}, column ${column}: ${error.message}`);
		return null;
	}
	if (!isObject(root)) {
		refuse("", "WRONG_TYPE", "The checks file must hold one JSON object.");
		return null;
	}
	let parsedChecks: { checks: CodeCheck[]; criticalPathSeconds: number; totalTimeoutSeconds: number } = {
		checks: [],
		criticalPathSeconds: 0,
		totalTimeoutSeconds: 0,
	};
	let site: CodeSiteRecipe | null = null;
	let preview: CodePreviewRecipe | undefined;
	let surfaceGate: CodeSurfaceGate | undefined;
	let maxParallel: number | undefined;
	let failFast: boolean | undefined;
	let caches: CodeCheckCache[] | undefined;
	for (const [key, value] of Object.entries(root)) {
		const at = pointer("", key);
		if (key === "$schema") {
			if (typeof value !== "string") refuse(at, "WRONG_TYPE", "Must be a string.");
		} else if (key === "checks") parsedChecks = parseChecksArray(value, at, refuse);
		else if (key === "site") site = parseSite(value, at, refuse);
		else if (key === "preview") preview = parsePreview(value, at, refuse);
		else if (key === "surfaceGate") {
			if (typeof value !== "string") refuse(at, "WRONG_TYPE", "Must be a string.");
			else if (value === "none" || value === "stage") surfaceGate = value;
			else refuse(at, "INVALID_VALUE", 'Must be "none" or "stage".');
		} else if (key === "maxParallel") {
			if (typeof value !== "number")
				refuse(at, "WRONG_TYPE", `Must be an integer from ${MIN_PARALLEL_CHECKS} to ${MAX_PARALLEL_CHECKS_LIMIT}.`);
			else if (!Number.isInteger(value) || value < MIN_PARALLEL_CHECKS || value > MAX_PARALLEL_CHECKS_LIMIT)
				refuse(
					at,
					"INVALID_VALUE",
					`Must be a whole number from ${MIN_PARALLEL_CHECKS} to ${MAX_PARALLEL_CHECKS_LIMIT}.`,
				);
			else maxParallel = value;
		} else if (key === "failFast") {
			if (typeof value !== "boolean") refuse(at, "WRONG_TYPE", "Must be a boolean.");
			else failFast = value;
		} else if (key === "caches") caches = parseCaches(value, at, refuse);
		else refuse(at, "UNKNOWN_KEY", UNKNOWN_KEY_MESSAGE);
	}
	if (!("checks" in root)) refuse("", "MISSING_KEY", "Needs checks.");
	return {
		ok: true,
		checks: parsedChecks.checks,
		criticalPathSeconds: parsedChecks.criticalPathSeconds,
		totalTimeoutSeconds: parsedChecks.totalTimeoutSeconds,
		mode: parsedChecks.checks.some((check) => check.needs !== undefined) ? "dag" : "sequential",
		site,
		...(preview !== undefined ? { preview } : {}),
		...(surfaceGate !== undefined ? { surfaceGate } : {}),
		...(maxParallel !== undefined ? { maxParallel } : {}),
		...(failFast !== undefined ? { failFast } : {}),
		...(caches !== undefined ? { caches } : {}),
	};
}

export function parseCodeChecksBytes(raw: Uint8Array): ParsedCodeChecks {
	const problems: CodeChecksProblem[] = [];
	const refuse: Refuse = (at, code, message) => {
		problems.push({ at, code, message });
	};
	if (raw.byteLength > MAX_CODE_CHECKS_FILE_BYTES) {
		refuse("", "TOO_LARGE", "The checks file is over 16 KiB.");
		return { ok: false, problems };
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
	} catch {
		refuse("", "NOT_UTF8", "The checks file is not UTF-8 text.");
		return { ok: false, problems };
	}
	const parsed = parseRootText(text, refuse);
	if (problems.length > 0 || parsed === null) return { ok: false, problems };
	return parsed;
}

export function parseCodeChecksText(text: string): ParsedCodeChecks {
	const problems: CodeChecksProblem[] = [];
	const refuse: Refuse = (at, code, message) => {
		problems.push({ at, code, message });
	};
	if (utf8Bytes(text) > MAX_CODE_CHECKS_FILE_BYTES) {
		refuse("", "TOO_LARGE", "The checks file is over 16 KiB.");
		return { ok: false, problems };
	}
	const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const parsed = parseRootText(source, refuse);
	if (problems.length > 0 || parsed === null) return { ok: false, problems };
	return parsed;
}

export function codeChecksPlan(
	checks: readonly CodeCheck[],
	drill?: Pick<CodeCheck, "name" | "run" | "timeoutSeconds" | "cwd">,
): readonly (readonly number[])[] | null {
	if (checks.length === 0) return [];
	if (!checks.some((check) => check.needs !== undefined))
		return checks.map((_, index) => (index === 0 ? [] : [index - 1]));
	const last = checks.at(-1);
	const earlier = checks.slice(0, -1);
	const hasTrailingDrill =
		drill !== undefined &&
		last !== undefined &&
		last.needs === undefined &&
		last.name === drill.name &&
		last.run === drill.run &&
		last.timeoutSeconds === drill.timeoutSeconds &&
		last.cwd === drill.cwd &&
		(earlier.some((check) => check.name === drill.name) ||
			!earlier.some((check) => check.needs?.includes(drill.name)));
	const repoCount = hasTrailingDrill ? checks.length - 1 : checks.length;
	const indexByName = new Map<string, number>();
	for (let index = 0; index < repoCount; index++) {
		const check = checks[index] as CodeCheck;
		if (indexByName.has(check.name)) return null;
		indexByName.set(check.name, index);
	}
	const dependencies: number[][] = [];
	for (let index = 0; index < repoCount; index++) {
		const check = checks[index] as CodeCheck;
		const seen = new Set<number>();
		const deps: number[] = [];
		for (const depName of check.needs ?? []) {
			const depIndex = indexByName.get(depName);
			if (depIndex === undefined || depIndex === index) return null;
			if (!seen.has(depIndex)) {
				seen.add(depIndex);
				deps.push(depIndex);
			}
		}
		dependencies.push(deps);
	}
	if (hasTrailingDrill) dependencies.push(Array.from({ length: repoCount }, (_, index) => index));
	const indegree = dependencies.map((deps) => deps.length);
	const dependents: number[][] = Array.from({ length: checks.length }, () => []);
	for (let index = 0; index < dependencies.length; index++) {
		for (const dep of dependencies[index] as readonly number[]) dependents[dep]?.push(index);
	}
	const ready: number[] = [];
	for (let index = 0; index < indegree.length; index++) if (indegree[index] === 0) ready.push(index);
	let visited = 0;
	while (ready.length > 0) {
		const current = ready.shift() as number;
		visited++;
		for (const next of dependents[current] as readonly number[]) {
			indegree[next] = (indegree[next] as number) - 1;
			if (indegree[next] === 0) ready.push(next);
		}
	}
	return visited === checks.length ? dependencies : null;
}

export function codeChecksWallBudget(
	checks: readonly CodeCheck[],
	dependencies: readonly (readonly number[])[],
	maxParallel: number,
): { readonly wallSeconds: number; readonly criticalPathNodes: number } {
	if (checks.length === 0) return { wallSeconds: 0, criticalPathNodes: 0 };
	const parallelism = Math.max(1, Math.min(MAX_PARALLEL_CHECKS_LIMIT, Math.trunc(maxParallel)));
	const durations = checks.map((check) => check.timeoutSeconds * (1 + (check.retries ?? 0)));
	const memoSeconds = new Array<number>(checks.length).fill(-1);
	const memoNodes = new Array<number>(checks.length).fill(-1);
	const visit = (index: number): { seconds: number; nodes: number } => {
		if (memoSeconds[index] >= 0) return { seconds: memoSeconds[index], nodes: memoNodes[index] };
		let bestSeconds = 0;
		let bestNodes = 0;
		for (const dep of dependencies[index] ?? []) {
			const child = visit(dep);
			if (child.seconds > bestSeconds || (child.seconds === bestSeconds && child.nodes > bestNodes)) {
				bestSeconds = child.seconds;
				bestNodes = child.nodes;
			}
		}
		memoSeconds[index] = bestSeconds + (durations[index] as number);
		memoNodes[index] = bestNodes + (1 + (checks[index]?.retries ?? 0));
		return { seconds: memoSeconds[index], nodes: memoNodes[index] };
	};
	let criticalSeconds = 0;
	let criticalNodes = 0;
	let nonExclusiveTotal = 0;
	let exclusiveTotal = 0;
	for (let index = 0; index < checks.length; index++) {
		const res = visit(index);
		if (res.seconds > criticalSeconds || (res.seconds === criticalSeconds && res.nodes > criticalNodes)) {
			criticalSeconds = res.seconds;
			criticalNodes = res.nodes;
		}
		if (checks[index]?.exclusive) exclusiveTotal += durations[index] as number;
		else nonExclusiveTotal += durations[index] as number;
	}
	const isDag = checks.some((check) => check.needs !== undefined);
	if (!isDag) {
		return {
			wallSeconds: durations.reduce((sum, value) => sum + value, 0),
			criticalPathNodes: checks.reduce((sum, check) => sum + 1 + (check.retries ?? 0), 0),
		};
	}
	const remainingDeps = dependencies.map((deps) => deps.length);
	const dependents: number[][] = Array.from({ length: checks.length }, () => []);
	for (let index = 0; index < checks.length; index++) {
		for (const dep of dependencies[index] ?? []) dependents[dep]?.push(index);
	}
	const ready: number[] = [];
	const finishAt = new Array<number>(checks.length).fill(0);
	for (let index = 0; index < checks.length; index++) {
		if (remainingDeps[index] === 0) ready.push(index);
	}
	const active: { index: number; end: number; exclusive: boolean }[] = [];
	let now = 0;
	while (ready.length > 0 || active.length > 0) {
		ready.sort((a, b) => a - b);
		let launched = false;
		if (!active.some((item) => item.exclusive)) {
			for (let pos = 0; pos < ready.length; ) {
				const candidate = ready[pos] as number;
				const isExclusive = checks[candidate]?.exclusive === true;
				if (isExclusive) {
					if (active.length === 0) {
						ready.splice(pos, 1);
						active.push({ index: candidate, end: now + (durations[candidate] as number), exclusive: true });
						launched = true;
						break;
					}
					pos++;
					continue;
				}
				if (active.length >= parallelism) break;
				ready.splice(pos, 1);
				active.push({ index: candidate, end: now + (durations[candidate] as number), exclusive: false });
				launched = true;
			}
		}
		if (active.length === 0) {
			if (!launched) break;
			continue;
		}
		let earliest = active[0]!.end;
		for (const item of active) if (item.end < earliest) earliest = item.end;
		now = earliest;
		for (let i = active.length - 1; i >= 0; i--) {
			const item = active[i]!;
			if (item.end <= now) {
				active.splice(i, 1);
				finishAt[item.index] = now;
				for (const dep of dependents[item.index] ?? []) {
					remainingDeps[dep] = (remainingDeps[dep] as number) - 1;
					if (remainingDeps[dep] === 0) ready.push(dep);
				}
			}
		}
	}
	const makespan = Math.max(criticalSeconds, now, Math.ceil(nonExclusiveTotal / parallelism) + exclusiveTotal);
	const waveCount = Math.max(criticalNodes, Math.ceil(checks.length / parallelism));
	return { wallSeconds: makespan, criticalPathNodes: waveCount };
}

export function expandCodeCheckNeeds(
	checks: readonly CodeCheck[],
	requestedNames: readonly string[],
): { readonly selected: readonly CodeCheck[]; readonly autoIncluded: readonly string[] } {
	const isDag = checks.some((check) => check.needs !== undefined);
	const requestedSet = new Set(requestedNames);
	const selectedNames = new Set(requestedNames);
	if (isDag) {
		const byName = new Map(checks.map((check) => [check.name, check]));
		const queue = [...requestedNames];
		while (queue.length > 0) {
			const name = queue.shift() as string;
			const check = byName.get(name);
			for (const dep of check?.needs ?? []) {
				if (!selectedNames.has(dep)) {
					selectedNames.add(dep);
					queue.push(dep);
				}
			}
		}
	}
	const selected = checks.filter((check) => selectedNames.has(check.name));
	const autoIncluded = selected.filter((check) => !requestedSet.has(check.name)).map((check) => check.name);
	return { selected, autoIncluded };
}

function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open < 0) return [pattern];
	const close = pattern.indexOf("}", open + 1);
	if (close < 0) return [pattern];
	const prefix = pattern.slice(0, open);
	const body = pattern.slice(open + 1, close);
	const suffix = pattern.slice(close + 1);
	const alternatives = body.split(",");
	const results: string[] = [];
	for (const alt of alternatives) {
		for (const tail of expandBraces(suffix)) {
			results.push(`${prefix}${alt}${tail}`);
			if (results.length >= 32) return results;
		}
	}
	return results;
}

function matchSegment(pattern: string, text: string): boolean {
	const pLen = pattern.length;
	const tLen = text.length;
	const memo = new Int8Array((pLen + 1) * (tLen + 1));
	const matchAt = (pi: number, ti: number): boolean => {
		const key = pi * (tLen + 1) + ti;
		const cached = memo[key];
		if (cached !== 0) return cached === 1;
		let ok = false;
		if (pi === pLen) {
			ok = ti === tLen;
		} else if (pattern[pi] === "*") {
			ok = matchAt(pi + 1, ti) || (ti < tLen && matchAt(pi, ti + 1));
		} else if (pattern[pi] === "?") {
			ok = ti < tLen && matchAt(pi + 1, ti + 1);
		} else if (pattern[pi] === "[") {
			const close = pattern.indexOf("]", pi + 1);
			if (close > pi + 1 && ti < tLen) {
				let cursor = pi + 1;
				let negate = false;
				if (pattern[cursor] === "!" || pattern[cursor] === "^") {
					negate = true;
					cursor++;
				}
				const ch = text[ti]!;
				let hit = false;
				while (cursor < close) {
					if (cursor + 2 < close && pattern[cursor + 1] === "-") {
						if (ch >= pattern[cursor]! && ch <= pattern[cursor + 2]!) hit = true;
						cursor += 3;
					} else {
						if (ch === pattern[cursor]) hit = true;
						cursor++;
					}
				}
				ok = (negate ? !hit : hit) && matchAt(close + 1, ti + 1);
			} else {
				ok = ti < tLen && text[ti] === "[" && matchAt(pi + 1, ti + 1);
			}
		} else {
			ok = ti < tLen && pattern[pi] === text[ti] && matchAt(pi + 1, ti + 1);
		}
		memo[key] = ok ? 1 : 2;
		return ok;
	};
	return matchAt(0, 0);
}

function matchSingleGlob(pattern: string, filePath: string): boolean {
	const pParts = pattern.split("/");
	const sParts = filePath.split("/");
	const pLen = pParts.length;
	const sLen = sParts.length;
	const memo = new Int8Array((pLen + 1) * (sLen + 1));
	const matchParts = (pi: number, si: number): boolean => {
		const key = pi * (sLen + 1) + si;
		const cached = memo[key];
		if (cached !== 0) return cached === 1;
		let ok = false;
		if (pi === pLen) {
			ok = si === sLen;
		} else if (pParts[pi] === "**") {
			ok = matchParts(pi + 1, si) || (si < sLen && matchParts(pi, si + 1));
		} else if (si < sLen) {
			ok = matchSegment(pParts[pi]!, sParts[si]!) && matchParts(pi + 1, si + 1);
		}
		memo[key] = ok ? 1 : 2;
		return ok;
	};
	return matchParts(0, 0);
}

export function matchCheckGlob(pattern: string, filePath: string): boolean {
	const normalized = filePath.startsWith("./") ? filePath.slice(2) : filePath;
	if (!normalized || normalized.startsWith("/")) return false;
	for (const expanded of expandBraces(pattern)) {
		if (matchSingleGlob(expanded, normalized)) return true;
	}
	return false;
}

export function filterCodeChecksByPaths(
	checks: readonly CodeCheck[],
	changedPaths: readonly string[] | undefined,
	checksFileChanged: boolean,
): ReadonlyMap<string, "paths_unmatched"> {
	const skipped = new Map<string, "paths_unmatched">();
	if (checksFileChanged || changedPaths === undefined) return skipped;
	const normalized = changedPaths
		.map((entry) => (entry.startsWith("./") ? entry.slice(2) : entry))
		.filter((entry) => entry.length > 0);
	if (normalized.includes(".qorpera/checks.json")) return skipped;
	for (const check of checks) {
		if (check.alwaysRun === true) continue;
		if (check.paths === undefined && check.pathsIgnore === undefined) continue;
		const matched = normalized.some((path) => {
			const included = check.paths === undefined || check.paths.some((pattern) => matchCheckGlob(pattern, path));
			if (!included) return false;
			if (check.pathsIgnore?.some((pattern) => matchCheckGlob(pattern, path))) {
				return false;
			}
			return true;
		});
		if (!matched) skipped.set(check.name, "paths_unmatched");
	}
	return skipped;
}

function decodeXmlEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
		if (entity === "amp") return "&";
		if (entity === "lt") return "<";
		if (entity === "gt") return ">";
		if (entity === "quot") return '"';
		if (entity === "apos") return "'";
		const code = entity.startsWith("#x")
			? Number.parseInt(entity.slice(2), 16)
			: Number.parseInt(entity.slice(1), 10);
		if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
		return String.fromCodePoint(code);
	});
}

function parseXmlAttributes(raw: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const attrPattern = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	for (;;) {
		const match = attrPattern.exec(raw);
		if (!match) break;
		attrs[match[1]!] = decodeXmlEntities(match[2] ?? match[3] ?? "");
	}
	return attrs;
}

function cleanFailureText(text: string | undefined, maxBytes = 300): string | undefined {
	if (!text) return undefined;
	const stripped = text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replaceAll("\r\n", "\n")
		.trim();
	if (!stripped) return undefined;
	const firstLines = stripped
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, 3)
		.join(" | ");
	if (!firstLines) return undefined;
	if (utf8Bytes(firstLines) <= maxBytes) return firstLines;
	let kept = "";
	let used = 0;
	for (const char of firstLines) {
		const size = utf8Bytes(char);
		if (used + size > maxBytes - 3) break;
		kept += char;
		used += size;
	}
	return `${kept}…`;
}

function normalizeArtifactFilePath(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const trimmed = file.trim();
	if (!trimmed) return undefined;
	const srcMarker = trimmed.indexOf("/src/");
	if (trimmed.startsWith("/") && srcMarker >= 0) {
		const rel = trimmed.slice(srcMarker + 5);
		return rel || undefined;
	}
	return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
}

function parsePositiveInt(value: string | number | undefined): number | undefined {
	if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	if (typeof value === "string" && /^[1-9][0-9]{0,7}$/.test(value.trim())) return Number(value.trim());
	return undefined;
}

export function parseJunitXmlFailedTests(xml: string, maxTests = MAX_FAILED_TESTS): FailedTestCase[] {
	const results: FailedTestCase[] = [];
	if (!xml || maxTests <= 0) return results;
	const suiteStack: { name?: string; file?: string }[] = [];
	const tokenPattern = /<(\/?)(testsuite|testcase|failure|error)\b([^>]*?)(\/?)>/gi;
	let activeCase:
		| {
				suite?: string;
				name: string;
				file?: string;
				line?: number;
				failed: boolean;
				message?: string;
				openFailureTag?: string;
				failureBodyStart?: number;
		  }
		| undefined;
	for (;;) {
		const match = tokenPattern.exec(xml);
		if (!match) break;
		const closing = match[1] === "/";
		const tag = match[2]!.toLowerCase();
		const attrRaw = match[3] ?? "";
		const selfClosing = match[4] === "/";
		if (tag === "testsuite") {
			if (closing) {
				suiteStack.pop();
			} else if (!selfClosing) {
				const attrs = parseXmlAttributes(attrRaw);
				suiteStack.push({
					...(attrs.name ? { name: attrs.name } : {}),
					...(attrs.file ? { file: attrs.file } : {}),
				});
			}
			continue;
		}
		if (tag === "testcase") {
			if (!closing) {
				const attrs = parseXmlAttributes(attrRaw);
				const parent = suiteStack.at(-1);
				const suite = attrs.classname || parent?.name;
				const file = normalizeArtifactFilePath(attrs.file || parent?.file);
				const line = parsePositiveInt(attrs.line);
				const name = attrs.name || "unnamed";
				if (!selfClosing) {
					activeCase = {
						...(suite ? { suite } : {}),
						name,
						...(file ? { file } : {}),
						...(line !== undefined ? { line } : {}),
						failed: false,
					};
				}
			} else if (activeCase) {
				if (activeCase.failed && results.length < maxTests) {
					results.push({
						...(activeCase.suite ? { suite: activeCase.suite } : {}),
						name: activeCase.name,
						...(activeCase.file ? { file: activeCase.file } : {}),
						...(activeCase.line !== undefined ? { line: activeCase.line } : {}),
						...(activeCase.message ? { message: activeCase.message } : {}),
					});
				}
				activeCase = undefined;
				if (results.length >= maxTests) break;
			}
			continue;
		}
		if ((tag === "failure" || tag === "error") && activeCase) {
			if (!closing) {
				const attrs = parseXmlAttributes(attrRaw);
				activeCase.failed = true;
				if (!activeCase.message && attrs.message) {
					activeCase.message = cleanFailureText(attrs.message);
				}
				if (!selfClosing) {
					activeCase.openFailureTag = tag;
					activeCase.failureBodyStart = tokenPattern.lastIndex;
				}
			} else if (activeCase.openFailureTag === tag && activeCase.failureBodyStart !== undefined) {
				const body = xml.slice(activeCase.failureBodyStart, match.index);
				if (!activeCase.message) {
					activeCase.message = cleanFailureText(decodeXmlEntities(body));
				}
				activeCase.openFailureTag = undefined;
				activeCase.failureBodyStart = undefined;
			}
		}
	}
	return results;
}

export function parseTapFailedTests(tap: string, maxTests = MAX_FAILED_TESTS): FailedTestCase[] {
	const results: FailedTestCase[] = [];
	if (!tap || maxTests <= 0) return results;
	const lines = tap.replaceAll("\r\n", "\n").split("\n");
	let currentSuite: string | undefined;
	for (let i = 0; i < lines.length && results.length < maxTests; i++) {
		const line = lines[i]!;
		const subtest = /^\s*#\s*Subtest:\s*(.+)$/.exec(line);
		if (subtest) {
			currentSuite = subtest[1]!.trim() || undefined;
			continue;
		}
		const fail = /^(\s*)not ok(?:\s+\d+)?(?:\s*-\s*|\s+)?(.*)$/.exec(line);
		if (!fail) continue;
		const indent = fail[1]!.length;
		let rawDesc = fail[2]!.trim();
		if (/#\s*(?:todo|skip)\b/i.test(rawDesc)) continue;
		const hashAt = rawDesc.indexOf(" #");
		if (hashAt >= 0) rawDesc = rawDesc.slice(0, hashAt).trim();
		const name = rawDesc || `test ${results.length + 1}`;
		let message: string | undefined;
		let file: string | undefined;
		let lineNum: number | undefined;
		let cursor = i + 1;
		while (cursor < lines.length && lines[cursor]!.trim() === "") cursor++;
		if (cursor < lines.length && /^\s*---\s*$/.test(lines[cursor]!)) {
			const yamlIndent = lines[cursor]!.length - lines[cursor]!.trimStart().length;
			if (yamlIndent >= indent) {
				cursor++;
				const diag: string[] = [];
				while (cursor < lines.length && !/^\s*\.\.\.\s*$/.test(lines[cursor]!)) {
					const kv = /^\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[cursor]!);
					if (kv) {
						const k = kv[1]!.toLowerCase();
						const v = kv[2]!.trim().replace(/^['"]|['"]$/g, "");
						if ((k === "message" || k === "error") && v && !message) message = cleanFailureText(v);
						else if (k === "file" && v && !file) file = normalizeArtifactFilePath(v);
						else if (k === "line" && !lineNum) lineNum = parsePositiveInt(v);
						else if (k === "at" && v) {
							const loc = /^(.+?):(\d+)(?::\d+)?$/.exec(v);
							if (loc) {
								file ??= normalizeArtifactFilePath(loc[1]);
								lineNum ??= parsePositiveInt(loc[2]);
							}
						} else if ((k === "expected" || k === "actual") && v) {
							diag.push(`${k}: ${v}`);
						}
					}
					cursor++;
				}
				if (!message && diag.length > 0) message = cleanFailureText(diag.join(", "));
				i = cursor;
			}
		} else {
			const comments: string[] = [];
			while (cursor < lines.length && /^\s*#(?!\s*Subtest:)/.test(lines[cursor]!)) {
				const comment = lines[cursor]!.replace(/^\s*#\s?/, "").trim();
				if (comment) comments.push(comment);
				cursor++;
			}
			if (comments.length > 0) {
				message = cleanFailureText(comments.join(" | "));
				i = cursor - 1;
			}
		}
		results.push({
			...(currentSuite ? { suite: currentSuite } : {}),
			name,
			...(file ? { file } : {}),
			...(lineNum !== undefined ? { line: lineNum } : {}),
			...(message ? { message } : {}),
		});
	}
	return results;
}

export function parseVitestJsonFailedTests(jsonText: string, maxTests = MAX_FAILED_TESTS): FailedTestCase[] {
	const results: FailedTestCase[] = [];
	if (!jsonText || maxTests <= 0) return results;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return results;
	}
	if (!isObject(parsed) || !Array.isArray(parsed.testResults)) return results;
	for (const fileResult of parsed.testResults) {
		if (results.length >= maxTests) break;
		if (!isObject(fileResult)) continue;
		const file = normalizeArtifactFilePath(typeof fileResult.name === "string" ? fileResult.name : undefined);
		const assertions = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : [];
		let addedForFile = 0;
		for (const assertion of assertions) {
			if (results.length >= maxTests) break;
			if (!isObject(assertion) || assertion.status !== "failed") continue;
			const ancestors = Array.isArray(assertion.ancestorTitles)
				? assertion.ancestorTitles.filter((t): t is string => typeof t === "string" && t.length > 0)
				: [];
			const suite = ancestors.length > 0 ? ancestors.join(" > ") : undefined;
			const title = typeof assertion.title === "string" && assertion.title ? assertion.title : undefined;
			const fullName = typeof assertion.fullName === "string" && assertion.fullName ? assertion.fullName : undefined;
			const name = title ?? fullName ?? "unnamed";
			const location = isObject(assertion.location) ? assertion.location : undefined;
			const line = parsePositiveInt(location?.line as number | string | undefined);
			const failureMessages = Array.isArray(assertion.failureMessages)
				? assertion.failureMessages.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
				: [];
			const message = cleanFailureText(failureMessages[0]);
			results.push({
				...(suite ? { suite } : {}),
				name,
				...(file ? { file } : {}),
				...(line !== undefined ? { line } : {}),
				...(message ? { message } : {}),
			});
			addedForFile++;
		}
		if (addedForFile === 0 && fileResult.status === "failed" && results.length < maxTests) {
			const message = cleanFailureText(typeof fileResult.message === "string" ? fileResult.message : undefined);
			if (file || message) {
				results.push({
					name: file ? (file.split("/").at(-1) ?? file) : "suite failed",
					...(file ? { file } : {}),
					...(message ? { message } : {}),
				});
			}
		}
	}
	return results;
}

export function parseCheckFailureArtifacts(
	entries: readonly { readonly format: CodeCheckArtifactFormat; readonly content: string }[],
	maxTests = MAX_FAILED_TESTS,
): FailedTestCase[] {
	if (maxTests <= 0) return [];
	const out: FailedTestCase[] = [];
	for (const { format, content } of entries) {
		if (format === "raw") continue;
		if (out.length >= maxTests) break;
		const remaining = maxTests - out.length;
		const parsed =
			format === "junit"
				? parseJunitXmlFailedTests(content, remaining)
				: format === "tap"
					? parseTapFailedTests(content, remaining)
					: parseVitestJsonFailedTests(content, remaining);
		out.push(...parsed);
	}
	return out.slice(0, maxTests);
}
