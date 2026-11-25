import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { withAbortScopes } from "./abort-scope.ts";
import { generateChatGptPlanImage, hasChatGptPlanDirectory, hasChatGptPlanToken } from "./cloud-chatgpt-plan-image.ts";
import type { CloudClaudePictureLane } from "./cloud-claude-picture-lane.ts";
import type { CloudCompanyPathControl } from "./cloud-company-path-gateway.ts";
import { DEFAULT_GEMINI_IMAGE_MODEL, generateGeminiImage } from "./cloud-gemini-image.ts";
import { GeminiCapReachedError, GeminiKeyRevokedError, GeminiProviderError } from "./cloud-gemini-tool-session.ts";
import type { CloudNativeToolBinding } from "./cloud-native-tool-authority.ts";
import {
	CloudPictureChannel,
	CloudPictureFailure,
	type CloudPictureLane,
	CloudPictureUnavailable,
} from "./cloud-picture-channel.ts";
import type { CloudRuntimeImageModel } from "./cloud-runtime-policy.ts";
import { type GeminiKeyRunClient, openGeminiKeyForRun } from "./cloud-secret-broker-http.ts";

const RECORD_TIMEOUT_MS = 10_000;
const SIDE_LANE_CLOSE_MS = 30_000;

export async function hasCodexLogin(identityRoot: string): Promise<boolean> {
	try {
		const stat = await lstat(join(identityRoot, "codex", "auth.json"));
		return stat.isFile() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

export function serializePictureLane(lane: CloudPictureLane): CloudPictureLane {
	let inFlight = false;
	return async (input, signal) => {
		if (inFlight) throw new CloudPictureFailure("busy");
		inFlight = true;
		try {
			return await lane(input, signal);
		} finally {
			inFlight = false;
		}
	};
}

export interface GeminiImageRunnerOptions {
	readonly binding: CloudNativeToolBinding;
	readonly paths: CloudCompanyPathControl;
	readonly geminiKeys?: GeminiKeyRunClient;
	readonly existingApiKey?: string;
	readonly apiBaseUrl?: string;
	readonly allowLoopback?: boolean;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
	readonly signal: AbortSignal;
}

export function createGeminiImageLane(options: GeminiImageRunnerOptions): CloudPictureLane | undefined {
	if (!options.existingApiKey && !options.geminiKeys) return undefined;
	const { binding, paths, geminiKeys } = options;
	let cachedKey: Promise<string> | null = null;
	let capReached: { readonly monthlyCapCents: number | null; readonly monthSpendMicrodollars: number } | null = null;
	let usageRecorderFailed = false;

	const recordCapReached = async (): Promise<void> => {
		try {
			await withAbortScopes(
				[],
				(recordSignal) =>
					paths.call("qorpera_record_gemini_cap_reached", { p_binding: binding }, recordSignal, RECORD_TIMEOUT_MS),
				RECORD_TIMEOUT_MS,
			);
		} catch {}
	};

	const recordKeyError = async (errorCode: GeminiProviderError["code"]): Promise<void> => {
		try {
			await withAbortScopes(
				[],
				(recordSignal) =>
					paths.call(
						"qorpera_record_gemini_key_error",
						{ p_binding: binding, p_error_code: errorCode },
						recordSignal,
						RECORD_TIMEOUT_MS,
					),
				RECORD_TIMEOUT_MS,
			);
		} catch {}
	};

	const openApiKey = async (): Promise<string> => {
		if (capReached) {
			throw new GeminiCapReachedError(capReached.monthlyCapCents ?? 0, capReached.monthSpendMicrodollars);
		}
		if (options.existingApiKey) return options.existingApiKey;
		if (!cachedKey) {
			if (!geminiKeys) throw new GeminiKeyRevokedError();
			cachedKey = openGeminiKeyForRun(
				geminiKeys,
				{
					leaseId: binding.leaseId,
					runId: binding.runId,
					jobId: binding.jobId,
					runnerId: binding.runnerId,
					assignmentId: binding.assignmentId,
					credentialCapsuleId: binding.credentialCapsuleId,
					computeIdentityId: binding.computeIdentityId,
				},
				options.signal,
			).then(
				(opened) => {
					if (opened.state === "refused") {
						cachedKey = null;
						if (opened.reason === "CAP_REACHED") {
							capReached = {
								monthlyCapCents: opened.monthlyCapCents,
								monthSpendMicrodollars: opened.monthSpendMicrodollars,
							};
							throw new GeminiCapReachedError(opened.monthlyCapCents, opened.monthSpendMicrodollars);
						}
						throw new GeminiKeyRevokedError();
					}
					return opened.apiKey;
				},
				(error) => {
					cachedKey = null;
					if (options.signal.aborted) throw error;
					if (error instanceof Error && /refused the Gemini key/i.test(error.message)) {
						throw new GeminiKeyRevokedError();
					}
					throw error;
				},
			);
		}
		return cachedKey;
	};

	return serializePictureLane(async (input, callSignal) => {
		try {
			if (usageRecorderFailed) throw new CloudPictureUnavailable();
			const apiKey = await openApiKey();
			callSignal.throwIfAborted();
			const result = await generateGeminiImage({
				apiKey,
				prompt: input.prompt,
				model: DEFAULT_GEMINI_IMAGE_MODEL,
				...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
				...(options.allowLoopback ? { allowLoopback: true } : {}),
				...(options.fetcher ? { fetcher: options.fetcher } : {}),
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				onUsage: async (usage) => {
					let recorded: {
						monthSpendMicrodollars?: unknown;
						monthlyCapCents?: unknown;
						capReached?: unknown;
					} | null;
					try {
						recorded = (await withAbortScopes(
							[],
							(recordSignal) =>
								paths.call(
									"qorpera_record_gemini_image_usage",
									{ p_binding: binding, p_model: DEFAULT_GEMINI_IMAGE_MODEL, p_usage: usage },
									recordSignal,
									RECORD_TIMEOUT_MS,
								),
							RECORD_TIMEOUT_MS,
						)) as {
							monthSpendMicrodollars?: unknown;
							monthlyCapCents?: unknown;
							capReached?: unknown;
						} | null;
					} catch {
						usageRecorderFailed = true;
						throw new CloudPictureUnavailable();
					}
					if (!recorded || typeof recorded !== "object" || typeof recorded.capReached !== "boolean") {
						usageRecorderFailed = true;
						throw new CloudPictureUnavailable();
					}
					if (recorded.capReached) {
						capReached = {
							monthlyCapCents: typeof recorded.monthlyCapCents === "number" ? recorded.monthlyCapCents : null,
							monthSpendMicrodollars:
								typeof recorded.monthSpendMicrodollars === "number" ? recorded.monthSpendMicrodollars : 0,
						};
					}
				},
				signal: callSignal,
			});
			return { png: result.png };
		} catch (error) {
			if (callSignal.aborted) throw error;
			if (error instanceof CloudPictureFailure || error instanceof CloudPictureUnavailable) throw error;
			if (error instanceof GeminiCapReachedError) {
				await recordCapReached();
				throw new CloudPictureFailure("spend_cap");
			}
			if (error instanceof GeminiKeyRevokedError) {
				cachedKey = null;
				throw new CloudPictureUnavailable();
			}
			if (error instanceof GeminiProviderError) {
				await recordKeyError(error.code);
				if (error.code === "key_rejected") {
					cachedKey = null;
					throw new CloudPictureUnavailable();
				}
				if (error.code === "billing_required") throw new CloudPictureFailure("billing_required");
				if (error.code === "quota_exhausted") throw new CloudPictureFailure("picture_limit");
				if (error.code === "invalid_request") throw new CloudPictureFailure("refused");
				throw new CloudPictureFailure("failed");
			}
			throw new CloudPictureFailure("failed");
		}
	});
}

export function createChatGptPlanImageLane(options: {
	readonly identityRoot: string;
	readonly model?: string;
	readonly apiBaseUrl?: string;
	readonly allowLoopback?: boolean;
	readonly fetcher?: typeof fetch;
	readonly timeoutMs?: number;
}): CloudPictureLane {
	return serializePictureLane((input, signal) =>
		generateChatGptPlanImage({
			identityRoot: options.identityRoot,
			prompt: input.prompt,
			...(options.model ? { model: options.model } : {}),
			...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
			...(options.allowLoopback ? { allowLoopback: true } : {}),
			...(options.fetcher ? { fetcher: options.fetcher } : {}),
			...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			signal,
		}),
	);
}

export interface ResolveRunPictureLaneOptions {
	readonly preferredModel?: CloudRuntimeImageModel;
	readonly identityRoot: string;
	readonly usesPrimaryCodexSession: boolean;
	readonly allowChatGptSubscription?: boolean;
	readonly geminiLane?: CloudPictureLane;
	readonly geminiFallbackAllowed?: boolean;
	readonly startCodexSideLane?: () => Promise<CloudClaudePictureLane | undefined>;
	readonly chatGptPlanModel?: string;
	readonly chatGptPlanApiBaseUrl?: string;
	readonly chatGptPlanAllowLoopback?: boolean;
	readonly chatGptPlanFetch?: typeof fetch;
	readonly timeoutMs?: number;
}

export interface ResolvedRunPictureLane {
	readonly channel?: CloudPictureChannel;
	readonly attachToCodex: boolean;
	readonly close: () => Promise<void>;
}

const NOOP_CLOSE = async (): Promise<void> => undefined;

async function closeSideLane(sideLane: CloudClaudePictureLane): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			sideLane.close().catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, SIDE_LANE_CLOSE_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function resolveRunPictureLane(options: ResolveRunPictureLaneOptions): Promise<ResolvedRunPictureLane> {
	const channelOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };
	const makeAttached = (lane: CloudPictureLane): CloudPictureChannel => {
		const channel = new CloudPictureChannel(channelOptions);
		channel.attach(lane);
		return channel;
	};

	if (options.preferredModel === "gemini-3-pro-image" && options.geminiLane) {
		return {
			channel: makeAttached(options.geminiLane),
			attachToCodex: false,
			close: NOOP_CLOSE,
		};
	}

	if (options.allowChatGptSubscription !== false) {
		if (await hasChatGptPlanToken(options.identityRoot)) {
			const planLane = createChatGptPlanImageLane({
				identityRoot: options.identityRoot,
				...(options.chatGptPlanModel ? { model: options.chatGptPlanModel } : {}),
				...(options.chatGptPlanApiBaseUrl ? { apiBaseUrl: options.chatGptPlanApiBaseUrl } : {}),
				...(options.chatGptPlanAllowLoopback ? { allowLoopback: true } : {}),
				...(options.chatGptPlanFetch ? { fetcher: options.chatGptPlanFetch } : {}),
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
			});
			return {
				channel: makeAttached(planLane),
				attachToCodex: false,
				close: NOOP_CLOSE,
			};
		}
		if (!(await hasChatGptPlanDirectory(options.identityRoot))) {
			if (options.usesPrimaryCodexSession) {
				return {
					channel: new CloudPictureChannel(channelOptions),
					attachToCodex: true,
					close: NOOP_CLOSE,
				};
			}
			if ((await hasCodexLogin(options.identityRoot)) && options.startCodexSideLane) {
				const sideLane = await options.startCodexSideLane();
				if (sideLane) {
					return {
						channel: makeAttached((input, signal) => sideLane.make(input, signal)),
						attachToCodex: false,
						close: () => closeSideLane(sideLane),
					};
				}
			}
		}
	}

	if (options.geminiFallbackAllowed && options.geminiLane) {
		return {
			channel: makeAttached(options.geminiLane),
			attachToCodex: false,
			close: NOOP_CLOSE,
		};
	}

	return {
		attachToCodex: false,
		close: NOOP_CLOSE,
	};
}
