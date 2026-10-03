import {
	CompanyComputerSiteStops,
	companyComputerCheckFrame,
	companyComputerSiteStop,
} from "@qorpera/runtime/cloud-company-computer-site-stops";
import { describe, expect, it } from "vitest";

const page = (shown: { title?: string; text?: string; length?: number }) => ({
	title: shown.title ?? "Welcome",
	text: shown.text ?? "",
	length: shown.length ?? (shown.text ?? "").length,
});

describe("a page that asks for a person", () => {
	it("is found by a shown frame of a CAPTCHA or human check service inside it", () => {
		expect(companyComputerCheckFrame({ url: "https://www.google.com/recaptcha/api2/anchor?k=x&size=normal" })).toBe(
			"captcha",
		);
		expect(companyComputerCheckFrame({ url: "https://www.google.com/recaptcha/api2/bframe?k=x" })).toBe("captcha");
		expect(companyComputerCheckFrame({ url: "https://newassets.hcaptcha.com/captcha/v1/x" })).toBe("captcha");
		expect(companyComputerCheckFrame({ url: "https://challenges.cloudflare.com/cdn-cgi/x" })).toBe("human_check");
		expect(companyComputerCheckFrame({ url: "https://octocaptcha.com/?origin_page=github_signup" })).toBe("captcha");
		expect(companyComputerCheckFrame({ url: "https://geo.captcha-delivery.com/captcha/?x" })).toBe("captcha");
		// reCAPTCHA's invisible badge and a hidden frame ask no one anything.
		expect(
			companyComputerCheckFrame({ url: "https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible" }),
		).toBeUndefined();
		expect(
			companyComputerCheckFrame({ url: "https://www.google.com/recaptcha/api2/bframe?k=x", visible: false }),
		).toBeUndefined();
		// Google's other pages, a look-alike host and an address that is not http are ordinary.
		expect(companyComputerCheckFrame({ url: "https://www.google.com/maps/embed" })).toBeUndefined();
		expect(companyComputerCheckFrame({ url: "https://hcaptcha.com.example/" })).toBeUndefined();
		expect(companyComputerCheckFrame({ url: "about:blank" })).toBeUndefined();
	});

	it("is found by an interstitial's whole title on any page, and by its words only on a short page", () => {
		const long = 10_000;
		for (const title of [
			"Just a moment...",
			"Just a moment…",
			"Attention Required! | Cloudflare",
			"Robot Check",
			"Access to this page has been denied",
		])
			expect(companyComputerSiteStop(page({ title, length: long })), title).toBeDefined();
		// "Access Denied" counts on a short page; a long one is an application's own permission page.
		expect(companyComputerSiteStop(page({ title: "Access Denied", text: "Reference #18.2f" }))).toBe("blocked");
		expect(companyComputerSiteStop(page({ title: "Access Denied", length: long }))).toBeUndefined();
		expect(companyComputerSiteStop(page({ text: "Verify you are human by completing the action below." }))).toBe(
			"human_check",
		);
		expect(companyComputerSiteStop(page({ text: "I’m not a robot" }))).toBe("captcha");
		expect(companyComputerSiteStop(page({ text: "Please confirm you’re a human." }))).toBe("human_check");
		expect(
			companyComputerSiteStop(
				page({ text: "Sorry, we just need to make sure you're not a robot. Enter the characters you see below" }),
			),
		).toBe("captcha");
		expect(companyComputerSiteStop(page({ text: "We've detected unusual activity on your account." }))).toBe(
			"unusual_activity",
		);
		expect(companyComputerSiteStop(page({ text: "The request is blocked." }))).toBe("blocked");
		expect(companyComputerSiteStop(page({ text: "Sorry, you have been blocked." }))).toBe("blocked");
		expect(companyComputerSiteStop(page({ text: "Checking your browser before accessing the site." }))).toBe(
			"human_check",
		);
	});

	it("leaves ordinary pages that mention such words alone", () => {
		for (const shown of [
			{ title: "mysql - Access denied for user 'root'@'localhost' - Stack Overflow", length: 20_000 },
			{ title: "git push fails with 403 Forbidden · Issue #123 · org/repo · GitHub", length: 20_000 },
			{ title: "Troubleshoot access denied (403 Forbidden) errors in Amazon S3", length: 20_000 },
			{ title: "What is CAPTCHA? | Cloudflare", length: 20_000 },
			{ title: "Checking your application status | Help Center", text: "Thanks! We are checking your details." },
			{ text: "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>" },
			{ title: "Rate limits for automated requests - API docs", text: "Automated requests are limited." },
			{ text: `Our login page shows a captcha after unusual activity. ${"How our product works. ".repeat(200)}` },
			{ title: "Sign up", text: "Email Password Create account" },
		])
			expect(companyComputerSiteStop(page(shown)), JSON.stringify(shown).slice(0, 80)).toBeUndefined();
	});
});

describe("sites the computer stopped on", () => {
	it("refuse the site, its names and its parents, with or without www or a trailing dot, and nothing else", () => {
		const stops = new CompanyComputerSiteStops();
		stops.add("https://www.vercel.com/signup", "human_check");
		stops.add("https://accounts.example.com./login", "blocked");
		for (const address of [
			"https://vercel.com/",
			"https://www.vercel.com/x",
			"https://api.vercel.com/",
			"http://VERCEL.COM/",
			"https://vercel.com./signup",
			"https://example.com/",
			"https://accounts.example.com/",
		])
			expect(stops.stoppedAt(address), address).toBeDefined();
		for (const address of ["https://netlify.com/", "https://notvercel.com/", "about:blank", "not a url"])
			expect(stops.stoppedAt(address), address).toBeUndefined();
		expect(stops.stoppedAt("https://vercel.com/")).toBe("human_check");
	});
});
