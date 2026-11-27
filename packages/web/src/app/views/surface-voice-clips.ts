export interface VoiceClipMeta {
	readonly caption: string;
	readonly file: string;
	readonly seconds: number;
}

const CAPTION_HASH_RE = /^[0-9a-f]{8}$/;
const CLIP_AUDIO_EXTS = new Set(["wav", "mp4", "m4a", "mp3", "webm"]);

export function captionHash(text: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

export function voiceClipMime(file: string, mediaType: string): string {
	if (mediaType.startsWith("audio/")) return mediaType;
	const lower = file.toLowerCase();
	if (lower.endsWith(".wav")) return "audio/wav";
	if (lower.endsWith(".mp3")) return "audio/mpeg";
	if (lower.endsWith(".webm")) return "audio/webm";
	return "audio/mp4";
}

export function parseVoiceClips(text: string | undefined): Map<string, VoiceClipMeta> {
	const out = new Map<string, VoiceClipMeta>();
	if (!text) return out;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return out;
	}
	const list =
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		Array.isArray((parsed as { clips?: unknown }).clips)
			? (parsed as { clips: unknown[] }).clips
			: [];
	for (const raw of list) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const rec = raw as Record<string, unknown>;
		const caption = typeof rec.caption === "string" ? rec.caption : "";
		const file = typeof rec.file === "string" ? rec.file : "";
		const seconds = typeof rec.seconds === "number" ? rec.seconds : Number.NaN;
		const dot = file.lastIndexOf(".");
		if (
			!CAPTION_HASH_RE.test(caption) ||
			dot <= 0 ||
			file.slice(0, dot) !== caption ||
			!CLIP_AUDIO_EXTS.has(file.slice(dot + 1)) ||
			!Number.isFinite(seconds) ||
			seconds <= 0 ||
			seconds > 60
		) {
			continue;
		}
		if (!out.has(caption)) out.set(caption, { caption, file, seconds });
	}
	return out;
}
