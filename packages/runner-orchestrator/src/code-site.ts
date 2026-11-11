import { createHash } from "node:crypto";
import { bytes, shown } from "./code-words.ts";

/** A repository's website (own code storage, step 4, part C1; STEP4-RELEASES-PLAN.md 5 and 8.1, as STEP4-BUILD.md
 * section 2 replaced them). A repository says in its checks file which folder its checks leave the built site in
 * (`"site": {"folder": "dist"}`). Once every check of a run passed, the executor's runner starts one more command of the
 * run, the collect (`CODE_SITE_COLLECT`): it takes the folder's web files from the clean copy on the session's machine
 * and writes them as git objects, their blobs and one tree, into the repository's own storage, where the upload pass
 * reads the tree later (`code-host-sites.ts`). When the folder's boundary after it did not save everything, the drop
 * (`CODE_SITE_DROP`) removes again what the collect wrote. This file holds what is pure of it: the site's rules, both
 * commands' texts and how their answers read, the report's value and the words of a refused site. It imports nothing
 * of the platform's (`deploy/coding-machine/test/code-checks-scripts.mjs` prints its commands with Node alone). */

/** A site's bounds, `publish_site`'s: files, bytes in all, bytes a file, and folders below the site's top that lead to a
 * file (every folder on a file's way counts: `a/b/c.css` counts `a` and `a/b`, each one tree the collect writes, so
 * that its blobs, trees and new object folders stay well within the 1,000 units of one save of the company folder). */
export const CODE_SITE_MAX_FILES = 500;
export const CODE_SITE_MAX_BYTES = 25 * 1024 * 1024;
export const CODE_SITE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CODE_SITE_MAX_FOLDERS = 100;
/** A site path's most bytes, beside the path rule (`qorpera_site_path_valid`). */
export const CODE_SITE_MAX_PATH_BYTES = 512;
const PART = "[A-Za-z0-9_][A-Za-z0-9._-]{0,199}";
/** A site path, as the database stores it (`qorpera_site_path_valid`): at most 16 parts, none hidden, none `..`, no
 * character a link would escape. */
export const CODE_SITE_PATH = new RegExp(`^${PART}(/${PART}){0,15}$`);
/** The extensions a site serves, as the database maps them (`qorpera_site_content_type`, 20260930550000), 30 of them;
 * a file's is the end of its name after its last dot, of any case. */
export const CODE_SITE_EXTENSIONS: readonly string[] = [
	"html",
	"htm",
	"css",
	"js",
	"mjs",
	"json",
	"map",
	"webmanifest",
	"txt",
	"csv",
	"xml",
	"svg",
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"ico",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"mp4",
	"webm",
	"mp3",
	"m4a",
	"ogg",
	"wav",
	"pdf",
];
const EXTENSION = /\.([A-Za-z0-9]{1,12})$/;

export type CodeSiteProblemCode =
	| "SITE_FOLDER_MISSING"
	| "SITE_NO_INDEX"
	| "SITE_TOO_MANY_FILES"
	| "SITE_TOO_MANY_FOLDERS"
	| "SITE_FILE_TOO_LARGE"
	| "SITE_TOO_LARGE"
	| "SITE_FILE_NAME"
	| "SITE_HOLDS_SECRET";

/** What the code made wrong in its site: the file it is about (`SITE_FILE_TOO_LARGE`, `SITE_FILE_NAME`, and
 * `SITE_HOLDS_SECRET` as the collect found it), and the secret variable whose value a file holds. A secret found only
 * by the folder's save check names neither. */
export interface CodeSiteProblem {
	readonly code: CodeSiteProblemCode;
	readonly path: string | null;
	readonly variable: string | null;
}

/** What became of a run's site: made (its tree written into the repository's storage and saved, with the recipe it was
 * made by), or missed, Qorpera's own failure with its code (the change lands without a site). */
export type CodeSiteCollected =
	| {
			readonly state: "made";
			readonly tree: string;
			readonly files: number;
			readonly bytes: number;
			readonly folder: string;
			readonly name: string | null;
			readonly title: string | null;
	  }
	| { readonly state: "missed"; readonly code: string };

// The recipe's rules, as the kernel checks a made site (qorpera_code_site_valid, 20260930729000) -------------------------

const NAME = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const RESERVED = new Set([
	"api",
	"app",
	"www",
	"admin",
	"assets",
	"static",
	"qorpera",
	"login",
	"signin",
	"signup",
	"robots",
	"favicon",
	"sites",
	"site",
	"well-known",
	"help",
	"support",
	"status",
	"mail",
	"functions",
	"auth",
	"rest",
	"storage",
	"realtime",
]);
const MAX_FOLDER_BYTES = 300;
const MAX_TITLE_CHARACTERS = 120;

/** A site's name, its link's last part (`qorpera_site_slug_valid`): 3 to 48 of a-z, 0-9 and `-`, from and to a letter
 * or a digit, and none of the names a site never gets. */
export function codeSiteNameValid(name: string): boolean {
	return NAME.test(name) && !RESERVED.has(name);
}

/** Whether a character is one the kernel's `[[:cntrl:]]` takes as a control under a UTF-8 locale: C0, DEL, C1 and the
 * line and paragraph separators. */
function control(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** The site's folder: `.` (the repository's top), or a relative path of the repository of at most 300 bytes with no
 * empty, `.` or `..` part, no control character and no backslash. A check's `cwd` takes the same, but for C1 controls
 * and the separators, which the kernel refuses in a site's folder. */
export function codeSiteFolderValid(folder: string): boolean {
	if (folder === ".") return true;
	if (folder === "" || bytes(folder) > MAX_FOLDER_BYTES) return false;
	for (const character of folder) if (control(character.codePointAt(0) as number) || character === "\\") return false;
	return folder.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** A site's title, as a version keeps it: 1 to 120 characters on one line (no control character, no line or paragraph
 * separator) with no space at either end. */
export function codeSiteTitleValid(title: string): boolean {
	const characters = Array.from(title);
	return (
		characters.length >= 1 &&
		characters.length <= MAX_TITLE_CHARACTERS &&
		!title.startsWith(" ") &&
		!title.endsWith(" ") &&
		characters.every((character) => !control(character.codePointAt(0) as number))
	);
}

// The tree's rules, for the upload pass ---------------------------------------------------------------------------------

/** The collect's rules on a tree's entries (mode, type, path, size), for the pass that reads it (`code-host-sites.ts`).
 * The collect leaves out what is not a regular web file of a path a site serves; a tree holds none of that, so here
 * each such entry is refused as its name. In C order, each entry: not a regular file's mode (a link's is 120000, a
 * submodule's 160000), a path over 512, not the path rule or with no extension a site serves: `SITE_FILE_NAME`; over
 * 10 MiB: `SITE_FILE_TOO_LARGE`; the 501st file: `SITE_TOO_MANY_FILES`; over 25 MiB in all: `SITE_TOO_LARGE`; the
 * 101st folder on the files' ways: `SITE_TOO_MANY_FOLDERS`; then no `index.html` at the top: `SITE_NO_INDEX`. The
 * collect checks its files in the same order. */
export function codeSiteTreeProblem(
	entries: readonly { mode: string; type: string; path: string; bytes: number }[],
): CodeSiteProblem | null {
	const problem = (code: CodeSiteProblemCode, path: string | null = null) => ({ code, path, variable: null });
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		folders = new Set<string>();
	let files = 0,
		total = 0;
	for (const { mode, path, bytes } of sorted) {
		const extension = EXTENSION.exec(path.slice(path.lastIndexOf("/") + 1))?.[1]?.toLowerCase();
		if (
			(mode !== "100644" && mode !== "100755") ||
			path.length > CODE_SITE_MAX_PATH_BYTES ||
			!CODE_SITE_PATH.test(path) ||
			!extension ||
			!CODE_SITE_EXTENSIONS.includes(extension)
		)
			return problem("SITE_FILE_NAME", path);
		if (bytes > CODE_SITE_MAX_FILE_BYTES) return problem("SITE_FILE_TOO_LARGE", path);
		files += 1;
		total += bytes;
		if (files > CODE_SITE_MAX_FILES) return problem("SITE_TOO_MANY_FILES");
		if (total > CODE_SITE_MAX_BYTES) return problem("SITE_TOO_LARGE");
		for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
			folders.add(path.slice(0, slash));
		if (folders.size > CODE_SITE_MAX_FOLDERS) return problem("SITE_TOO_MANY_FOLDERS");
	}
	return sorted.some((entry) => entry.path === "index.html") ? null : problem("SITE_NO_INDEX");
}

/** `publish_site`'s manifest (site-tools' `manifestOf`): lines `path TAB sha256 TAB bytes` in C order, joined by LF with
 * none after the last, then their SHA-256. Paths are ASCII, so code-unit order is the database's byte order. */
export function codeSiteManifest(files: readonly { path: string; sha256: string; bytes: number }[]): string {
	const lines = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) => `${file.path}\t${file.sha256}\t${file.bytes}`);
	return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

// The commands ------------------------------------------------------------------------------------------------------------

/** Step 3's rule for every command of a run of the checks (coding-executor-host.ts keeps the same lines for the copy
 * and each check): a command of a run that is not the newest exits 91 before it does anything, when a run folder with a
 * higher name stands in `$QORPERA_CHECKS_ROOT`. Names compare as bytes (`LC_ALL=C`, in a subshell of its own). */
export const CODE_CHECKS_NEWER_RUN: readonly string[] = [
	"(",
	"\tLC_ALL=C",
	'\tfor e in "$QORPERA_CHECKS_ROOT"/*; do',
	'\t\tm="$(basename -- "$e")"',
	"\t\tif [[ $m =~ ^[0-9]{10}-[0-9]{4}$ && $m > $QORPERA_CHECKS_NAME ]]; then exit 91; fi",
	"\tdone",
	")",
	'if [ "$?" -eq 91 ]; then exit 91; fi',
];

/** The collect's program (python3 -I: no variable, path or file of the session's changes how Python runs, and the
 * copy's own files are never imported). Its environment: the run's QORPERA_CHECKS_ROOT and QORPERA_CHECKS_NAME (the
 * run's folder `$d`, whose `src` is the copy), QORPERA_CHECKS_REPOSITORY (the repository's storage), QORPERA_SITE_FOLDER
 * (the recipe's folder) and QORPERA_SITE_SECRET_NAMES (the session's secret variables, space separated). In order:
 * 1. `$d/site.wrote` is made empty, before anything is written.
 * 2. The folder below `$d/src`, each part a folder and none a link, else `SITE_FOLDER_MISSING`.
 * 3. Its files, links never followed or listed: every regular file with no part starting with a dot whose extension a
 *    site serves, in C order. Each, in turn: the name rule (`SITE_FILE_NAME`), its bytes read once (at most 10 MiB and
 *    one byte: `SITE_FILE_TOO_LARGE`), then the count, the total and the folders. Then `index.html` at the top.
 * 4. The secret scan: for each name whose value in this command's environment has at least 8 bytes (the mask's own
 *    least), whether a file's bytes hold it, byte for byte (`SITE_HOLDS_SECRET <NAME> <path>`). No value is printed.
 * 5. Git, with an environment of its own (no variable, configuration or attribute of the session's or of the copy's,
 *    which the repository's own code writes): a new scratch repository `$d/site.git`; the files' exact bytes
 *    (`hash-object --no-filters`, which reads them again), and one tree, all of mode 100644, of the ids of the bytes
 *    scanned: a file that changed meanwhile has no object of that id, and git refuses the tree.
 * 6. The objects the repository's storage lacks, asked of git (loose or packed: `hash-object -w` cannot be trusted to
 *    skip one there, its freshening fails on the company folder and it then writes a loose copy), blobs first, then the
 *    trees from the leaves to the top. Each as git writes one: a temporary `tmp_obj_*` in its object folder (never
 *    published by the folder), then, unless something put the object there meanwhile, its id on a line of
 *    `$d/site.wrote`, then the rename. So `site.wrote` names every object the collect put at its name, and at most one
 *    more that it was about to; no file at an object's name is ever partial.
 * 7. Three lines: `tree <id>`, `files <n>`, `bytes <n>`.
 * A problem prints one line `<CODE>[ <detail>]` and exits 3, the detail's bytes outside printable ASCII and its
 * backslashes written `\xHH`, at most 1,000 bytes. Anything that is not the code's fault exits otherwise: 2 for a run
 * folder or a recipe that is not as the host made it, 4 for a file that changed while it was taken or a git command
 * that failed, 1 for anything else Python could not do. */
const COLLECT_PY = String.raw`import hashlib,os,re,shutil,stat,subprocess,sys
E=os.environb
d=E[b"QORPERA_CHECKS_ROOT"]+b"/"+E[b"QORPERA_CHECKS_NAME"]
w=os.open(d+b"/site.wrote",os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_APPEND,0o644)
def say(code,detail=b""):
	os.write(1,code+(b" "+detail if detail else b"")+b"\n")
	sys.exit(3)
def esc(p):
	return b"".join(bytes([c]) if 32<=c<127 and c!=92 else b"\\x%02x"%c for c in p)[:1000]
top=d+b"/src"
if not stat.S_ISDIR(os.lstat(top).st_mode):
	sys.exit(2)
folder=E[b"QORPERA_SITE_FOLDER"]
parts=[] if folder==b"." else folder.split(b"/")
if any(part in (b"",b".",b"..") for part in parts):
	sys.exit(2)
for part in parts:
	top+=b"/"+part
	try:
		mode=os.lstat(top).st_mode
	except (FileNotFoundError,NotADirectoryError):
		say(b"SITE_FOLDER_MISSING")
	if not stat.S_ISDIR(mode):
		say(b"SITE_FOLDER_MISSING")
EXT=re.compile(rb"\.([A-Za-z0-9]{1,12})\Z")
SERVED=set(b"${CODE_SITE_EXTENSIONS.join(" ")}".split())
paths=[]
todo=[b""]
while todo:
	at=todo.pop()
	with os.scandir(top+b"/"+at if at else top) as entries:
		for entry in entries:
			if entry.name[:1]==b".":
				continue
			p=at+b"/"+entry.name if at else entry.name
			if entry.is_dir(follow_symlinks=False):
				todo.append(p)
			elif entry.is_file(follow_symlinks=False):
				m=EXT.search(entry.name)
				if m and m.group(1).lower() in SERVED:
					paths.append(p)
paths.sort()
RULE=re.compile(rb"${PART}(/${PART}){0,15}")
files=[]
total=0
folders=set()
for p in paths:
	if len(p)>${CODE_SITE_MAX_PATH_BYTES} or not RULE.fullmatch(p):
		say(b"SITE_FILE_NAME",esc(p))
	fd=os.open(top+b"/"+p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
	with os.fdopen(fd,"rb") as f:
		if not stat.S_ISREG(os.fstat(fd).st_mode):
			sys.exit(4)
		content=f.read(${CODE_SITE_MAX_FILE_BYTES}+1)
	if len(content)>${CODE_SITE_MAX_FILE_BYTES}:
		say(b"SITE_FILE_TOO_LARGE",esc(p))
	files.append((p,content))
	total+=len(content)
	if len(files)>${CODE_SITE_MAX_FILES}:
		say(b"SITE_TOO_MANY_FILES")
	if total>${CODE_SITE_MAX_BYTES}:
		say(b"SITE_TOO_LARGE")
	slash=p.find(b"/")
	while slash>=0:
		folders.add(p[:slash])
		slash=p.find(b"/",slash+1)
	if len(folders)>${CODE_SITE_MAX_FOLDERS}:
		say(b"SITE_TOO_MANY_FOLDERS")
if b"index.html" not in paths:
	say(b"SITE_NO_INDEX")
NAME=re.compile(rb"[A-Za-z_][A-Za-z0-9_]{0,127}")
for name in E.get(b"QORPERA_SITE_SECRET_NAMES",b"").split():
	value=E.get(name) if NAME.fullmatch(name) else None
	if value is not None and len(value)>=8:
		for p,content in files:
			if value in content:
				say(b"SITE_HOLDS_SECRET",name+b" "+esc(p))
scratch=d+b"/site.git"
if os.path.islink(scratch) or os.path.isfile(scratch):
	os.unlink(scratch)
elif os.path.isdir(scratch):
	shutil.rmtree(scratch)
ENV={b"PATH":E.get(b"PATH",b"/usr/bin:/bin"),b"HOME":d,b"LC_ALL":b"C",b"GIT_CONFIG_NOSYSTEM":b"1",b"GIT_CONFIG_GLOBAL":b"/dev/null",b"GIT_ATTR_NOSYSTEM":b"1",b"GIT_NO_REPLACE_OBJECTS":b"1"}
def git(args,given=b"",more={},cwd=d):
	r=subprocess.run([b"git",b"--git-dir="+scratch]+args,input=given,stdout=subprocess.PIPE,env={**ENV,**more},cwd=cwd)
	if r.returncode:
		sys.exit(4)
	return r.stdout
git([b"init",b"--quiet",b"--bare",b"--template=",b"--object-format=sha1",b"--initial-branch=site"])
blobs=[hashlib.sha1(b"blob %d\0"%len(content)+content).hexdigest().encode() for p,content in files]
git([b"hash-object",b"-w",b"--no-filters",b"--stdin-paths"],b"".join(p+b"\n" for p,content in files),cwd=top)
git([b"update-index",b"--add",b"-z",b"--index-info"],b"".join(b"100644 %s\t%s\0"%(i,p) for i,(p,content) in zip(blobs,files)))
tree=git([b"write-tree"]).strip()
trees=[y.split(b"\t")[0].split(b" ")[2] for y in git([b"ls-tree",b"-r",b"-t",b"-z",tree]).split(b"\0") if y[:12]==b"040000 tree "]
ids=list(dict.fromkeys(sorted(blobs)+trees[::-1]+[tree]))
objects=E[b"QORPERA_CHECKS_REPOSITORY"]+b"/objects"
held=git([b"cat-file",b"--batch-check"],b"".join(i+b"\n" for i in ids),{b"GIT_OBJECT_DIRECTORY":objects}).split(b"\n")
if len(held)!=len(ids)+1 or held[-1] or any(not y.startswith(i+b" ") for i,y in zip(ids,held)):
	sys.exit(4)
LETTERS=b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
for i in [i for i,y in zip(ids,held) if y==i+b" missing"]:
	with open(scratch+b"/objects/"+i[:2]+b"/"+i[2:],"rb") as f:
		stored=f.read()
	place=objects+b"/"+i[:2]
	try:
		os.mkdir(place)
	except FileExistsError:
		pass
	while True:
		temporary=place+b"/tmp_obj_"+bytes(LETTERS[k%62] for k in os.urandom(6))
		try:
			fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o444)
			break
		except FileExistsError:
			pass
	try:
		with os.fdopen(fd,"wb") as f:
			f.write(stored)
		if os.path.lexists(place+b"/"+i[2:]):
			os.unlink(temporary)
			continue
		os.write(w,i+b"\n")
		os.rename(temporary,place+b"/"+i[2:])
	except BaseException:
		if os.path.lexists(temporary):
			os.unlink(temporary)
		raise
os.write(1,b"tree %s\nfiles %d\nbytes %d\n"%(tree,len(files),total))`;

/** The collect (part C2 starts it as one more command of the run, after the last check passed): the run's own guard,
 * then everything it prints to stderr goes to `$d/site.err` (stdout and stderr are one output, which must hold nothing
 * but the answer), then its program. Uses bash and python3, which runs git; of coreutils (the image's are uutils) only
 * the guard's `basename`, as every command of the run. Exits 0 with three lines, 3 with one (`codeSiteCollectAnswer`),
 * 91 when a newer run's folder stands (nothing written), anything else when it could not take the site. */
export const CODE_SITE_COLLECT = [
	...CODE_CHECKS_NEWER_RUN,
	'exec 2>"$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME/site.err"',
	"exec python3 -I - <<'QORPERA_SITE'",
	COLLECT_PY,
	"QORPERA_SITE",
].join("\n");

/** The drop's program: each line of `$d/site.wrote` that is an object's id, its loose file in the repository's storage
 * removed; one that cannot be removed (gone already, or saved by a boundary: the company folder keeps it) is passed
 * over. Prints `dropped <n>`, the files removed. */
const DROP_PY = String.raw`import os,re
E=os.environb
d=E[b"QORPERA_CHECKS_ROOT"]+b"/"+E[b"QORPERA_CHECKS_NAME"]
objects=E[b"QORPERA_CHECKS_REPOSITORY"]+b"/objects"
try:
	with open(d+b"/site.wrote","rb") as f:
		lines=f.read().split(b"\n")
except FileNotFoundError:
	lines=[]
dropped=0
for i in lines:
	if re.fullmatch(rb"[0-9a-f]{40}",i):
		try:
			os.unlink(objects+b"/"+i[:2]+b"/"+i[2:])
			dropped+=1
		except OSError:
			pass
os.write(1,b"dropped %d\n"%dropped)`;

/** The drop (part C2 runs it when the boundary after the collect did not save everything, then asks the boundary once
 * more): the objects the collect wrote go again, before a refused one holds the session's storage (a secret value the
 * machine's masks cover is in one, or the save check could not finish). Its environment: QORPERA_CHECKS_ROOT,
 * QORPERA_CHECKS_NAME, QORPERA_CHECKS_REPOSITORY. Uses bash, python3 and the guard's `basename`. Exits 0 with
 * `dropped <n>` (`codeSiteDropAnswer`), 91 when a newer run's folder stands (nothing removed). */
export const CODE_SITE_DROP = [
	...CODE_CHECKS_NEWER_RUN,
	'exec 2>>"$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME/site.err"',
	"exec python3 -I - <<'QORPERA_SITE'",
	DROP_PY,
	"QORPERA_SITE",
].join("\n");

// The answers ---------------------------------------------------------------------------------------------------------

const MADE = /^tree ([0-9a-f]{40})\nfiles ([1-9][0-9]{0,2})\nbytes (0|[1-9][0-9]{0,7})\n$/;
const REFUSED = /^(SITE_[A-Z_]+)(?: ([^\n]+))?\n$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const WITHOUT_DETAIL: readonly CodeSiteProblemCode[] = [
	"SITE_FOLDER_MISSING",
	"SITE_NO_INDEX",
	"SITE_TOO_MANY_FILES",
	"SITE_TOO_MANY_FOLDERS",
	"SITE_TOO_LARGE",
];

/** A detail as the collect wrote it: `\xHH` is that byte, every other character itself, and the bytes UTF-8 (one that
 * is not shows as U+FFFD). */
function unescaped(detail: string): string {
	const parts = detail
		.split(/(\\x[0-9a-f]{2})/)
		.map((part) =>
			/^\\x[0-9a-f]{2}$/.test(part) ? Buffer.from([Number.parseInt(part.slice(2), 16)]) : Buffer.from(part, "utf8"),
		);
	return new TextDecoder().decode(Buffer.concat(parts));
}

/** The collect's ending, from its exit code and its whole output (stdout and stderr as one, masked): `made` for exit 0
 * and exactly its three lines (a tree's id, 1 to 500 files, at most 25 MiB); a problem for exit 3 and exactly one line
 * of one of the eight codes with the detail its code has; null for anything else, which is not the command's own ending
 * (91 included). Pure. */
export function codeSiteCollectAnswer(
	output: string,
	exitCode: number | null,
): { made: { tree: string; files: number; bytes: number } } | { problem: CodeSiteProblem } | null {
	if (exitCode === 0) {
		const made = MADE.exec(output);
		if (!made) return null;
		const files = Number(made[2]),
			total = Number(made[3]);
		return files <= CODE_SITE_MAX_FILES && total <= CODE_SITE_MAX_BYTES
			? { made: { tree: made[1] as string, files, bytes: total } }
			: null;
	}
	if (exitCode !== 3) return null;
	const refused = REFUSED.exec(output);
	if (!refused) return null;
	const code = refused[1] as CodeSiteProblemCode,
		detail = refused[2];
	if (WITHOUT_DETAIL.includes(code))
		return detail === undefined ? { problem: { code, path: null, variable: null } } : null;
	if (detail === undefined) return null;
	if (code === "SITE_FILE_TOO_LARGE" || code === "SITE_FILE_NAME")
		return { problem: { code, path: unescaped(detail), variable: null } };
	if (code !== "SITE_HOLDS_SECRET") return null;
	const space = detail.indexOf(" "),
		variable = detail.slice(0, space);
	return space > 0 && VARIABLE.test(variable) && space < detail.length - 1
		? { problem: { code, path: unescaped(detail.slice(space + 1)), variable } }
		: null;
}

/** The drop's ending: how many objects it removed, for exit 0 and exactly its line; null for anything else. Pure. */
export function codeSiteDropAnswer(output: string, exitCode: number | null): number | null {
	const dropped = /^dropped (0|[1-9][0-9]{0,5})\n$/.exec(output);
	return exitCode === 0 && dropped ? Number(dropped[1]) : null;
}

// What the report and the words say ------------------------------------------------------------------------------------

const TREE = /^[0-9a-f]{40}$/;
const MISSED = /^[A-Z0-9_:]{1,120}$/;

/** The `site` of a landing's report v3 (`qorpera.code-change-report/v3`), exactly as the kernel takes it: JSON null for
 * no site (no recipe, or sites switched off), `{"state":"made","site":{"schema":"qorpera.code-site/v1","tree","files",
 * "bytes","folder","name","title"}}` or `{"state":"missed","code"}`. A value the kernel would refuse throws
 * `INVALID_CODE_SITE`. Pure. */
export function codeSiteReported(collected: CodeSiteCollected | null): Record<string, unknown> | null {
	if (collected === null) return null;
	if (collected.state === "missed") {
		if (!MISSED.test(collected.code)) throw new Error("INVALID_CODE_SITE");
		return { state: "missed", code: collected.code };
	}
	const { tree, files, bytes: total, folder, name, title } = collected;
	if (
		!TREE.test(tree) ||
		!Number.isSafeInteger(files) ||
		files < 1 ||
		files > CODE_SITE_MAX_FILES ||
		!Number.isSafeInteger(total) ||
		total < 0 ||
		total > CODE_SITE_MAX_BYTES ||
		!codeSiteFolderValid(folder) ||
		(name !== null && !codeSiteNameValid(name)) ||
		(title !== null && !codeSiteTitleValid(title))
	)
		throw new Error("INVALID_CODE_SITE");
	return { state: "made", site: { schema: "qorpera.code-site/v1", tree, files, bytes: total, folder, name, title } };
}

/** `CODING_CHECKS_SITE_REFUSED`: every check passed, but the site the code left in `folder` cannot go, so nothing went
 * into main (STEP4-RELEASES-PLAN.md 10.3, with STEP4-BUILD.md's eighth code). Within 3,500 bytes, as every word of a
 * failed turn: the folder and a path are shown on one line and cut. Pure. */
export function codeSiteRefusedSummary(problem: CodeSiteProblem, folder: string): string {
	const path = shown(problem.path ?? "", 300);
	let what: string;
	switch (problem.code) {
		case "SITE_FOLDER_MISSING":
			what = "is not there (no folder of that name once the checks ran; a link is not followed)";
			break;
		case "SITE_NO_INDEX":
			what = "has no index.html at its top";
			break;
		case "SITE_TOO_MANY_FILES":
			what = `has more than ${CODE_SITE_MAX_FILES} web files`;
			break;
		case "SITE_TOO_MANY_FOLDERS":
			what = `has web files in more than ${CODE_SITE_MAX_FOLDERS} folders`;
			break;
		case "SITE_FILE_TOO_LARGE":
			what = `has a file over 10 MB: ${path}`;
			break;
		case "SITE_TOO_LARGE":
			what = "is over 25 MB";
			break;
		case "SITE_FILE_NAME":
			what =
				`has a file whose name a site cannot serve: ${path} (only letters, digits, dots, hyphens and underscores, ` +
				"each part starting with a letter, a digit or an underscore and at most 200 bytes, at most 16 parts and 512 " +
				"bytes in all)";
			break;
		case "SITE_HOLDS_SECRET":
			what =
				problem.variable !== null && problem.path !== null
					? `holds the value of ${shown(problem.variable, 128)} in ${path}`
					: "holds one of this session's secret values";
			break;
	}
	const key = problem.code === "SITE_HOLDS_SECRET" ? " A key must never be built into the site." : "";
	return `Nothing went into main: every check passed, but the site in "${shown(folder, 300)}" ${what}.${key} Fix it in the code or in the checks file's "site", and finish again. [code=CODING_CHECKS_SITE_REFUSED]`;
}
