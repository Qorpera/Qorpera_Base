import { createHash } from "node:crypto";

export interface SessionMessagePreview {
	id: string;
	role: "user" | "assistant";
	text: string;
	timestamp: number;
}

export interface SessionSidebarPreview {
	lastMessage?: SessionMessagePreview;
	lastAssistantMessage?: SessionMessagePreview;
}

/** Public message text only: reasoning, tool arguments/results, host context,
 * and transport records never become a sidebar snippet or an unread marker. */
export function sessionSidebarPreview(content: Buffer, partialHead = false): SessionSidebarPreview {
	const lines = content.toString("utf-8").split("\n");
	if (partialHead) lines.shift();
	const preview: SessionSidebarPreview = {};
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as {
				type?: string;
				id?: string;
				timestamp?: string;
				message?: {
					role?: string;
					content?: string | Array<{ type?: string; text?: string }>;
					timestamp?: number;
					stopReason?: string;
				};
			};
			const message = entry.message;
			if (entry.type !== "message" || !message || (message.role !== "user" && message.role !== "assistant"))
				continue;
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const content = message.content;
			const raw =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((part) => part.type === "text" && typeof part.text === "string")
								.map((part) => part.text)
								.join(" ")
						: "";
			const text = raw
				.replace(/^(?:\[(?:Sidechat|Connection choice) context:[^\]]*\]\s*)+/, "")
				.replace(/\s+/g, " ")
				.trim();
			const imageOnly = Array.isArray(content) && content.some((part) => part.type === "image");
			if (!text && !imageOnly) continue;
			const timestamp = message.timestamp ?? Date.parse(entry.timestamp ?? "");
			if (!Number.isFinite(timestamp) || timestamp < 0) continue;
			const item: SessionMessagePreview = {
				id:
					typeof entry.id === "string"
						? entry.id
						: createHash("sha256").update(`${message.role}:${timestamp}:${text}`).digest("hex").slice(0, 24),
				role: message.role,
				text: (text || "Image").slice(0, 240),
				timestamp,
			};
			preview.lastMessage = item;
			if (
				message.role === "assistant" &&
				(!message.stopReason || message.stopReason === "stop" || message.stopReason === "length")
			)
				preview.lastAssistantMessage = item;
		} catch {
			/* Ignore foreign or incomplete append-only entries. */
		}
	}
	return preview;
}
