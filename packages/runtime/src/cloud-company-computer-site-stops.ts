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

/** Frames the common CAPTCHA and bot-check services serve, by host (and path where the host serves more). */
const CHECK_FRAMES: ReadonlyArray<{ host: string; path?: string; reason: CompanyComputerSiteStopReason }> = [
	{ host: "challenges.cloudflare.com", reason: "human_check" },
	{ host: "www.google.com", path: "/recaptcha/", reason: "captcha" },
	{ host: "recaptcha.net", path: "/recaptcha/", reason: "captcha" },
	{ host: "www.recaptcha.net", path: "/recaptcha/", reason: "captcha" },
	{ host: "hcaptcha.com", reason: "captcha" },
	{ host: "arkoselabs.com", reason: "captcha" },
	{ host: "funcaptcha.com", reason: "captcha" },
	{ host: "captcha-delivery.com", reason: "captcha" },
	{ host: "perimeterx.net", reason: "human_check" },
	{ host: "px-cdn.net", reason: "human_check" },
	{ host: "awswaf.com", reason: "captcha" },
];

/** Words such a page shows, in its title or at the top of its text (lower case). The first that matches names it. */
const CHECK_WORDS: ReadonlyArray<{ words: RegExp; reason: CompanyComputerSiteStopReason }> = [
	{ words: /\bcaptcha\b|i'?m not a robot|i am not a robot/, reason: "captcha" },
	{
		words: /verify (that )?you are (a )?human|verifying you are human|confirm (that )?you(?:'re| are) (a )?human|are you a robot|checking (your|if the site connection is secure|the browser)|complete the security check|press (&|and) hold|human verification|just a moment\.\.\./,
		reason: "human_check",
	},
	{
		words: /unusual (activity|traffic)|suspicious activity|automated (queries|requests|traffic|access)|we('ve| have) detected (unusual|suspicious)/,
		reason: "unusual_activity",
	},
	{
		words: /you (have been|are) blocked|access (is )?denied|request (was )?blocked|attention required! \| cloudflare|pardon our interruption|403 forbidden/,
		reason: "blocked",
	},
];

/** How much of the page's text is read: such a page says so at its top. Its words count only on a short page (such
 * pages are short), so an ordinary page that mentions them is not taken for one; its title and frames always count. */
export const COMPANY_COMPUTER_SITE_SAMPLE = 4000;
const SHORT_PAGE = 3000;

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function hostOf(address: string): string | undefined {
	try {
		const url = new URL(address);
		return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

/** What a page's title, text and frames say, or undefined for an ordinary page. */
export function companyComputerSiteStop(page: {
	title: string;
	/** The top of the page's text, and the whole text's length. */
	text: string;
	length: number;
	frames: readonly string[];
}): CompanyComputerSiteStopReason | undefined {
	for (const frame of page.frames) {
		const host = hostOf(frame);
		if (!host) continue;
		const path = new URL(frame).pathname;
		const found = CHECK_FRAMES.find(
			(check) => under(host, check.host) && (!check.path || path.startsWith(check.path)),
		);
		if (found) return found.reason;
	}
	const title = page.title.toLowerCase();
	const text = page.length <= SHORT_PAGE ? page.text.slice(0, COMPANY_COMPUTER_SITE_SAMPLE).toLowerCase() : "";
	return CHECK_WORDS.find((check) => check.words.test(title) || check.words.test(text))?.reason;
}

/** Reads a tab for companyComputerSiteStop within 2 s; a page that does not answer counts as ordinary. */
export async function readCompanyComputerSiteStop(page: Page): Promise<CompanyComputerSiteStopReason | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const shown = await Promise.race([
			page.evaluate((sample) => {
				const global = globalThis as unknown as {
					document: { title: string; body: { innerText?: string } | null };
				};
				const text = global.document.body?.innerText ?? "";
				return { title: global.document.title, text: text.slice(0, sample), length: text.length };
			}, COMPANY_COMPUTER_SITE_SAMPLE),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), 2_000);
			}),
		]);
		if (!shown) return undefined;
		return companyComputerSiteStop({ ...shown, frames: page.frames().map((frame) => frame.url()) });
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The sites this computer stopped on, while its office service runs: every later page action on one (the site, a
 * name under it, or the site under a name it stopped on) is refused before it starts. A person continues there.
 */
export class CompanyComputerSiteStops {
	readonly #stopped = new Map<string, CompanyComputerSiteStopReason>();

	/** The site of an address: its host without a leading www. */
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
