import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAbortScopes } from "./abort-scope.ts";
import { narrateSpokenLine } from "./cloud-app-narrate-tool.ts";
import { EXPLAINER_VOICE_PEER_CJS } from "./cloud-embedded-assets.ts";
import {
	type CloudVoiceCall,
	type CloudVoiceChannel,
	CloudVoiceLimitReached,
	type CloudVoiceName,
	cloudVoiceUsageFull,
	MAX_CLOUD_VOICE_TEXT_BYTES,
} from "./cloud-voice-channel.ts";

export interface StudioChatGptVoiceClip {
	readonly hash: string;
	readonly audio: Uint8Array;
	readonly mediaType: "audio/webm";
	readonly fileExtension: "webm";
	readonly seconds: number;
}

export interface StudioChatGptVoiceBatchResult {
	readonly clips: readonly StudioChatGptVoiceClip[];
	readonly stopReason: "limit_reached" | "error" | null;
	readonly errorMessage?: string;
}

const PREFIX = "QORPERA-VOICE ";
const PEER_SECONDS = 240;
const FINISHING_SECONDS = 25;
const OFFER_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 45_000;

export async function recordStudioChatGptVoiceClips(input: {
	readonly voice: Pick<CloudVoiceChannel, "open" | "usage">;
	readonly voiceName?: CloudVoiceName;
	readonly captions: readonly { readonly hash: string; readonly text: string }[];
	readonly signal: AbortSignal;
}): Promise<StudioChatGptVoiceBatchResult> {
	const usage = await input.voice.usage(input.signal).catch(() => undefined);
	if (cloudVoiceUsageFull(usage)) {
		return { clips: [], stopReason: "limit_reached" };
	}
	const workDir = await mkdtemp(join(tmpdir(), "qorpera-studio-voice-"));
	const scriptPath = join(workDir, "voice-peer.cjs");
	await writeFile(scriptPath, EXPLAINER_VOICE_PEER_CJS, "utf8");

	const child = spawn(process.execPath, [scriptPath, workDir, String(PEER_SECONDS), String(FINISHING_SECONDS)], {
		env: { ...process.env, QORPERA_PLAYWRIGHT: "playwright-core" },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const lines: Record<string, unknown>[] = [];
	const waiters = new Set<() => void>();
	let stdoutBuf = "";
	let closed = false;
	const wake = () => {
		for (const fn of [...waiters]) fn();
	};
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuf += chunk;
		let newline = stdoutBuf.indexOf("\n");
		while (newline >= 0) {
			const line = stdoutBuf.slice(0, newline).trim();
			stdoutBuf = stdoutBuf.slice(newline + 1);
			if (line.startsWith(PREFIX)) {
				try {
					const parsed = JSON.parse(line.slice(PREFIX.length)) as unknown;
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						lines.push(parsed as Record<string, unknown>);
						wake();
					}
				} catch {}
			}
			newline = stdoutBuf.indexOf("\n");
		}
	});
	child.on("close", () => {
		closed = true;
		wake();
	});

	const waitForLine = (
		predicate: (line: Record<string, unknown>) => boolean,
		timeoutMs: number,
	): Promise<Record<string, unknown> | null> => {
		const existing = lines.find(predicate);
		if (existing) return Promise.resolve(existing);
		if (closed || input.signal.aborted) return Promise.resolve(null);
		return new Promise((resolve) => {
			let settled = false;
			const done = (value: Record<string, unknown> | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				waiters.delete(check);
				input.signal.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const check = () => {
				const found = lines.find(predicate);
				if (found) done(found);
				else if (closed) done(null);
			};
			const onAbort = () => done(null);
			const timer = setTimeout(() => done(null), timeoutMs);
			waiters.add(check);
			input.signal.addEventListener("abort", onAbort, { once: true });
		});
	};

	const clips: StudioChatGptVoiceClip[] = [];
	let stopReason: "limit_reached" | "error" | null = null;
	let errorMessage: string | undefined;
	let call: CloudVoiceCall | undefined;
	try {
		const offerLine = await waitForLine(
			(line) => typeof line.offer === "string" || "ended" in line,
			OFFER_TIMEOUT_MS,
		);
		if (typeof offerLine?.offer !== "string") {
			return {
				clips: [],
				stopReason: "error",
				errorMessage: "Local voice recorder did not produce an offer",
			};
		}
		try {
			call = await input.voice.open(
				{ offerSdp: offerLine.offer, ...(input.voiceName ? { voice: input.voiceName } : {}) },
				input.signal,
			);
		} catch (error) {
			if (error instanceof CloudVoiceLimitReached) {
				return { clips: [], stopReason: "limit_reached" };
			}
			return {
				clips: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
		const answer = call.answerSdp.endsWith("\n") ? call.answerSdp : `${call.answerSdp}\n`;
		await writeFile(join(workDir, "answer.sdp"), answer, "utf8");
		const connected = await waitForLine((line) => line.connected === true || "ended" in line, CONNECT_TIMEOUT_MS);
		if (connected?.connected !== true) {
			return {
				clips: [],
				stopReason: "error",
				errorMessage: "Voice call did not connect to recorder",
			};
		}

		let expectedTurn = 0;
		for (const caption of input.captions) {
			if (input.signal.aborted) break;
			const spokenPrompt = narrateSpokenLine(caption.text);
			if (Buffer.byteLength(spokenPrompt) > MAX_CLOUD_VOICE_TEXT_BYTES) continue;
			expectedTurn += 1;
			try {
				await withAbortScopes(
					[input.signal],
					(turnSignal) => call!.speak(spokenPrompt, turnSignal),
					TURN_TIMEOUT_MS,
				);
			} catch (error) {
				if (error instanceof CloudVoiceLimitReached) {
					stopReason = "limit_reached";
					break;
				}
				stopReason = "error";
				errorMessage = error instanceof Error ? error.message : String(error);
				break;
			}
			const recordedTurn = await waitForLine(
				(line) => line.turn === expectedTurn || "ended" in line,
				TURN_TIMEOUT_MS,
			);
			if (!recordedTurn || typeof recordedTurn.file !== "string") {
				stopReason = "error";
				errorMessage = "Voice turn audio was not written";
				break;
			}
			const audioBytes = await readFile(join(workDir, recordedTurn.file));
			const ms = typeof recordedTurn.ms === "number" && Number.isFinite(recordedTurn.ms) ? recordedTurn.ms : 1000;
			clips.push({
				hash: caption.hash,
				audio: new Uint8Array(audioBytes),
				mediaType: "audio/webm",
				fileExtension: "webm",
				seconds: Math.max(0.1, Math.round((ms / 1000) * 100) / 100),
			});
		}
	} finally {
		await call?.close().catch(() => undefined);
		await writeFile(join(workDir, "stop"), "").catch(() => undefined);
		await waitForLine((line) => "ended" in line, 3_000).catch(() => undefined);
		if (!closed) {
			try {
				child.kill("SIGKILL");
			} catch {}
		}
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
	return {
		clips,
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
	};
}
