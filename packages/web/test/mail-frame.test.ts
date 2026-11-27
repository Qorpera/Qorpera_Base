// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAIL_ESCAPE,
	MAIL_FRAME_URL,
	MAIL_HEIGHT,
	MAIL_INIT,
	MAIL_OPEN,
	MAIL_READY,
	MAIL_RENDER,
	MailFrame,
	mailHtmlToText,
	safeMailHref,
	sanitizeMailHtml,
} from "../src/ui/mail-frame.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const headers = readFileSync(resolve(root, "public/_headers"), "utf8");
const previewHtml = readFileSync(resolve(root, "public/mail-preview/index.html"), "utf8");

function rule(path: string): string[] {
	const lines = headers.split(/\r?\n/);
	const start = lines.indexOf(path);
	const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && !line.startsWith("#"));
	return lines
		.slice(start + 1, end < 0 ? undefined : end)
		.filter((line) => line.trim() && !line.trim().startsWith("#"))
		.map((line) => line.trim());
}

function readyFrom(source: Window | null, data: unknown = { type: MAIL_READY }): void {
	const event = new MessageEvent("message", { data });
	Object.defineProperty(event, "source", { value: source });
	window.dispatchEvent(event);
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("mail preview CSP and headers", () => {
	it("locks /mail-preview/* to the exact inline bootstrap hash while keeping /* strict", () => {
		const scripts = [...previewHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
		expect(scripts).toHaveLength(1);
		expect(scripts[0]![0]).toMatch(/^<script>/);
		const expectedHash = `sha256-${createHash("sha256").update(scripts[0]![1]!, "utf8").digest("base64")}`;

		const mailRule = rule("/mail-preview/*");
		expect(mailRule.slice(0, 3)).toEqual(["! Content-Security-Policy", "! X-Frame-Options", "! Permissions-Policy"]);
		expect(mailRule).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()");
		expect(mailRule).toContain("X-Frame-Options: SAMEORIGIN");

		const policy = mailRule.find((line) => line.startsWith("Content-Security-Policy:"))!;
		const directives = policy
			.slice("Content-Security-Policy:".length)
			.split(";")
			.map((part) => part.trim());
		expect(directives).toEqual([
			"sandbox allow-scripts",
			"default-src 'none'",
			`script-src '${expectedHash}'`,
			"style-src 'unsafe-inline'",
			"img-src data: https:",
			"font-src data:",
			"connect-src 'none'",
			"media-src 'none'",
			"object-src 'none'",
			"frame-src 'none'",
			"worker-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'self'",
		]);

		const metaMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(previewHtml);
		expect(metaMatch).not.toBeNull();
		expect(metaMatch![1]).toBe(
			directives.filter((d) => !d.startsWith("sandbox ") && !d.startsWith("frame-ancestors ")).join("; "),
		);

		const appPolicy = rule("/*").find((line) => line.startsWith("Content-Security-Policy:"))!;
		expect(appPolicy).toContain("default-src 'self';");
		expect(appPolicy).toContain("frame-ancestors 'none';");
		expect(appPolicy).not.toMatch(/frame-src|child-src/);
	});
});

describe("sanitizeMailHtml", () => {
	it("preserves transactional HTML layout, styles, and body attributes", () => {
		const raw = [
			"<!doctype html>",
			'<html dir="rtl">',
			"<head><title>Secret alert</title><style>.card { color: #111; border: 1px solid #ddd; }</style></head>",
			'<body bgcolor="#f6f8fa" style="padding: 16px">',
			'<table class="card"><tr><td><h1>Secret exposed</h1><p>Repository: <strong>Qorpera/Qorpera_Base</strong></p>',
			'<a href="https://dashboard.gitguardian.com/incidents/42">Inspect incident</a></td></tr></table>',
			"</body></html>",
		].join("");

		const out = sanitizeMailHtml(raw);
		expect(out.hasContent).toBe(true);
		expect(out.remoteImageCount).toBe(0);
		expect(out.bodyBg).toBe("#f6f8fa");
		expect(out.bodyStyle).toBe("padding: 16px");
		expect(out.bodyDir).toBe("rtl");
		expect(out.styles).toEqual([".card { color: #111; border: 1px solid #ddd; }"]);
		expect(out.bodyHtml).toContain("<h1>Secret exposed</h1>");
		expect(out.bodyHtml).toContain('href="https://dashboard.gitguardian.com/incidents/42"');
		expect(out.bodyHtml).toContain('rel="noopener noreferrer"');
		expect(out.bodyHtml).toContain('target="_blank"');
	});

	it("strips dangerous elements, handlers, attributes, and unsafe URLs", () => {
		const raw = [
			'<div onclick="alert(1)" data-qorpera-hidden-img="alt">',
			"<script>alert(2)</script>",
			'<noscript><style>.evil { background: url("https://evil.example/x.png"); }</style><img src="https://evil.example/ns.png"></noscript>',
			'<iframe src="https://evil.example"></iframe>',
			'<object data="https://evil.example/a.swf"></object>',
			'<form action="https://evil.example/phish" method="post"><input name="pw"><button formaction="https://evil.example/p">Go</button></form>',
			'<a href="javascript:alert(3)" ping="https://evil.example/p">Bad link</a>',
			'<a href="data:text/html,<script>1</script>">Data link</a>',
			'<a href="mailto:hello@acme.example">Email</a>',
			'<a href="#section-1">Jump</a>',
			'<svg><image href="https://evil.example/svg.png" /><feImage href="https://evil.example/fe.png" /><use href="#icon-1" /><use href="https://evil.example/sprite.svg#a" /></svg>',
			"</div>",
		].join("");

		const out = sanitizeMailHtml(raw);
		expect(out.styles).toEqual([]);
		expect(out.remoteImageCount).toBe(0);
		expect(out.bodyHtml).not.toMatch(/onclick|alert|script|iframe|object|formaction|action=|ping=|input|feimage/i);
		expect(out.bodyHtml).not.toContain("data-qorpera-hidden-img");
		expect(out.bodyHtml).not.toContain("javascript:");
		expect(out.bodyHtml).not.toContain("data:text/html");
		expect(out.bodyHtml).not.toContain("https://evil.example");
		expect(out.bodyHtml).toContain('type="button"');
		expect(out.bodyHtml).toContain('href="mailto:hello@acme.example"');
		expect(out.bodyHtml).toContain('href="#section-1"');
		expect(out.bodyHtml).toContain('href="#icon-1"');
	});

	it("sanitizes CSS imports, escapes, image-set, fixed positioning, and remote fonts", () => {
		const raw = [
			"<style>",
			'@import url("https://evil.example/a.css");',
			'@im\\port "https://evil.example/b.css";',
			'@font-face { font-family: Brand; src: url("https://fonts.example/brand.woff2"); }',
			".hero { background-image: \\75\\72\\6c('https://cdn.example/hero.png'); position: fixed; }",
			".obf { background: u\\rl(https://cdn.example/obf.png); -moz-binding: url(x); behavior: url(y); }",
			".set { background-image: image-set(url('https://cdn.example/s.png') 1x); width: expression(alert(1)); }",
			"</style>",
			'<p style="background: /*c*/ url(https://cdn.example/inline.png); color: #222">Hello</p>',
		].join("");

		const blocked = sanitizeMailHtml(raw, { allowRemoteImages: false });
		expect(blocked.remoteImageCount).toBe(3);
		const joinedBlocked = `${blocked.styles.join("\n")}\n${blocked.bodyHtml}`;
		expect(joinedBlocked).not.toContain("https://");
		expect(joinedBlocked).not.toMatch(/@import|image-set|expression|-moz-binding|behavior|position:\s*fixed/i);
		expect(joinedBlocked).toContain("position: static");

		const allowed = sanitizeMailHtml(raw, { allowRemoteImages: true });
		expect(allowed.remoteImageCount).toBe(3);
		expect(allowed.styles.join("\n")).toContain('url("https://cdn.example/hero.png")');
		expect(allowed.styles.join("\n")).toContain('url("https://cdn.example/obf.png")');
		expect(allowed.styles.join("\n")).not.toContain("fonts.example");
		expect(allowed.bodyHtml).toContain("https://cdn.example/inline.png");
	});

	it("blocks unclosed url() at EOF, escaped quotes inside url(), and unclosed @font-face", () => {
		const unclosedQuoted = `<div style="background-image:url('https://tracker.example/o.gif?id=42'">A</div>`;
		const unclosedBare = `<div style="background-image:url(https://tracker.example/bare.gif">B</div>`;
		const escapedQuote = `<div style='background-image:url("https://tracker.example/p\\"")'>C</div>`;
		const hexEscapedQuote = `<div style='background-image:url("https://tracker.example/p\\22 ")'>D</div>`;
		const unclosedFontFace = `<style>@font-face { font-family: X; src: url("https://fonts.example/a.woff2")</style><p>E</p>`;

		for (const sample of [unclosedQuoted, unclosedBare, escapedQuote, hexEscapedQuote]) {
			const blocked = sanitizeMailHtml(sample, { allowRemoteImages: false });
			expect(blocked.remoteImageCount).toBe(1);
			expect(blocked.bodyHtml).not.toContain("https://tracker.example");
			expect(blocked.bodyHtml).not.toMatch(/url\s*\(/i);

			const allowed = sanitizeMailHtml(sample, { allowRemoteImages: true });
			expect(allowed.remoteImageCount).toBe(1);
			expect(allowed.bodyHtml).toContain("https://tracker.example/");
		}

		const fontBlocked = sanitizeMailHtml(unclosedFontFace, { allowRemoteImages: true });
		expect(fontBlocked.remoteImageCount).toBe(0);
		expect(fontBlocked.styles.join("\n")).not.toContain("fonts.example");
	});

	it("blocks remote images by default, allows raster data URIs, deduplicates src+srcset, and drops tracking pixels", () => {
		const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
		const svg = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
		const raw = [
			`<img src="${png}" alt="Inline">`,
			`<img src="${svg}" alt="SvgData">`,
			'<img src="https://cdn.example/logo.png" srcset="https://cdn.example/logo@2x.png 2x" alt="GitGuardian">',
			'<img src="http://insecure.example/a.png" alt="Http">',
			'<img src="cid:logo@mail" alt="CidLogo">',
			'<img src="https://track.example/open.gif" width="1" height="1" alt="Tracker">',
			'<img src="https://track.example/hidden.gif" style="display: none">',
			'<img src="https://track.example/zero.gif" style="width: 0px; height: 20px">',
		].join("");

		const blocked = sanitizeMailHtml(raw, { allowRemoteImages: false });
		expect(blocked.remoteImageCount).toBe(1);
		expect(blocked.bodyHtml).toContain(`src="${png}"`);
		expect(blocked.bodyHtml).not.toContain(svg);
		expect(blocked.bodyHtml).not.toContain("https://cdn.example");
		expect(blocked.bodyHtml).not.toContain("https://track.example");
		expect(blocked.bodyHtml).not.toContain("http://insecure.example");
		expect(blocked.bodyHtml).toContain('data-qorpera-hidden-img="alt"');
		expect(blocked.bodyHtml).toContain('data-qorpera-hidden-img="empty"');

		const allowed = sanitizeMailHtml(raw, { allowRemoteImages: true });
		expect(allowed.remoteImageCount).toBe(1);
		expect(allowed.bodyHtml).toContain('src="https://cdn.example/logo.png"');
		expect(allowed.bodyHtml).toContain('srcset="https://cdn.example/logo@2x.png 2x"');
		expect(allowed.bodyHtml).toContain('referrerpolicy="no-referrer"');
		expect(allowed.bodyHtml).not.toContain("https://track.example");
		expect(allowed.bodyHtml).not.toContain("http://insecure.example");
	});

	it("reports hasContent accurately for empty vs image-only HTML", () => {
		expect(sanitizeMailHtml("<style>p{color:red}</style><script>1</script>   ").hasContent).toBe(false);
		expect(sanitizeMailHtml('<img src="https://track.example/p.gif" width="1" height="1">').hasContent).toBe(false);
		expect(sanitizeMailHtml('<img src="https://cdn.example/poster.png" width="600" height="400">').hasContent).toBe(
			true,
		);
	});
});

describe("mailHtmlToText and safeMailHref", () => {
	it("extracts readable text without head, styles, scripts, or invisible preheader padding", () => {
		const html = [
			"<html><head><title>Ignored</title><style>.x{display:none}</style></head>",
			"<body><script>bad()</script><div>&#847;&zwnj;&nbsp;Secret found</div>",
			"<p>Line 1<br>Line 2</p><table><tr><td>Repo</td><td>Qorpera</td></tr></table></body></html>",
		].join("");
		expect(mailHtmlToText(html)).toBe("Secret found\n\nLine 1\nLine 2\n\nRepo Qorpera");
	});

	it("validates link href schemes", () => {
		expect(safeMailHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
		expect(safeMailHref("http://example.com")).toBe("http://example.com/");
		expect(safeMailHref("mailto:team@acme.example")).toBe("mailto:team@acme.example");
		expect(safeMailHref("#top")).toBe("#top");
		expect(safeMailHref("javascript:alert(1)")).toBeNull();
		expect(safeMailHref("data:text/html,hi")).toBeNull();
		expect(safeMailHref("file:///etc/passwd")).toBeNull();
		expect(safeMailHref(`https://example.com/${"a".repeat(5000)}`)).toBeNull();
	});
});

describe("MailFrame", () => {
	it("handshakes over MessageChannel, updates in place, handles reloads, resizes, and disposes", async () => {
		const opened: string[] = [];
		let escaped = 0;
		const payload1 = sanitizeMailHtml("<p>First</p>");
		const payload2 = sanitizeMailHtml('<p>Second <img src="https://cdn.example/a.png"></p>', {
			allowRemoteImages: true,
		});
		const mf = new MailFrame(payload1, "From outside the company", {
			onOpen: (href) => opened.push(href),
			onEscape: () => {
				escaped += 1;
			},
		});
		expect(mf.frame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(mf.frame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(mf.frame.getAttribute("src")).toBe(MAIL_FRAME_URL);
		expect(mf.frame.title).toBe("From outside the company");

		const stranger = document.createElement("iframe");
		document.body.append(mf.frame, stranger);
		const post = vi.spyOn(mf.frame.contentWindow!, "postMessage");

		readyFrom(null);
		readyFrom(stranger.contentWindow);
		readyFrom(mf.frame.contentWindow, { type: "other" });
		expect(post).not.toHaveBeenCalled();

		readyFrom(mf.frame.contentWindow);
		expect(post).toHaveBeenCalledTimes(1);
		const [initMsg, initOrigin, initTransfer] = (post.mock.calls as unknown[][])[0]!;
		expect(initMsg).toMatchObject({ type: MAIL_INIT, bodyHtml: payload1.bodyHtml });
		expect(initOrigin).toBe("*");
		const port = (initTransfer as MessagePort[])[0]!;
		expect(port).toBeInstanceOf(MessagePort);

		const receivedByFrame: unknown[] = [];
		port.addEventListener("message", (event) => receivedByFrame.push(event.data));
		port.start();

		mf.update(payload2);
		await vi.waitFor(() => expect(receivedByFrame).toHaveLength(1));
		expect(receivedByFrame[0]).toMatchObject({ type: MAIL_RENDER, bodyHtml: payload2.bodyHtml });

		port.postMessage({ type: MAIL_HEIGHT, height: 420.2 });
		await vi.waitFor(() => expect(mf.frame.style.height).toBe("421px"));
		port.postMessage({ type: MAIL_HEIGHT, height: 999_999 });
		await vi.waitFor(() => expect(mf.frame.style.height).toBe("50000px"));
		port.postMessage({ type: MAIL_HEIGHT, height: -5 });
		port.postMessage({ type: MAIL_HEIGHT, height: Number.NaN });

		port.postMessage({ type: MAIL_OPEN, href: "https://dashboard.gitguardian.com/incidents/1" });
		port.postMessage({ type: MAIL_OPEN, href: "javascript:alert(1)" });
		port.postMessage({ type: MAIL_OPEN, href: "#local" });
		port.postMessage({ type: MAIL_ESCAPE });
		await vi.waitFor(() => expect(opened).toEqual(["https://dashboard.gitguardian.com/incidents/1"]));
		expect(escaped).toBe(1);

		readyFrom(mf.frame.contentWindow);
		expect(post).toHaveBeenCalledTimes(2);
		expect(post.mock.calls[1]![0]).toMatchObject({ type: MAIL_INIT, bodyHtml: payload2.bodyHtml });

		mf.dispose();
		readyFrom(mf.frame.contentWindow);
		expect(post).toHaveBeenCalledTimes(2);
	});
});
