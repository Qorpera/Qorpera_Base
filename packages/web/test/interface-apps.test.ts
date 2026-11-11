// @vitest-environment jsdom
import { createHash } from "node:crypto";
import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AppBridge,
	type AppLink,
	appLink,
	appReadablePath,
	assembleApp,
	type CompanyApp,
	CompanyApps,
	companyConcepts,
	readApps,
	resolveAppPath,
	sharedFolderHints,
	warmApps,
} from "../src/app/interface-apps.ts";
import { markdown } from "../src/ui/markdown.ts";

/** A member's folder over fixed files: read, list and readFile as the cloud client answers them. */
function fakeFolder(files: Record<string, string | Uint8Array>) {
	const bytes = new Map(
		Object.entries(files).map(([path, value]) => [
			path,
			typeof value === "string" ? new TextEncoder().encode(value) : value,
		]),
	);
	const folders = new Set<string>();
	for (const path of bytes.keys()) {
		const parts = path.split("/");
		for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
	}
	const reads: string[] = [];
	const entry = (path: string): CloudMemberFolderEntry | null => {
		const data = bytes.get(path);
		if (data)
			return {
				path,
				kind: "file",
				version: "00000000-0000-4000-8000-000000000001",
				seq: 1,
				updatedAt: "2026-11-05T00:00:00Z",
				file: {
					manifestSha256: createHash("sha256").update(path).digest("hex"),
					fileSha256: createHash("sha256").update(data).digest("hex"),
					bytes: data.byteLength,
					mediaType: "application/octet-stream",
					executable: false,
				},
				target: null,
			};
		if (folders.has(path))
			return {
				path,
				kind: "folder",
				version: "00000000-0000-4000-8000-000000000002",
				seq: 1,
				updatedAt: "2026-11-05T00:00:00Z",
				file: null,
				target: null,
			};
		return null;
	};
	const byHash = new Map(
		[...bytes].map(([path, data]) => [createHash("sha256").update(data).digest("hex"), { path, data }]),
	);
	return {
		reads,
		read: async (path: string) => {
			reads.push(path);
			return { asOfSeq: 1, entry: entry(path) };
		},
		list: async (parent: string | null) => {
			const prefix = parent ? `${parent}/` : "";
			const names = [...new Set([...bytes.keys(), ...folders])]
				.filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
				.sort();
			return { asOfSeq: 1, entries: names.map((path) => entry(path)!), next: null };
		},
		readFile: async (file: { fileSha256: string }) => byHash.get(file.fileSha256)!.data,
	} as never as Parameters<typeof assembleApp>[0] & { reads: string[] };
}

describe("an app's paths", () => {
	it("resolves a page's references inside the app's folder only", () => {
		expect(resolveAppPath("", "style.css")).toBe("style.css");
		expect(resolveAppPath("pages", "../img/a.png?x=1#y")).toBe("img/a.png");
		expect(resolveAppPath("pages", "./b%20c.js")).toBe("pages/b c.js");
		for (const bad of [
			"../x.css",
			"/abs.css",
			"https://x.test/a.js",
			"data:text/css,a",
			"a%2f..%2fb",
			"a\\b",
			"javascript:alert(1)",
		])
			expect(resolveAppPath("", bad)).toBeNull();
	});

	it("reads only the company's own work, never the platform's folders", () => {
		expect(appReadablePath("sales/report.md")).toBe("sales/report.md");
		expect(appReadablePath("")).toBe("");
		for (const bad of [
			"QorperaOS/vision/vision.md",
			"qorperaos/agents",
			"hooks/mail/a.eml",
			"bank/x",
			"digital-post/x",
			"members/x",
			"code/repo/a.ts",
			"../x",
			"a/../b",
			5,
			"a%2fb",
		])
			expect(appReadablePath(bad)).toBeNull();
	});
});

describe("a link in an app's page", () => {
	it("leads to an app, a file of the company's own work or a web page", () => {
		expect(appLink("app:sales-board")).toEqual({ kind: "app", name: "sales-board" });
		expect(appLink(" folder:reports/Q1%20plan.md ")).toEqual({ kind: "file", path: "reports/Q1 plan.md" });
		expect(appLink("folder:apps/sales")).toEqual({ kind: "file", path: "apps/sales" });
		expect(appLink("https://example.com/a?b=1#c")).toEqual({ kind: "web", href: "https://example.com/a?b=1#c" });
		// As the browser reads the address, which is what opens.
		expect(appLink("HTTP://Example.com")).toEqual({ kind: "web", href: "http://example.com/" });
	});

	it("leads nowhere else, whatever a page writes", () => {
		for (const bad of [
			// Not an app's name.
			"app:",
			"app:Bad",
			"app:sales/../x",
			"APP:sales",
			// Not a path of the company's own work: the platform's folders, and no way around the path rules.
			"folder:",
			"folder:/abs",
			"folder:QorperaOS/vision/vision.md",
			"folder:qorperaos/agents",
			"folder:hooks/mail/a.eml",
			"folder:bank/x",
			"folder:digital-post/x",
			"folder:members/x",
			"folder:code/repo/a.ts",
			"folder:../x",
			"folder:a/%2e%2e/b",
			"folder:a%252fb",
			"folder:a%5cb",
			"folder:a?x=1",
			// Not a web page a link in a message would open.
			"other.html",
			"/c/x",
			"//example.com/x",
			"#top",
			"",
			"javascript:alert(1)",
			"data:text/html,<p>x",
			"blob:https://example.com/1",
			"file:///etc/passwd",
			"ftp://example.com/x",
			"mailto:someone@example.com",
			"https://user:secret@example.com/",
			"https://",
			`https://example.com/${"a".repeat(2048)}`,
			5,
			null,
			{ href: "app:sales" },
		])
			expect(appLink(bad), String(bad)).toBeNull();
	});
});

describe("putting an app's page together", () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const folder = () =>
		fakeFolder({
			"apps/sales/index.html":
				'<!doctype html><html><head><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="https://cdn.test/x.css"></head><body><img src="img/logo.png"><img src="../secret.png"><script src="js/app.js"></script></body></html>',
			"apps/sales/style.css": 'body{background:url("img/logo.png")}',
			"apps/sales/js/app.js": 'document.body.append("</script><b>x</b>")',
			"apps/sales/img/logo.png": PNG,
			"apps/secret.png": PNG,
		});

	it("puts an app's videos in, each up to its own limit, outside the limit of the rest", async () => {
		const big = new Uint8Array(1024 * 1024);
		const assembled = await assembleApp(
			fakeFolder({
				"apps/ideas/index.html":
					'<!doctype html><html><body><video src="a.mp4" controls></video><video><source src="clips/b.webm"></video><video src="../c.mp4"></video></body></html>',
				"apps/ideas/a.mp4": big,
				"apps/ideas/clips/b.webm": big,
				"apps/c.mp4": big,
			}) as never,
			{ path: "apps/ideas", entry: "index.html" },
			new AbortController().signal,
		);
		expect(assembled.ok).toBe(true);
		if (!assembled.ok) return;
		const page = new DOMParser().parseFromString(assembled.page, "text/html");
		expect(page.querySelector("video")?.getAttribute("src")?.startsWith("data:video/mp4;base64,")).toBe(true);
		expect(page.querySelector("source")?.getAttribute("src")?.startsWith("data:video/webm;base64,")).toBe(true);
		// Out of the app's own folder, it stays as written and the frame's policy blocks it.
		expect(page.querySelectorAll("video")[2]?.getAttribute("src")).toBe("../c.mp4");
		const tooBig = await assembleApp(
			fakeFolder({
				"apps/ideas/index.html": '<!doctype html><html><body><video src="a.mp4"></video></body></html>',
				"apps/ideas/a.mp4": new Uint8Array(13 * 1024 * 1024),
			}) as never,
			{ path: "apps/ideas", entry: "index.html" },
			new AbortController().signal,
		);
		expect(tooBig.ok).toBe(false);
	});

	it("puts an explainer together as any app: its engine, its scenes and its voice clips, in a dark page", async () => {
		// The page as save_app's explainer kit writes it (packages/runtime/src/cloud-app-kit-explainer.ts
		// `explainerPage`, whose test holds this text): the web needs to know nothing of the kit.
		const page = [
			"<!doctype html>",
			'<html lang="en">',
			"<head>",
			'<meta charset="utf-8">',
			'<meta name="viewport" content="width=device-width, initial-scale=1">',
			'<meta name="color-scheme" content="dark">',
			"<title>How the fee works</title>",
			"</head>",
			"<body>",
			'<div id="video"></div>',
			'<audio data-caption="3f0a9c1e" data-seconds="5.42" preload="none"><source src="voice/3f0a9c1e.mp4"></audio>',
			'<audio data-caption="0000beef" data-seconds="2" preload="none"><source src="voice/0000beef.mp4"></audio>',
			'<script src="engine.js"></script>',
			'<script>window.V = new Video(document.getElementById("video"), { title: "How the fee works" });</script>',
			'<script src="scenes.js"></script>',
			"<script>V.start();</script>",
			"</body>",
			"</html>",
			"",
		].join("\n");
		const assembled = await assembleApp(
			fakeFolder({
				"apps/fee/index.html": page,
				"apps/fee/engine.js": "window.Video = class {};",
				"apps/fee/scenes.js": 'V.part("The fee");',
				"apps/fee/voice/3f0a9c1e.mp4": new Uint8Array([0, 0, 0, 28]),
				// The second clip is listed in the page and gone from the folder: it stays a name the frame can't load.
			}) as never,
			{ path: "apps/fee", entry: "index.html" },
			new AbortController().signal,
			{ scheme: "light", brand: null },
		);
		expect(assembled.ok).toBe(true);
		if (!assembled.ok) return;
		// It says it is dark, so it is dark whatever the member's scheme, and so is what stands behind it meanwhile.
		expect(assembled.scheme).toBe("dark");
		const handed = new DOMParser().parseFromString(assembled.page, "text/html");
		const scripts = [...handed.querySelectorAll("script")].map((script) => script.textContent);
		expect(scripts).toEqual([
			"window.Video = class {};",
			'window.V = new Video(document.getElementById("video"), { title: "How the fee works" });',
			'V.part("The fee");',
			"V.start();",
		]);
		expect(handed.querySelector("script[src]")).toBeNull();
		const clips = [...handed.querySelectorAll("audio[data-caption] > source")].map((source) =>
			source.getAttribute("src"),
		);
		expect(clips).toEqual(["data:video/mp4;base64,AAAAHA==", "voice/0000beef.mp4"]);
		expect(handed.querySelector("audio")?.getAttribute("data-seconds")).toBe("5.42");
	});

	it("puts the app's own stylesheets, scripts and pictures in, and leaves everything else as written", async () => {
		const assembled = await assembleApp(
			folder(),
			{ path: "apps/sales", entry: "index.html" },
			new AbortController().signal,
		);
		expect(assembled.ok).toBe(true);
		if (!assembled.ok) return;
		const page = new DOMParser().parseFromString(assembled.page, "text/html");
		expect(page.querySelector("style")?.textContent).toBe('body{background:url("data:image/png;base64,iVBORw==")}');
		expect(page.querySelector("link")?.getAttribute("href")).toBe("https://cdn.test/x.css");
		const images = [...page.querySelectorAll("img")].map((image) => image.getAttribute("src"));
		expect(images).toEqual(["data:image/png;base64,iVBORw==", "../secret.png"]);
		const script = page.querySelector("script");
		expect(script?.hasAttribute("src")).toBe(false);
		// A script's text can't end its own element early.
		expect(script?.textContent).toBe('document.body.append("<\\/script><b>x</b>")');
		expect(assembled.files).toBe(4);
	});

	it("reads the page's files side by side, a few at once and each once, and puts each where it is named", async () => {
		const names = Array.from({ length: 12 }, (_, index) => `p${index}.png`);
		const files: Record<string, string> = {
			"apps/many/index.html": `<link rel="stylesheet" href="a.css">${names.map((name) => `<img src="${name}">`).join("")}<img src="p0.png">`,
			"apps/many/a.css": "b{background:url(p1.png)}",
		};
		for (const [index, name] of names.entries()) files[`apps/many/${name}`] = String.fromCharCode(65 + index);
		const f = fakeFolder(files);
		let active = 0;
		let most = 0;
		const read = f.read;
		const slow = Object.assign(f, {
			read: async (path: string, signal: AbortSignal) => {
				active++;
				most = Math.max(most, active);
				// The later a file is named, the sooner its read ends.
				await new Promise((resolve) => setTimeout(resolve, 30 - (names.indexOf(path.split("/").at(-1)!) + 1) * 2));
				active--;
				return read(path, signal);
			},
		});
		const assembled = await assembleApp(
			slow,
			{ path: "apps/many", entry: "index.html" },
			new AbortController().signal,
		);
		expect(assembled.ok).toBe(true);
		if (!assembled.ok) return;
		const page = new DOMParser().parseFromString(assembled.page, "text/html");
		const sources = [...page.querySelectorAll("img")].map((image) => atob(image.getAttribute("src")!.split(",")[1]!));
		expect(sources).toEqual([...names.map((_, index) => String.fromCharCode(65 + index)), "A"]);
		expect(page.querySelector("style")?.textContent).toBe('b{background:url("data:image/png;base64,Qg==")}');
		expect(most).toBeGreaterThan(1);
		expect(most).toBeLessThanOrEqual(8);
		expect(f.reads.filter((path) => path === "apps/many/p0.png")).toHaveLength(1);
		expect(assembled.files).toBe(14);
	});

	it("starts a page from the base style, first in its head and under the page's own styles", async () => {
		const files = fakeFolder({
			"apps/plain/index.html": "<!doctype html><title>Plain</title><style>h1{color:red}</style><h1>Hi</h1>",
			"apps/both/index.html": '<meta name="Color-Scheme" content="Light Dark"><p>Hi</p>',
			"QorperaOS/brand/brand.toml": 'accent = "#1f6f5b"',
		});
		const signal = new AbortController().signal;
		const brand = {
			light: { accent: "#1f6f5b", background: null, text: null },
			dark: { accent: null, background: null, text: null },
		};
		const plain = await assembleApp(files, { path: "apps/plain", entry: "index.html" }, signal, {
			scheme: "dark",
			brand,
		});
		if (!plain.ok) throw new Error(plain.message);
		const page = new DOMParser().parseFromString(plain.page, "text/html");
		const [base, own] = [...page.querySelectorAll("style")];
		expect(page.head.firstElementChild).toBe(base);
		expect(base?.hasAttribute("data-qorpera-base")).toBe(true);
		// One layer, and the page's own styles in none: whatever the page writes wins.
		expect(base?.textContent?.startsWith("@layer qorpera-base {")).toBe(true);
		expect(base?.textContent?.match(/@layer/g)).toHaveLength(1);
		expect(own?.textContent).toBe("h1{color:red}");
		expect(base?.textContent).toContain("--q-accent: #1f6f5b;");
		// A page that does not say it supports dark is shown light, in a dark app too.
		expect(plain.scheme).toBe("light");
		expect(base?.textContent).toContain("color-scheme: light;");
		expect(plain.page.startsWith("<!DOCTYPE html><html><head><style data-qorpera-base")).toBe(true);
		// One that says it supports both follows the app.
		const both = await assembleApp(files, { path: "apps/both", entry: "index.html" }, signal, {
			scheme: "dark",
			brand: null,
		});
		expect(both).toMatchObject({ ok: true, scheme: "dark" });
		expect(both.ok && both.page).toContain("color-scheme: dark;");
		const light = await assembleApp(files, { path: "apps/both", entry: "index.html" }, signal, {
			scheme: "light",
			brand: null,
		});
		expect(light).toMatchObject({ ok: true, scheme: "light" });
		// The company's colours are handed in: putting a page together reads only the app's own folder.
		expect(files.reads.every((path) => path.startsWith("apps/"))).toBe(true);
		// With no look (a concept of the product), the page is as written.
		const asWritten = await assembleApp(files, { path: "apps/plain", entry: "index.html" }, signal);
		expect(asWritten.ok && asWritten.page).not.toContain("qorpera-base");
		expect(asWritten.ok && asWritten.scheme).toBeUndefined();
	});

	it("says when the entry is missing, and never reads outside the app", async () => {
		const f = folder();
		const missing = await assembleApp(f, { path: "apps/sales", entry: "other.html" }, new AbortController().signal);
		expect(missing).toMatchObject({ ok: false, reason: "missing" });
		await assembleApp(f, { path: "apps/sales", entry: "index.html" }, new AbortController().signal);
		expect(f.reads.every((path) => path.startsWith("apps/sales/"))).toBe(true);
	});
});

describe("the company's apps", () => {
	it("lists each app with its manifest, or its problems", async () => {
		const f = fakeFolder({
			"apps/sales/app.toml": 'name = "Sales"\nposted = true\n',
			"apps/sales/index.html": "<p>",
			"apps/broken/app.toml": "name =",
			"apps/empty/index.html": "<p>",
			"apps/Bad_Name/app.toml": 'name = "x"',
		});
		const apps = await readApps(f, new AbortController().signal);
		expect(apps.map((app) => [app.name, app.manifest?.posted ?? null, app.problems.length > 0])).toEqual([
			["broken", null, true],
			["empty", null, true],
			["sales", true, false],
		]);
	});

	it("reads ahead each app's entry and the company's colours, and nothing else of an app", async () => {
		const f = fakeFolder({
			"apps/sales/app.toml": 'name = "Sales"\n',
			"apps/sales/index.html": '<img src="big.png">',
			"apps/sales/big.png": "x",
			"apps/plan/app.toml": 'name = "Plan"\nentry = "pages/start.html"\n',
			"apps/plan/pages/start.html": "<p>",
			"apps/broken/app.toml": "name =",
			"QorperaOS/brand/brand.toml": 'accent = "#123456"\n',
		});
		const readFile = vi.spyOn(f, "readFile");
		await warmApps(f, await readApps(f, new AbortController().signal), new AbortController().signal);
		const read = readFile.mock.calls.map(([file]) => (file as { bytes: number }).bytes);
		expect(f.reads).toEqual(
			expect.arrayContaining(["QorperaOS/brand/brand.toml", "apps/sales/index.html", "apps/plan/pages/start.html"]),
		);
		expect(f.reads).not.toContain("apps/sales/big.png");
		expect(f.reads.filter((path) => path.startsWith("apps/broken/") && path !== "apps/broken/app.toml")).toEqual([]);
		// The three manifests that read, the colours and two entries.
		expect(read).toHaveLength(6);
		const stopped = new AbortController();
		stopped.abort();
		f.reads.length = 0;
		await warmApps(f, await readApps(f, new AbortController().signal), stopped.signal);
		expect(f.reads.filter((path) => !path.endsWith("app.toml") && path !== "apps")).toEqual([]);
	});

	it("lists the concepts of the company's product, the most recently changed first", async () => {
		const f = fakeFolder({
			"apps/shop-a/app.toml": 'name = "Shop A"\nconcept = true\ncover = "cover.webp"\n',
			"apps/shop-b/app.toml": 'name = "Shop B"\nconcept = true\n',
			"apps/sales/app.toml": 'name = "Sales"\nposted = true\n',
			"apps/broken/app.toml": "name = \nconcept = true\n",
		});
		const apps = await readApps(f, new AbortController().signal);
		expect(apps.find((app) => app.name === "shop-a")?.manifest).toMatchObject({ concept: true, cover: "cover.webp" });
		expect(apps.every((app) => app.changed === 1)).toBe(true);
		// The same change number: by name. A later change comes first.
		expect(companyConcepts(apps).map((app) => app.name)).toEqual(["shop-a", "shop-b"]);
		const later = apps.map((app) => (app.name === "shop-b" ? { ...app, changed: 9 } : app));
		expect(companyConcepts(later).map((app) => app.name)).toEqual(["shop-b", "shop-a"]);
		expect(companyConcepts([])).toEqual([]);
	});

	it("shares one hint channel between readers", async () => {
		let opened = 0;
		let closed = 0;
		const listeners: ((seq: number) => void)[] = [];
		const hints = sharedFolderHints({
			signal: new AbortController().signal,
			folder: () => fakeFolder({}),
			folderHints: (onHint) => {
				opened++;
				listeners.push(onHint);
				return { close: async () => void closed++ };
			},
		});
		const seen: number[] = [];
		const a = hints((seq) => seen.push(seq));
		const b = hints((seq) => seen.push(seq * 10));
		listeners[0]?.(2);
		expect(seen).toEqual([2, 20]);
		await a.close();
		expect(closed).toBe(0);
		await b.close();
		expect([opened, closed]).toEqual([1, 1]);
	});
});

describe("the bridge", () => {
	const app = (reads: string): CompanyApp & { manifest: NonNullable<CompanyApp["manifest"]> } => {
		const parsed = parseAppManifest(`name = "Sales"\nreads = [${reads}]\n`);
		if (!parsed.ok) throw new Error("manifest");
		return { name: "sales", path: "apps/sales", manifest: parsed.manifest, problems: [], version: null };
	};
	const files = {
		"apps/sales/data.json": '{"week":1}',
		"sales/report.md": "# Report",
		"QorperaOS/tables/tasks/table.toml": "x",
	};
	const bridge = (reads: string, key = crypto.randomUUID()) =>
		new AppBridge(
			{ folder: () => fakeFolder(files), agents: () => [{ name: "Nora", role: "Sales", working: true }] },
			app(reads),
			key,
			new AbortController().signal,
		);

	it("reads the app's own files, and others only with files in reads", async () => {
		expect(await bridge("").answer({ method: "read", params: { path: "apps/sales/data.json" } })).toEqual({
			ok: true,
			value: '{"week":1}',
		});
		expect(await bridge("").answer({ method: "read", params: { path: "sales/report.md" } })).toMatchObject({
			ok: false,
		});
		expect(await bridge('"files"').answer({ method: "read", params: { path: "sales/report.md" } })).toEqual({
			ok: true,
			value: "# Report",
		});
		expect(
			await bridge('"files"').answer({ method: "read", params: { path: "QorperaOS/tables/tasks/table.toml" } }),
		).toMatchObject({ ok: false, error: "An app reads only the company's own files" });
		expect(await bridge('"files"').answer({ method: "list", params: { path: "" } })).toMatchObject({
			ok: true,
			value: [{ name: "apps" }, { name: "sales" }],
		});
	});

	it("answers agents, tables and todos only when the manifest asks for them, and nothing else", async () => {
		expect(await bridge("").answer({ method: "agents", params: {} })).toMatchObject({ ok: false });
		expect(await bridge('"agents"').answer({ method: "agents", params: {} })).toEqual({
			ok: true,
			value: [{ name: "Nora", role: "Sales", working: true }],
		});
		expect(await bridge("").answer({ method: "table", params: { name: "tasks" } })).toMatchObject({ ok: false });
		expect(await bridge('"tables"').answer({ method: "table", params: { name: "tasks" } })).toMatchObject({
			ok: false,
			error: "That table's definition has problems",
		});
		expect(await bridge('"files"').answer({ method: "writeRows", params: {} })).toMatchObject({ ok: false });
		expect(await bridge('"files"').answer({ method: "token", params: {} })).toMatchObject({ ok: false });
	});

	it("opens a link the member clicked once it is checked, reads nothing for it, and tells the page nothing", async () => {
		const folder = fakeFolder(files);
		const followed: AppLink[] = [];
		const key = crypto.randomUUID();
		const open = (href: unknown, follows = true) =>
			new AppBridge(
				{ folder: () => folder, agents: () => [] },
				app(""),
				key,
				new AbortController().signal,
				undefined,
				follows ? (link) => followed.push(link) : undefined,
			).answer({ method: "open", params: { href } });
		// It needs nothing in reads, and the answer is the same whether or not what the link names is there.
		for (const href of ["app:hiring", "folder:sales/report.md", "folder:sales/missing.md", "https://example.com/"])
			expect(await open(href), href).toEqual({ ok: true, value: null });
		expect(followed).toEqual([
			{ kind: "app", name: "hiring" },
			{ kind: "file", path: "sales/report.md" },
			{ kind: "file", path: "sales/missing.md" },
			{ kind: "web", href: "https://example.com/" },
		]);
		for (const bad of ["folder:QorperaOS/tables/tasks/table.toml", "other.html", "javascript:alert(1)", 7])
			expect(await open(bad), String(bad)).toEqual({
				ok: false,
				error: "A link opens an app (app:name), a company file (folder:path) or a web page (https://…)",
			});
		expect(followed).toHaveLength(4);
		expect(folder.reads).toEqual([]);
		// A bridge given no way to open one (none is today) opens none.
		expect(await open("app:hiring", false)).toMatchObject({ ok: false });
		// Each link is a call of the app's budget: 120 a minute, with its reads.
		let refused = 0;
		for (let index = 0; index < 115; index++) if (!(await open("app:hiring")).ok) refused++;
		expect(refused).toBe(4);
		expect(followed).toHaveLength(4 + 111);
		expect(await open("app:hiring")).toEqual({ ok: false, error: "Too many calls: wait a moment and try again" });
	});

	it("keeps an app's budget across its frames", async () => {
		const key = crypto.randomUUID();
		let refused = 0;
		for (let index = 0; index < 125; index++) {
			const answer = await bridge("", key).answer({ method: "read", params: { path: "apps/sales/data.json" } });
			if (!answer.ok) refused++;
		}
		expect(refused).toBe(5);
	});
});

describe("an app's card in a message", () => {
	it("keeps a sentence whole around an app's link, with the card under it", () => {
		const prose = markdown("See this [first sketch](app:first-sketch): the desk is by the window.");
		const paragraph = prose.querySelector("p");
		expect(paragraph?.textContent).toBe("See this first sketch: the desk is by the window.");
		expect(paragraph?.querySelector(".app-card")).toBeNull();
		expect(paragraph?.querySelector<HTMLElement>("[data-app-name]")?.dataset.appName).toBe("first-sketch");
		expect(prose.querySelector(":scope > .app-card, p + .app-card")?.getAttribute("data-app-name")).toBe(
			"first-sketch",
		);
		// Alone on its line, it is the card and nothing else.
		const alone = markdown("[First sketch](app:first-sketch)");
		expect(alone.querySelectorAll("[data-app-name]")).toHaveLength(1);
		expect(alone.querySelector(".app-card")).not.toBeNull();
	});

	it("draws app: links as a card that names the app", () => {
		const body = markdown("See [Sales this week](app:sales-board) and [x](app:Bad).");
		const card = body.querySelector<HTMLButtonElement>("button.app-card");
		expect(card?.dataset.appName).toBe("sales-board");
		expect(card?.querySelector(".app-card-title")?.textContent).toBe("Sales this week");
		expect(body.querySelectorAll(".app-card")).toHaveLength(1);
		expect(body.querySelector("a")).toBeNull();
	});

	it("says the card and the link open the app's own page, not a panel beside the chat", () => {
		const prose = markdown("See [Sales this week](app:sales-board) for the numbers.");
		const [link, card] = prose.querySelectorAll<HTMLButtonElement>("[data-app-name]");
		expect(link?.title).toBe("Open sales-board");
		expect(card?.title).toBe("Open sales-board");
		expect(card?.querySelector(".app-card-note")?.textContent).toBe("App · opens on its own page");
		expect(prose.textContent).not.toContain("beside the chat");
	});
});

describe("following the company's apps from a hidden tab", () => {
	function following() {
		vi.useFakeTimers();
		const folders = vi.fn(() => fakeFolder({}));
		let hint = () => {};
		let state = (_connected: boolean) => {};
		const apps = new CompanyApps(
			{
				signal: new AbortController().signal,
				folder: folders as never,
				folderHints: (onHint, onState) => {
					hint = () => onHint(2);
					state = (connected) => onState?.(connected);
					return { close: async () => {} };
				},
			},
			() => {},
		);
		apps.open();
		const showing = (shown: DocumentVisibilityState) => {
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => shown });
			document.dispatchEvent(new Event("visibilitychange"));
		};
		return { apps, folders, showing, hint: () => hint(), state: (connected: boolean) => state(connected) };
	}
	afterEach(() => {
		Reflect.deleteProperty(document, "visibilityState");
		vi.useRealTimers();
	});

	it("reads on no clock while its hints work, reads on a hint, and reads what the clock skipped when it is back", async () => {
		const f = following();
		f.state(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.folders).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.folders).toHaveBeenCalledTimes(2);
		f.showing("hidden");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(f.folders).toHaveBeenCalledTimes(2);
		f.hint();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(f.folders).toHaveBeenCalledTimes(3);
		f.showing("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(f.folders).toHaveBeenCalledTimes(4);
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.folders).toHaveBeenCalledTimes(4);
		f.apps.dispose();
	});

	it("stays on the minute's poll while its hint's channel is down", async () => {
		const f = following();
		await vi.advanceTimersByTimeAsync(0);
		f.showing("hidden");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.folders).toHaveBeenCalledTimes(2);
		f.state(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.folders).toHaveBeenCalledTimes(2);
		f.state(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.folders).toHaveBeenCalledTimes(3);
		f.apps.dispose();
	});

	it("reads at once when it comes back after a whole period, though no timer fired (a frozen tab)", async () => {
		const f = following();
		f.state(true);
		await vi.advanceTimersByTimeAsync(0);
		f.showing("hidden");
		vi.setSystemTime(Date.now() + 60 * 60_000);
		f.showing("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(f.folders).toHaveBeenCalledTimes(2);
		f.apps.dispose();
	});

	it("reads nothing extra when it comes back before a period has passed", async () => {
		const f = following();
		f.state(true);
		await vi.advanceTimersByTimeAsync(0);
		f.showing("hidden");
		await vi.advanceTimersByTimeAsync(5_000);
		f.showing("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(f.folders).toHaveBeenCalledTimes(1);
		f.apps.dispose();
	});

	it("tells each reader of the shared hint whether its channel is subscribed", async () => {
		let tell = (_connected: boolean) => {};
		const hints = sharedFolderHints({
			signal: new AbortController().signal,
			folder: () => {
				throw new Error("not read here");
			},
			folderHints: (_onHint, onState) => {
				tell = (connected) => onState?.(connected);
				return { close: async () => {} };
			},
		});
		const first: boolean[] = [];
		const second: boolean[] = [];
		hints(
			() => {},
			(connected) => first.push(connected),
		);
		tell(true);
		hints(
			() => {},
			(connected) => second.push(connected),
		);
		tell(false);
		expect(first).toEqual([false, true, false]);
		expect(second).toEqual([true, false]);
	});
});
