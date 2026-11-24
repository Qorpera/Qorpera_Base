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

const MINIMAL_PDF = Buffer.from(
	"%PDF-1.4\n1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj\n4 0 obj<< /Length 44 >>stream\nBT /F1 18 Tf 20 50 Td (Hello PDF) Tj ET\nendstream\nendobj\n5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000241 00000 n \n0000000335 00000 n \ntrailer<< /Size 6 /Root 1 0 R >>\nstartxref\n405\n%%EOF\n",
	"latin1",
);
const HTML_DISGUISED = Buffer.from(
	'<!doctype html><html><body><script>window.top.postMessage("XSS_RAN","*");</script></body></html>',
	"utf8",
);

const previewHtml = await readFile(join(web, "public/pdf-preview/index.html"));
const previewJs = await readFile(join(web, "public/pdf-preview/preview.js"));
const appBundle = await build({
	stdin: {
		contents: `import { SurfacePdfViewer } from ${JSON.stringify(join(web, "src/app/views/surface-blocks/pdf.ts"))};
window.__xss = false;
window.addEventListener("message", (event) => {
	if (event.data === "XSS_RAN") window.__xss = true;
});
const kind = new URLSearchParams(location.search).get("kind") || "pdf";
const controller = new AbortController();
const viewer = new SurfacePdfViewer(async () => new Uint8Array(await (await fetch("/fixture/" + kind)).arrayBuffer()), controller.signal);
const card = viewer.renderCard({
	path: "reports/" + kind + ".pdf",
	title: "Sample",
	ref: { manifestSha256: "a".repeat(64), fileSha256: "b".repeat(64), bytes: 512, mediaType: "application/pdf" },
	changed: false,
});
document.body.append(card);`,
		resolveDir: repository,
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	plugins: [
		{
			name: "workspace-source",
			setup(pluginBuild) {
				pluginBuild.onResolve({ filter: /^@qorpera\/cloud-client\/(.+)$/ }, (args) => ({
					path: join(repository, "packages/cloud-client/src", `${args.path.slice("@qorpera/cloud-client/".length)}.ts`),
				}));
				pluginBuild.onResolve({ filter: /^@qorpera\/contracts$/ }, () => ({
					path: join(repository, "packages/contracts/src/index.ts"),
				}));
			},
		},
	],
	write: false,
	logLevel: "silent",
});

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/app.js") {
		res.writeHead(200, { ...headersFor("/app.js"), "content-type": "application/javascript" });
		res.end(appBundle.outputFiles[0].contents);
		return;
	}
	if (url.pathname === "/fixture/pdf") {
		res.writeHead(200, { "content-type": "application/octet-stream" });
		res.end(MINIMAL_PDF);
		return;
	}
	if (url.pathname === "/fixture/html") {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(HTML_DISGUISED);
		return;
	}
	if (url.pathname === "/pdf-preview/") {
		res.writeHead(200, { ...headersFor("/pdf-preview/"), "content-type": "text/html; charset=utf-8" });
		res.end(previewHtml);
		return;
	}
	if (url.pathname === "/pdf-preview/preview.js") {
		res.writeHead(200, { ...headersFor("/pdf-preview/preview.js"), "content-type": "application/javascript" });
		res.end(previewJs);
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
	const cspViolations = [];
	const consoleErrors = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text());
	});
	await page.addInitScript(() => {
		window.__csp = [];
		document.addEventListener("securitypolicyviolation", (event) => {
			window.__csp.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
		});
	});
	await page.goto(`${base}/?kind=pdf`);
	await page.waitForFunction(() => Boolean(document.querySelector("iframe.studio-pdf-frame")));
	await page.waitForTimeout(1000);
	const violations = await page.evaluate(() => window.__csp);
	const frameUrls = page.frames().map((frame) => frame.url());
	assert.deepEqual(violations, [], `unexpected CSP violations: ${JSON.stringify(violations)}`);
	assert.deepEqual(consoleErrors, [], `unexpected console errors: ${JSON.stringify(consoleErrors)}`);
	assert.ok(frameUrls.some((u) => u.endsWith("/pdf-preview/")), `missing door frame in ${JSON.stringify(frameUrls)}`);
	assert.ok(frameUrls.some((u) => u.startsWith("blob:")), `missing inner blob PDF frame in ${JSON.stringify(frameUrls)}`);
	assert.ok(
		frameUrls.some((u) => u.startsWith("chrome-extension://")),
		`missing Chromium PDF viewer frame in ${JSON.stringify(frameUrls)}`,
	);

	const popupPromise = context.waitForEvent("page");
	await page.click('a[target="_blank"]');
	const popup = await popupPromise;
	await popup.waitForTimeout(800);
	assert.ok(popup.url().startsWith("blob:"), `Open PDF did not navigate to blob URL: ${popup.url()}`);
	assert.ok(
		popup.frames().some((frame) => frame.url().startsWith("chrome-extension://")),
		"Open PDF tab did not load Chromium PDF viewer",
	);
	await popup.close();

	await page.goto(`${base}/?kind=html`);
	await page.waitForTimeout(800);
	assert.equal(await page.evaluate(() => window.__xss), false, "HTML disguised as PDF must never execute");

	await context.close();
	console.log("test-web-pdf-preview-browser: PASS");
} finally {
	await browser.close();
	server.close();
}
