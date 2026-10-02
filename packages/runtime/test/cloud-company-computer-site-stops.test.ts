import { CompanyComputerSiteStops, companyComputerSiteStop } from "@qorpera/runtime/cloud-company-computer-site-stops";
import { describe, expect, it } from "vitest";

const page = (shown: { title?: string; text?: string; frames?: string[] }) => ({
	title: shown.title ?? "Welcome",
	text: shown.text ?? "",
	length: (shown.text ?? "").length,
	frames: shown.frames ?? ["https://vercel.com/signup"],
});

describe("a page that asks for a person", () => {
	it("is found by a CAPTCHA or human check service's frame", () => {
		expect(companyComputerSiteStop(page({ frames: ["https://www.google.com/recaptcha/api2/anchor"] }))).toBe(
			"captcha",
		);
		expect(companyComputerSiteStop(page({ frames: ["https://newassets.hcaptcha.com/captcha/v1/x"] }))).toBe(
			"captcha",
		);
		expect(companyComputerSiteStop(page({ frames: ["https://challenges.cloudflare.com/cdn-cgi/x"] }))).toBe(
			"human_check",
		);
		expect(companyComputerSiteStop(page({ frames: ["https://geo.captcha-delivery.com/captcha/?x"] }))).toBe(
			"captcha",
		);
		// Google's other pages, a look-alike host and an address that is not http are ordinary.
		expect(companyComputerSiteStop(page({ frames: ["https://www.google.com/maps/embed"] }))).toBeUndefined();
		expect(companyComputerSiteStop(page({ frames: ["https://hcaptcha.com.example/"] }))).toBeUndefined();
		expect(companyComputerSiteStop(page({ frames: ["about:blank", "data:text/html,captcha"] }))).toBeUndefined();
	});

	it("is found by its title, or the words at the top of a short page", () => {
		expect(companyComputerSiteStop(page({ title: "Just a moment..." }))).toBe("human_check");
		expect(companyComputerSiteStop(page({ title: "Attention Required! | Cloudflare" }))).toBe("blocked");
		expect(companyComputerSiteStop(page({ title: "Access Denied" }))).toBe("blocked");
		expect(companyComputerSiteStop(page({ text: "Verify you are human by completing the action below." }))).toBe(
			"human_check",
		);
		expect(
			companyComputerSiteStop(page({ text: "We've detected unusual activity on your account. Developer tools." })),
		).toBe("unusual_activity");
		expect(companyComputerSiteStop(page({ text: "Please complete the CAPTCHA to continue." }))).toBe("captcha");
		expect(companyComputerSiteStop(page({ text: "Sorry, you have been blocked." }))).toBe("blocked");
		// A long ordinary page that mentions such words is not one; nor is a sign-up form.
		const article = `Our login page shows a captcha after unusual activity. ${"How our product works. ".repeat(200)}`;
		expect(companyComputerSiteStop(page({ text: article }))).toBeUndefined();
		expect(
			companyComputerSiteStop(page({ title: "Sign up", text: "Email Password Create account" })),
		).toBeUndefined();
	});
});

describe("sites the computer stopped on", () => {
	it("refuse the site, its names and its parents, with or without www, and nothing else", () => {
		const stops = new CompanyComputerSiteStops();
		stops.add("https://www.vercel.com/signup", "human_check");
		stops.add("https://accounts.example.com/login", "blocked");
		for (const address of [
			"https://vercel.com/",
			"https://www.vercel.com/x",
			"https://api.vercel.com/",
			"http://VERCEL.COM/",
			"https://example.com/",
			"https://accounts.example.com/",
		])
			expect(stops.stoppedAt(address), address).toBeDefined();
		for (const address of ["https://netlify.com/", "https://notvercel.com/", "about:blank", "not a url"])
			expect(stops.stoppedAt(address), address).toBeUndefined();
		expect(stops.stoppedAt("https://vercel.com/")).toBe("human_check");
	});
});
