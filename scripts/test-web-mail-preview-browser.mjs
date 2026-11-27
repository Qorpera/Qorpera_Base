import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const executablePath = process.env.QORPERA_WEB_TEST_BROWSER;
if (!executablePath) throw new Error("Set QORPERA_WEB_TEST_BROWSER to an existing Chromium executable");
const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const web = join(repository, "packages/web");

const rules = [];
for (const line of (await readFile(join(web, "public/_headers"), "utf8")).split("\n").map((text) => text.trim())) {
	if (!line || line.startsWith("#")) continue;
	if (line.startsWith("/")) rules.push({ pattern: line, unset: [], set: [] });
	else if (line.startsWith("!")) rules.at(-1).unset.push(line.slice(1).trim().toLowerCase());
	else
		rules
			.at(-1)
			.set.push([line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]);
}
function headersFor(path) {
	const headers = new Map();
	for (const rule of rules) {
		if (!new RegExp(`^${rule.pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path)) continue;
		for (const name of rule.unset) headers.delete(name);
		for (const [name, value] of rule.set) headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
	}
	const policy = headers.get("content-security-policy");
	if (policy) {
		headers.set(
			"content-security-policy",
			policy.replace(" __QORPERA_WEB_CONNECT_SRC__", "").replace("; upgrade-insecure-requests", ""),
		);
	}
	headers.delete("strict-transport-security");
	return Object.fromEntries(headers);
}

const RAW_MAIL_HTML = [
	"<!doctype html><html><head><style>.card { padding: 24px; border: 1px solid #d0d7de; border-radius: 8px; font-family: sans-serif; } .cta { display: inline-block; padding: 10px 16px; background: #1a56db; color: #fff; text-decoration: none; }</style></head>",
	'<body style="margin: 0; padding: 12px"><div class="card"><h1>Generic High Entropy Secret exposed</h1>',
	"<p>GitGuardian detected a secret in Qorpera/Qorpera_Base.</p>",
	'<p style="margin-top: 24px"><a class="cta" href="https://dashboard.gitguardian.example/incidents/42">Inspect incident</a></p>',
	'<img id="hero" src="https://127.0.0.1.invalid/hero.png" alt="Hero banner" width="240" height="80">',
	'<img id="pixel" src="https://127.0.0.1.invalid/tracker.gif" width="1" height="1">',
	`<div style="width:10px;height:10px;background-image:url('https://127.0.0.1.invalid/unclosed.gif?id=42'"></div>`,
	`<div style='width:10px;height:10px;background-image:url("https://127.0.0.1.invalid/escaped\\"")'></div>`,
	'<script>window.parent.postMessage("XSS_RAN", "*");</script>',
	"</div></body></html>",
].join("");

const previewHtml = await readFile(join(web, "public/mail-preview/index.html"));
const appBundle = await build({
	stdin: {
		contents: `import { MailFrame, sanitizeMailHtml } from ${JSON.stringify(join(web, "src/ui/mail-frame.ts"))};
window.__opened = [];
window.__xss = false;
window.addEventListener("message", (event) => {
	if (event.data === "XSS_RAN") window.__xss = true;
});
const raw = ${JSON.stringify(RAW_MAIL_HTML)};
const first = sanitizeMailHtml(raw, { allowRemoteImages: false });
window.__remoteCount = first.remoteImageCount;
const mailFrame = new MailFrame(first, "From outside the company", {
	onOpen: (href) => window.__opened.push(href),
});
mailFrame.frame.style.width = "640px";
mailFrame.frame.style.border = "0";
document.body.append(mailFrame.frame);
window.__showImages = () => {
	mailFrame.update(sanitizeMailHtml(raw, { allowRemoteImages: true }));
};
window.__injectRawXss = () => {
	mailFrame.update({
		styles: [],
		bodyHtml: '<img src=x onerror="window.parent.postMessage(\\'XSS_RAN\\',\\'*\\')"><script>window.parent.postMessage("XSS_RAN","*");</script><p id="after">Safe</p>',
		bodyStyle: "",
		bodyBg: "",
		bodyDir: "",
	});
};`,
		resolveDir: repository,
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	write: false,
	logLevel: "silent",
});

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/app.js") {
		res.writeHead(200, { ...headersFor("/app.js"), "content-type": "application/javascript" });
		res.end(appBundle.outputFiles[0].contents);
		return;
	}
	if (url.pathname === "/mail-preview/") {
		res.writeHead(200, { ...headersFor("/mail-preview/"), "content-type": "text/html; charset=utf-8" });
		res.end(previewHtml);
		return;
	}
	res.writeHead(200, { ...headersFor("/"), "content-type": "text/html; charset=utf-8" });
	res.end('<!doctype html><html><head><script type="module" src="/app.js"></script></head><body></body></html>');
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath, headless: true });

try {
	const context = await browser.newContext();
	const page = await context.newPage();
	const consoleErrors = [];
	const remoteRequests = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	await context.route("https://127.0.0.1.invalid/**", async (route) => {
		remoteRequests.push(route.request().url());
		await route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 });
	});
	await page.addInitScript(() => {
		window.__csp = [];
		document.addEventListener("securitypolicyviolation", (event) => {
			window.__csp.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
		});
	});

	await page.goto(`${base}/`);
	await page.waitForFunction(() => Boolean(document.querySelector("iframe.mailbox-html-frame")));
	const frame = page.frameLocator("iframe.mailbox-html-frame");
	await frame.locator("h1").waitFor({ state: "visible" });
	assert.equal(await frame.locator("h1").textContent(), "Generic High Entropy Secret exposed");
	assert.equal(await page.evaluate(() => window.__remoteCount), 3);

	await page.waitForFunction(() => {
		const el = document.querySelector("iframe.mailbox-html-frame");
		return el && el.getBoundingClientRect().height > 140;
	});
	assert.deepEqual(remoteRequests, [], `remote images must not load before Show images: ${JSON.stringify(remoteRequests)}`);
	assert.deepEqual(await page.evaluate(() => window.__csp), []);
	assert.deepEqual(consoleErrors, []);

	await frame.locator("a.cta").click();
	await page.waitForFunction(() => window.__opened.length === 1);
	assert.deepEqual(await page.evaluate(() => window.__opened), ["https://dashboard.gitguardian.example/incidents/42"]);

	await page.evaluate(() => window.__showImages());
	await frame.locator('#hero[src="https://127.0.0.1.invalid/hero.png"]').waitFor({ state: "visible" });
	await page.waitForFunction(
		() => {
			const el = document.querySelector("iframe.mailbox-html-frame");
			return el && el.getBoundingClientRect().height > 180;
		},
	);
	await frame.locator("#hero").evaluate(
		(img) =>
			img.complete && img.naturalWidth > 0
				? true
				: new Promise((resolve, reject) => {
						img.addEventListener("load", () => resolve(true), { once: true });
						img.addEventListener("error", () => reject(new Error("hero image failed to load")), { once: true });
					}),
	);
	assert.ok(
		remoteRequests.includes("https://127.0.0.1.invalid/hero.png"),
		`expected hero.png request after Show images, got ${JSON.stringify(remoteRequests)}`,
	);
	assert.ok(
		!remoteRequests.some((url) => url.includes("tracker.gif")),
		`tracking pixel must stay blocked even after Show images: ${JSON.stringify(remoteRequests)}`,
	);

	await page.evaluate(() => window.__injectRawXss());
	await frame.locator("#after").waitFor({ state: "visible" });
	await page.waitForTimeout(300);
	assert.equal(await page.evaluate(() => window.__xss), false, "injected scripts must never execute inside mail-preview");

	await context.close();
	console.log("test-web-mail-preview-browser: PASS");
} finally {
	await browser.close();
	server.close();
}
