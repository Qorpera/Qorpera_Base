import {
	PROGRAM_FILE,
	PROGRAM_FILE_MAX_BYTES,
	type Program,
	type ProgramHandIn,
	type ProgramKeptForm,
	parseProgramHandIn,
	programFilePath,
	writeProgram,
} from "@qorpera/cloud-client/app-program";
import type { CloudCompanyFolderFileEntry } from "./cloud-company-folder-client.ts";
import { CloudToolRefusal } from "./cloud-native-tool-boundary.ts";

export const PROGRAM_NO_SCREENS =
	"No screens: the page shows a plain tile with the file's name. Take real screenshots of the running program on a machine (the phone app, the desktop window), write them into the app's folder and name them in screens, then save again.";

export function programHandIn(text: string): ProgramHandIn {
	const parsed = parseProgramHandIn(text);
	if ("problem" in parsed) throw new CloudToolRefusal(`APP_DATA_INVALID: ${parsed.problem}`);
	return parsed.handIn;
}

const named = (entry: CloudCompanyFolderFileEntry) => entry.path.slice(entry.path.lastIndexOf("/") + 1);

function missing(app: string, path: string): CloudToolRefusal {
	return new CloudToolRefusal(
		`PROGRAM_FILE_MISSING: this call saved nothing. ${path} is not in the app's folder: copy it there from a machine, to /company/apps/${app}/${path}, then make this call again.`,
	);
}

export function keepProgram(options: {
	readonly app: string;
	readonly handIn: ProgramHandIn;
	readonly kept: Program | null;
	readonly file: (path: string) => CloudCompanyFolderFileEntry | undefined;
	readonly now: Date;
}): { readonly text: string; readonly notes: readonly string[] } {
	const { app, handIn, kept } = options;
	const forms: ProgramKeptForm[] = handIn.forms.map((form) => {
		const path = programFilePath(handIn.version, form.file);
		const entry = options.file(path);
		if (!entry) throw missing(app, path);
		return { for: form.for, file: named(entry), bytes: entry.file.bytes, sha256: entry.file.fileSha256 };
	});
	for (const path of [handIn.screens.phone, handIn.screens.desktop])
		if (path !== undefined && !options.file(path)) throw missing(app, path);
	const versions = kept?.versions ?? [];
	const at = versions.findIndex((each) => each.version === handIn.version);
	const same = (a: readonly ProgramKeptForm[], b: readonly ProgramKeptForm[]) =>
		a.length === b.length &&
		a.every((form) =>
			b.some((other) => other.for === form.for && other.file === form.file && other.sha256 === form.sha256),
		);
	if (at > 0)
		throw new CloudToolRefusal(
			`PROGRAM_VERSION_EARLIER: this call saved nothing. ${handIn.version} is an earlier version than ${versions[0]?.version}, the newest: a new build takes a new version.`,
		);
	if (at === 0 && !same(versions[0]?.forms ?? [], forms))
		throw new CloudToolRefusal(
			`PROGRAM_VERSION_KEPT: this call saved nothing. Version ${handIn.version} is kept with other files: a new build takes a new version, and the files of a kept one stay as they are.`,
		);
	const program: Program = {
		version: handIn.version,
		forms: handIn.forms.map((form, index) => ({ for: form.for, file: forms[index]?.file ?? form.file })),
		screens: handIn.screens,
		versions:
			at === 0 ? versions : [{ version: handIn.version, date: options.now.toISOString(), forms }, ...versions],
	};
	const text = writeProgram(program);
	if (Buffer.byteLength(text) > PROGRAM_FILE_MAX_BYTES)
		throw new CloudToolRefusal(
			`PROGRAM_FULL: this call saved nothing. ${PROGRAM_FILE} keeps ${versions.length} versions, as many as it holds: make a new program app for the next one.`,
		);
	return {
		text,
		notes: handIn.screens.phone === undefined && handIn.screens.desktop === undefined ? [PROGRAM_NO_SCREENS] : [],
	};
}
