import { createHash } from "node:crypto";
import { bytes, oneLine, shown } from "./code-words.ts";

/** A repository's website (own code storage, step 4, part C1; STEP4-RELEASES-PLAN.md 5 and 8.1, as STEP4-BUILD.md
 * section 2 replaced them). A repository says in its checks file which folder its checks leave the built site in
 * (`"site": {"folder": "dist"}`). Once every check of a run passed, the executor's runner starts one more command of the
 * run, the collect (`CODE_SITE_COLLECT`): it takes the folder's web files from the clean copy on the session's machine
 * and writes them as git objects, their blobs and one tree, into the repository's own storage, where the upload pass
 * reads the tree later (`code-host-sites.ts`). Whenever a collect that started has ended without a site made and saved
 * by the folder's boundary, the drop (`CODE_SITE_DROP`) removes again what it wrote (not after its exit 91, nor after
 * the turn's abort). This file holds what is pure of it: the site's rules, both commands' texts and how their answers
 * read, the report's value and the words of a refused site. It imports nothing of the platform's
 * (`deploy/coding-machine/test/code-checks-scripts.mjs` prints its commands with Node alone). */

/** A site's bounds, `publish_site`'s: files, bytes in all, bytes a file, and folders below the site's top that lead to a
 * file (every folder on a file's way counts: `a/b/c.css` counts `a` and `a/b`, each one tree the collect writes, so
 * that its blobs, trees and new object folders stay well within the 1,000 units of one save of the company folder). */
export const CODE_SITE_MAX_FILES = 500;
export const CODE_SITE_MAX_BYTES = 25 * 1024 * 1024;
const CODE_SITE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CODE_SITE_MAX_FOLDERS = 100;
/** A site path's most bytes, beside the path rule (`qorpera_site_path_valid`). */
const CODE_SITE_MAX_PATH_BYTES = 512;
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
	"vtt",
	"md",
	"rss",
	"atom",
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
	"wasm",
	"glb",
	"gltf",
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
	| "SITE_HOLDS_SECRET"
	| "SITE_LINKS_FROM_ROOT";

/** What the code made wrong in its site: the file it is about (`SITE_FILE_TOO_LARGE`, `SITE_FILE_NAME`,
 * `SITE_LINKS_FROM_ROOT`, and `SITE_HOLDS_SECRET` as the collect found it; null when its path holds a secret value or
 * would not fit whole), the secret variable whose value a file or its path holds, and for `SITE_LINKS_FROM_ROOT` how
 * many links from the root the file has (null when the file is not named). Never a byte of a file's content: a link
 * is never named (review round 3 of #1691: any piece our own parser cuts out of a file can be a piece of a value no
 * mask knows whole). A secret found only by the folder's save check names neither file nor variable. */
export interface CodeSiteProblem {
	readonly code: CodeSiteProblemCode;
	readonly path: string | null;
	readonly variable: string | null;
	readonly links?: number | null;
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
			readonly kind?: "static" | "server" | "hybrid";
			readonly dockerfile?: string | null;
			readonly port?: number;
			readonly healthPath?: string;
			readonly idleTimeoutSec?: number;
			readonly memoryMb?: number;
			readonly vcpuLimit?: number;
			readonly spaFallback?: string | null;
	  }
	| { readonly state: "missed"; readonly code: string };

// The recipe's rules, as the kernel checks a made site (qorpera_code_site_valid, 20260930729000) -------------------------

const NAME = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
/** The names a site never takes, the platform's own under qorpera.com (own code storage, step 5, rule D20): the text of
 * `qorpera_site_reserved_names()` (migration 20260930756000) byte for byte, names split by one space. A new platform
 * name is added there by a migration, then here; code-site.test.ts fails while the two differ. */
export const CODE_SITE_RESERVED_NAMES =
	"api app www admin assets static qorpera login signin signup robots favicon sites site well-known help support status mail functions auth rest storage realtime objects inbox send screens edge coding noreply staging dev test preview next docs blog news account accounts billing pay payments checkout secure security sso id oauth my dashboard console portal cdn media files download downloads smtp imap pop mx autoconfig autodiscover abuse postmaster hostmaster webmaster ns1 ns2 vpn git code data db ws live screen desktop computer health metrics tunnel gateway relay hooks webhooks events invite invites join team teams company companies members cofounder agent agents chat email webmail calendar ftp m mobile wiki shop store home root system internal private public demo beta";
const RESERVED = new Set(CODE_SITE_RESERVED_NAMES.split(" "));
const MAX_FOLDER_BYTES = 300;
const MAX_TITLE_CHARACTERS = 120;

/** A site's name (`qorpera_site_slug_valid`, as migration 20260930756000 leaves it, rule D20): 3 to 48 of a-z, 0-9 and
 * `-`, from and to a letter or a digit, never two hyphens in a row (a site's own host is `<name>.qorpera.com` and its
 * next host `<name>--next.qorpera.com`), never ending `-preview` (an app link's host), never holding `qorpera`, and none
 * of the names a site never gets (`CODE_SITE_RESERVED_NAMES`). */
export function codeSiteNameValid(name: string): boolean {
	return codeSiteNameRefusal(name) === null;
}

/** The name rule in one sentence, as every refusal of a site's name says it: the kernel's SITE_NAME_INVALID of
 * publish_site, share_app and unpublish_site (`qorpera_site_name_words()`, migration 20260930756000), the runtime's for a
 * slug of the wrong shape, and this executor's for a checks file's `site.name`, byte for byte (code-site.test.ts reads
 * the migration's text). */
export const CODE_SITE_NAME_RULE =
	"A site's name is 3 to 48 characters of a to z, 0 to 9 and single hyphens, starts and ends with a letter or digit, does not end in -preview, does not contain qorpera, and is not a reserved name (such as app, api, mail, shop, login).";

/** What is wrong with a site's name, as the checks file's refusal says it to the session (at most 300 bytes, which the
 * refusal's words show whole): the rule (`CODE_SITE_NAME_RULE`), which part of it the name breaks, and what to do; null
 * for a name that is one. Never the name itself: the session knows what it wrote. */
export function codeSiteNameRefusal(name: string): string | null {
	let broken: string;
	if (!NAME.test(name)) broken = "";
	else if (name.includes("--")) broken = " This one has two hyphens in a row.";
	else if (name.endsWith("-preview")) broken = " This one ends in -preview.";
	else if (name.includes("qorpera")) broken = " This one contains qorpera.";
	else if (RESERVED.has(name)) broken = " This one is a reserved name.";
	else return null;
	return `${CODE_SITE_NAME_RULE}${broken} Pick another, or leave name out.`;
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
 * (the recipe's folder), QORPERA_SITE_SECRET_NAMES (the session's secret variables, space separated) and
 * QORPERA_SITE_ROOT_LINKS (`allowed` while sites have hosts of their own, else `refused`: step 4a). In order:
 * 1. `$d/site.wrote` is made empty, before anything is written.
 * 2. The folder below `$d/src`, each part a folder and none a link, else `SITE_FOLDER_MISSING`.
 * 3. Its files, links never followed or listed: every regular file with no part starting with a dot whose extension a
 *    site serves, in C order. Each, in turn: the name rule (`SITE_FILE_NAME`), its bytes read once (at most 10 MiB and
 *    one byte: `SITE_FILE_TOO_LARGE`), then the count, the total and the folders. Then `index.html` at the top.
 * 4. The secret scan: for each name whose value in this command's environment has at least 8 bytes (the mask's own
 *    least), whether a file's bytes or its path hold it, byte for byte (`SITE_HOLDS_SECRET <NAME> <path>`). No value is
 *    printed, in any spelling: a path the answer would name that holds one of those values is never named (release
 *    review, F1: the transport masks the answer while its paths are still written `\xHH`, so a value with a backslash
 *    or a byte outside printable ASCII passed the mask and came back whole once read). The answer is then
 *    `SITE_HOLDS_SECRET <NAME>` alone, whatever rule the path met first.
 * 4a. The links from the root (the first live site, 11 Nov: a page that loads `/src/app.js` asks the domain's top for
 *    it, never its site, which is served at `https://sites.qorpera.com/<slug>/~s<visitor>/`): each `.html` and `.htm`
 *    file, read with Python's own HTML parser (tags and attributes of any case, values quoted or bare, character
 *    references decoded; comments, and the text of `script`, `style` and every other element, are no attributes), for
 *    `href`, `src`, `poster`, `action`, `formaction`, `xlink:href`, `background`, `data` on `object`, each URL of a
 *    `srcset`, an `imagesrcset` or a `ping`, the URL of a `<meta http-equiv="refresh">`, and the CSS of a `style`
 *    element or attribute; each `.css` file as CSS. CSS is tokenized as CSS Syntax 3 says, for the tokens that load
 *    something: comments between any tokens; escapes (a backslash and up to six hex digits with one space after them,
 *    or a backslash and any other character) decoded in names, strings and URLs, so `u\72l(` is `url(` and
 *    `@im\70ort` is `@import`; a `url(` token (a bare URL to its `)`, an escaped `)` or quote inside it included; one
 *    with a space, a quote, a parenthesis or a control inside is a bad URL, which CSS drops); the string of `url("…")`
 *    and `src("…")`, each string directly inside `image-set(` and `-webkit-image-set(`, and the string right after
 *    `@import`. Any other string is no link. A value that starts with one `/` once a browser has read it (the spaces
 *    and controls at its ends and every tab and line break dropped, a backslash taken as a slash) is a link from the
 *    root; `//host`, a scheme, `#`, `?` and an empty value are not. The first file in C order that has any refuses the
 *    site: `SITE_LINKS_FROM_ROOT <file> <n>`, n the number of them in that file. **The link itself is never printed**
 *    (review round 3 of #1691: any piece our own parser cuts out of a file's content can be a piece of a value no mask
 *    knows whole, however careful the parser), so the reading only decides yes or no, and counts. Scripts and SVG files
 *    are not read. A file whose path holds a secret value is never named (step 4's rule): `SITE_HOLDS_SECRET <NAME>`
 *    alone. Each page and style sheet is read once more as text, at most 25 MiB in all, in time linear in its size.
 *    Only while QORPERA_SITE_ROOT_LINKS is exactly `allowed` is none of it read (own code storage, step 5, D15): a site
 *    is then served at the top of its own host, `https://<name>.qorpera.com/`, where a link from the root is its own.
 *    Any other value, or none, reads as before.
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
 * backslashes written `\xHH` (lowercase), at most 1,000 bytes. A detail is printed whole or not at all (review of
 * #1691, F1: a cut one can carry the start of a value that neither the transport's mask nor the host's knows whole): a
 * path that does not fit leaves the code alone (or `SITE_HOLDS_SECRET <NAME>`). No detail holds a byte of a file's
 * content: a path, a variable's name, a count. Anything that is not the code's fault exits otherwise: 2 for a run folder
 * or a recipe that is not as the host made it, 4 for a file that changed while it was taken or a git command that
 * failed, 1 for anything else Python could not do. */
const COLLECT_PY = String.raw`import hashlib,html.parser,os,re,shutil,stat,subprocess,sys
E=os.environb
d=E[b"QORPERA_CHECKS_ROOT"]+b"/"+E[b"QORPERA_CHECKS_NAME"]
w=os.open(d+b"/site.wrote",os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_APPEND,0o644)
def say(code,detail=b""):
	os.write(1,code+(b" "+detail if detail else b"")+b"\n")
	sys.exit(3)
def esc(p):
	return b"".join(bytes([c]) if 32<=c<127 and c!=92 else b"\\x%02x"%c for c in p)
NAME=re.compile(rb"[A-Za-z_][A-Za-z0-9_]{0,127}")
SECRETS=[]
for name in E.get(b"QORPERA_SITE_SECRET_NAMES",b"").split():
	value=E.get(name) if NAME.fullmatch(name) else None
	if value is not None and len(value)>=8:
		SECRETS.append((name,value))
def named(code,p,variable=b"",count=0):
	held=[name for name,value in SECRETS if value in p]
	if held:
		say(b"SITE_HOLDS_SECRET",variable or held[0])
	detail=(variable+b" " if variable else b"")+esc(p)+(b" %d"%count if count else b"")
	say(code,detail if len(detail)<=1000 else variable)
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
		named(b"SITE_FILE_NAME",p)
	fd=os.open(top+b"/"+p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
	with os.fdopen(fd,"rb") as f:
		if not stat.S_ISREG(os.fstat(fd).st_mode):
			sys.exit(4)
		content=f.read(${CODE_SITE_MAX_FILE_BYTES}+1)
	if len(content)>${CODE_SITE_MAX_FILE_BYTES}:
		named(b"SITE_FILE_TOO_LARGE",p)
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
for name,value in SECRETS:
	for p,content in files:
		if value in content or value in p:
			named(b"SITE_HOLDS_SECRET",p,name)
# Links from the root: a help, so that an agent hears "use relative links" before a site goes out without its design.
# No security boundary, and nothing depends on it being complete: a spelling it misses leaves the site exactly as it
# would be without the check. It reads pages and styles as a browser does, and where it must guess, it counts a link.
BLANK="".join(map(chr,range(33)))
def rooted(u):
	t=u.strip(BLANK).replace("\t","").replace("\n","").replace("\r","")
	t=t[:2].replace("\\","/")+t[2:]
	return t[:1]=="/" and t[1:2]!="/"
CSS_ESC=r"\\(?:[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?|[^\n\r\f0-9a-fA-F]|\Z)"
CSS_NAME=r"(?:[\w\-\u0080-\U0010ffff]|"+CSS_ESC+r")+"
CSS=re.compile(r"(?P<c>/\*.*?(?:\*/|\Z))|\"(?P<dq>(?:[^\"\\\n]|\\[\s\S]|\\\Z)*)(?P<dqe>\"|\Z)?|'(?P<sq>(?:[^'\\\n]|\\[\s\S]|\\\Z)*)(?P<sqe>'|\Z)?|@(?P<at>"+CSS_NAME+r")|#"+CSS_NAME+r"|(?P<n>"+CSS_NAME+r")(?P<f>\()?|(?P<o>\()|(?P<x>\))|(?P<d>[^\"'@#/()\\\w\-\u0080-\U0010ffff]+)|[\s\S]",re.S)
WS=re.compile(r"[ \t\n\r\f]*")
URL=re.compile(r"[ \t\n\r\f]*((?:[^)\"'(\\ \t\n\r\f\x00-\x08\x0b\x0e-\x1f\x7f]|"+CSS_ESC+r")*)[ \t\n\r\f]*")
BAD=re.compile(r"(?:\\[^\n\r\f]|[^)])*\)?",re.S)
UNESC=re.compile(r"\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S])|(\Z))")
def unesc(text,end="\ufffd"):
	def one(m):
		if m[1]:
			c=int(m[1],16)
			return chr(c) if 0<c<=0x10FFFF and not 0xD800<=c<=0xDFFF else "\ufffd"
		if m[4] is not None:
			return end
		return "" if m[2] else m[3]
	return UNESC.sub(one,text)
SURROGATE=re.compile("[\ud800-\udfff]")
def css(text):
	text=SURROGATE.sub("\ufffd",text.replace("\r\n","\n").replace("\r","\n").replace("\f","\n").replace("\0","\ufffd"))
	count=0
	stack=[]
	importing=False
	pos=0
	while pos<len(text):
		m=CSS.match(text,pos)
		pos=m.end()
		kind=m.lastgroup
		if kind=="c" or (kind=="d" and not m[0].strip(" \t\n\r\f")):
			continue
		if kind in ("dqe","sqe"):
			if importing or (stack and stack[-1]!="("):
				count+=rooted(unesc(m[kind[:2]],""))
		elif kind=="f":
			name=unesc(m["n"]).lower()
			ahead=WS.match(text,pos).end()
			if name=="url" and text[ahead:ahead+1] not in ("'",'"'):
				u=URL.match(text,pos)
				pos=u.end()
				if pos==len(text) or text[pos]==")":
					count+=rooted(unesc(u[1]))
					pos+=1
				else:
					pos=BAD.match(text,pos).end()
			else:
				stack.append("u" if name in ("url","src","image-set","-webkit-image-set") else "(")
		elif kind=="o":
			stack.append("(")
		elif kind=="x" and stack:
			stack.pop()
		importing=kind=="at" and unesc(m["at"]).lower()=="import"
	return count
WSP="\t\n\f\r "
LOWER=str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz")
def srcset(v):
	count=0
	at=0
	while at<len(v):
		while at<len(v) and v[at] in WSP+",":
			at+=1
		start=at
		while at<len(v) and v[at] not in WSP:
			at+=1
		u=v[start:at]
		if u.endswith(","):
			u=u.rstrip(",")
		else:
			depth=0
			while at<len(v):
				c=v[at]
				at+=1
				if c=="(":
					depth+=1
				elif c==")" and depth:
					depth-=1
				elif c=="," and not depth:
					break
		count+=rooted(u)
	return count
REFRESH=re.compile(r"[\t\n\f\r ]*[0-9.]+(?=[;,\t\n\f\r ]|\Z)[\t\n\f\r ]*[;,]?[\t\n\f\r ]*(?:url[\t\n\f\r ]*=[\t\n\f\r ]*)?(.*)",re.I|re.S)
LEADS=("href","src","poster","action","formaction","xlink:href","background")
RAW=("script","style","xmp","iframe","noembed","noframes","plaintext","textarea","title")
VOID=set("area base basefont bgsound br col embed frame hr image img input keygen link meta param source track wbr".split())
BREAKOUT=set("b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var".split())
SCRIPT_NEXT=re.compile(r"-+|[<>]")
DELIMS=("\t","\n","\f","\r"," ","/",">")
def script_end(raw,i):
	state=0
	dashes=0
	while True:
		m=SCRIPT_NEXT.search(raw,i)
		if not m:
			return -1
		if m.start()>i:
			dashes=0
		i=m.start()
		if raw[i]=="-":
			dashes+=m.end()-i
			i=m.end()
		elif raw[i]==">":
			if dashes>=2:
				state=0
			dashes=0
			i+=1
		elif state==0 and raw.startswith("<!--",i):
			state=1
			dashes=2
			i+=4
		elif raw[i+1:i+2]=="/" and raw[i+2:i+8].lower()=="script" and raw[i+8:i+9] in DELIMS:
			if state<2:
				return i
			state=1
			dashes=0
			i+=8
		elif state==1 and raw[i+1:i+7].lower()=="script" and raw[i+7:i+8] in DELIMS:
			state=2
			dashes=0
			i+=7
		else:
			dashes=0
			i+=1
class At(int):
	def start(self):
		return int(self)
class ScriptEnd:
	def search(self,raw,pos):
		i=script_end(raw,pos)
		return None if i<0 else At(i)
def point(ns,tag,first):
	if ns=="svg":
		return tag in ("foreignobject","desc","title")
	if tag=="annotation-xml":
		return (first.get("encoding") or "").translate(LOWER) in ("text/html","application/xhtml+xml")
	return tag in ("mi","mo","mn","ms","mtext")
class Page(html.parser.HTMLParser):
	def __init__(self,later=None):
		super().__init__(convert_charrefs=True)
		self.links=0
		self.later=later
		self.doubt=False
		self.open=[]
		self.marks=[]
		self.names={}
		self.sheet=None
		self.opened_foreign=False
		self._support_cdata=False
	def node(self):
		if not self.open:
			return ("","",True,None)
		m=self.marks[-1]
		if m[0]==len(self.open)-1:
			return (self.open[-1],m[1],m[2],m[3])
		return (self.open[-1],m[1],False,None)
	def foreign(self):
		n=self.node()
		return not n[2] and n[1]!="html"
	def pop(self):
		self.names[self.open.pop()]-=1
		if self.marks[-1][0]==len(self.open):
			sheet=self.marks.pop()[3]
			if sheet is not None:
				self.links+=css("".join(sheet))
		if not self.open:
			self.doubt=False
	def push(self,tag,ns,pt,sheet):
		if pt or sheet is not None or not self.marks or self.marks[-1][1]!=ns:
			self.marks.append((len(self.open),ns,pt,sheet))
		tag=sys.intern(tag)
		self.open.append(tag)
		self.names[tag]=self.names.get(tag,0)+1
	def breakout(self):
		while self.foreign():
			self.pop()
	def set_cdata_mode(self,elem,**given):
		if self.opened_foreign:
			return
		try:
			super().set_cdata_mode(elem,**given)
		except TypeError:
			super().set_cdata_mode(elem)
		if self.cdata_elem=="script":
			self.interesting=ScriptEnd()
	def parse_comment(self,i,report=True):
		for close in (">","->"):
			if self.rawdata.startswith(close,i+4):
				return i+4+len(close)
		return super().parse_comment(i,report)
	def unknown_decl(self,data):
		if data.startswith("CDATA["):
			self.handle_data(data[6:])
			if self.doubt and self.later is not None and ">" in data:
				self.later.append(data[data.index(">")+1:])
	def handle_starttag(self,tag,attrs,closed=False):
		first={}
		for name,value in attrs:
			first.setdefault(name,value)
		if self.foreign() and (tag in BREAKOUT or (tag=="font" and ("color" in first or "face" in first or "size" in first))):
			self.breakout()
		cur,ns,pt,_=self.node()
		if ns=="html":
			at=self.marks[-2]
			cur,ns,pt=self.open[at[0]],at[1],True
		if pt and not (ns=="math" and cur!="annotation-xml" and tag in ("mglyph","malignmark")):
			ns=tag if tag in ("svg","math") else "html" if self.open else ""
		elif tag=="svg" and cur=="annotation-xml":
			ns="svg"
		self.opened_foreign=ns not in ("","html")
		for name,value in first.items():
			if value is None:
				continue
			if name in LEADS or (name=="data" and tag=="object"):
				self.links+=rooted(value)
			elif name in ("srcset","imagesrcset"):
				self.links+=srcset(value)
			elif name=="ping":
				self.links+=sum(rooted(u) for u in re.split("[\t\n\f\r ]",value))
			elif name=="style":
				self.links+=css(value)
			elif name=="content" and tag=="meta" and (first.get("http-equiv") or "").translate(LOWER)=="refresh":
				m=REFRESH.match(value)
				u=m.group(1) if m else ""
				if u[:1] in ("'",'"'):
					u=u[1:].split(u[0],1)[0]
				self.links+=rooted(u)
		if self.opened_foreign:
			if not closed:
				self.push(tag,ns,point(ns,tag,first),[] if ns=="svg" and tag=="style" else None)
		elif tag in RAW:
			self.set_cdata_mode(tag,escapable=tag in ("textarea","title"))
			if tag=="style":
				self.sheet=[]
		elif ns and tag not in VOID:
			self.push(tag,ns,False,None)
		self._support_cdata=self.node()[1] not in ("","html")
	def handle_startendtag(self,tag,attrs):
		self.handle_starttag(tag,attrs,True)
	def handle_endtag(self,tag):
		if self.cdata_elem:
			if self.sheet is not None:
				self.links+=css("".join(self.sheet))
				self.sheet=None
		else:
			if tag in ("br","p"):
				self.breakout()
			if self.names.get(tag):
				while self.open[-1]!=tag:
					if self.node()[1]=="html":
						self.doubt=True
					self.pop()
				self.pop()
		self._support_cdata=self.node()[1] not in ("","html")
	def handle_data(self,data):
		if self.cdata_elem:
			if self.sheet is not None:
				self.sheet.append(data)
		elif self.open:
			sheet=self.node()[3]
			if sheet is not None:
				sheet.append(data)
	def close(self):
		super().close()
		while self.open:
			self.pop()
		if self.sheet is not None:
			self.links+=css("".join(self.sheet))
			self.sheet=None
for p,content in files if E.get(b"QORPERA_SITE_ROOT_LINKS")!=b"allowed" else ():
	kind=p.rsplit(b".",1)[-1].lower()
	links=0
	if kind in (b"html",b"htm"):
		later=[]
		page=Page(later)
		page.feed(content.decode("utf-8","surrogateescape"))
		page.close()
		links=page.links
		for text in later:
			again=Page()
			again.feed(text)
			again.close()
			links+=again.links
	elif kind==b"css":
		links=css(content.decode("utf-8","surrogateescape"))
	if links:
		named(b"SITE_LINKS_FROM_ROOT",p,count=links)
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

const APP_COLLECT_PY = String.raw`import os,stat,subprocess,sys
E=os.environb
d=E[b"QORPERA_CHECKS_ROOT"]+b"/"+E[b"QORPERA_CHECKS_NAME"]
top=d+b"/src"
if not stat.S_ISDIR(os.lstat(top).st_mode):
	sys.exit(2)
dockerfile=E.get(b"QORPERA_SITE_DOCKERFILE",b"")
if dockerfile:
	parts=dockerfile.split(b"/")
	if any(part in (b"",b".",b"..") for part in parts):
		sys.exit(2)
	target=top+b"/"+dockerfile
	try:
		mode=os.lstat(target).st_mode
	except OSError:
		os.write(1,b"SITE_FOLDER_MISSING\n")
		sys.exit(3)
	if not stat.S_ISREG(mode):
		os.write(1,b"SITE_FOLDER_MISSING\n")
		sys.exit(3)
ENV={b"PATH":E.get(b"PATH",b"/usr/bin:/bin"),b"HOME":d,b"LC_ALL":b"C",b"GIT_CONFIG_NOSYSTEM":b"1",b"GIT_CONFIG_GLOBAL":b"/dev/null"}
r=subprocess.run([b"git",b"-C",top,b"rev-parse",b"HEAD^{tree}"],stdout=subprocess.PIPE,env=ENV)
if r.returncode:
	sys.exit(4)
tree=r.stdout.strip()
if len(tree)!=40:
	sys.exit(4)
os.write(1,b"tree %s\nfiles 0\nbytes 0\n"%tree)`;

export const CODE_SITE_APP_COLLECT = [
	...CODE_CHECKS_NEWER_RUN,
	'exec 2>"$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME/site.err"',
	"exec python3 -I - <<'QORPERA_SITE_APP'",
	APP_COLLECT_PY,
	"QORPERA_SITE_APP",
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

/** The drop (part C2 runs it whenever a collect that started has ended without a site made and saved, but not after
 * its exit 91 nor after the turn's abort, and asks the boundary once more when one was asked after the collect): the
 * objects the collect wrote go again, before a refused one holds the session's storage (a secret value the machine's
 * masks cover is in one, or the save check could not finish). Its environment: QORPERA_CHECKS_ROOT,
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
const MADE_APP = /^tree ([0-9a-f]{40})\nfiles (0|[1-9][0-9]{0,4})\nbytes (0|[1-9][0-9]{0,9})\n$/;
const REFUSED = /^(SITE_[A-Z_]+)(?: ([^\n]+))?\n$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** A detail exactly as the collect spells one: printable ASCII but the backslash as itself, and every other byte (a
 * control, the backslash, DEL and each byte from 0x80) as `\xHH` in lowercase, at most 1,000 bytes. Any other spelling,
 * such as a printable byte written `\x41`, is not the collect's: it could carry a secret value past the mask, which
 * reads the answer before it is decoded (release review, F1). */
const DETAIL = /^(?:[\x20-\x5b\x5d-\x7e]|\\x(?:[01][0-9a-f]|5c|7f|[89a-f][0-9a-f]))+$/;
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
 * of one of the nine codes with the detail its code has, spelled as the collect spells one (`SITE_HOLDS_SECRET` with
 * its variable alone, or the variable and a path); null for anything else, which is not the command's own ending (91
 * included). A path it gives was masked before it was decoded: the host masks it again before it shows it anywhere.
 * Pure. */
export function codeSiteCollectAnswer(
	output: string,
	exitCode: number | null,
	options?: { readonly allowEmpty?: boolean },
): { made: { tree: string; files: number; bytes: number } } | { problem: CodeSiteProblem } | null {
	if (exitCode === 0) {
		if (options?.allowEmpty) {
			const made = MADE_APP.exec(output);
			if (!made) return null;
			const files = Number(made[2]);
			const total = Number(made[3]);
			return files <= 10_000 && total <= 512 * 1024 * 1024
				? { made: { tree: made[1] as string, files, bytes: total } }
				: null;
		}
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
	// A detail that would not fit whole is left out (review of #1691, F1): the code alone.
	if (detail === undefined) {
		if (code === "SITE_FILE_TOO_LARGE" || code === "SITE_FILE_NAME")
			return { problem: { code, path: null, variable: null } };
		return code === "SITE_LINKS_FROM_ROOT" ? { problem: { code, path: null, variable: null, links: null } } : null;
	}
	if (detail.length > 1000 || !DETAIL.test(detail)) return null;
	if (code === "SITE_FILE_TOO_LARGE" || code === "SITE_FILE_NAME")
		return { problem: { code, path: unescaped(detail), variable: null } };
	// The file, a path of the site (no space in it), then how many links from the root it has; never a link.
	if (code === "SITE_LINKS_FROM_ROOT") {
		const parts = /^([^ ]+) ([1-9][0-9]{0,8})$/.exec(detail);
		return parts
			? { problem: { code, path: unescaped(parts[1] as string), variable: null, links: Number(parts[2]) } }
			: null;
	}
	if (code !== "SITE_HOLDS_SECRET") return null;
	// The variable alone: the value is in a path the collect does not name.
	if (!detail.includes(" ")) return VARIABLE.test(detail) ? { problem: { code, path: null, variable: detail } } : null;
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
	const {
		tree,
		files,
		bytes: total,
		folder,
		name,
		title,
		kind,
		dockerfile,
		port,
		healthPath,
		idleTimeoutSec,
		memoryMb,
		vcpuLimit,
		spaFallback,
	} = collected;
	const hasV2Fields =
		kind !== undefined ||
		dockerfile !== undefined ||
		port !== undefined ||
		healthPath !== undefined ||
		idleTimeoutSec !== undefined ||
		memoryMb !== undefined ||
		vcpuLimit !== undefined ||
		spaFallback !== undefined;
	if (!hasV2Fields) {
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
		return {
			state: "made",
			site: { schema: "qorpera.code-site/v1", tree, files, bytes: total, folder, name, title },
		};
	}
	const effectiveKind = kind ?? "static";
	if (
		!TREE.test(tree) ||
		!Number.isSafeInteger(files) ||
		files < (effectiveKind === "static" ? 1 : 0) ||
		files > 10_000 ||
		!Number.isSafeInteger(total) ||
		total < 0 ||
		total > 512 * 1024 * 1024 ||
		!codeSiteFolderValid(folder) ||
		(name !== null && !codeSiteNameValid(name)) ||
		(title !== null && !codeSiteTitleValid(title))
	)
		throw new Error("INVALID_CODE_SITE");
	return {
		state: "made",
		site: {
			schema: "qorpera.code-site/v2",
			kind: effectiveKind,
			tree,
			files,
			bytes: total,
			folder,
			name,
			title,
			...(port !== undefined ? { port } : {}),
			...(healthPath !== undefined ? { healthPath } : {}),
			...(dockerfile !== undefined ? { dockerfile } : {}),
			...(idleTimeoutSec !== undefined ? { idleTimeoutSec } : {}),
			...(memoryMb !== undefined ? { memoryMb } : {}),
			...(vcpuLimit !== undefined ? { vcpuLimit } : {}),
			...(spaFallback !== undefined ? { spaFallback } : {}),
		},
	};
}

/** `CODING_CHECKS_SITE_REFUSED`: every check passed, but the site the code left in `folder` cannot go, so nothing went
 * into main (STEP4-RELEASES-PLAN.md 10.3, with STEP4-BUILD.md's eighth code and the links from the root, the ninth,
 * added once the first live site showed them). Within 3,500 bytes, as every word of a failed turn. A path is shown on
 * one line and whole, never cut (review of #1691, F1: a cut one can carry the start of a secret value that no mask
 * knows whole): when the words would pass 3,500 bytes, the path is left out. `opening` (an operator's drill's words and
 * a space, `CODE_DRILL_WORDS`) comes first and counts within them. Pure. */
export function codeSiteRefusedSummary(problem: CodeSiteProblem, folder: string, opening = ""): string {
	const words = `${opening}${refusedWords(problem, folder)}`;
	return bytes(words) <= MAX_SUMMARY_BYTES ? words : `${opening}${refusedWords({ ...problem, path: null }, folder)}`;
}

/** The most bytes the executor's words of a failed turn take (code-checks.ts keeps the same bound). */
const MAX_SUMMARY_BYTES = 3500;

function refusedWords(problem: CodeSiteProblem, folder: string): string {
	const path = oneLine(problem.path ?? "");
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
			what = problem.path === null ? "has a file over 10 MB" : `has a file over 10 MB: ${path}`;
			break;
		case "SITE_TOO_LARGE":
			what = "is over 25 MB";
			break;
		case "SITE_FILE_NAME":
			what =
				`has a file whose name a site cannot serve${problem.path === null ? "" : `: ${path}`} (only letters, digits, dots, hyphens and underscores, ` +
				"each part starting with a letter, a digit or an underscore and at most 200 bytes, at most 16 parts and 512 " +
				"bytes in all)";
			break;
		case "SITE_HOLDS_SECRET":
			what =
				problem.variable === null
					? "holds one of this session's secret values"
					: problem.path === null
						? `holds the value of ${shown(problem.variable, 128)} in one of its files or file names`
						: `holds the value of ${shown(problem.variable, 128)} in ${path}`;
			break;
		case "SITE_LINKS_FROM_ROOT": {
			const many = problem.path !== null && (problem.links ?? 1) > 1;
			const where = problem.path === null ? "" : ` in ${path}${many ? ` (${problem.links} of them)` : ""}`;
			what =
				`has ${many ? "links that start" : "a link that starts"} with /${where}. A site is served under an address of its ` +
				"own, never at the top of a domain: link its files with relative links (src/app.js, ../img/logo.png), in its " +
				'scripts too, which Qorpera does not read, or set your bundler\'s base path (Vite: base: "./")';
			break;
		}
	}
	const key = problem.code === "SITE_HOLDS_SECRET" ? " A key must never be built into the site." : "";
	return `Nothing went into main: every check passed, but the site in "${shown(folder, 300)}" ${what}.${key} Fix it in the code or in the checks file's "site", and finish again. [code=CODING_CHECKS_SITE_REFUSED]`;
}

// An operator's drill (own code storage, step 5, D17) ------------------------------------------------------------------

/** What a session reads first when an operator's drill (`qorpera_code_set_drill`, migration 20260930756000), which the
 * checks switch hands over once, failed its landing's checks or refused its site: so that the platform's own refusal
 * paths are proven live on work that is not meant to fail, and the session does not take them for its own fault. */
export const CODE_DRILL_WORDS =
	"This was a drill by Qorpera's operator: nothing is wrong with your work, and the next try goes through. Finish again.";

/** A `check` drill's check, run after the repository's own, as one more check of the run: it says it is a drill and
 * fails. A repository may name a check of its own the same: the drill's is the last of the run. */
export const CODE_CHECKS_DRILL = {
	name: "qorpera-drill",
	run: `echo "A drill by Qorpera's operator: this check fails on purpose, once."; exit 1`,
	timeoutSeconds: 10,
	cwd: ".",
} as const;

/** The folder a `site` drill's refusal names (`SITE_FOLDER_MISSING`). The host refuses the site itself, whatever the
 * repository holds (a repository may have a folder of this name: the review of #1774, F3); no collect looks for it. */
export const CODE_SITE_DRILL_FOLDER = "qorpera-drill-missing";
