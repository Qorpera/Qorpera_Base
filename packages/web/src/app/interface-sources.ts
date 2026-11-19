import { companyStatePath } from "@qorpera/cloud-client/company-state-files";

/** An instant as a page's rows hold one, to the second: `2026-10-04T09:00:00Z`, which `since`, ordering and the
 * calendar read (the cloud client's `interfaceInstant`). Null for what isn't one. */
export function rowInstant(text: string | null | undefined): string | null {
	const at = text ? Date.parse(text) : Number.NaN;
	return Number.isFinite(at) ? new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/** A `file:` source's text: the file without its settings block (front matter), which is the file's settings, not its
 * text (§3.2). A rule's or an agent's file starts with one, and so may any other markdown. The vision and sections files
 * have none, so a leading `---` there is part of their text. */
export function fileSourceText(path: string, text: string): string {
	const kind = companyStatePath(path)?.kind;
	if (kind === "vision" || kind === "sections") return text;
	return text.replace(/^﻿?---[ \t]*\r?\n(?:[^\r\n]*\r?\n)*?---[ \t]*(?:\r?\n|$)/, "");
}
