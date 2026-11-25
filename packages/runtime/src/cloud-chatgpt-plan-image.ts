import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedCloudResponse } from "@qorpera/cloud-client/cloud-request";
import { withAbortScopes } from "./abort-scope.ts";
import { CHATGPT_PLAN_RESOURCE } from "./cloud-chatgpt-plan.ts";
import {
	convertImageBytesToPng,
	FolderImageRefusal,
	MAX_FOLDER_IMAGE_BYTES,
	oneImageAtATime,
} from "./cloud-folder-images.ts";
import { CHATGPT_PLAN_DIRECTORY, CHATGPT_PLAN_TOKEN_FILE } from "./cloud-native-isolation.ts";
import {
	CLOUD_PICTURE_MS,
	CloudPictureFailure,
	type CloudPictureMade,
	CloudPictureUnavailable,
	cloudPictureInput,
	MAX_CLOUD_PICTURE_BYTES,
	MAX_CLOUD_PICTURE_PROMPT_BYTES,
} from "./cloud-picture-channel.ts";

export const CHATGPT_PLAN_DEFAULT_API_BASE = CHATGPT_PLAN_RESOURCE;
export const DEFAULT_CHATGPT_PLAN_IMAGE_MODEL = "gpt-6.2-sol";

const MAX_PLAN_TOKEN_BYTES = 16 * 1024;
const MAX_PLAN_IMAGE_RESPONSE_BYTES = 24 * 1024 * 1024;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;
const MAX_RETRY_WAIT_MS = 10_000;
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;
const REFUSAL_PATTERN = /content[_\s-]?policy|moderation|safety|refus|disallowed|policy[_\s-]?violation/i;
const IMAGE_LIMIT_PATTERN = /image[_\s-]?gen|image[_\s-]?limit|too many images|pictures? left/i;
const FREE_PLAN_PATTERN = /\bfree\s+(?:plan|tier)\b/i;

export interface GenerateChatGptPlanImageInput {
	readonly identityRoot: string;
	readonly prompt: string;
	readonly model?: string;
	readonly apiBaseUrl?: string;
	readonly allowLoopback?: boolean;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
	readonly signal: AbortSignal;
}

export async function hasChatGptPlanDirectory(identityRoot: string): Promise<boolean> {
	try {
		await lstat(join(identityRoot, CHATGPT_PLAN_DIRECTORY));
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

export async function hasChatGptPlanToken(identityRoot: string): Promise<boolean> {
	try {
		const stat = await lstat(join(identityRoot, CHATGPT_PLAN_DIRECTORY, CHATGPT_PLAN_TOKEN_FILE));
		return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_PLAN_TOKEN_BYTES;
	} catch {
		return false;
	}
}

async function readChatGptPlanAccessToken(identityRoot: string): Promise<string> {
	const tokenPath = join(identityRoot, CHATGPT_PLAN_DIRECTORY, CHATGPT_PLAN_TOKEN_FILE);
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(tokenPath);
	} catch {
		throw new CloudPictureUnavailable();
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_PLAN_TOKEN_BYTES) {
		throw new CloudPictureUnavailable();
	}
	let raw: string;
	try {
		raw = await readFile(tokenPath, "utf8");
	} catch {
		throw new CloudPictureUnavailable();
	}
	const token = raw.trim();
	if (!token || token.length > MAX_PLAN_TOKEN_BYTES || !TOKEN_PATTERN.test(token)) {
		throw new CloudPictureUnavailable();
	}
	return token;
}

function validateChatGptPlanBaseUrl(value: string, allowLoopback: boolean): string {
	const url = new URL(value);
	const allowedProduction = url.protocol === "https:" && url.hostname === "api.openai.com";
	const allowedTest =
		allowLoopback && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if ((!allowedProduction && !allowedTest) || url.username || url.password || url.search || url.hash) {
		throw new Error("ChatGPT plan API base URL is invalid");
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimRevisedPrompt(text: string): { readonly revisedPrompt: string; readonly revisedPromptCut?: true } {
	if (Buffer.byteLength(text, "utf8") <= MAX_CLOUD_PICTURE_PROMPT_BYTES) {
		return { revisedPrompt: text };
	}
	let used = 0;
	let out = "";
	for (const ch of text) {
		const size = Buffer.byteLength(ch, "utf8");
		if (used + size > MAX_CLOUD_PICTURE_PROMPT_BYTES) break;
		out += ch;
		used += size;
	}
	return { revisedPrompt: out, revisedPromptCut: true };
}

function parseRetryAfterMs(header: string | null): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (!/^\d{1,6}$/.test(trimmed)) return null;
	const seconds = Number(trimmed);
	if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
	return Math.min(MAX_RETRY_WAIT_MS, seconds * 1_000);
}

function parseResetsAt(
	errorObj: Record<string, unknown> | undefined,
	retryAfterHeader: string | null,
): number | undefined {
	if (errorObj) {
		const raw = errorObj.resets_at ?? errorObj.resetsAt;
		if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
			return Math.trunc(raw > 1e11 ? raw / 1000 : raw);
		}
	}
	const retryMs = parseRetryAfterMs(retryAfterHeader);
	if (retryMs !== null) {
		return Math.ceil((Date.now() + retryMs) / 1000);
	}
	return undefined;
}

function classifyPlanHttpError(
	status: number,
	bodyBytes: Uint8Array,
	retryAfterHeader: string | null,
): CloudPictureFailure {
	let errorObj: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes.subarray(0, 8192)),
		) as unknown;
		if (isPlainObject(parsed) && isPlainObject(parsed.error)) {
			errorObj = parsed.error;
		}
	} catch {}
	const code = typeof errorObj?.code === "string" ? errorObj.code : "";
	const type = typeof errorObj?.type === "string" ? errorObj.type : "";
	const message = typeof errorObj?.message === "string" ? errorObj.message : "";
	const combined = `${code} ${type} ${message}`;

	if (status === 429) {
		const resetsAt = parseResetsAt(errorObj, retryAfterHeader);
		if (IMAGE_LIMIT_PATTERN.test(combined)) {
			return new CloudPictureFailure("picture_limit", resetsAt);
		}
		return new CloudPictureFailure("usage_limit", resetsAt);
	}
	if ((status === 401 || status === 403) && FREE_PLAN_PATTERN.test(combined)) {
		return new CloudPictureFailure("free_plan");
	}
	if (status === 400 && REFUSAL_PATTERN.test(combined)) {
		return new CloudPictureFailure("refused");
	}
	return new CloudPictureFailure("failed");
}

function pauseWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref?.();
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function generateChatGptPlanImage(input: GenerateChatGptPlanImageInput): Promise<CloudPictureMade> {
	const { prompt } = cloudPictureInput({ prompt: input.prompt });
	const accessToken = await readChatGptPlanAccessToken(input.identityRoot);
	const baseUrl = validateChatGptPlanBaseUrl(
		input.apiBaseUrl ?? CHATGPT_PLAN_DEFAULT_API_BASE,
		input.allowLoopback === true,
	);
	const url = `${baseUrl}/responses`;
	const model = input.model?.trim() || DEFAULT_CHATGPT_PLAN_IMAGE_MODEL;
	const fetcher = input.fetcher ?? fetch;
	const timeoutMs = input.timeoutMs ?? CLOUD_PICTURE_MS;
	const body = JSON.stringify({
		model,
		input: prompt,
		tools: [{ type: "image_generation", output_format: "png" }],
		tool_choice: { type: "image_generation" },
		store: false,
	});

	for (let attempt = 0; ; attempt += 1) {
		input.signal.throwIfAborted();
		let retryWait: number | undefined;
		let bytes: Uint8Array | undefined;
		await withAbortScopes(
			[input.signal],
			async (requestSignal) => {
				let response: Response;
				try {
					response = await fetcher(url, {
						method: "POST",
						redirect: "error",
						headers: {
							authorization: `Bearer ${accessToken}`,
							"content-type": "application/json",
						},
						body,
						signal: requestSignal,
					});
				} catch (error) {
					if (input.signal.aborted) throw error;
					if (requestSignal.aborted) throw new CloudPictureFailure("timeout");
					const wait = RETRY_DELAYS_MS[attempt];
					if (wait !== undefined) {
						retryWait = wait;
						return;
					}
					throw new CloudPictureFailure("failed");
				}

				try {
					bytes = await readBoundedCloudResponse(response, MAX_PLAN_IMAGE_RESPONSE_BYTES, requestSignal);
				} catch (error) {
					if (input.signal.aborted) throw error;
					if (requestSignal.aborted) throw new CloudPictureFailure("timeout");
					throw new CloudPictureFailure("too_large");
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}

				if (!response.ok) {
					const transient =
						response.status === 500 ||
						response.status === 502 ||
						response.status === 503 ||
						response.status === 504;
					const fallbackWait = RETRY_DELAYS_MS[attempt];
					if (transient && fallbackWait !== undefined) {
						retryWait = Math.min(
							MAX_RETRY_WAIT_MS,
							parseRetryAfterMs(response.headers.get("retry-after")) ?? fallbackWait,
						);
						return;
					}
					throw classifyPlanHttpError(response.status, bytes, response.headers.get("retry-after"));
				}
			},
			timeoutMs,
		);

		if (retryWait !== undefined) {
			await pauseWithAbort(retryWait, input.signal);
			continue;
		}
		if (!bytes) throw new CloudPictureFailure("failed");

		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new CloudPictureFailure("invalid");
		}
		if (!isPlainObject(parsed)) throw new CloudPictureFailure("invalid");
		const output = Array.isArray(parsed.output) ? parsed.output.filter(isPlainObject) : [];
		let imageBase64: string | undefined;
		let revisedPromptRaw: string | undefined;
		let refused = false;
		for (const item of output) {
			if (item.type === "image_generation_call") {
				if (typeof item.result === "string" && item.result.length > 0 && item.status !== "failed") {
					imageBase64 = item.result;
					revisedPromptRaw = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
				} else if (item.status === "failed" || item.error !== undefined) {
					refused = true;
				}
			} else if (item.type === "message" && Array.isArray(item.content)) {
				for (const part of item.content) {
					if (isPlainObject(part) && part.type === "refusal") {
						refused = true;
					}
				}
			}
		}
		if (!imageBase64) {
			throw new CloudPictureFailure(refused ? "refused" : "no_picture");
		}
		const decoded = Buffer.from(imageBase64, "base64");
		if (decoded.byteLength === 0) throw new CloudPictureFailure("invalid");
		if (decoded.byteLength > MAX_FOLDER_IMAGE_BYTES) throw new CloudPictureFailure("too_large");

		let png: Buffer;
		try {
			png = await oneImageAtATime(input.signal, async () => convertImageBytesToPng(decoded));
		} catch (error) {
			if (error instanceof FolderImageRefusal) {
				throw new CloudPictureFailure(error.reason === "too_large" ? "too_large" : "invalid");
			}
			throw error;
		}
		if (png.byteLength > MAX_CLOUD_PICTURE_BYTES) {
			throw new CloudPictureFailure("too_large");
		}
		const revised =
			revisedPromptRaw && revisedPromptRaw.trim().length > 0 ? trimRevisedPrompt(revisedPromptRaw) : undefined;
		return {
			png,
			...(revised ?? {}),
		};
	}
}
