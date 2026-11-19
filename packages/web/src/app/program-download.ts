import { type ProgramKeptForm, type ProgramKind, programFormsInOrder } from "@qorpera/cloud-client/app-program";

export const PROGRAM_KIND_NAMES: Readonly<Record<ProgramKind, string>> = Object.freeze({
	android: "Android",
	linux: "Linux",
	windows: "Windows",
	mac: "Mac",
	iphone: "iPhone",
});

export interface BrowserSystem {
	readonly userAgent: string;
	readonly platform?: string;
	readonly maxTouchPoints?: number;
}

export function memberSystem(browser: BrowserSystem): ProgramKind | null {
	const agent = browser.userAgent;
	if (/Android/i.test(agent)) return "android";
	if (/iPhone|iPad|iPod/i.test(agent)) return "iphone";
	if (/Macintosh|Mac OS X/i.test(agent)) return (browser.maxTouchPoints ?? 0) > 1 ? "iphone" : "mac";
	if (/Windows/i.test(agent)) return "windows";
	if (/CrOS/i.test(agent)) return null;
	if (/Linux|X11/i.test(agent)) return "linux";
	return null;
}

export const isPhoneSystem = (kind: ProgramKind | null): boolean => kind === "android" || kind === "iphone";

export interface DownloadOffer {
	readonly form: ProgramKeptForm;
	readonly own: boolean;
	readonly install: boolean;
}

export function downloadOffer(forms: readonly ProgramKeptForm[], system: ProgramKind | null): DownloadOffer | null {
	const ordered = programFormsInOrder(forms);
	const own = ordered.find((form) => form.for === system);
	if (own) return { form: own, own: true, install: own.for === "android" };
	const first = ordered[0];
	return first ? { form: first, own: false, install: false } : null;
}
