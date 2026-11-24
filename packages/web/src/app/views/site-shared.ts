import { CloudRpcError } from "../../cloud/client.ts";
import type { CompanySite } from "../../cloud/sites.ts";
import { fmtTime, h } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { phrase, t } from "../../ui/preferences.ts";

const MANAGERS_ONLY = phrase("Only founders and admins can see passwords.");

export function hasPassword(site: CompanySite): boolean {
	return site.kind === "app";
}

/** A site's link as the page shows it: no https:// in front and no slash at the end. */
export function shownLink(url: string): string {
	return url.replace(/^https:\/\//, "").replace(/\/$/, "");
}

export function siteEmblem(): SVGSVGElement {
	const emblem = interfaceEmblem("globe", 28);
	emblem.classList.add("site-emblem");
	return emblem;
}

/** Why a change was refused, in the interface language. */
export function changeError(error: unknown, fallback: string): string {
	const code = error instanceof CloudRpcError ? error.code : undefined;
	if (code === "42501") return t(MANAGERS_ONLY);
	return t(fallback);
}

/** What to press to copy a text the page selected, when the browser would not let the page copy it. */
export function pressToCopy(): string {
	return /Mac|iPhone|iPad/.test(navigator.userAgent) ? t("Press ⌘C to copy.") : t("Press Ctrl+C to copy.");
}

/** Puts a text on the clipboard; false when the browser refuses. A text still being read is handed over as it is read,
 * where the browser takes that (a ClipboardItem of a promise), so the copy keeps the press it came from: Safari copies
 * only within the press. */
export async function toClipboard(text: string | Promise<string>): Promise<boolean> {
	const clipboard = navigator.clipboard as Clipboard | undefined;
	if (typeof text !== "string" && typeof ClipboardItem === "function" && typeof clipboard?.write === "function") {
		try {
			const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
			// A read that fails is told by the caller, which waits on the read itself.
			blob.catch(() => {});
			await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
			return true;
		} catch {
			// A browser that takes no promise there may still take the text itself.
		}
	}
	try {
		if (!clipboard) return false;
		await clipboard.writeText(await text);
		return true;
	} catch {
		return false;
	}
}

/** The site's state as a dot and a word; when and by whom it was published as its tip. A site Qorpera took down is that,
 * whatever the list says of it. */
export function stateOf(site: CompanySite, down: boolean): HTMLElement {
	const published = publishedTip(site);
	return h(
		"span",
		{ class: `site-state is-${down ? "down" : site.state}`, ...(published ? { title: published } : {}) },
		h("span", { class: "site-dot", "aria-hidden": "true" }),
		down ? t("Taken down") : site.state === "live" ? t("Live") : site.state === "off" ? t("Off") : t("Publishing…"),
	);
}

function publishedTip(site: CompanySite): string | undefined {
	if (!site.publishedAt) return undefined;
	return site.publishedBy
		? t("Published {time} by {agent}", { time: fmtTime(site.publishedAt), agent: site.publishedBy.name })
		: t("Published {time}", { time: fmtTime(site.publishedAt) });
}
