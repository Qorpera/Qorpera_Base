import { isUuid } from "@qorpera/contracts";
import { APP_COVER_KINDS, APPS_FOLDER, appFileKind, appFolder, appRelativePath } from "./interface-apps.ts";

export const PROGRAM_KIT = "program";
export const PROGRAM_FILE = "program.json";
export const PROGRAM_VERSIONS_FOLDER = "versions";
export const PROGRAM_FILE_MAX_BYTES = 256 * 1024;
export const PROGRAM_KINDS = Object.freeze(["android", "linux", "windows", "mac", "iphone"] as const);
export type ProgramKind = (typeof PROGRAM_KINDS)[number];
export const PROGRAM_VERSION_MAX_CHARS = 24;
export const PROGRAM_FILE_NAME_MAX_CHARS = 200;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HAND_IN_KEYS = ["version", "forms", "screens"];
const SCREENS = ["phone", "desktop"] as const;

export interface ProgramForm {
	readonly for: ProgramKind;
	readonly file: string;
}

export interface ProgramScreens {
	readonly phone?: string;
	readonly desktop?: string;
}

export interface ProgramHandIn {
	readonly version: string;
	readonly forms: readonly ProgramForm[];
	readonly screens: ProgramScreens;
}

export interface ProgramKeptForm extends ProgramForm {
	readonly bytes: number;
	readonly sha256: string;
}

export interface ProgramVersion {
	readonly version: string;
	readonly date: string;
	readonly forms: readonly ProgramKeptForm[];
	readonly userId?: string;
}

export interface Program extends ProgramHandIn {
	readonly versions: readonly ProgramVersion[];
}

export const isProgramKind = (value: unknown): value is ProgramKind =>
	typeof value === "string" && (PROGRAM_KINDS as readonly string[]).includes(value);

export function isProgramVersion(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= PROGRAM_VERSION_MAX_CHARS &&
		VERSION.test(value) &&
		!value.includes("..")
	);
}

export function isProgramFileName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		[...value].length <= PROGRAM_FILE_NAME_MAX_CHARS &&
		!value.includes("/") &&
		!/[\0-\x1f\x7f"<>\\]/.test(value) &&
		appRelativePath(value) === value
	);
}

export const programFilePath = (version: string, file: string): string =>
	`${PROGRAM_VERSIONS_FOLDER}/${version}/${file}`;

export function programUploadPath(
	path: string,
): { readonly name: string; readonly version: string; readonly file: string } | null {
	const parts = path.split("/");
	if (parts.length !== 5 || parts[0] !== APPS_FOLDER || parts[2] !== PROGRAM_VERSIONS_FOLDER) return null;
	const [, name = "", , version, file] = parts;
	if (appFolder(name) === null || !isProgramVersion(version) || !isProgramFileName(file)) return null;
	return { name, version, file };
}

export function programFormsInOrder<T extends ProgramForm>(forms: readonly T[]): T[] {
	return [...forms].sort((a, b) => PROGRAM_KINDS.indexOf(a.for) - PROGRAM_KINDS.indexOf(b.for));
}

type Read<T> = { readonly value: T } | { readonly problem: string };

function readForms(value: unknown): Read<ProgramForm[]> {
	const shape = `forms must be a list of 1 to ${PROGRAM_KINDS.length} {"for", "file"}, for one of ${PROGRAM_KINDS.join(", ")}`;
	if (!Array.isArray(value) || value.length === 0 || value.length > PROGRAM_KINDS.length) return { problem: shape };
	const forms: ProgramForm[] = [];
	for (const [index, form] of value.entries()) {
		if (typeof form !== "object" || form === null || Array.isArray(form)) return { problem: shape };
		const { for: kind, file } = form as Record<string, unknown>;
		if (!isProgramKind(kind))
			return { problem: `form ${index + 1}'s for must be one of ${PROGRAM_KINDS.join(", ")}` };
		if (!isProgramFileName(file))
			return {
				problem: `form ${index + 1}'s file must be one file's name in versions/<version>/, such as fokusur-0.1.apk: no folder, at most ${PROGRAM_FILE_NAME_MAX_CHARS} characters`,
			};
		if (forms.some((each) => each.for === kind))
			return { problem: `forms name ${kind} twice: one file for each kind` };
		forms.push({ for: kind, file });
	}
	return { value: forms };
}

function readScreens(value: unknown): Read<ProgramScreens> {
	if (value === undefined || value === null) return { value: {} };
	if (
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !SCREENS.includes(key as never))
	)
		return { problem: 'screens must be {"phone", "desktop"}, each a picture in the app\'s folder' };
	const screens: { phone?: string; desktop?: string } = {};
	for (const key of SCREENS) {
		const path = (value as Record<string, unknown>)[key];
		if (path === undefined || path === null) continue;
		const relative = typeof path === "string" ? appRelativePath(path) : null;
		if (relative === null || !APP_COVER_KINDS.has(appFileKind(relative)))
			return {
				problem: `screens.${key} must be a .png, .jpg or .webp picture in the app's folder, such as screens/${key}.png`,
			};
		screens[key] = relative;
	}
	return { value: screens };
}

function readVersion(value: unknown): Read<string> {
	return isProgramVersion(value)
		? { value }
		: {
				problem: `version must be short text such as 0.1: letters, digits and . _ + -, at most ${PROGRAM_VERSION_MAX_CHARS} characters`,
			};
}

function readJson(text: string): Read<Record<string, unknown>> {
	if (new TextEncoder().encode(text).byteLength > PROGRAM_FILE_MAX_BYTES)
		return { problem: `${PROGRAM_FILE} is larger than ${PROGRAM_FILE_MAX_BYTES / 1024} KiB` };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { problem: `${PROGRAM_FILE} is not JSON` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return { problem: `${PROGRAM_FILE} must be one JSON object` };
	return { value: value as Record<string, unknown> };
}

export function parseProgramHandIn(text: string): { readonly handIn: ProgramHandIn } | { readonly problem: string } {
	const json = readJson(text);
	if ("problem" in json) return json;
	const data = json.value;
	if (data.versions !== undefined)
		return {
			problem: `${PROGRAM_FILE}'s versions is kept by save_app: leave it out and give version, forms and screens`,
		};
	const unknown = Object.keys(data).find((key) => !HAND_IN_KEYS.includes(key));
	if (unknown !== undefined)
		return { problem: `${unknown} is not a field of ${PROGRAM_FILE} (it has ${HAND_IN_KEYS.join(", ")})` };
	const version = readVersion(data.version);
	if ("problem" in version) return version;
	const forms = readForms(data.forms);
	if ("problem" in forms) return forms;
	const screens = readScreens(data.screens);
	if ("problem" in screens) return screens;
	return { handIn: { version: version.value, forms: forms.value, screens: screens.value } };
}

function readKept(value: unknown): ProgramVersion | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const { version, date, forms, userId } = value as Record<string, unknown>;
	if (!isProgramVersion(version) || typeof date !== "string" || !Number.isFinite(Date.parse(date))) return null;
	if (userId !== undefined && !isUuid(userId)) return null;
	const read = readForms(forms);
	if ("problem" in read || !Array.isArray(forms)) return null;
	const kept: ProgramKeptForm[] = [];
	for (const [index, form] of read.value.entries()) {
		const { bytes, sha256 } = forms[index] as Record<string, unknown>;
		if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || typeof sha256 !== "string" || !SHA256.test(sha256))
			return null;
		kept.push({ ...form, bytes: bytes as number, sha256 });
	}
	return { version, date, forms: kept, ...(userId === undefined ? {} : { userId }) };
}

export function parseProgram(text: string): Program | null {
	const json = readJson(text);
	if ("problem" in json) return null;
	const data = json.value;
	const version = readVersion(data.version);
	const forms = readForms(data.forms);
	const screens = readScreens(data.screens);
	if ("problem" in version || "problem" in forms || "problem" in screens || !Array.isArray(data.versions)) return null;
	const versions: ProgramVersion[] = [];
	for (const each of data.versions) {
		const kept = readKept(each);
		if (kept === null || versions.some((other) => other.version === kept.version)) return null;
		versions.push(kept);
	}
	if (versions[0]?.version !== version.value) return null;
	return { version: version.value, forms: forms.value, screens: screens.value, versions };
}

export function writeProgram(program: Program): string {
	const screens = Object.keys(program.screens).length > 0 ? { screens: program.screens } : {};
	return `${JSON.stringify(
		{ version: program.version, forms: program.forms, ...screens, versions: program.versions },
		null,
		2,
	)}\n`;
}
