import { folderKey } from "@qorpera/contracts";

/** The company folder's rules for the names of a repository's files, which git takes and the folder does not: what the
 * import's look (code-host-import.ts), a session's landing, a session's worktree and a seed from GitHub (code-host-jobs.ts:
 * `landCodeBranch`, `addCodeWorktree`, `seedCodeArea`) ask of every path they would put in the place (own code storage,
 * step 6). Here, with no import of either file, so all ask the same rule. */

/** A control character as the folder's rule and the import look's display read it: C0, DEL, C1 and the line and
 * paragraph separators. */
export const CODE_FOLDER_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
/** No lone surrogate: the text is its UTF-8 bytes exactly. */
const wellFormed = (text: string) => Buffer.from(text, "utf8").toString("utf8") === text;

// WHY: SQL qorpera_folder_commit enforces c_key_bound = 2600 on folded keys; codeFolderRefuses checks it alongside 255-byte names.
export const CODE_FOLDER_KEY_BYTES = 2600;

/** The company folder's rule for a path under `code/` (`qorpera_company_path_valid`, migration 20260928569110, whose
 * code/ branch takes `%`, `:` and device names): 1 to 4,096 bytes, NFC; and the path, its folder key and its key by full
 * case mapping (stricter than the database's simple mapping wherever the two differ) each have as many parts as the
 * path, none empty, `.` or `..`, none ending in `.` or a space, no control character (C0, DEL, C1 and the line and
 * paragraph separators: stricter than the database's `[[:cntrl:]]` where it differs) and no backslash. A path outside
 * `code/` is no path this rule is for: false. No TypeScript copy of the rule was in `@qorpera/contracts`. */
export function codeImportFolderPathValid(path: string): boolean {
	if (typeof path !== "string" || !wellFormed(path)) return false;
	const bytes = utf8(path);
	if (bytes < 1 || bytes > 4096 || path.normalize("NFC") !== path) return false;
	const key = folderKey(path);
	if (key.split("/")[0] !== "code") return false;
	const parts = path.split("/").length;
	for (const candidate of [path, key, path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC")]) {
		if (CODE_FOLDER_CONTROL.test(candidate) || candidate.includes("\\") || candidate.split("/").length !== parts)
			return false;
		if (candidate.split("/").some((part) => part === "" || part === "." || part === ".." || /[. ]$/.test(part)))
			return false;
	}
	return true;
}

/** The longest name the company folder takes: its program refuses a longer one (`valid_name`,
 * `crates/qorpera-folder/src/proto.rs`). Neither the folder's SQL rule nor `codeImportFolderPathValid` asks this. */
export const CODE_FOLDER_NAME_BYTES = 255;

/** Where any coding session's worktree holds a repository's files, for a check that is no one session's own: a session's
 * worktree is `worktrees/<workerId>`, and every session's id is a UUID of 36 characters, so this one, the nil UUID's,
 * is as long as every session's. A path the folder takes here it takes in every session's worktree, and in `main/`,
 * which is 42 bytes shorter: what the place's default branch holds, every session can check out. */
export const CODE_FOLDER_ANY_SESSION = "worktrees/00000000-0000-0000-0000-000000000000";

/** The paths of a tree (`ls-tree -r -t`'s records, a folder before what is in it) that the company folder would refuse
 * where they stand in the place, `<area>/<under>/<path>` (`area` is the place, `code/<owner>/<name>`; `under` is
 * `main`, the default, or a session's worktree, `worktrees/<workerId>`, or `CODE_FOLDER_ANY_SESSION` for every
 * session's): `codeImportFolderPathValid` there, and at most `CODE_FOLDER_NAME_BYTES` for each name. git takes such
 * names and `Run.checkNames` asks none of these, so without this the folder would refuse the checkout's whole change set
 * only once it was written. Each is named at the highest entry that breaks the rule: what is below a refused folder is
 * not named again. */
export function codeFolderRefuses(
	area: string,
	records: readonly { type: string; path: Buffer }[],
	under = "main",
): string[] {
	const refused: string[] = [],
		below = new Set<string>();
	for (const record of records) {
		const path = record.path.toString("utf8"),
			slash = path.lastIndexOf("/");
		if (slash >= 0 && below.has(path.slice(0, slash))) {
			if (record.type === "tree") below.add(path);
			continue;
		}
		const full = `${area}/${under}/${path}`;
		if (
			codeImportFolderPathValid(full) &&
			utf8(folderKey(full)) <= CODE_FOLDER_KEY_BYTES &&
			path.split("/").every((part) => utf8(part) <= CODE_FOLDER_NAME_BYTES)
		)
			continue;
		refused.push(path);
		if (record.type === "tree") below.add(path);
	}
	return refused;
}
