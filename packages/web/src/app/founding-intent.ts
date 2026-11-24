import { CloudRpcError, describeError } from "../cloud/client.ts";
import { t } from "../ui/preferences.ts";

export interface FoundingIntent {
	friends?: boolean;
	vision?: string;
	start?: boolean;
	founders?: string[];
	spectators?: string[];
}

const intents = new Map<string, FoundingIntent>();
const intentKey = (profileId: string) => `qorpera:founding-intent:${profileId}`;

function texts(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
		: [];
}

export function setFoundingIntent(profileId: string, intent: FoundingIntent): void {
	if (!intent.friends && !intent.vision && !intent.start && !intent.founders?.length && !intent.spectators?.length) {
		intents.delete(profileId);
		try {
			sessionStorage.removeItem(intentKey(profileId));
		} catch {
			return;
		}
		return;
	}
	intents.set(profileId, intent);
	try {
		sessionStorage.setItem(intentKey(profileId), JSON.stringify(intent));
	} catch {
		return;
	}
}

export function takeFoundingIntent(profileId: string): FoundingIntent | undefined {
	const kept = intents.get(profileId);
	if (kept) return kept;
	try {
		const saved: unknown = JSON.parse(sessionStorage.getItem(intentKey(profileId)) ?? "null");
		if (!saved || typeof saved !== "object") return undefined;
		const vision = "vision" in saved && typeof saved.vision === "string" ? saved.vision.trim() : "";
		const founders = "founders" in saved ? texts(saved.founders) : [];
		const spectators = "spectators" in saved ? texts(saved.spectators) : [];
		return {
			...("friends" in saved && saved.friends === true ? { friends: true } : {}),
			...(vision ? { vision } : {}),
			...("start" in saved && saved.start === true ? { start: true } : {}),
			...(founders.length ? { founders } : {}),
			...(spectators.length ? { spectators } : {}),
		};
	} catch {
		return undefined;
	}
}

export function lobbyError(error: unknown): string {
	return error instanceof CloudRpcError && error.code === "0A000"
		? t("Creating a company is paused. Try again later.")
		: describeError(error);
}
