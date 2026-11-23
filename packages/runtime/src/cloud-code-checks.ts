import { createHash, randomBytes } from "node:crypto";
import {
	type CloudCodingCommandReceipt,
	type CloudCodingCommandScope,
	CODE_CHECK_NAME_PATTERN,
	type CodeCheck,
	type CodeCheckArtifactFormat,
	type CodeChecksProblem,
	type CodePreviewRecipe,
	type CodeSiteKind,
	type CodeSiteRecipe,
	type CodeSurfaceGate,
	expandCodeCheckNeeds,
	type FailedTestCase,
	type JsonValue,
	MAX_CODE_CHECKS_FILE_BYTES,
	MAX_PARALLEL_CHECKS,
	type ParsedCodeChecks,
	parseCheckFailureArtifacts,
	parseCloudCodingCommandRead,
	parseCloudCodingCommandReceipt,
	parseCodeChecksText,
} from "@qorpera/contracts";
import type { CloudCodingCommandGateway } from "./cloud-coding-command-tools.ts";
import { CLOUD_COMMAND_PAGE_ASK } from "./cloud-command-page-fit.ts";
import { cloudControlPause } from "./cloud-control-errors.ts";
import { type CloudNativeToolIdentity, cloudToolRequest } from "./cloud-native-tool-authority.ts";
import {
	type CloudToolContent,
	type CloudToolContext,
	cloudToolJsonText,
	redactCloudWebhookSecrets,
} from "./cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "./cloud-native-tool-operations.ts";
import { fitsOneResult } from "./cloud-worker-tools.ts";

export { CODE_CHECK_NAME_PATTERN, MAX_CODE_CHECKS_FILE_BYTES, parseCodeChecksText };
export type { CodeChecksProblem, FailedTestCase, ParsedCodeChecks };
export type CodePreflightCheck = CodeCheck;
export type CodePreflightSiteKind = CodeSiteKind;
export type CodePreflightSite = CodeSiteRecipe;
export type CodePreflightPreview = CodePreviewRecipe;
export type CodePreflightSurfaceGate = CodeSurfaceGate;

export const MAX_PARALLEL_PREFLIGHT_CHECKS = MAX_PARALLEL_CHECKS;

const MAX_TAIL_LINES = 30;
const MAX_TAIL_BYTES = 1500;
const MAX_COMMAND_BYTES = 16384;
const MAX_COMMAND_JSON_BYTES = 60000;
const READ_CHECKS_TIMEOUT_MS = 30_000;
const CLEAN_COPY_TIMEOUT_MS = 120_000;
const SITE_VALIDATE_TIMEOUT_MS = 60_000;
const ARTIFACT_READ_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const MAX_POLL_MS = 1000;
const DEFAULT_TIMEOUT_GRACE_MS = 5000;
const CANCEL_ON_ABORT_MS = 5000;
const TAIL_READ_BYTES = 8192;

const SITE_EXTENSIONS_JSON = JSON.stringify([
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
]);

const READ_CHECKS_COMMAND =
	"if [ ! -e .qorpera/checks.json ] && [ ! -L .qorpera/checks.json ]; then exit 44; fi; if [ -L .qorpera ] || [ -L .qorpera/checks.json ] || [ ! -f .qorpera/checks.json ]; then exit 45; fi; if [ \"$(wc -c < .qorpera/checks.json)\" -gt 16384 ]; then exit 46; fi; if command -v iconv >/dev/null 2>&1; then iconv -f UTF-8 -t UTF-8 -- .qorpera/checks.json >/dev/null 2>&1 || exit 47; elif command -v node >/dev/null 2>&1; then node -e \"new TextDecoder('utf-8',{fatal:true}).decode(require('node:fs').readFileSync('.qorpera/checks.json'))\" >/dev/null 2>&1 || exit 47; fi; cat -- .qorpera/checks.json";

const CHANGE_INDEX_LINE = /^- (\d+) · (\d{4}-\d{2}-\d{2}) · ([^·]+?)(?: · (.*))?$/;
const CHANGE_INDEX_NOTICE =
	/^(?:Put back to an earlier copy|Brought in on|Live:|Ready in What's new:|Preparing for What's new:|Site taken down)/;

export interface CodeChangeSummary {
	readonly change: number;
	readonly date: string;
	readonly state: string;
	readonly summary: string;
}

export interface ParsedCodeChangesIndex {
	readonly notices: readonly string[];
	readonly totalListed: number;
	readonly changes: readonly CodeChangeSummary[];
}

export interface CodingPreflightCheckRequest {
	readonly operationKey: string;
	readonly checkNames?: readonly string[];
	readonly failFast?: boolean;
	readonly cleanCopy?: boolean;
	readonly validateSite?: boolean;
}

interface PreflightCheckOutcome {
	readonly name: string;
	readonly cwd: string;
	readonly needs?: readonly string[];
	readonly status: "passed" | "failed" | "cancelled" | "machine_stopped" | "unconfirmed";
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly ms: number;
	readonly commandId: string;
	readonly attempts?: number;
	readonly tail?: string;
	readonly failedTests?: readonly FailedTestCase[];
}

type PreflightSiteValidation =
	| { readonly state: "valid"; readonly folder: string; readonly files: number; readonly bytes: number }
	| {
			readonly state: "invalid";
			readonly folder: string;
			readonly problem: { readonly code: string; readonly path: string | null };
	  }
	| { readonly state: "no_site" }
	| { readonly state: "error"; readonly folder: string; readonly reason: string };

function isControlPoint(point: number): boolean {
	return point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029;
}

function isUnseenPoint(point: number): boolean {
	return (
		isControlPoint(point) ||
		(point >= 0x200b && point <= 0x200f) ||
		(point >= 0x202a && point <= 0x202e) ||
		(point >= 0x2066 && point <= 0x2069) ||
		point === 0xfeff
	);
}

export function parseCodeChangesIndex(text: string, maxChanges = 15): ParsedCodeChangesIndex {
	const notices: string[] = [];
	const changes: CodeChangeSummary[] = [];
	let totalListed = 0;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = CHANGE_INDEX_LINE.exec(line);
		if (match) {
			totalListed++;
			if (changes.length < maxChanges) {
				changes.push({
					change: Number(match[1]),
					date: match[2]!,
					state: match[3]!.trim(),
					summary: (match[4] ?? "").trim(),
				});
			}
			continue;
		}
		if (CHANGE_INDEX_NOTICE.test(line) && notices.length < 6) notices.push(line);
	}
	return { notices, totalListed, changes };
}

function endOfLine(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const ellipsis = "…";
	const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
	if (maxBytes < ellipsisBytes) return "";
	const chars = Array.from(text);
	let used = ellipsisBytes;
	let from = chars.length;
	while (from > 0) {
		const size = Buffer.byteLength(chars[from - 1]!, "utf8");
		if (used + size > maxBytes) break;
		used += size;
		from--;
	}
	return `${ellipsis}${chars.slice(from).join("")}`;
}

export function codeChecksTail(output: string, maxBytes = MAX_TAIL_BYTES): string {
	if (maxBytes <= 0) return "";
	let clean = "";
	for (const character of output.replaceAll("\r\n", "\n")) {
		const point = character.codePointAt(0) as number;
		const halfSurrogate = point >= 0xd800 && point <= 0xdfff;
		clean += character !== "\n" && (halfSurrogate || isUnseenPoint(point)) ? "\uFFFD" : character;
	}
	const lines = clean.split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0 && kept.length < MAX_TAIL_LINES; index--) {
		const line = lines[index]!;
		const size = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
		if (used + size <= maxBytes) {
			kept.unshift(line);
			used += size;
			continue;
		}
		if (kept.length === 0) kept.unshift(endOfLine(line, maxBytes));
		break;
	}
	while (kept.length > 0 && kept[0] === "") kept.shift();
	return kept.join("\n");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildPreflightCheckCommand(
	check: Pick<CodePreflightCheck, "cwd" | "run" | "env">,
	workDir?: string,
): string {
	const envPrefix = check.env
		? `${Object.entries(check.env)
				.map(([k, v]) => `${k}=${shellQuote(v)}`)
				.join(" ")} `
		: "";
	const inner = `${envPrefix}CI=true QORPERA_CHECKS=1 /bin/bash --noprofile --norc -c ${shellQuote(check.run)} </dev/null`;
	const targetDir = workDir === undefined ? check.cwd : check.cwd === "." ? workDir : `${workDir}/${check.cwd}`;
	return targetDir === "." ? inner : `( cd -- ${shellQuote(targetDir)} && ${inner} )`;
}

function buildCleanCopySetupCommand(hash: string): string {
	return [
		"set -eu",
		`dir="$HOME/.qorpera-preflight/${hash}"`,
		'rm -rf -- "$dir"',
		'mkdir -p -- "$HOME/.qorpera-preflight"',
		'commit="$(git rev-parse --verify HEAD 2>/dev/null)" || exit 48',
		'dirty="$(git status --porcelain 2>/dev/null | head -n 1 || true)"',
		'git clone --quiet --shared --no-checkout -- . "$dir"',
		'git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach "$commit"',
		'state="clean"; [ -z "$dirty" ] || state="dirty"',
		'printf \'QORPERA_CLEAN_COPY %s %s %s\\n\' "$commit" "$state" "$dir"',
	].join("\n");
}

function buildCleanCopyDropCommand(hash: string): string {
	return `rm -rf -- "$HOME/.qorpera-preflight/${hash}"`;
}

function buildReadChecksCommand(workDir?: string): string {
	return workDir === undefined ? READ_CHECKS_COMMAND : `( cd -- ${shellQuote(workDir)} && ${READ_CHECKS_COMMAND} )`;
}

function buildSiteValidateCommand(folder: string, workDir?: string): string {
	const base = workDir ?? ".";
	const py = [
		"import json,os,re,sys",
		`EXT=set(${SITE_EXTENSIONS_JSON})`,
		'PATH_RE=re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}(/[A-Za-z0-9_][A-Za-z0-9._-]{0,199}){0,15}$")',
		'EXT_RE=re.compile(r"\\.([A-Za-z0-9]{1,12})$")',
		"def fail(code,p=''):print('QORPERA_SITE_PROBLEM '+code+(' '+p if p else ''));sys.exit(3)",
		"root=sys.argv[1];folder=sys.argv[2]",
		"cur=root",
		'if folder!=".":',
		'\tfor part in folder.split("/"):',
		"\t\tcur=os.path.join(cur,part)",
		"\t\tif os.path.islink(cur) or not os.path.isdir(cur):fail('SITE_FOLDER_MISSING')",
		"elif os.path.islink(cur) or not os.path.isdir(cur):fail('SITE_FOLDER_MISSING')",
		"files=0;total=0;folders=set();has_index=False",
		"for dp,dns,fns in os.walk(cur,followlinks=False):",
		'\tdns[:]=[d for d in sorted(dns) if not d.startswith(".") and not os.path.islink(os.path.join(dp,d))]',
		"\tfor fn in sorted(fns):",
		'\t\tif fn.startswith("."):continue',
		"\t\tfp=os.path.join(dp,fn)",
		"\t\tif os.path.islink(fp) or not os.path.isfile(fp):continue",
		"\t\tm=EXT_RE.search(fn)",
		"\t\tif not m or m.group(1).lower() not in EXT:continue",
		'\t\trel=os.path.relpath(fp,cur).replace(os.sep,"/")',
		"\t\tif len(rel.encode('utf-8'))>512 or not PATH_RE.fullmatch(rel):fail('SITE_FILE_NAME',rel)",
		"\t\tsz=os.lstat(fp).st_size",
		"\t\tif sz>10*1024*1024:fail('SITE_FILE_TOO_LARGE',rel)",
		"\t\tfiles+=1",
		"\t\tif files>500:fail('SITE_TOO_MANY_FILES')",
		"\t\ttotal+=sz",
		"\t\tif total>25*1024*1024:fail('SITE_TOO_LARGE')",
		'\t\tparts=rel.split("/")',
		"\t\tfor i in range(1,len(parts)):folders.add('/'.join(parts[:i]))",
		"\t\tif len(folders)>100:fail('SITE_TOO_MANY_FOLDERS')",
		"\t\tif rel=='index.html':has_index=True",
		"if not has_index:fail('SITE_NO_INDEX')",
		"print(f'QORPERA_SITE_OK {files} {total}')",
	].join("\n");
	return `python3 -I - ${shellQuote(base)} ${shellQuote(folder)} <<'QORPERA_SITE_VALIDATE_EOF'\n${py}\nQORPERA_SITE_VALIDATE_EOF`;
}

function buildServerSiteValidateCommand(dockerfile: string, workDir?: string): string {
	const base = workDir ?? ".";
	const py = [
		"import os,stat,sys",
		"def fail(code,p=''):print('QORPERA_SITE_PROBLEM '+code+(' '+p if p else ''));sys.exit(3)",
		"root=sys.argv[1];dockerfile=sys.argv[2]",
		"if not stat.S_ISDIR(os.lstat(root).st_mode):sys.exit(2)",
		'parts=dockerfile.split("/")',
		'if any(part in ("",".","..") for part in parts):sys.exit(2)',
		"target=os.path.join(root,dockerfile)",
		"try:",
		"\tmode=os.lstat(target).st_mode",
		"except OSError:",
		"\tfail('SITE_FOLDER_MISSING',dockerfile)",
		"if not stat.S_ISREG(mode):",
		"\tfail('SITE_FOLDER_MISSING',dockerfile)",
		"print('QORPERA_SITE_OK 0 0')",
	].join("\n");
	return `python3 -I - ${shellQuote(base)} ${shellQuote(dockerfile)} <<'QORPERA_SITE_VALIDATE_EOF'\n${py}\nQORPERA_SITE_VALIDATE_EOF`;
}

function buildArtifactReadCommand(
	paths: readonly string[],
	format: CodeCheckArtifactFormat,
	nonce: string,
	workDir?: string,
): string {
	const base = workDir ?? ".";
	const py = [
		"import fnmatch,json,os,sys",
		"src=sys.argv[1];pats=json.loads(sys.argv[2]);fmt=sys.argv[3];nonce=sys.argv[4]",
		"def exp_braces(p):",
		'\to=p.find("{")',
		"\tif o<0:return [p]",
		'\tc=p.find("}",o+1)',
		"\tif c<0:return [p]",
		"\tout=[]",
		'\tfor a in p[o+1:c].split(","):',
		"\t\tfor t in exp_braces(p[c+1:]):",
		"\t\t\tout.append(p[:o]+a+t)",
		"\t\t\tif len(out)>=32:return out",
		"\treturn out",
		"def match_one(pat,rel):",
		'\tpp=pat.split("/");sp=rel.split("/");memo={}',
		"\tdef dp(i,j):",
		"\t\tif (i,j) in memo:return memo[(i,j)]",
		"\t\tif i==len(pp):r=(j==len(sp))",
		'\t\telif pp[i]=="**":r=dp(i+1,j) or (j<len(sp) and dp(i,j+1))',
		"\t\telif j<len(sp):r=fnmatch.fnmatchcase(sp[j],pp[i]) and dp(i+1,j+1)",
		"\t\telse:r=False",
		"\t\tmemo[(i,j)]=r;return r",
		"\treturn dp(0,0)",
		"def match_glob(pat,rel):return any(match_one(e,rel) for e in exp_braces(pat))",
		"rem=256*1024;count=0",
		"for dp,dns,fns in os.walk(src,followlinks=False):",
		'\tdns[:]=[d for d in sorted(dns) if d.lower()!=".git" and not os.path.islink(os.path.join(dp,d))]',
		"\tfor fn in sorted(fns):",
		"\t\tif rem<=0 or count>=50:break",
		"\t\tfp=os.path.join(dp,fn)",
		"\t\tif os.path.islink(fp) or not os.path.isfile(fp):continue",
		'\t\trel=os.path.relpath(fp,src).replace(os.sep,"/")',
		"\t\tif not any(match_glob(p,rel) for p in pats):continue",
		"\t\tcount+=1",
		"\t\ttry:",
		'\t\t\twith open(fp,"rb") as f:raw=f.read(rem)',
		"\t\t\trem-=len(raw)",
		'\t\t\tsys.stdout.write(f"QORPERA_ARTIFACT_BEGIN:{nonce}:{fmt}\\n")',
		'\t\t\tsys.stdout.write(raw.decode("utf-8",errors="replace"))',
		'\t\t\tsys.stdout.write(f"\\nQORPERA_ARTIFACT_END:{nonce}\\n")',
		"\t\texcept OSError:pass",
	].join("\n");
	return `python3 -I - ${shellQuote(base)} ${shellQuote(JSON.stringify(paths))} ${shellQuote(format)} ${shellQuote(nonce)} <<'QORPERA_ARTIFACT_EOF'\n${py}\nQORPERA_ARTIFACT_EOF`;
}

function extractFramedArtifacts(
	output: string,
	nonce: string,
): { readonly format: CodeCheckArtifactFormat; readonly content: string }[] {
	const results: { format: CodeCheckArtifactFormat; content: string }[] = [];
	const beginPrefix = `QORPERA_ARTIFACT_BEGIN:${nonce}:`;
	const endMarker = `\nQORPERA_ARTIFACT_END:${nonce}`;
	let cursor = 0;
	for (;;) {
		const start = output.indexOf(beginPrefix, cursor);
		if (start < 0) break;
		const lineEnd = output.indexOf("\n", start);
		if (lineEnd < 0) break;
		const format = output.slice(start + beginPrefix.length, lineEnd).trim();
		const end = output.indexOf(endMarker, lineEnd + 1);
		if (end < 0) break;
		if (format === "junit" || format === "tap" || format === "vitest-json") {
			results.push({ format, content: output.slice(lineEnd + 1, end) });
		}
		cursor = end + endMarker.length;
	}
	return results;
}

function preflightSubOperationKey(operationKey: string, suffix: string): string {
	const hash = createHash("sha256").update(operationKey, "utf8").digest("hex").slice(0, 32);
	return `pf:${hash}:${suffix}`;
}

function serializePreflightOutcome(
	payload: {
		readonly state: "passed" | "failed" | "not_run";
		readonly mode: "sequential" | "dag";
		readonly ms: number;
		readonly checks: readonly PreflightCheckOutcome[];
		readonly notRun: readonly string[];
		readonly skipped: readonly { readonly name: string; readonly blockedBy: readonly string[] }[];
		readonly site: CodePreflightSite | null;
		readonly autoIncludedNeeds?: readonly string[];
		readonly cleanCopy?: { readonly commit: string; readonly uncommittedChangesIgnored: boolean };
		readonly siteValidation?: PreflightSiteValidation;
		readonly notices?: readonly string[];
	},
	tailCap: number,
): string {
	const checks = payload.checks.map(
		(entry): Record<string, JsonValue> => ({
			name: entry.name,
			cwd: entry.cwd,
			...(entry.needs && entry.needs.length > 0 ? { needs: [...entry.needs] } : {}),
			status: entry.status,
			exitCode: entry.exitCode,
			...(entry.timedOut ? { timedOut: true } : {}),
			...(entry.attempts !== undefined && entry.attempts > 1 ? { attempts: entry.attempts } : {}),
			ms: entry.ms,
			commandId: entry.commandId,
			...(entry.tail !== undefined ? { tail: codeChecksTail(entry.tail, tailCap) } : {}),
			...(entry.failedTests && entry.failedTests.length > 0
				? {
						failedTests: entry.failedTests.map((t) => ({
							...(t.suite !== undefined ? { suite: t.suite } : {}),
							name: t.name,
							...(t.file !== undefined ? { file: t.file } : {}),
							...(t.line !== undefined ? { line: t.line } : {}),
							...(t.message !== undefined ? { message: t.message } : {}),
						})),
					}
				: {}),
		}),
	);
	return cloudToolJsonText(
		{
			schema: "qorpera.coding-preflight-checks/v1",
			state: payload.state,
			file: ".qorpera/checks.json",
			mode: payload.mode,
			ms: payload.ms,
			checks,
			notRun: [...payload.notRun],
			skipped: payload.skipped.map((item) => ({ name: item.name, blockedBy: [...item.blockedBy] })),
			site: payload.site
				? {
						folder: payload.site.folder,
						name: payload.site.name,
						title: payload.site.title,
						...(payload.site.kind !== undefined ? { kind: payload.site.kind } : {}),
						...(payload.site.dockerfile !== undefined ? { dockerfile: payload.site.dockerfile } : {}),
						...(payload.site.port !== undefined ? { port: payload.site.port } : {}),
						...(payload.site.healthPath !== undefined ? { healthPath: payload.site.healthPath } : {}),
						...(payload.site.idleTimeoutSec !== undefined ? { idleTimeoutSec: payload.site.idleTimeoutSec } : {}),
						...(payload.site.memoryMb !== undefined ? { memoryMb: payload.site.memoryMb } : {}),
						...(payload.site.vcpuLimit !== undefined ? { vcpuLimit: payload.site.vcpuLimit } : {}),
						...(payload.site.spaFallback !== undefined ? { spaFallback: payload.site.spaFallback } : {}),
					}
				: null,
			...(payload.autoIncludedNeeds && payload.autoIncludedNeeds.length > 0
				? { autoIncludedNeeds: [...payload.autoIncludedNeeds] }
				: {}),
			...(payload.cleanCopy !== undefined ? { cleanCopy: payload.cleanCopy } : {}),
			...(payload.siteValidation !== undefined
				? { siteValidation: payload.siteValidation as unknown as JsonValue }
				: {}),
			...(payload.notices && payload.notices.length > 0 ? { notices: [...payload.notices] } : {}),
		},
		MAX_COMMAND_JSON_BYTES,
	);
}

export async function runCodingPreflightChecks(options: {
	scope: CloudCodingCommandScope;
	identity: CloudNativeToolIdentity;
	operations: Pick<CloudNativeToolOperations, "execute">;
	gateway: CloudCodingCommandGateway;
	checkAuthority: (context: CloudToolContext) => Promise<void>;
	request: CodingPreflightCheckRequest;
	context: CloudToolContext;
	pollMs?: number;
	timeoutGraceMs?: number;
}): Promise<CloudToolContent> {
	const { scope, operations, gateway, checkAuthority, request, context } = options;
	const target = { schema: "qorpera.coding-command-target/v1", ...scope };
	const basePollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const maxPollMs = Math.max(basePollMs, Math.min(MAX_POLL_MS, basePollMs * 4));
	const timeoutGraceMs = options.timeoutGraceMs ?? DEFAULT_TIMEOUT_GRACE_MS;

	const checkedReceipt = (value: unknown, commandId: string, inputSha256?: string): CloudCodingCommandReceipt => {
		const receipt = parseCloudCodingCommandReceipt(value);
		if (
			receipt.workerId !== scope.workerId ||
			receipt.commandId !== commandId ||
			(inputSha256 !== undefined && receipt.inputSha256 !== inputSha256)
		)
			throw new Error("Coding command result differs");
		return receipt;
	};

	const cancelThroughOperation = async (
		suffix: string,
		commandId: string,
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> => {
		const cancelKey = preflightSubOperationKey(request.operationKey, `${suffix}:cancel`);
		const cancelArgs = { commandId, operationKey: cancelKey };
		const childObservation = context.observation?.child("coding_cancel_command");
		const content = await operations.execute({
			operation: {
				tool: "coding_cancel_command",
				toolVersion: "v1",
				logicalOperationKey: cancelKey,
				arguments: cancelArgs,
				target,
				requiresCompanyRevision: false,
			},
			authorize: (_operation, admitted, authSignal) => gateway.authorize(scope, admitted, authSignal),
			perform: async (_operation, receipt) => {
				const cancelled = checkedReceipt(await gateway.cancel(scope, commandId, receipt.signal), commandId);
				return { content: { kind: "text", value: cloudToolJsonText(cancelled) } };
			},
			signal,
			...(childObservation ? { observation: childObservation } : {}),
		});
		if (content.kind !== "text") throw new Error("Coding command result differs");
		return parseCloudCodingCommandReceipt(JSON.parse(content.value));
	};

	const cancelOnAbort = async (suffix: string, commandId: string): Promise<void> => {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new DOMException("Cancel timed out", "TimeoutError")),
			CANCEL_ON_ABORT_MS,
		);
		timer.unref?.();
		try {
			await cancelThroughOperation(suffix, commandId, controller.signal);
		} catch {
			try {
				await gateway.cancel(scope, commandId, controller.signal);
			} catch {
				return;
			}
		} finally {
			clearTimeout(timer);
		}
	};

	const cancelBestEffort = async (
		suffix: string,
		commandId: string,
	): Promise<CloudCodingCommandReceipt | undefined> => {
		if (context.signal.aborted) {
			await cancelOnAbort(suffix, commandId);
			context.signal.throwIfAborted();
		}
		try {
			return await cancelThroughOperation(suffix, commandId, context.signal);
		} catch {
			if (context.signal.aborted) {
				await cancelOnAbort(suffix, commandId);
				context.signal.throwIfAborted();
			}
			return undefined;
		}
	};

	const startSubCommand = async (
		suffix: string,
		command: string,
		timeoutMs: number,
	): Promise<CloudCodingCommandReceipt> => {
		const subKey = preflightSubOperationKey(request.operationKey, suffix);
		const subArgs = { operationKey: subKey, command, timeoutMs };
		const childObservation = context.observation?.child("coding_run_command");
		let startedRunningId: string | null = null;
		let content: CloudToolContent;
		try {
			content = await operations.execute({
				operation: {
					tool: "coding_run_command",
					toolVersion: "v1",
					logicalOperationKey: subKey,
					arguments: subArgs,
					target,
					requiresCompanyRevision: false,
				},
				authorize: (_operation, admitted, signal) => gateway.authorize(scope, admitted, signal),
				perform: async (_operation, receipt) => {
					const started = checkedReceipt(
						await gateway.start(
							scope,
							{ commandId: receipt.receiptId, inputSha256: receipt.inputSha256, command, timeoutMs },
							receipt.signal,
						),
						receipt.receiptId,
						receipt.inputSha256,
					);
					if (started.state === "running") startedRunningId = started.commandId;
					return { content: { kind: "text", value: cloudToolJsonText(started) } };
				},
				signal: context.signal,
				...(childObservation ? { observation: childObservation } : {}),
			});
		} catch (error) {
			if (context.signal.aborted && startedRunningId !== null) await cancelOnAbort(suffix, startedRunningId);
			throw error;
		}
		if (content.kind !== "text") throw new Error("Coding command result differs");
		return parseCloudCodingCommandReceipt(JSON.parse(content.value));
	};

	const readReceipt = async (
		commandId: string,
		input: { offset?: number; limit: number; tail?: boolean },
		signal: AbortSignal,
	): Promise<CloudCodingCommandReceipt> => {
		const parsed = parseCloudCodingCommandRead({ commandId, ...input });
		return checkedReceipt(
			await cloudToolRequest((requestSignal) => gateway.read(scope, parsed, requestSignal), signal),
			commandId,
		);
	};

	const readFullOutput = async (
		initial: CloudCodingCommandReceipt,
		maxBytes: number,
		signal: AbortSignal,
	): Promise<string> => {
		let out = initial.log.offset === 0 ? initial.output : "";
		let cursor = initial.log.offset === 0 ? initial.log.nextOffset : 0;
		const total = Math.min(initial.log.totalBytes, maxBytes);
		while (cursor < total) {
			const page = await readReceipt(
				initial.commandId,
				{ offset: cursor, limit: Math.max(4, Math.min(CLOUD_COMMAND_PAGE_ASK, total - cursor)) },
				signal,
			);
			out += page.output;
			if (page.log.nextOffset <= cursor) break;
			cursor = page.log.nextOffset;
		}
		return out;
	};

	const readOutputTail = async (ended: CloudCodingCommandReceipt, signal: AbortSignal): Promise<string> => {
		if (ended.log.totalBytes === 0) return "";
		if (ended.log.offset === 0 && ended.log.nextOffset >= ended.log.totalBytes) {
			return redactCloudWebhookSecrets(ended.output);
		}
		const tail = await readReceipt(ended.commandId, { tail: true, limit: TAIL_READ_BYTES }, signal);
		return redactCloudWebhookSecrets(tail.output);
	};

	const waitUntilDone = async (
		suffix: string,
		initial: CloudCodingCommandReceipt,
		timeoutMs: number,
		stopSignal: AbortSignal,
	): Promise<{ receipt: CloudCodingCommandReceipt; timedOut: boolean; cancelledByWave: boolean }> => {
		let current = initial;
		const deadline = Date.now() + timeoutMs + timeoutGraceMs;
		let delay = basePollMs;
		while (current.state === "running") {
			if (context.signal.aborted) {
				await cancelOnAbort(suffix, current.commandId);
				context.signal.throwIfAborted();
			}
			if (stopSignal.aborted) {
				const cancelled = await cancelBestEffort(suffix, current.commandId);
				return {
					receipt: { ...(cancelled ?? current), state: "cancelled", exitCode: null },
					timedOut: false,
					cancelledByWave: true,
				};
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				const cancelled = await cancelBestEffort(suffix, current.commandId);
				return {
					receipt: { ...(cancelled ?? current), state: "failed", exitCode: cancelled?.exitCode ?? null },
					timedOut: true,
					cancelledByWave: false,
				};
			}
			try {
				await cloudControlPause(Math.min(delay, remaining), stopSignal);
			} catch (error) {
				if (context.signal.aborted) {
					await cancelOnAbort(suffix, current.commandId);
					throw error;
				}
				const cancelled = await cancelBestEffort(suffix, current.commandId);
				return {
					receipt: { ...(cancelled ?? current), state: "cancelled", exitCode: null },
					timedOut: false,
					cancelledByWave: true,
				};
			}
			delay = Math.min(maxPollMs, Math.max(basePollMs, Math.round(delay * 1.5)));
			try {
				await checkAuthority(context);
				current = await readReceipt(
					current.commandId,
					{ offset: current.log.totalBytes, limit: 4 },
					context.signal,
				);
			} catch (error) {
				if (context.signal.aborted) await cancelOnAbort(suffix, current.commandId);
				throw error;
			}
		}
		return { receipt: current, timedOut: false, cancelledByWave: false };
	};

	const finish = async (text: string): Promise<CloudToolContent> => {
		await checkAuthority(context);
		return { kind: "text", value: text };
	};

	const cleanHash = request.cleanCopy
		? createHash("sha256").update(request.operationKey, "utf8").digest("hex").slice(0, 16)
		: undefined;
	let cleanWorkDir: string | undefined;
	let cleanCopyMeta: { readonly commit: string; readonly uncommittedChangesIgnored: boolean } | undefined;

	const cleanupCleanCopy = async (): Promise<void> => {
		if (!cleanHash || cleanWorkDir === undefined || context.signal.aborted) return;
		try {
			const dropped = await startSubCommand(
				"clean-drop",
				buildCleanCopyDropCommand(cleanHash),
				READ_CHECKS_TIMEOUT_MS,
			);
			await waitUntilDone("clean-drop", dropped, READ_CHECKS_TIMEOUT_MS, context.signal);
		} catch {
			return;
		}
	};

	try {
		if (cleanHash) {
			const setupStarted = await startSubCommand(
				"clean-setup",
				buildCleanCopySetupCommand(cleanHash),
				CLEAN_COPY_TIMEOUT_MS,
			);
			const setupWaited = await waitUntilDone("clean-setup", setupStarted, CLEAN_COPY_TIMEOUT_MS, context.signal);
			if (setupWaited.timedOut) {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "not_run",
						file: ".qorpera/checks.json",
						reason: "clean_copy_timed_out",
					}),
				);
			}
			const setupFinal = setupWaited.receipt;
			if (setupFinal.state !== "succeeded") {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "not_run",
						file: ".qorpera/checks.json",
						reason: setupFinal.exitCode === 48 ? "clean_copy_no_head" : "clean_copy_failed",
						...(setupFinal.exitCode !== null ? { exitCode: setupFinal.exitCode } : {}),
					}),
				);
			}
			const setupOut = await readFullOutput(setupFinal, 4096, context.signal);
			const line = setupOut
				.replaceAll("\r\n", "\n")
				.split("\n")
				.find((entry) => entry.startsWith("QORPERA_CLEAN_COPY "));
			const match = line ? /^QORPERA_CLEAN_COPY ([0-9a-f]{40}) (clean|dirty) (\/[^\n]+)$/.exec(line) : null;
			if (!match || !match[3]!.includes("/.qorpera-preflight/")) {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "not_run",
						file: ".qorpera/checks.json",
						reason: "clean_copy_invalid",
					}),
				);
			}
			cleanCopyMeta = { commit: match[1]!, uncommittedChangesIgnored: match[2] === "dirty" };
			cleanWorkDir = match[3]!;
		}

		const readStarted = await startSubCommand("read", buildReadChecksCommand(cleanWorkDir), READ_CHECKS_TIMEOUT_MS);
		const readWaited = await waitUntilDone("read", readStarted, READ_CHECKS_TIMEOUT_MS, context.signal);
		if (readWaited.timedOut) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "not_run",
					file: ".qorpera/checks.json",
					reason: "read_timed_out",
				}),
			);
		}
		const readFinal = readWaited.receipt;
		if (readFinal.state !== "succeeded" && readFinal.state !== "failed") {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "not_run",
					file: ".qorpera/checks.json",
					reason: readFinal.state,
				}),
			);
		}
		if (readFinal.state === "failed") {
			if (readFinal.exitCode === 44) {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "missing",
						file: ".qorpera/checks.json",
						message: "No .qorpera/checks.json file was found in this worktree. Add one before coding_finish.",
					}),
				);
			}
			if (readFinal.exitCode === 45) {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "invalid",
						file: ".qorpera/checks.json",
						problems: [
							{
								at: "",
								code: "NOT_A_FILE",
								message: "The checks file is not a regular file (a folder, a symlink or a submodule).",
							},
						],
					}),
				);
			}
			if (readFinal.exitCode === 46) {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "invalid",
						file: ".qorpera/checks.json",
						problems: [{ at: "", code: "TOO_LARGE", message: "The checks file is over 16 KiB." }],
					}),
				);
			}
			if (readFinal.exitCode === 47) {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "invalid",
						file: ".qorpera/checks.json",
						problems: [{ at: "", code: "NOT_UTF8", message: "The checks file is not UTF-8 text." }],
					}),
				);
			}
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "not_run",
					file: ".qorpera/checks.json",
					reason: "read_failed",
					exitCode: readFinal.exitCode,
				}),
			);
		}

		const rawChecksText = await readFullOutput(readFinal, MAX_CODE_CHECKS_FILE_BYTES + 1, context.signal);
		const parsed = parseCodeChecksText(rawChecksText);
		if (!parsed.ok) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "invalid",
					file: ".qorpera/checks.json",
					problems: parsed.problems.map((p) => ({ at: p.at, code: p.code, message: p.message })),
				}),
			);
		}

		const originalIndexByName = new Map(parsed.checks.map((check, index) => [check.name, index]));
		let selected = parsed.checks;
		let autoIncludedNeeds: readonly string[] = [];
		if (request.checkNames !== undefined) {
			const unknown = request.checkNames.filter((name) => !originalIndexByName.has(name));
			if (unknown.length > 0) {
				return finish(
					cloudToolJsonText({
						schema: "qorpera.coding-preflight-checks/v1",
						state: "invalid",
						file: ".qorpera/checks.json",
						problems: unknown.map((name) => ({
							at: "",
							code: "UNKNOWN_CHECK",
							message: `No check named "${name}" exists in .qorpera/checks.json.`,
						})),
						availableChecks: parsed.checks.map((check) => check.name),
					}),
				);
			}
			const expanded = expandCodeCheckNeeds(parsed.checks, request.checkNames);
			selected = expanded.selected;
			autoIncludedNeeds = expanded.autoIncluded;
		}
		const selectedNames = new Set(selected.map((check) => check.name));

		const commandProblems: CodeChecksProblem[] = [];
		const commandsByName = new Map<string, string>();
		for (const check of selected) {
			const cmd = buildPreflightCheckCommand(check, cleanWorkDir);
			if (
				Buffer.byteLength(cmd, "utf8") > MAX_COMMAND_BYTES ||
				Buffer.byteLength(JSON.stringify(cmd)) > MAX_COMMAND_JSON_BYTES
			) {
				commandProblems.push({
					at: `/checks/${originalIndexByName.get(check.name)}/run`,
					code: "COMMAND_TOO_LONG",
					message: `Check "${check.name}" exceeds the command size limit after shell quoting.`,
				});
			} else {
				commandsByName.set(check.name, cmd);
			}
		}
		if (commandProblems.length > 0) {
			return finish(
				cloudToolJsonText({
					schema: "qorpera.coding-preflight-checks/v1",
					state: "invalid",
					file: ".qorpera/checks.json",
					problems: commandProblems.map((p) => ({ at: p.at, code: p.code, message: p.message })),
				}),
			);
		}

		const isDag = parsed.mode === "dag";
		const effectiveFailFast = request.failFast ?? parsed.failFast ?? true;
		const maxConcurrent = isDag ? Math.max(1, Math.min(8, parsed.maxParallel ?? MAX_PARALLEL_PREFLIGHT_CHECKS)) : 1;
		const depsByName = new Map<string, readonly string[]>();
		for (const check of selected) {
			depsByName.set(check.name, isDag ? (check.needs ?? []).filter((dep) => selectedNames.has(dep)) : []);
		}

		const runStartedAt = Date.now();
		const outcomes = new Map<string, PreflightCheckOutcome>();
		const skipped = new Map<string, readonly string[]>();
		const pending = new Set<string>(selected.map((check) => check.name));
		const checkByName = new Map(selected.map((check) => [check.name, check]));
		const waveAbort = new AbortController();
		const waveSignal = AbortSignal.any([context.signal, waveAbort.signal]);
		const running = new Map<string, Promise<string>>();
		let activeExclusive = false;
		let stoppedByFailure = false;
		let anyFailed = false;
		let anyNotRun = false;

		const readFailedArtifacts = async (
			check: CodePreflightCheck,
			originalIndex: number,
		): Promise<readonly FailedTestCase[] | undefined> => {
			if (!check.artifacts || check.artifacts.format === "raw") return undefined;
			if (context.signal.aborted) return undefined;
			try {
				const nonce = randomBytes(12).toString("hex");
				const cmd = buildArtifactReadCommand(check.artifacts.paths, check.artifacts.format, nonce, cleanWorkDir);
				const started = await startSubCommand(`a:${originalIndex}`, cmd, ARTIFACT_READ_TIMEOUT_MS);
				const waited = await waitUntilDone(`a:${originalIndex}`, started, ARTIFACT_READ_TIMEOUT_MS, context.signal);
				if (waited.timedOut || waited.receipt.state !== "succeeded") return undefined;
				const text = redactCloudWebhookSecrets(await readFullOutput(waited.receipt, 320 * 1024, context.signal));
				const extracted = extractFramedArtifacts(text, nonce);
				if (extracted.length === 0) return undefined;
				const failedTests = parseCheckFailureArtifacts(extracted);
				return failedTests.length > 0 ? failedTests : undefined;
			} catch {
				if (context.signal.aborted) throw context.signal.reason;
				return undefined;
			}
		};

		const startCheck = async (check: CodePreflightCheck): Promise<void> => {
			const isExclusive = check.exclusive === true;
			if (isExclusive) activeExclusive = true;
			const checkStartedAt = Date.now();
			const originalIndex = originalIndexByName.get(check.name)!;
			const cmd = commandsByName.get(check.name)!;
			const timeoutMs = check.timeoutSeconds * 1000;
			const maxRetries = check.retries ?? 0;
			let firstStarted: CloudCodingCommandReceipt;
			try {
				firstStarted = await startSubCommand(`c:${originalIndex}`, cmd, timeoutMs);
			} catch (error) {
				if (isExclusive) activeExclusive = false;
				throw error;
			}
			const promise = (async (): Promise<string> => {
				try {
					let attempt = 0;
					let currentReceipt = firstStarted;
					for (;;) {
						const suffix = attempt === 0 ? `c:${originalIndex}` : `c:${originalIndex}:r${attempt}`;
						const waited = await waitUntilDone(suffix, currentReceipt, timeoutMs, waveSignal);
						const finalReceipt = waited.receipt;
						const status: PreflightCheckOutcome["status"] =
							finalReceipt.state === "succeeded"
								? "passed"
								: finalReceipt.state === "failed"
									? "failed"
									: finalReceipt.state === "cancelled"
										? "cancelled"
										: finalReceipt.state === "machine_stopped"
											? "machine_stopped"
											: "unconfirmed";
						if (
							status === "failed" &&
							!waited.cancelledByWave &&
							attempt < maxRetries &&
							!waveAbort.signal.aborted &&
							!context.signal.aborted
						) {
							attempt++;
							currentReceipt = await startSubCommand(`c:${originalIndex}:r${attempt}`, cmd, timeoutMs);
							continue;
						}
						const elapsedMs = Math.max(0, Date.now() - checkStartedAt);
						const tail =
							status === "passed" || waited.cancelledByWave
								? undefined
								: await readOutputTail(finalReceipt, context.signal);
						const failedTests =
							status === "failed" && !waited.cancelledByWave
								? await readFailedArtifacts(check, originalIndex)
								: undefined;
						outcomes.set(check.name, {
							name: check.name,
							cwd: check.cwd,
							...(check.needs !== undefined ? { needs: check.needs } : {}),
							status,
							exitCode: finalReceipt.exitCode,
							timedOut: waited.timedOut,
							...(attempt > 0 ? { attempts: attempt + 1 } : {}),
							ms: elapsedMs,
							commandId: finalReceipt.commandId,
							...(tail !== undefined ? { tail } : {}),
							...(failedTests !== undefined ? { failedTests } : {}),
						});
						if (status !== "passed") {
							if (status === "machine_stopped" || status === "unconfirmed") anyNotRun = true;
							else if (!waited.cancelledByWave) anyFailed = true;
							if (effectiveFailFast && !waited.cancelledByWave) {
								stoppedByFailure = true;
								waveAbort.abort();
							}
						}
						return check.name;
					}
				} finally {
					if (isExclusive) activeExclusive = false;
				}
			})();
			promise.catch(() => {
				waveAbort.abort();
			});
			running.set(check.name, promise);
		};

		try {
			while (pending.size > 0 || running.size > 0) {
				if (!stoppedByFailure && !waveAbort.signal.aborted) {
					let progressed = true;
					while (progressed) {
						progressed = false;
						for (const name of [...pending]) {
							const deps = depsByName.get(name) ?? [];
							const blockedBy = deps.filter((dep) => {
								const depOutcome = outcomes.get(dep);
								return (depOutcome !== undefined && depOutcome.status !== "passed") || skipped.has(dep);
							});
							if (blockedBy.length > 0) {
								pending.delete(name);
								skipped.set(name, blockedBy);
								progressed = true;
							}
						}
					}
					if (!activeExclusive) {
						for (const name of [...pending]) {
							if (stoppedByFailure || waveAbort.signal.aborted) break;
							const deps = depsByName.get(name) ?? [];
							if (!deps.every((dep) => outcomes.get(dep)?.status === "passed")) continue;
							const check = checkByName.get(name)!;
							if (check.exclusive === true) {
								if (running.size === 0) {
									pending.delete(name);
									await startCheck(check);
									break;
								}
								continue;
							}
							if (running.size >= maxConcurrent) break;
							pending.delete(name);
							await startCheck(check);
						}
					}
				}
				if (running.size === 0) break;
				const finishedName = await Promise.race(running.values());
				running.delete(finishedName);
			}
		} finally {
			waveAbort.abort();
			if (running.size > 0) await Promise.allSettled(running.values());
		}

		const orderedOutcomes: PreflightCheckOutcome[] = [];
		for (const check of selected) {
			const outcome = outcomes.get(check.name);
			if (outcome) orderedOutcomes.push(outcome);
		}
		const notRun = selected.map((check) => check.name).filter((name) => pending.has(name));
		const skippedList = selected
			.filter((check) => skipped.has(check.name))
			.map((check) => ({ name: check.name, blockedBy: skipped.get(check.name)! }));
		let overallState: "passed" | "failed" | "not_run" =
			anyNotRun && !anyFailed
				? "not_run"
				: anyFailed || notRun.length > 0 || skippedList.length > 0
					? "failed"
					: "passed";

		let siteValidation: PreflightSiteValidation | undefined;
		if (request.validateSite === true && overallState === "passed") {
			if (parsed.site === null) {
				siteValidation = { state: "no_site" };
			} else if (parsed.site.kind === "server" && !parsed.site.dockerfile) {
				siteValidation = { state: "valid", folder: parsed.site.folder, files: 0, bytes: 0 };
			} else {
				const validateCommand =
					parsed.site.kind === "server" && parsed.site.dockerfile
						? buildServerSiteValidateCommand(parsed.site.dockerfile, cleanWorkDir)
						: buildSiteValidateCommand(parsed.site.folder, cleanWorkDir);
				const valStarted = await startSubCommand("site-validate", validateCommand, SITE_VALIDATE_TIMEOUT_MS);
				const valWaited = await waitUntilDone(
					"site-validate",
					valStarted,
					SITE_VALIDATE_TIMEOUT_MS,
					context.signal,
				);
				if (valWaited.timedOut) {
					siteValidation = { state: "error", folder: parsed.site.folder, reason: "timed_out" };
					overallState = "failed";
				} else {
					const valOut = redactCloudWebhookSecrets(await readFullOutput(valWaited.receipt, 8192, context.signal));
					const okMatch = /^QORPERA_SITE_OK (\d+) (\d+)$/m.exec(valOut);
					const probMatch = /^QORPERA_SITE_PROBLEM ([A-Z0-9_]+)(?: (.+))?$/m.exec(valOut);
					if (valWaited.receipt.state === "succeeded" && okMatch) {
						siteValidation = {
							state: "valid",
							folder: parsed.site.folder,
							files: Number(okMatch[1]),
							bytes: Number(okMatch[2]),
						};
					} else if (probMatch) {
						siteValidation = {
							state: "invalid",
							folder: parsed.site.folder,
							problem: { code: probMatch[1]!, path: probMatch[2]?.trim() || null },
						};
						overallState = "failed";
					} else {
						siteValidation = {
							state: "error",
							folder: parsed.site.folder,
							reason:
								valWaited.receipt.exitCode !== null
									? `exit_${valWaited.receipt.exitCode}`
									: valWaited.receipt.state,
						};
						overallState = "failed";
					}
				}
			}
		}

		const checksWithSecrets = selected.filter((check) => check.secrets !== undefined).map((check) => check.name);
		const notices =
			checksWithSecrets.length > 0
				? [
						`Per-check secrets allow-lists are enforced at landing; pre-flight runs with the session environment (checks with secrets: ${checksWithSecrets.join(", ")}).`,
					]
				: undefined;
		const totalMs = Math.max(0, Date.now() - runStartedAt);
		const payload = {
			state: overallState,
			mode: parsed.mode,
			ms: totalMs,
			checks: orderedOutcomes,
			notRun,
			skipped: skippedList,
			site: parsed.site,
			...(autoIncludedNeeds.length > 0 ? { autoIncludedNeeds } : {}),
			...(cleanCopyMeta !== undefined ? { cleanCopy: cleanCopyMeta } : {}),
			...(siteValidation !== undefined ? { siteValidation } : {}),
			...(notices !== undefined ? { notices } : {}),
		};
		for (const tailCap of [MAX_TAIL_BYTES, 800, 400, 200, 0]) {
			const candidate = redactCloudWebhookSecrets(serializePreflightOutcome(payload, tailCap));
			if (fitsOneResult(candidate)) return finish(candidate);
		}
		return finish(redactCloudWebhookSecrets(serializePreflightOutcome(payload, 0)));
	} finally {
		await cleanupCleanCopy();
	}
}
