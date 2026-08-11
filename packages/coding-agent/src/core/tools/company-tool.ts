/**
 * The company-tool runner (Build 2 — sandboxed company-authored capabilities).
 *
 * Runs a company-authored program as a clean-environment subprocess. This is
 * the sanctioned lane for executing company code: unlike `bash`, the call
 * carries the PROGRAM's identity — the authority layer derives behaviorPath
 * from the path argument (authority.ts effectiveBehaviorPath), so the
 * EVOLUTION §3 signature rule covers the program's content hash and every
 * run stamps `qorpera_effect.behavior` into the trail.
 *
 * Isolation model (stated honestly, manifesto §7.2): the subprocess inherits
 * the OS confinement of the controller child that spawns it — under the
 * desktop kernel that is the Codex sandbox profile (company-scope writes,
 * protected paths read-only, no network). What THIS code enforces on every
 * platform: a clean environment (allowlist below — no ambient credentials,
 * no QORPERA_* kernel state), the program resolving to a physical file
 * inside the company, bounded output, and a hard timeout.
 */

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@qorpera/pi-agent-core";
import { Text } from "@qorpera/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { spawn } from "../../utils/child-process.ts";
import {
	type Authority,
	COMPANY_TOOL_NAME,
	discoverAuthority,
	evaluateToolCall,
	finalizeAuthorityDecision,
	HTTP_TOOL_NAME,
} from "../authority.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { brokeredHttpRequest, isHttpBrokerAvailable } from "../http-broker-client.ts";
import { getTextOutput, renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const companyToolSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the company-authored program to run (relative to the session directory or absolute; must be inside the company folder). JavaScript runs directly; TypeScript runs through the bundled loader.",
	}),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the program" })),
	timeoutSeconds: Type.Optional(
		Type.Number({ description: `Seconds before the program is terminated (default ${120}, max ${600})` }),
	),
});

export type CompanyToolInput = Static<typeof companyToolSchema>;

export interface CompanyToolDetails {
	/** Company-root-relative POSIX path of the executed program. */
	behaviorPath: string;
	/** sha256 of the program file at execution time — the acting code identity. */
	contentHash: string;
	exitCode: number | null;
	durationMs: number;
	timedOut?: true;
	interrupted?: true;
	truncated?: true;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TS_EXTENSIONS = new Set([".ts", ".mts", ".cts"]);

/**
 * The program-side HTTP lane (Build 3): a company program may print
 * `{"type":"qorpera_program_http_request","requestId":…,"method":…,"url":…}`
 * lines on stdout and read matching `qorpera_program_http_response` lines
 * from stdin. The runner evaluates authority for each request as UNATTENDED
 * codified behavior — the program file is the acting behavior, so the
 * EVOLUTION §3 signature rule applies at outward classes — then forwards it
 * through the kernel HTTP lane with the program's identity attached. This
 * is what lets a founder-signed program act outward with nobody present.
 */
interface ProgramHttpFrame {
	requestId: string;
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
	/** File mode (kernel-streamed): see http-broker-client. */
	saveTo?: string;
	sendFile?: string;
}

function parsedProgramHttpFrame(line: string): ProgramHttpFrame | undefined {
	if (!line.startsWith('{"type":"qorpera_program_http_request"')) return undefined;
	try {
		const frame = JSON.parse(line) as Partial<ProgramHttpFrame> & { type?: unknown };
		if (
			frame.type !== "qorpera_program_http_request" ||
			typeof frame.requestId !== "string" ||
			typeof frame.method !== "string" ||
			typeof frame.url !== "string"
		)
			return undefined;
		return frame as ProgramHttpFrame;
	} catch {
		return undefined;
	}
}

async function serveProgramHttpFrame(
	frame: ProgramHttpFrame,
	authority: Authority,
	cwd: string,
	program: ResolvedProgram,
	respond: (payload: object) => void,
): Promise<void> {
	const fail = (error: string): void =>
		respond({ type: "qorpera_program_http_response", requestId: frame.requestId, error });
	if (!isHttpBrokerAvailable()) {
		fail("http lane requires the kernel broker (company sessions under the desktop kernel)");
		return;
	}
	const spec = {
		method: frame.method,
		url: frame.url,
		...(frame.headers ? { headers: frame.headers } : {}),
		...(frame.body !== undefined ? { body: frame.body } : {}),
		...(frame.saveTo !== undefined ? { saveTo: frame.saveTo } : {}),
		...(frame.sendFile !== undefined ? { sendFile: frame.sendFile } : {}),
		...(frame.timeoutMs !== undefined ? { timeoutMs: frame.timeoutMs } : {}),
	};
	// Program-initiated requests are never founder presence: attended=false
	// regardless of who is watching the chat, so outward classes require the
	// program's signature and class modes apply on top.
	const decision = evaluateToolCall(authority, HTTP_TOOL_NAME, spec, cwd, {
		attended: false,
		behaviorPath: program.absolute,
	});
	const finalized = await finalizeAuthorityDecision(authority, decision, HTTP_TOOL_NAME, spec);
	if (finalized.kind === "block") {
		fail(finalized.reason);
		return;
	}
	try {
		const response = await brokeredHttpRequest({
			...spec,
			behavior: { path: program.rootRelative, contentHash: program.contentHash },
		});
		respond({
			type: "qorpera_program_http_response",
			requestId: frame.requestId,
			status: response.status,
			headers: response.headers,
			body: response.body,
			bodyBytes: response.bodyBytes,
			...(response.bodyTruncated ? { bodyTruncated: true } : {}),
			...(response.savedTo ? { savedTo: response.savedTo } : {}),
			...(response.sha256 ? { sha256: response.sha256 } : {}),
		});
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

/**
 * The complete environment a company program receives. Values come from the
 * controller's own (already sandbox-scoped) environment; nothing else —
 * no model keys, no QORPERA_* kernel state, no broker tokens.
 */
const CLEAN_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"TEMP",
	"TMP",
	"TMPDIR",
	"SystemRoot",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"LANG",
	"LC_ALL",
	"TZ",
] as const;

function cleanProgramEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of CLEAN_ENV_ALLOWLIST) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	// The controller may itself run on Electron's embedded Node.
	env.ELECTRON_RUN_AS_NODE = "1";
	return env;
}

function fileExtension(path: string): string {
	const base = path.slice(path.lastIndexOf(sep) + 1);
	const dot = base.lastIndexOf(".");
	return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

function tsLoaderArgs(programPath: string): string[] {
	if (!TS_EXTENSIONS.has(fileExtension(programPath))) return [];
	try {
		return ["--import", import.meta.resolve("jiti/register")];
	} catch {
		// Without the loader a .ts program fails with node's own clear error.
		return [];
	}
}

interface ResolvedProgram {
	absolute: string;
	rootRelative: string;
	contentHash: string;
}

/** Resolve and admit the program: a physical file inside the company folder. */
function resolveProgram(rawPath: string, cwd: string, authorityRoot: string): ResolvedProgram {
	const resolved = resolve(isAbsolute(rawPath) ? rawPath : join(cwd, rawPath));
	const rel = relative(authorityRoot, resolved);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`run_company_tool only runs programs inside the company folder: ${rawPath}`);
	}
	if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
		throw new Error(`Program not found: ${rawPath}`);
	}
	const physical = realpathSync(resolved);
	const physicalRel = relative(authorityRoot, physical);
	if (physicalRel.startsWith("..") || isAbsolute(physicalRel)) {
		throw new Error(`Program resolves outside the company folder (link): ${rawPath}`);
	}
	const contentHash = createHash("sha256").update(readFileSync(physical)).digest("hex");
	return { absolute: physical, rootRelative: rel.split(sep).join("/"), contentHash };
}

export interface CompanyToolOptions {
	/** Override the executable used to run programs (tests). Default: this Node runtime. */
	nodeBinary?: string;
}

export function createCompanyToolDefinition(
	cwd: string,
	options?: CompanyToolOptions,
): ToolDefinition<typeof companyToolSchema, CompanyToolDetails | undefined> {
	return {
		name: COMPANY_TOOL_NAME,
		label: "run company tool",
		description:
			"Run a company-authored program (e.g. under app/tools/) as a clean-environment subprocess with the program's identity recorded in the trail. This is the sanctioned lane for codified company behavior: programs run here carry a content-hash identity that the founder can sign for unattended outward action (bash carries no such identity). The program runs with the company folder as working directory, no inherited credentials, bounded output, and a timeout.",
		promptSnippet: "Run a company-authored program with recorded code identity",
		parameters: companyToolSchema,
		async execute(_toolCallId, { path, args, timeoutSeconds }: CompanyToolInput, signal?: AbortSignal) {
			const authority = discoverAuthority(cwd);
			if (!authority) {
				throw new Error("run_company_tool requires a company folder (no authority root found)");
			}
			const program = resolveProgram(path, cwd, authority.root);
			const timeoutMs = Math.min(Math.max(timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1), MAX_TIMEOUT_SECONDS) * 1000;
			const nodeBinary = options?.nodeBinary ?? process.execPath;
			const started = Date.now();

			return await new Promise((resolvePromise, rejectPromise) => {
				if (signal?.aborted) {
					rejectPromise(new Error("Operation aborted"));
					return;
				}
				let child: ChildProcess;
				try {
					child = spawn(nodeBinary, [...tsLoaderArgs(program.absolute), program.absolute, ...(args ?? [])], {
						cwd: authority.root,
						env: cleanProgramEnvironment(),
						stdio: ["pipe", "pipe", "pipe"],
						shell: false,
					});
				} catch (error) {
					rejectPromise(error);
					return;
				}

				let outputBytes = 0;
				let truncated = false;
				const chunks: Buffer[] = [];
				const collect = (chunk: Buffer): void => {
					if (outputBytes >= MAX_OUTPUT_BYTES) {
						truncated = true;
						return;
					}
					const room = MAX_OUTPUT_BYTES - outputBytes;
					const piece = chunk.subarray(0, room);
					chunks.push(piece);
					outputBytes += piece.length;
					if (piece.length < chunk.length) truncated = true;
				};
				// stdout is scanned line-wise: program HTTP frames are served
				// through the authority + kernel lanes; everything else is
				// ordinary output. stderr is ordinary output.
				const respond = (payload: object): void => {
					if (child.exitCode === null) child.stdin?.write(`${JSON.stringify(payload)}\n`);
				};
				if (child.stdout) {
					createInterface({ input: child.stdout }).on("line", (line) => {
						const frame = parsedProgramHttpFrame(line);
						if (frame) {
							void serveProgramHttpFrame(frame, authority, cwd, program, respond);
							return;
						}
						collect(Buffer.from(`${line}\n`, "utf-8"));
					});
				}
				child.stderr?.on("data", collect);

				let timedOut = false;
				let interrupted = false;
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs);
				const onAbort = (): void => {
					interrupted = true;
					child.kill("SIGKILL");
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				child.once("error", (error) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					rejectPromise(error);
				});
				child.once("close", (exitCode) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					const durationMs = Date.now() - started;
					const output = Buffer.concat(chunks).toString("utf-8");
					const details: CompanyToolDetails = {
						behaviorPath: program.rootRelative,
						contentHash: program.contentHash,
						exitCode,
						durationMs,
						...(timedOut ? { timedOut: true as const } : {}),
						...(interrupted ? { interrupted: true as const } : {}),
						...(truncated ? { truncated: true as const } : {}),
					};
					const status = timedOut
						? `terminated after ${Math.round(timeoutMs / 1000)}s timeout`
						: interrupted
							? "interrupted"
							: `exit ${exitCode}`;
					const header = `${program.rootRelative} (sha256 ${program.contentHash.slice(0, 12)}…) — ${status}, ${durationMs}ms`;
					const body = output.trim()
						? `\n${output}${truncated ? "\n[output truncated at 1MB]" : ""}`
						: "\n(no output)";
					resolvePromise({ content: [{ type: "text", text: `${header}${body}` }], details });
				});
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const pathDisplay = renderToolPath(str(args?.path), theme, context.cwd, { emptyFallback: "?" });
			const argText = args?.args?.length ? theme.fg("toolOutput", ` ${args.args.join(" ")}`) : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("run company tool"))} ${pathDisplay}${argText}`);
			return text;
		},
		renderResult(result, options: ToolRenderResultOptions, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as never, context.showImages).trim();
			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 20;
			const shown = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
			const remaining = lines.length - maxLines;
			text.setText(
				`\n${shown.join("\n")}${remaining > 0 ? theme.fg("muted", `\n... (${remaining} more lines)`) : ""}`,
			);
			return text;
		},
	};
}

export function createCompanyTool(cwd: string, options?: CompanyToolOptions): AgentTool<typeof companyToolSchema> {
	return wrapToolDefinition(createCompanyToolDefinition(cwd, options));
}
