import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createGunzip } from "node:zlib";
import { isUuid } from "@qorpera/contracts";
import { codeFolderRefuses } from "./code-folder-names.ts";
import {
	CodeHostJobFailure,
	CodeHostRefusal,
	MAX_PACK,
	moveBase,
	type Run,
	SHA,
	withJob,
	ZERO,
} from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CodingControlRefused } from "./coding-executor.ts";

export const CODE_GIT_HTTP_RPCS = ["qorpera_verify_code_git_token", "qorpera_record_git_http_push"] as const;

export type CodeGitHttpRpc = (typeof CODE_GIT_HTTP_RPCS)[number];

export interface CodeGitHttpControl {
	call(method: CodeGitHttpRpc, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface CodeGitHttpServerOptions {
	readonly host?: string;
	readonly port: number;
	readonly control: CodeGitHttpControl;
	readonly hosts: Pick<CodeHostJobs, "run">;
	readonly requestTimeoutMs?: number;
	readonly maxUploadPackBodyBytes?: number;
	readonly maxReceivePackBodyBytes?: number;
	readonly report?: (event: Record<string, unknown>) => void;
}

interface VerifiedGitToken {
	readonly tokenId: string;
	readonly companyId: string;
	readonly environmentId: string;
	readonly owner: string;
	readonly name: string;
	readonly defaultBranch: string;
}

interface ParsedGitRoute {
	readonly companyId: string;
	readonly owner: string;
	readonly name: string;
	readonly endpoint: "info/refs" | "git-upload-pack" | "git-receive-pack";
	readonly service: "git-upload-pack" | "git-receive-pack";
}

interface RefUpdateCommand {
	readonly oldSha: string;
	readonly newSha: string;
	readonly refName: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const RECORD_PUSH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_UPLOAD_PACK_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECEIVE_PACK_BYTES = 64 * 1024 * 1024;
const MAX_ADVERTISE_BYTES = 16 * 1024 * 1024;
const HIDE_INTERNAL_REFS_ARGS = [
	"-c",
	"transfer.hideRefs=refs/qorpera",
	"-c",
	"transfer.hideRefs=refs/heads/qorpera",
] as const;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const TOKEN_PATTERN = /^qgit_[A-Za-z0-9_-]{16,128}$/;

function isInternalPlatformRef(refName: string): boolean {
	const lowered = refName.toLowerCase();
	return (
		lowered === "refs/qorpera" ||
		lowered.startsWith("refs/qorpera/") ||
		lowered === "refs/heads/qorpera" ||
		lowered.startsWith("refs/heads/qorpera/")
	);
}

function hasSqlState(error: unknown, sqlState: string): boolean {
	if (!error || typeof error !== "object") return false;
	const rec = error as { code?: unknown; message?: unknown; cause?: unknown };
	if (rec.code === sqlState) return true;
	const text = `${typeof rec.message === "string" ? rec.message : ""} ${rec.cause instanceof Error ? rec.cause.message : typeof rec.cause === "string" ? rec.cause : ""}`;
	return text.includes(` ${sqlState} `) || text.endsWith(` ${sqlState}`) || text === sqlState;
}

function classifyVerifyFailure(error: unknown): { status: number; body: string; challenge: boolean } {
	if (
		error instanceof CodingControlRefused ||
		hasSqlState(error, "42501") ||
		(error instanceof Error && error.message === "GIT_HTTP_UNAUTHORIZED")
	) {
		return { status: 401, body: "Invalid or unauthorized Git token\n", challenge: true };
	}
	if (hasSqlState(error, "55000")) {
		return { status: 403, body: "Company execution is paused\n", challenge: false };
	}
	return { status: 503, body: "Git authentication service temporarily unavailable\n", challenge: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pktLine(line: string): Buffer {
	const payload = Buffer.from(line, "utf8");
	const lengthHex = (payload.length + 4).toString(16).padStart(4, "0");
	return Buffer.concat([Buffer.from(lengthHex, "ascii"), payload]);
}

export function extractGitAuthToken(header: string | undefined): string | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (trimmed.toLowerCase().startsWith("bearer ")) {
		const token = trimmed.slice(7).trim();
		return TOKEN_PATTERN.test(token) ? token : null;
	}
	if (trimmed.toLowerCase().startsWith("basic ")) {
		const encoded = trimmed.slice(6).trim();
		if (!encoded || encoded.length > 512) return null;
		let decoded: string;
		try {
			decoded = Buffer.from(encoded, "base64").toString("utf8");
		} catch {
			return null;
		}
		const colon = decoded.indexOf(":");
		if (colon < 0) return null;
		const user = decoded.slice(0, colon);
		const pass = decoded.slice(colon + 1);
		if (TOKEN_PATTERN.test(pass)) return pass;
		if (TOKEN_PATTERN.test(user)) return user;
	}
	return null;
}

export function parseGitHttpRoute(method: string, rawUrl: string): ParsedGitRoute | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl, "http://127.0.0.1");
	} catch {
		return null;
	}
	const parts = parsed.pathname.split("/").filter(Boolean);
	if (parts.length < 5 || parts[0] !== "git") return null;
	const companyId = parts[1] ?? "";
	const owner = parts[2] ?? "";
	const rawName = parts[3] ?? "";
	const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
	if (!isUuid(companyId) || !OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return null;
	const rest = parts.slice(4).join("/");
	if (method === "GET" && rest === "info/refs") {
		const service = parsed.searchParams.get("service");
		if (service !== "git-upload-pack" && service !== "git-receive-pack") return null;
		return {
			companyId: companyId.toLowerCase(),
			owner: owner.toLowerCase(),
			name: name.toLowerCase(),
			endpoint: "info/refs",
			service,
		};
	}
	if (method === "POST" && (rest === "git-upload-pack" || rest === "git-receive-pack")) {
		return {
			companyId: companyId.toLowerCase(),
			owner: owner.toLowerCase(),
			name: name.toLowerCase(),
			endpoint: rest,
			service: rest,
		};
	}
	return null;
}

export function parseReceivePackCommands(body: Buffer): RefUpdateCommand[] {
	const commands: RefUpdateCommand[] = [];
	let offset = 0;
	while (offset + 4 <= body.length) {
		const lenStr = body.subarray(offset, offset + 4).toString("ascii");
		if (!/^[0-9a-fA-F]{4}$/.test(lenStr)) {
			throw new CodeHostRefusal("GIT_HTTP_INVALID_PKTLINE");
		}
		const len = Number.parseInt(lenStr, 16);
		if (len === 0) {
			break;
		}
		if (len < 4 || offset + len > body.length) {
			throw new CodeHostRefusal("GIT_HTTP_INVALID_PKTLINE");
		}
		const lineBuf = body.subarray(offset + 4, offset + len);
		offset += len;
		const nulIndex = lineBuf.indexOf(0);
		const commandText = (nulIndex >= 0 ? lineBuf.subarray(0, nulIndex) : lineBuf)
			.toString("utf8")
			.replace(/\r?\n$/, "");
		const parts = commandText.split(" ");
		if (parts.length !== 3) {
			throw new CodeHostRefusal("GIT_HTTP_INVALID_COMMAND");
		}
		const [oldSha = "", newSha = "", refName = ""] = parts;
		if (!SHA.test(oldSha) || !SHA.test(newSha) || !refName.startsWith("refs/") || /[\0-\x1f\x7f\s]/.test(refName)) {
			throw new CodeHostRefusal("GIT_HTTP_INVALID_COMMAND");
		}
		commands.push({ oldSha, newSha, refName });
		if (commands.length > 256) {
			throw new CodeHostRefusal("GIT_HTTP_TOO_MANY_REF_UPDATES");
		}
	}
	return commands;
}

function parseVerifiedToken(value: unknown): VerifiedGitToken {
	if (!isRecord(value) || value.allowed !== true) {
		throw new Error("GIT_HTTP_UNAUTHORIZED");
	}
	const { tokenId, companyId, environmentId, owner, name, defaultBranch } = value;
	if (
		typeof tokenId !== "string" ||
		!isUuid(tokenId) ||
		typeof companyId !== "string" ||
		!isUuid(companyId) ||
		typeof environmentId !== "string" ||
		!isUuid(environmentId) ||
		typeof owner !== "string" ||
		typeof name !== "string" ||
		typeof defaultBranch !== "string" ||
		defaultBranch.trim().length === 0
	) {
		throw new Error("GIT_HTTP_UNAUTHORIZED");
	}
	return { tokenId, companyId, environmentId, owner, name, defaultBranch: defaultBranch.trim() };
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	const encoding = (req.headers["content-encoding"] ?? "").toLowerCase().trim();
	if (encoding && encoding !== "identity" && encoding !== "gzip") {
		throw new CodeHostRefusal("GIT_HTTP_UNSUPPORTED_ENCODING");
	}
	const gunzip = encoding === "gzip" ? createGunzip() : null;
	const stream = gunzip ? req.pipe(gunzip) : req;
	try {
		for await (const chunk of stream) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buf.length;
			if (total > maxBytes) {
				gunzip?.destroy();
				req.destroy();
				throw new CodeHostRefusal("GIT_HTTP_BODY_TOO_LARGE");
			}
			chunks.push(buf);
		}
	} catch (error) {
		if (error instanceof CodeHostRefusal) throw error;
		if (gunzip) throw new CodeHostRefusal("GIT_HTTP_INVALID_GZIP");
		throw error;
	}
	return Buffer.concat(chunks, total);
}

async function readRefSha(run: Run, refName: string): Promise<string | null> {
	const res = await run.git(run.repo, ["rev-parse", "--verify", "--quiet", refName]);
	if (res.status !== 0) return null;
	const sha = res.stdout.toString("utf8").trim();
	return SHA.test(sha) ? sha : null;
}

export class CodeGitHttpServer {
	readonly #host: string;
	readonly #port: number;
	readonly #control: CodeGitHttpControl;
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #requestTimeoutMs: number;
	readonly #maxUploadPackBodyBytes: number;
	readonly #maxReceivePackBodyBytes: number;
	readonly #report: (event: Record<string, unknown>) => void;
	#server: Server | undefined;

	constructor(options: CodeGitHttpServerOptions) {
		this.#host = options.host ?? "127.0.0.1";
		this.#port = options.port;
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#maxUploadPackBodyBytes = options.maxUploadPackBodyBytes ?? DEFAULT_MAX_UPLOAD_PACK_BYTES;
		this.#maxReceivePackBodyBytes = options.maxReceivePackBodyBytes ?? DEFAULT_MAX_RECEIVE_PACK_BYTES;
		this.#report = options.report ?? (() => undefined);
	}

	get address(): AddressInfo | null {
		const addr = this.#server?.address();
		return addr && typeof addr === "object" ? addr : null;
	}

	async start(signal?: AbortSignal): Promise<AddressInfo> {
		if (this.#server) {
			const addr = this.address;
			if (!addr) throw new Error("CODE_GIT_HTTP_NOT_BOUND");
			return addr;
		}
		const server = createServer((req, res) => {
			void this.#handle(req, res);
		});
		this.#server = server;
		await new Promise<void>((resolveStart, rejectStart) => {
			const onAbort = () => {
				server.close();
				rejectStart(signal?.reason ?? new Error("CODE_GIT_HTTP_ABORTED"));
			};
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			server.once("error", (error) => {
				signal?.removeEventListener("abort", onAbort);
				rejectStart(error);
			});
			server.listen(this.#port, this.#host, () => {
				signal?.removeEventListener("abort", onAbort);
				resolveStart();
			});
		});
		const addr = this.address;
		if (!addr) throw new Error("CODE_GIT_HTTP_NOT_BOUND");
		return addr;
	}

	async close(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		await new Promise<void>((resolveClose) => {
			server.close(() => resolveClose());
		});
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const method = req.method ?? "GET";
		const url = req.url ?? "/";
		if (method === "GET" && url === "/health") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		const route = parseGitHttpRoute(method, url);
		if (!route) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			res.end("Not found\n");
			return;
		}

		const token = extractGitAuthToken(req.headers.authorization);
		if (!token) {
			res.writeHead(401, {
				"www-authenticate": 'Basic realm="Qorpera Git"',
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
			});
			res.end("Authentication required\n");
			return;
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("GIT_HTTP_TIMEOUT")), this.#requestTimeoutMs);
		timer.unref?.();
		const onClose = () => {
			if (!res.writableEnded) controller.abort(new Error("GIT_HTTP_CLIENT_CLOSED"));
		};
		res.once("close", onClose);

		try {
			const tokenSha256 = createHash("sha256").update(token, "utf8").digest("hex");
			const operation = route.service === "git-receive-pack" ? "write" : "read";
			let verified: VerifiedGitToken;
			try {
				const raw = await this.#control.call(
					"qorpera_verify_code_git_token",
					{
						p_token_sha256: tokenSha256,
						p_profile_id: route.companyId,
						p_owner: route.owner,
						p_name: route.name,
						p_operation: operation,
					},
					controller.signal,
				);
				verified = parseVerifiedToken(raw);
			} catch (error) {
				const classified = classifyVerifyFailure(error);
				res.writeHead(classified.status, {
					...(classified.challenge ? { "www-authenticate": 'Basic realm="Qorpera Git"' } : {}),
					"content-type": "text/plain; charset=utf-8",
					"cache-control": "no-store",
				});
				res.end(classified.body);
				return;
			}

			const repository = {
				host: "qorpera" as const,
				owner: verified.owner,
				name: verified.name,
				baseBranch: verified.defaultBranch,
			};

			if (route.endpoint === "info/refs") {
				const out = await this.#hosts.run(
					verified.companyId,
					verified.environmentId,
					controller.signal,
					async (job) =>
						withJob(job, repository, async (run) => {
							await run.prepare(undefined, { readOnly: true });
							const subcommand = route.service === "git-receive-pack" ? "receive-pack" : "upload-pack";
							const result = await run.command(
								[
									run.layout.git,
									...HIDE_INTERNAL_REFS_ARGS,
									subcommand,
									"--stateless-rpc",
									"--advertise-refs",
									run.repo,
								],
								{ maximumOutputBytes: MAX_ADVERTISE_BYTES },
							);
							if (result.status !== 0) {
								throw new CodeHostJobFailure("GIT_HTTP_ADVERTISE_FAILED", result.stderr);
							}
							return result.stdout;
						}),
					{ readOnly: true, yields: false },
				);
				const header = Buffer.concat([pktLine(`# service=${route.service}\n`), Buffer.from("0000", "ascii")]);
				res.writeHead(200, {
					"content-type": `application/x-${route.service}-advertisement`,
					"cache-control": "no-cache",
				});
				res.end(Buffer.concat([header, out]));
				return;
			}

			const maxBody =
				route.endpoint === "git-receive-pack" ? this.#maxReceivePackBodyBytes : this.#maxUploadPackBodyBytes;
			const body = await readRequestBody(req, maxBody);

			if (route.endpoint === "git-upload-pack") {
				const out = await this.#hosts.run(
					verified.companyId,
					verified.environmentId,
					controller.signal,
					async (job) =>
						withJob(job, repository, async (run) => {
							await run.prepare(undefined, { readOnly: true });
							const result = await run.command(
								[run.layout.git, ...HIDE_INTERNAL_REFS_ARGS, "upload-pack", "--stateless-rpc", run.repo],
								{ stdin: body, maximumOutputBytes: MAX_PACK },
							);
							if (result.status !== 0) {
								throw new CodeHostJobFailure("GIT_HTTP_UPLOAD_PACK_FAILED", result.stderr);
							}
							return result.stdout;
						}),
					{ readOnly: true, yields: false },
				);
				res.writeHead(200, {
					"content-type": "application/x-git-upload-pack-result",
					"cache-control": "no-cache",
				});
				res.end(out);
				return;
			}

			const commands = parseReceivePackCommands(body);
			const defaultRef = `refs/heads/${verified.defaultBranch}`;
			for (const cmd of commands) {
				if (isInternalPlatformRef(cmd.refName)) {
					res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
					res.end("Refused: cannot push to internal platform refs\n");
					return;
				}
				if (cmd.refName === defaultRef && cmd.newSha === ZERO) {
					res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
					res.end("Refused: cannot delete default branch\n");
					return;
				}
			}

			const receiveOutcome = await this.#hosts.run(
				verified.companyId,
				verified.environmentId,
				controller.signal,
				async (job) =>
					withJob(job, repository, async (run) => {
						const area = await run.prepare();
						const refSnapshots = new Map<string, string | null>();
						const trackedRefs = new Set<string>([defaultRef, ...commands.map((cmd) => cmd.refName)]);
						for (const refName of trackedRefs) {
							refSnapshots.set(refName, await readRefSha(run, refName));
						}
						const mainBefore = refSnapshots.get(defaultRef) ?? null;
						const result = await run.command(
							[
								run.layout.git,
								...HIDE_INTERNAL_REFS_ARGS,
								"-c",
								"receive.denyNonFastForwards=true",
								"-c",
								"receive.denyDeletes=true",
								"-c",
								"receive.fsckObjects=true",
								"receive-pack",
								"--stateless-rpc",
								run.repo,
							],
							{ stdin: body, maximumOutputBytes: MAX_ADVERTISE_BYTES },
						);
						if (result.status !== 0) {
							throw new CodeHostJobFailure("GIT_HTTP_RECEIVE_PACK_FAILED", result.stderr);
						}
						const mainAfter = await readRefSha(run, defaultRef);
						if (mainAfter && mainAfter !== mainBefore) {
							try {
								const records = await run.checkNames(run.repo, mainAfter);
								const refused = codeFolderRefuses(run.area, records, "main");
								if (refused.length > 0) {
									throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
								}
								await moveBase(run, area.main, defaultRef, mainAfter, mainAfter);
							} catch (error) {
								for (const [refName, priorSha] of refSnapshots.entries()) {
									const currentSha = await readRefSha(run, refName);
									if (currentSha === priorSha) continue;
									if (priorSha === null) {
										if (currentSha) {
											await run.git(run.repo, ["update-ref", "-d", refName, currentSha]);
										}
									} else if (currentSha) {
										await run.git(run.repo, ["update-ref", refName, priorSha, currentSha]);
									} else {
										await run.git(run.repo, ["update-ref", refName, priorSha]);
									}
								}
								throw error;
							}
							try {
								await this.#control.call(
									"qorpera_record_git_http_push",
									{
										p_environment_id: verified.environmentId,
										p_owner: verified.owner,
										p_name: verified.name,
										p_token_id: verified.tokenId,
										p_main_before: mainBefore,
										p_main_after: mainAfter,
										p_pushed_refs: commands.map((cmd) => cmd.refName),
									},
									AbortSignal.timeout(RECORD_PUSH_TIMEOUT_MS),
								);
							} catch (error) {
								this.#report({
									event: "code-git-http-record-error",
									companyId: verified.companyId,
									owner: verified.owner,
									name: verified.name,
									code: error instanceof Error ? error.message : "UNKNOWN",
								});
							}
						}
						return { stdout: result.stdout, mainBefore, mainAfter };
					}),
				{ readOnly: false, yields: false },
			);

			res.writeHead(200, {
				"content-type": "application/x-git-receive-pack-result",
				"cache-control": "no-cache",
			});
			res.end(receiveOutcome.stdout);
		} catch (error) {
			if (!res.headersSent) {
				if (error instanceof CodeHostRefusal) {
					const status = error.code === "GIT_HTTP_BODY_TOO_LARGE" ? 413 : 400;
					res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
					res.end(`${error.message}\n`);
				} else {
					res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
					res.end("Git HTTP operation failed\n");
				}
			}
			this.#report({
				event: "code-git-http-error",
				endpoint: route.endpoint,
				code: error instanceof Error ? error.message : "UNKNOWN",
			});
		} finally {
			clearTimeout(timer);
			res.off("close", onClose);
		}
	}
}
