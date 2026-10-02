import type { Page } from "playwright-core";

/**
 * A page that tells an automated browser to stop: a CAPTCHA or other human check, an "unusual activity" warning, or a
 * block. The Company Computer stops there and never tries again (Jonas, 2 October 2026: a person continues, in their
 * own browser where the site asks for one). It only recognises such a page; it never tries to pass one.
 */
export type CompanyComputerSiteStopReason = "captcha" | "human_check" | "unusual_activity" | "blocked";

export const COMPANY_COMPUTER_SITE_STOP_CODES: Readonly<Record<CompanyComputerSiteStopReason, string>> = {
	captcha: "SITE_STOP_CAPTCHA",
	human_check: "SITE_STOP_HUMAN_CHECK",
	unusual_activity: "SITE_STOP_UNUSUAL_ACTIVITY",
	blocked: "SITE_STOP_BLOCKED",
};

/** What the agent reads with a stop. */
export const COMPANY_COMPUTER_SITE_STOP_MESSAGE =
	"This website asks for a person (a CAPTCHA, a human check, an unusual activity warning or a block). Stop here and never retry: mark the account needs_person with company_account and tell a member what a person must do.";

/**
 * Frames the common CAPTCHA and human check services serve inside a page, by host (and path where the host serves
 * more). Only a frame inside the page counts (never the page itself, such as a service's own website), and only a
 * shown one: reCAPTCHA's invisible badge and a hidden challenge ask no one anything.
 */
const CHECK_FRAMES: ReadonlyArray<{ host: string; path?: string; reason: CompanyComputerSiteStopReason }> = [
	{ host: "challenges.cloudflare.com", reason: "human_check" },
	{ host: "www.google.com", path: "/recaptcha/", reason: "captcha" },
	{ host: "recaptcha.net", path: "/recaptcha/", reason: "captcha" },
	{ host: "www.recaptcha.net", path: "/recaptcha/", reason: "captcha" },
	{ host: "hcaptcha.com", reason: "captcha" },
	{ host: "arkoselabs.com", reason: "captcha" },
	{ host: "funcaptcha.com", reason: "captcha" },
	{ host: "octocaptcha.com", reason: "captcha" },
	{ host: "captcha-delivery.com", reason: "captcha" },
	{ host: "perimeterx.net", reason: "human_check" },
	{ host: "px-cdn.net", reason: "human_check" },
	{ host: "awswaf.com", reason: "captcha" },
];

/** Titles such a page has, whole (lower case, after normalising): they count on a page of any length. */
const CHECK_TITLES: ReadonlyMap<string, CompanyComputerSiteStopReason> = new Map([
	["just a moment...", "human_check"],
	["attention required! | cloudflare", "blocked"],
	["access denied", "blocked"],
	["pardon our interruption", "human_check"],
	["access to this page has been denied", "human_check"],
	["robot check", "captcha"],
]);

/** Words such a page shows in its title or at the top of its text (lower case). They count only on a short page: such
 * pages are short, so an ordinary page that mentions them (a question about "access denied" errors, an article about
 * CAPTCHAs) is not taken for one. The first that matches names it. */
const CHECK_WORDS: ReadonlyArray<{ words: RegExp; reason: CompanyComputerSiteStopReason }> = [
	{
		words: /\bcaptcha\b|not a robot|enter the characters you see below/,
		reason: "captcha",
	},
	{
		words: /verify (that )?you are (a )?human|verifying you are human|confirm (that )?you(?:'re| are) (a )?human|are you a robot|checking your browser|checking if the site connection is secure|complete the security check|press (&|and) hold|human verification/,
		reason: "human_check",
	},
	{
		words: /unusual (activity|traffic)|suspicious activity|automated (queries|traffic)|we('ve| have) detected (unusual|suspicious)/,
		reason: "unusual_activity",
	},
	{
		words: /you (have been|are) blocked|request (was |is )?blocked|pardon our interruption/,
		reason: "blocked",
	},
];

/** How much of the page's text is read, and how short a page must be for its words to count. */
export const COMPANY_COMPUTER_SITE_SAMPLE = 4000;
const SHORT_PAGE = 3000;

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Curly apostrophes and the ellipsis character as plain ones, in lower case. */
const plain = (text: string) => text.replace(/[‘’ʼ]/g, "'").replace(/…/g, "...").toLowerCase();

function hostOf(address: string): string | undefined {
	try {
		const url = new URL(address);
		// A trailing dot names the same host.
		return url.protocol === "http:" || url.protocol === "https:"
			? url.hostname.toLowerCase().replace(/\.+$/, "")
			: undefined;
	} catch {
		return undefined;
	}
}

/** Whether a frame inside the page is a CAPTCHA or human check service's, and which; `visible` false leaves it out. */
export function companyComputerCheckFrame(frame: {
	url: string;
	visible?: boolean;
}): CompanyComputerSiteStopReason | undefined {
	if (frame.visible === false) return undefined;
	const host = hostOf(frame.url);
	if (!host) return undefined;
	const url = new URL(frame.url);
	// reCAPTCHA's invisible badge (v3, invisible v2) is on many ordinary pages; its challenge is another frame.
	if (url.searchParams.get("size") === "invisible") return undefined;
	return CHECK_FRAMES.find((check) => under(host, check.host) && (!check.path || url.pathname.startsWith(check.path)))
		?.reason;
}

/** What a page's title and the top of its text say, or undefined for an ordinary page. */
export function companyComputerSiteStop(page: {
	title: string;
	/** The top of the page's text, and the whole text's length. */
	text: string;
	length: number;
}): CompanyComputerSiteStopReason | undefined {
	const title = plain(page.title).trim();
	const exact = CHECK_TITLES.get(title);
	if (exact) return exact;
	if (page.length > SHORT_PAGE) return undefined;
	const text = plain(page.text.slice(0, COMPANY_COMPUTER_SITE_SAMPLE));
	return CHECK_WORDS.find((check) => check.words.test(title) || check.words.test(text))?.reason;
}

/** Waits for `work` up to `ms`; undefined when it does not answer in time or fails. */
async function within<T>(work: () => Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work(),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Reads a tab: first the frames inside it (a list the browser keeps, so a page that does not answer still shows them;
 * a check frame whose visibility cannot be read within 1 s counts), then its title and text within 2 s (a page that
 * does not answer counts as ordinary there).
 */
export async function readCompanyComputerSiteStop(page: Page): Promise<CompanyComputerSiteStopReason | undefined> {
	let frames: ReturnType<Page["frames"]>;
	try {
		frames = page.frames().filter((frame) => frame.parentFrame() !== null);
	} catch {
		frames = [];
	}
	for (const frame of frames) {
		let url: string;
		try {
			url = frame.url();
		} catch {
			continue;
		}
		if (!companyComputerCheckFrame({ url })) continue;
		const visible = await within(async () => (await frame.frameElement()).isVisible(), 1_000);
		const reason = companyComputerCheckFrame({ url, ...(visible === undefined ? {} : { visible }) });
		if (reason) return reason;
	}
	const shown = await within(
		() =>
			page.evaluate((sample) => {
				const global = globalThis as unknown as {
					document: { title: string; body: { innerText?: string } | null };
				};
				const text = global.document.body?.innerText ?? "";
				return { title: global.document.title, text: text.slice(0, sample), length: text.length };
			}, COMPANY_COMPUTER_SITE_SAMPLE),
		2_000,
	);
	return shown && typeof shown.title === "string" && typeof shown.text === "string"
		? companyComputerSiteStop(shown)
		: undefined;
}

/**
 * The sites this computer stopped on, while its office service runs: every later page action on one (the site, a
 * name under it, or the site under a name it stopped on) is refused before it starts. A person continues there.
 */
export class CompanyComputerSiteStops {
	readonly #stopped = new Map<string, CompanyComputerSiteStopReason>();

	/** The site of an address: its host without a leading www. or a trailing dot. */
	static site(address: string): string | undefined {
		const host = hostOf(address);
		return host?.replace(/^www\./, "");
	}

	add(address: string, reason: CompanyComputerSiteStopReason): void {
		const site = CompanyComputerSiteStops.site(address);
		if (site) this.#stopped.set(site, reason);
	}

	/** Why the computer stopped on this address's site, or undefined. */
	stoppedAt(address: string): CompanyComputerSiteStopReason | undefined {
		const site = CompanyComputerSiteStops.site(address);
		if (!site) return undefined;
		for (const [stopped, reason] of this.#stopped) if (under(site, stopped) || under(stopped, site)) return reason;
		return undefined;
	}
}
