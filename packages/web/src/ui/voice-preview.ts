import { CHATGPT_VOICE_PROFILES } from "../cloud/default-models.ts";

export type VoicePreviewLocale = "en" | "da";

export const PREVIEWABLE_VOICE_MODELS = ["chatgpt-voice"] as const;

export interface VoiceSampleAudio {
	currentTime: number;
	preload: string;
	play(): Promise<void> | undefined;
	pause(): void;
	addEventListener(type: "ended" | "error", listener: () => void): void;
	removeEventListener(type: "ended" | "error", listener: () => void): void;
}

export type VoiceAudioFactory = (url: string) => VoiceSampleAudio;

const PREVIEWABLE_VOICE_MODEL_SET = new Set<string>(PREVIEWABLE_VOICE_MODELS);
const CHATGPT_PROFILE_SET = new Set<string>(CHATGPT_VOICE_PROFILES);

export function hasVoiceModelPreview(modelId: string): boolean {
	return PREVIEWABLE_VOICE_MODEL_SET.has(modelId);
}

export function voiceSampleRelativePath(modelId: string, voiceName: string, locale: VoicePreviewLocale): string | null {
	if (modelId !== "chatgpt-voice" || !CHATGPT_PROFILE_SET.has(voiceName)) return null;
	return `./assets/voice-samples/${modelId}/${locale}/${voiceName.toLowerCase()}.mp3`;
}

export function voiceSampleUrl(modelId: string, voiceName: string, locale: VoicePreviewLocale): string | null {
	const relative = voiceSampleRelativePath(modelId, voiceName, locale);
	if (!relative) return null;
	return new URL(relative, document.baseURI).href;
}

export class VoicePreviewPlayer {
	readonly #onStateChange: () => void;
	readonly #onError: () => void;
	readonly #createAudio: VoiceAudioFactory;
	#audio: VoiceSampleAudio | undefined;
	#activeKey: string | undefined;
	#cleanup: (() => void) | undefined;
	#disposed = false;

	constructor(
		onStateChange: () => void,
		onError: () => void,
		createAudio: VoiceAudioFactory = (url) => new Audio(url),
	) {
		this.#onStateChange = onStateChange;
		this.#onError = onError;
		this.#createAudio = createAudio;
	}

	isPlaying(key?: string): boolean {
		if (!this.#activeKey) return false;
		return key === undefined ? true : this.#activeKey === key;
	}

	stop(): void {
		const hadActive = this.#audio !== undefined || this.#activeKey !== undefined;
		this.#release();
		if (hadActive && !this.#disposed) this.#onStateChange();
	}

	dispose(): void {
		this.#disposed = true;
		this.#release();
	}

	async play(url: string, key: string): Promise<boolean> {
		if (this.#disposed) return false;
		this.#release();
		const audio = this.#createAudio(url);
		audio.preload = "auto";
		let settledError = false;
		const finish = (failed: boolean): void => {
			if (this.#audio !== audio) return;
			this.#release();
			if (this.#disposed) return;
			if (failed) {
				settledError = true;
				this.#onError();
			} else {
				this.#onStateChange();
			}
		};
		const onEnded = () => finish(false);
		const onError = () => finish(true);
		audio.addEventListener("ended", onEnded);
		audio.addEventListener("error", onError);
		this.#audio = audio;
		this.#activeKey = key;
		this.#cleanup = () => {
			audio.removeEventListener("ended", onEnded);
			audio.removeEventListener("error", onError);
			try {
				audio.pause();
				audio.currentTime = 0;
			} catch {}
		};
		this.#onStateChange();
		try {
			await audio.play();
			return !settledError;
		} catch {
			if (this.#audio !== audio) return !settledError;
			this.#release();
			if (!this.#disposed) this.#onStateChange();
			return false;
		}
	}

	#release(): void {
		const cleanup = this.#cleanup;
		this.#cleanup = undefined;
		this.#audio = undefined;
		this.#activeKey = undefined;
		cleanup?.();
	}
}
