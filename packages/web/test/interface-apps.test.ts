// @vitest-environment jsdom
import { createHash } from "node:crypto";
import {
	type CloudMemberDataAnswer,
	CloudMemberDataError,
	type CloudMemberDataQuestion,
	type CloudMemberDataWatch,
	type CloudMemberDataWatchAnswer,
} from "@qorpera/cloud-client/cloud-member-data";
import { type CloudMemberFolderEntry, CloudMemberFolderError } from "@qorpera/cloud-client/cloud-member-folder";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AppBridge,
	type AppLink,
	appLink,
	appReadablePath,
	assembleApp,
	type CompanyApp,
	CompanyApps,
	CompanyData,
	type CompanyDataClient,
	CompanyNumbers,
	companyConcepts,
	numbersPollMs,
	PageFiles,
	readApps,
	resolveAppPath,
	sharedFolderHints,
	warmApps,
} from "../src/app/interface-apps.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { askCompanyNumbers } from "../src/cloud/company-numbers.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";

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

const textOf = (blob: Blob | undefined) =>
	new Promise<string>((resolve, reject) => {
		if (!blob) return reject(new Error("no file"));
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.readAsText(blob);
	});

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

	it("sends small videos with the page, and marks large ones to come when their element needs them", async () => {
		const small = new Uint8Array(1024 * 1024);
		const assembled = await assembleApp(
			fakeFolder({
				"apps/ideas/index.html":
					'<!doctype html><html><body><video src="a.mp4" controls></video><video><source src="clips/b.webm"></video><video src="../c.mp4"></video><video src="film.mp4" poster="still.avif"></video><audio src="voice.mp3"></audio><video src="none.mp4"></video></body></html>',
				"apps/ideas/a.mp4": small,
				"apps/ideas/clips/b.webm": small,
				"apps/ideas/film.mp4": new Uint8Array(60 * 1024 * 1024),
				"apps/ideas/still.avif": new Uint8Array(10),
				"apps/ideas/voice.mp3": new Uint8Array(10),
				"apps/c.mp4": small,
			}) as never,
			{ path: "apps/ideas", entry: "index.html" },
			new AbortController().signal,
		);
		expect(assembled.ok).toBe(true);
		if (!assembled.ok) return;
		const page = new DOMParser().parseFromString(assembled.page, "text/html");
		const videos = [...page.querySelectorAll("video")];
		const handed = new Map(assembled.framed.files);
		const sent = (token: string | null | undefined) => handed.get(token ?? "")?.type;
		expect(sent(videos[0]?.getAttribute("src"))).toBe("video/mp4");
		expect(sent(page.querySelector("source")?.getAttribute("src"))).toBe("video/webm");
		expect(sent(videos[3]?.getAttribute("poster"))).toBe("image/avif");
		expect(sent(page.querySelector("audio")?.getAttribute("src"))).toBe("audio/mpeg");
		// Out of the app's own folder, it stays as written and the frame's policy blocks it.
		expect(videos[2]?.getAttribute("src")).toBe("../c.mp4");
		expect(videos[3]?.hasAttribute("src")).toBe(false);
		expect(videos[3]?.getAttribute("data-qorpera-src")).toBe("film.mp4");
		expect([...handed.values()].every((blob) => blob.size < 2 * 1024 * 1024)).toBe(true);
		expect(videos[4]?.hasAttribute("src")).toBe(false);
		expect(assembled.framed.missing).toEqual(["none.mp4"]);
		expect(assembled.key).toContain("film.mp4 ");
	});

	it("keeps no cap on an app: any number of files of any kind and size", async () => {
		const files: Record<string, string | Uint8Array> = {
			"apps/big/index.html": `<link rel="stylesheet" href="look.css">${Array.from({ length: 200 }, (_, n) => `<img src="p/${n}.webp">`).join("")}<script src="three.min.js"></script><img src="huge.png" hidden>`,
			"apps/big/look.css": '@font-face{font-family:Brand;src:url("type/brand.woff2")}',
			"apps/big/type/brand.woff2": new Uint8Array(40_000),
			"apps/big/three.min.js": `window.T=${JSON.stringify("x".repeat(700_000))};`,
			"apps/big/huge.png": new Uint8Array(20 * 1024 * 1024),
		};
		for (let n = 0; n < 200; n++) files[`apps/big/p/${n}.webp`] = new Uint8Array(20_000).fill(n);
		const progress: [number, number][] = [];
		const assembled = await assembleApp(
			fakeFolder(files) as never,
			{ path: "apps/big", entry: "index.html" },
			new AbortController().signal,
			undefined,
			(read, of) => progress.push([read, of]),
		);
		if (!assembled.ok) throw new Error(assembled.message);
		const page = new DOMParser().parseFromString(assembled.page, "text/html");
		const handed = new Map(assembled.framed.files);
		const script = page.querySelector("script");
		expect(handed.get(script?.getAttribute("src") ?? "")?.type).toBe("text/javascript");
		expect(handed.get(script?.getAttribute("src") ?? "")?.size).toBeGreaterThan(700_000);
		expect(page.querySelector("style")?.textContent).toMatch(/url\("qorpera-file-[0-9a-f]{32}-woff2"\)/);
		expect(handed.get(page.querySelector("img[hidden]")?.getAttribute("src") ?? "")?.size).toBe(20 * 1024 * 1024);
		expect(page.querySelectorAll("img:not([hidden])")).toHaveLength(200);
		expect(page.querySelectorAll("img:not([hidden])[src]")).toHaveLength(24);
		expect(page.querySelectorAll("img[data-qorpera-src]")).toHaveLength(176);
		expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);
	});

	it("reads a large file of the first paint piece by piece into its blob, never whole", async () => {
		const big = new Uint8Array(9 * 1024 * 1024).fill(7);
		const f = fakeFolder({
			"apps/kit/index.html": '<div hidden><img src="sheet.webp"></div><img src="small.png">',
			"apps/kit/sheet.webp": big,
			"apps/kit/small.png": new Uint8Array(10),
		});
		const whole = vi.spyOn(f, "readFile");
		const pieces = vi.fn(
			async (
				file: { bytes: number },
				_signal: AbortSignal,
				onPiece: (piece: Uint8Array, index: number, count: number) => void,
			) => {
				const count = Math.ceil(file.bytes / (4 * 1024 * 1024));
				for (let index = 0; index < count; index++)
					onPiece(big.subarray(index * 4 * 1024 * 1024, (index + 1) * 4 * 1024 * 1024), index, count);
			},
		);
		const assembled = await assembleApp(
			Object.assign(f, { readFilePieces: pieces }) as never,
			{ path: "apps/kit", entry: "index.html" },
			new AbortController().signal,
		);
		if (!assembled.ok) throw new Error(assembled.message);
		const page = new DOMParser().parseFromString(assembled.page, "text/html");
		const handed = new Map(assembled.framed.files);
		expect(handed.get(page.querySelector("[hidden] img")?.getAttribute("src") ?? "")?.size).toBe(big.byteLength);
		expect(pieces).toHaveBeenCalledOnce();
		expect(whole.mock.calls.map(([file]) => (file as { bytes: number }).bytes).sort()).toEqual(
			[10, '<div hidden><img src="sheet.webp"></div><img src="small.png">'.length].sort(),
		);
		expect(assembled.files).toBe(3);
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
		expect(clips[0]).toMatch(/^qorpera-file-[0-9a-f]{32}-mp4$/);
		expect(clips[1]).toBeNull();
		expect(assembled.framed.missing).toEqual(["voice/0000beef.mp4"]);
		expect(await textOf(new Map(assembled.framed.files).get(clips[0] ?? ""))).toBe("\0\0\0\u001c");
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
		const logo = /url\("(qorpera-file-[0-9a-f]{32}-png)"\)/.exec(page.querySelector("style")?.textContent ?? "")?.[1];
		expect(page.querySelector("style")?.textContent).toBe(`body{background:url("${logo}")}`);
		expect(new Map(assembled.framed.files).get(logo ?? "")?.type).toBe("image/png");
		expect(page.querySelector("link")?.getAttribute("href")).toBe("https://cdn.test/x.css");
		const images = [...page.querySelectorAll("img")].map((image) => image.getAttribute("src"));
		expect(images).toEqual([logo, "../secret.png"]);
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
		const handed = new Map(assembled.framed.files);
		const sources = await Promise.all(
			[...page.querySelectorAll("img")].map((image) => textOf(handed.get(image.getAttribute("src")!))),
		);
		expect(sources).toEqual([...names.map((_, index) => String.fromCharCode(65 + index)), "A"]);
		const second = page.querySelectorAll("img")[1]?.getAttribute("src");
		expect(page.querySelector("style")?.textContent).toBe(`b{background:url("${second}")}`);
		expect(most).toBeGreaterThan(1);
		expect(most).toBeLessThanOrEqual(8);
		expect(f.reads.filter((path) => path === "apps/many/p0.png")).toHaveLength(1);
		expect(assembled.files).toBe(14);
	});

	it("reads the entries of the files a page names in one call, and each path alone where that call is missing", async () => {
		const files = {
			"apps/many/index.html": '<link rel="stylesheet" href="a.css"><img src="p.png"><script src="s.js"></script>',
			"apps/many/a.css": "b{background:url(q.png)}",
			"apps/many/p.png": "P",
			"apps/many/q.png": "Q",
			"apps/many/s.js": "1",
		};
		const withMany = (answer: (paths: readonly string[]) => Promise<unknown>) => {
			const f = fakeFolder(files);
			const alone: string[] = [];
			const many: string[][] = [];
			const read = f.read;
			return {
				alone,
				many,
				folder: Object.assign(f, {
					read: async (path: string, signal: AbortSignal) => {
						alone.push(path);
						return read(path, signal);
					},
					readMany: async (paths: readonly string[], signal: AbortSignal) => {
						many.push([...paths]);
						await answer(paths);
						return Promise.all(paths.map((path) => read(path, signal)));
					},
				}),
			};
		};
		const signal = new AbortController().signal;
		// One call for the entry, one for what it names, one for the stylesheet's picture.
		const one = withMany(async () => undefined);
		const assembled = await assembleApp(one.folder, { path: "apps/many", entry: "index.html" }, signal);
		expect(assembled).toMatchObject({ ok: true, files: 5 });
		expect(one.alone).toEqual([]);
		expect(one.many).toEqual([
			["apps/many/index.html"],
			["apps/many/a.css", "apps/many/s.js", "apps/many/p.png"],
			["apps/many/q.png"],
		]);
		// A call that fails reads each path alone, and asks again next time; a 404 (no such call yet) is not asked again.
		const failing = withMany(async () => {
			throw new CloudMemberFolderError("Company folder is unavailable (503)", 503);
		});
		expect(await assembleApp(failing.folder, { path: "apps/many", entry: "index.html" }, signal)).toEqual(assembled);
		expect(failing.alone).toHaveLength(5);
		expect(failing.many).toHaveLength(3);
		const missing = withMany(async () => {
			throw new CloudMemberFolderError("Company folder is unavailable (404)", 404);
		});
		expect(await assembleApp(missing.folder, { path: "apps/many", entry: "index.html" }, signal)).toEqual(assembled);
		expect(await assembleApp(missing.folder, { path: "apps/many", entry: "index.html" }, signal)).toEqual(assembled);
		expect(missing.many).toEqual([["apps/many/index.html"]]);
		expect(missing.alone).toHaveLength(10);
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

describe("an app's module scripts", () => {
	const signal = new AbortController().signal;
	const open = async (files: Record<string, string>, entry = "index.html", path = "apps/mod") => {
		const assembled = await assembleApp(fakeFolder(files) as never, { path, entry }, signal);
		if (!assembled.ok) throw new Error(assembled.message);
		const page = new DOMParser().parseFromString(assembled.page, "text/html");
		const handed = new Map(assembled.framed.files);
		const map = JSON.parse(page.querySelector("script[type=importmap]")?.textContent ?? "{}") as {
			imports: Record<string, string>;
		};
		const source = (path: string) => textOf(handed.get(map.imports[`qorpera-module:/${path}`] ?? ""));
		return { assembled, page, handed, map, source, said: assembled.framed.said ?? [] };
	};

	it("binds a module page's whole graph: module src, inline, relative at any depth, export from, side effects and a cycle", async () => {
		const { page, map, source, said, handed } = await open({
			"apps/mod/index.html":
				'<script type="module" src="main.js"></script><script type="module">import { a } from "./lib/a.js"; a();</script>',
			"apps/mod/main.js":
				'import "./lib/side.js";\nexport * from "./lib/a.js";\nimport { b } from "./lib/deep/b.js";\nb();',
			"apps/mod/lib/a.js": 'import { b } from "./deep/b.js";\nexport const a = () => b();',
			"apps/mod/lib/deep/b.js":
				'import { a } from "../a.js";\nimport { c } from "../../c.js";\nexport const b = () => c(a);',
			"apps/mod/c.js": "export const c = (f) => f;",
			"apps/mod/lib/side.js": "globalThis.side = 1;",
		});
		expect(said).toEqual([]);
		expect(Object.keys(map.imports).sort()).toEqual(
			["c.js", "lib/a.js", "lib/deep/b.js", "lib/side.js", "main.js"]
				.map((path) => `qorpera-module:/${path}`)
				.sort(),
		);
		expect(page.head.firstElementChild?.getAttribute("type")).toBe("importmap");
		const main = page.querySelector("script[src]");
		expect(main?.getAttribute("src")).toBe(map.imports["qorpera-module:/main.js"]);
		expect(page.querySelector("script[type=module]:not([src])")?.textContent).toBe(
			'import { a } from "qorpera-module:/lib/a.js"; a();',
		);
		expect(await source("main.js")).toBe(
			'import "qorpera-module:/lib/side.js";\nexport * from "qorpera-module:/lib/a.js";\nimport { b } from "qorpera-module:/lib/deep/b.js";\nb();\n//# sourceURL=qorpera-module:/main.js',
		);
		expect(await source("lib/deep/b.js")).toContain('import { a } from "qorpera-module:/lib/a.js";');
		expect(await source("lib/deep/b.js")).toContain('import { c } from "qorpera-module:/c.js";');
		expect(await source("lib/a.js")).toContain('import { b } from "qorpera-module:/lib/deep/b.js";');
		expect([...handed.values()].every((blob) => blob.type === "text/javascript")).toBe(true);
		expect(Object.values(map.imports).every((token) => /^qorpera-file-[0-9a-f]{32}-module$/.test(token))).toBe(true);
	});

	it("resolves bare names through the page's import map, exact and by prefix, and literal dynamic imports", async () => {
		const { page, map, source, said } = await open({
			"apps/mod/index.html":
				'<script type="importmap">{"imports": {"three": "./vendor/three.module.js", "three/addons/": "./vendor/addons/"}}</script><script type="module" src="viewer.js"></script>',
			"apps/mod/viewer.js":
				"import * as THREE from 'three';\nimport { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nconst later = await import('./later.js');\nconst any = await import(name);\nconst url = new URL('./model.glb', import.meta.url);",
			"apps/mod/vendor/three.module.js": "export const REVISION = '186';",
			"apps/mod/vendor/addons/loaders/GLTFLoader.js":
				"import { REVISION } from 'three';\nexport class GLTFLoader {}",
			"apps/mod/later.js": "export default 1;",
		});
		expect(said).toEqual([]);
		expect(page.querySelectorAll("script[type=importmap]")).toHaveLength(1);
		const viewer = await source("viewer.js");
		expect(viewer).toContain("import * as THREE from 'qorpera-module:/vendor/three.module.js';");
		expect(viewer).toContain("import { GLTFLoader } from 'qorpera-module:/vendor/addons/loaders/GLTFLoader.js';");
		expect(viewer).toContain('const later = await import("qorpera-module:/later.js");');
		expect(viewer).toContain("const any = await import(name);");
		expect(viewer).toContain(
			`const url = new URL('./model.glb', ${JSON.stringify(new URL("./page-preview/viewer.js", document.baseURI).href)});`,
		);
		expect(await source("vendor/addons/loaders/GLTFLoader.js")).toContain(
			"import { REVISION } from 'qorpera-module:/vendor/three.module.js';",
		);
		expect(map.imports.three).toBe(map.imports["qorpera-module:/vendor/three.module.js"]);
	});

	it("refuses what is not a file of the page's folder, each with a plain line, and leaves it as written", async () => {
		const { source, said } = await open({
			"apps/mod/index.html": '<script type="module" src="viewer.js"></script>',
			"apps/mod/viewer.js":
				"import 'https://cdn.example/three.js';\nimport 'lodash';\nimport '../secret.js';\nimport '/apps/mod/x.js';\nimport './gone.js';\nimport 'data:text/javascript,1';",
			"apps/secret.js": "1",
		});
		expect(said).toEqual([
			"viewer.js imports https://cdn.example/three.js, which is not a file of the page's folder",
			"viewer.js imports lodash, which the page's import map does not name",
			"viewer.js imports ../secret.js, which is outside the page's folder",
			"viewer.js imports /apps/mod/x.js, which is not a file of the page's folder",
			"viewer.js imports ./gone.js, which is not in the page's folder",
		]);
		const viewer = await source("viewer.js");
		expect(viewer).toContain("import 'https://cdn.example/three.js';");
		expect(viewer).toContain("import '../secret.js';");
		expect(viewer).toContain("import 'qorpera-module:/gone.js';");
		expect(viewer).toContain("import 'data:text/javascript,1';");
	});

	it("binds JSON and CSS module imports as they are, and refuses another kind with a plain line", async () => {
		const { map, source, said, handed } = await open({
			"apps/mod/index.html": '<script type="module" src="viewer.js"></script>',
			"apps/mod/viewer.js":
				'import config from "./config.json" with { type: "json" };\nimport sheet from \'./look.css\' with {type:\'css\'};\nconst more = await import("./more.json", { with: { type: "json" } });\nimport notes from "./notes.txt" with { type: "text" };\nimport plain from "./plain.js" with { };',
			"apps/mod/config.json": '{ "name": "klokkesten" }\n',
			"apps/mod/more.json": '{ "count": 3 }',
			"apps/mod/look.css": "p { color: red }",
			"apps/mod/notes.txt": "notes",
			"apps/mod/plain.js": "export default 1;",
		});
		expect(said).toEqual(["viewer.js imports ./notes.txt as text, which a page can't import"]);
		const viewer = await source("viewer.js");
		expect(viewer).toContain('import config from "qorpera-module:/config.json?type=json" with { type: "json" };');
		expect(viewer).toContain("import sheet from 'qorpera-module:/look.css?type=css' with {type:'css'};");
		expect(viewer).toContain('await import("qorpera-module:/more.json?type=json", { with: { type: "json" } });');
		expect(viewer).toContain('import notes from "./notes.txt" with { type: "text" };');
		expect(viewer).toContain('import plain from "qorpera-module:/plain.js" with { };');
		const file = (virtual: string) => handed.get(map.imports[virtual] ?? "");
		expect(await textOf(file("qorpera-module:/config.json?type=json"))).toBe('{ "name": "klokkesten" }\n');
		expect(file("qorpera-module:/config.json?type=json")?.type).toBe("application/json");
		expect(map.imports["qorpera-module:/config.json?type=json"]).toMatch(/^qorpera-file-[0-9a-f]{32}-json$/);
		expect(map.imports["qorpera-module:/look.css?type=css"]).toBe(`data:text/css;base64,${btoa("p { color: red }")}`);
		expect(await textOf(file("qorpera-module:/more.json?type=json"))).toBe('{ "count": 3 }');
		expect(Object.keys(map.imports).some((key) => key.includes("notes"))).toBe(false);
	});

	it("maps an import-map prefix that names the app's own folder, from the root and from a page below it", async () => {
		const fromRoot = await open({
			"apps/mod/index.html":
				'<script type="importmap">{"imports": {"@/": "./", "app/": "./"}}</script><script type="module">import "@/lib/x.js"; import "app/y.js";</script>',
			"apps/mod/lib/x.js": "1",
			"apps/mod/y.js": "2",
		});
		expect(fromRoot.said).toEqual([]);
		expect(fromRoot.page.querySelector("script[type=module]")?.textContent).toBe(
			'import "qorpera-module:/lib/x.js"; import "qorpera-module:/y.js";',
		);
		const fromBelow = await open(
			{
				"apps/mod/pages/index.html":
					'<script type="importmap">{"imports": {"~/": "../", "out/": "../../"}}</script><script type="module">import "~/lib/x.js"; import "out/z.js";</script>',
				"apps/mod/lib/x.js": "1",
			},
			"pages/index.html",
		);
		expect(fromBelow.said).toEqual([
			"the page imports out/z.js, which the page's import map names outside its folder",
		]);
		expect(fromBelow.page.querySelector("script[type=module]")?.textContent).toBe(
			'import "qorpera-module:/lib/x.js"; import "out/z.js";',
		);
	});

	it("gives import.meta.url with each part of a path escaped, so a neighbour resolves to the right file", async () => {
		const { source, said, map } = await open({
			"apps/mod/index.html": '<script type="module" src="two%20words/m%C3%B8de%20%26%20co.js"></script>',
			"apps/mod/two words/møde & co.js": "const near = new URL('./near.txt', import.meta.url);",
		});
		expect([said, Object.keys(map.imports)]).toEqual([[], ["qorpera-module:/two%20words/m%C3%B8de%20%26%20co.js"]]);
		const url = new URL("./page-preview/two%20words/m%C3%B8de%20%26%20co.js", document.baseURI).href;
		expect(await source("two%20words/m%C3%B8de%20%26%20co.js")).toContain(
			`new URL('./near.txt', ${JSON.stringify(url)})`,
		);
		const near = new URL("./near.txt", url).href.slice(new URL("./page-preview/", document.baseURI).href.length);
		expect(resolveAppPath("", near)).toBe("two words/near.txt");
	});

	it("reads a large module piece by piece and binds a module the page names twice once", async () => {
		const bytes = new TextEncoder().encode(`export const big = "${"x".repeat(9 * 1024 * 1024)}";`);
		const f = fakeFolder({
			"apps/mod/index.html":
				'<script type="module" src="big.js"></script><script type="module">import { big } from "./big.js";</script>',
			"apps/mod/big.js": bytes,
		});
		const whole = vi.spyOn(f, "readFile");
		const pieces = vi.fn(
			async (
				file: { bytes: number },
				_signal: AbortSignal,
				onPiece: (piece: Uint8Array, index: number, count: number) => void,
			) => {
				const count = Math.ceil(file.bytes / (4 * 1024 * 1024));
				for (let index = 0; index < count; index++)
					onPiece(bytes.subarray(index * 4 * 1024 * 1024, (index + 1) * 4 * 1024 * 1024), index, count);
			},
		);
		const assembled = await assembleApp(
			Object.assign(f, { readFilePieces: pieces }) as never,
			{ path: "apps/mod", entry: "index.html" },
			signal,
		);
		if (!assembled.ok) throw new Error(assembled.message);
		expect(pieces).toHaveBeenCalledOnce();
		expect(whole.mock.calls.map(([file]) => (file as { bytes: number }).bytes)).not.toContain(bytes.length);
		const modules = (assembled.framed.files ?? []).filter(([token]) => token.endsWith("-module"));
		expect(modules).toHaveLength(1);
		expect(modules[0]?.[1].size).toBe(bytes.length + "\n//# sourceURL=qorpera-module:/big.js".length);
	});

	it("leaves a page with no module script as it was", async () => {
		const { assembled, page } = await open({
			"apps/mod/index.html": '<script src="app.js"></script><p>Hi</p>',
			"apps/mod/app.js": "1",
		});
		expect(page.querySelector("script[type=importmap]")).toBeNull();
		expect(assembled.framed.said).toBeUndefined();
		expect(page.querySelector("script")?.textContent).toBe("1");
	});
});

describe("a page opened from the company folder by itself", () => {
	const files = () =>
		fakeFolder({
			"marketing/jordro/index.html":
				'<link rel="stylesheet" href="look.css"><img src="hero.webp"><video src="film/ad.mp4"></video><img src="../secret.png">',
			"marketing/jordro/look.css": "@font-face{font-family:J;src:url(type/j.woff2)}",
			"marketing/jordro/type/j.woff2": new Uint8Array(30),
			"marketing/jordro/hero.webp": new Uint8Array(20),
			"marketing/jordro/film/ad.mp4": new Uint8Array(10),
			"marketing/secret.png": new Uint8Array(5),
			"bank/statement.pdf": new Uint8Array(5),
			"QorperaOS/vision/vision.md": "x",
		});

	it("loads the files beside it and below it, as an app's page does", async () => {
		const f = files();
		const assembled = await assembleApp(
			f,
			{ path: "marketing/jordro", entry: "index.html" },
			new AbortController().signal,
		);
		if (!assembled.ok) throw new Error(assembled.message);
		expect([...new Map(assembled.framed.files).values()].map((blob) => blob.type).sort()).toEqual([
			"font/woff2",
			"image/webp",
			"video/mp4",
		]);
		expect(assembled.page).toContain('src="../secret.png"');
		expect(f.reads.every((path) => path.startsWith("marketing/jordro/"))).toBe(true);
	});

	it("reads only the files in its own folder and below, never a platform folder, and makes no other call", async () => {
		const f = files();
		const signal = new AbortController().signal;
		const page = new PageFiles(f, "marketing/jordro", signal);
		const read = (path: string, base: string) => page.answer({ method: "file", params: { path, base } });
		const hero = await read("hero.webp", "");
		expect(hero.ok && hero.value instanceof Blob && hero.value.type).toBe("image/webp");
		expect((await read("j.woff2", "type")).ok).toBe(true);
		for (const [path, base] of [
			["../secret.png", ""] as const,
			["../../bank/statement.pdf", ""],
			["/marketing/secret.png", ""],
			["hero.webp", "../.."],
			["https://example.com/x.png", ""],
			["missing.png", ""],
		])
			expect((await read(path, base)).ok, `${base} ${path}`).toBe(false);
		for (const method of ["read", "list", "table", "agents", "todos", "query", "answer", "setRow", "tell", "open"])
			expect((await page.answer({ method, params: { path: "hero.webp" } })).ok, method).toBe(false);
		expect(f.reads.every((path) => path.startsWith("marketing/jordro/"))).toBe(true);
		for (const root of ["bank", "QorperaOS/vision"]) {
			const closed = new PageFiles(f, root, signal);
			expect((await closed.answer({ method: "file", params: { path: "statement.pdf", base: "" } })).ok).toBe(false);
			expect((await closed.answer({ method: "file", params: { path: "vision.md", base: "" } })).ok).toBe(false);
		}
		expect(f.reads.some((path) => path.startsWith("bank/") || path.startsWith("QorperaOS/"))).toBe(false);
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

	it("reads ahead each app's page with the files it names and the company's colours, but no long videos", async () => {
		const f = fakeFolder({
			"apps/sales/app.toml": 'name = "Sales"\n',
			"apps/sales/index.html":
				'<link rel="stylesheet" href="look.css"><script src="app.js"></script><img src="big.png"><video src="clip.mp4"></video><video src="film.mp4"></video>',
			"apps/sales/look.css": "body{background:url(back.webp)}",
			"apps/sales/back.webp": "w",
			"apps/sales/app.js": "1",
			"apps/sales/big.png": "x",
			"apps/sales/clip.mp4": "v",
			"apps/sales/film.mp4": new Uint8Array(2 * 1024 * 1024 + 1),
			"apps/sales/unused.png": "u",
			"apps/plan/app.toml": 'name = "Plan"\nentry = "pages/start.html"\n',
			"apps/plan/pages/start.html": "<p>",
			"apps/broken/app.toml": "name =",
			"QorperaOS/brand/brand.toml": 'accent = "#123456"\n',
		});
		const readFile = vi.spyOn(f, "readFile");
		await warmApps(f, await readApps(f, new AbortController().signal), new AbortController().signal);
		const read = readFile.mock.calls.map(([file]) => (file as { bytes: number }).bytes);
		expect(f.reads).toEqual(
			expect.arrayContaining([
				"QorperaOS/brand/brand.toml",
				"apps/sales/index.html",
				"apps/sales/look.css",
				"apps/sales/back.webp",
				"apps/sales/app.js",
				"apps/sales/big.png",
				"apps/sales/clip.mp4",
				"apps/plan/pages/start.html",
			]),
		);
		// A short clip is read ahead, a video past 2 MiB waits for the open (its entry is read, never its bytes), and a
		// file the page doesn't name is never read.
		expect(read).not.toContain(2 * 1024 * 1024 + 1);
		expect(f.reads).not.toContain("apps/sales/unused.png");
		expect(f.reads.filter((path) => path.startsWith("apps/broken/") && path !== "apps/broken/app.toml")).toEqual([]);
		// The three manifests that read, the colours, six files of Sales and Plan's entry.
		expect(read).toHaveLength(11);
		const stopped = new AbortController();
		stopped.abort();
		f.reads.length = 0;
		await warmApps(f, await readApps(f, new AbortController().signal), stopped.signal);
		expect(f.reads.filter((path) => !path.endsWith("app.toml") && path !== "apps")).toEqual([]);
	});

	it("reads ahead the files a page's styles name without parsing a single inline style", async () => {
		const files = {
			"apps/sales/app.toml": 'name = "Sales"\n',
			"apps/sales/index.html":
				'<!doctype html><html><head><STYLE media="all">body > main{background:url(a.png)}</STYLE><link rel="stylesheet" href="look.css"></head><body><main id="m" title="a > b"\n  style="background:url(\'b.png\')"><p data-note="style=red" style=color:red>hi</p><svg><style>.s{fill:url(c.png)}</style></svg></main><script>for(let i=0;i<rows.length;i++){/* don\'t skip */}</script><!-- <b style="x"> --><div class="hero" style="background:url(e.png)">x</div><p>It\'s ready</p><i/style="color:blue"></i><b title="x"style="color:red"></b><u style></u><textarea><b style="x"></textarea></body></html>',
			"apps/sales/look.css": "p{background:url(d.png)}",
			"apps/sales/a.png": "a",
			"apps/sales/b.png": "b",
			"apps/sales/c.png": "c",
			"apps/sales/d.png": "d",
			"apps/sales/e.png": "e",
		};
		const f = fakeFolder(files);
		const parsed: Document[] = [];
		const parse = DOMParser.prototype.parseFromString;
		const spy = vi.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(function (
			this: DOMParser,
			text: string,
			type: DOMParserSupportedType,
		) {
			const page = parse.call(this, text, type);
			parsed.push(page);
			return page;
		});
		try {
			await warmApps(f, await readApps(f, new AbortController().signal), new AbortController().signal);
		} finally {
			spy.mockRestore();
		}
		expect(f.reads).toEqual(
			expect.arrayContaining(["a", "b", "c", "d", "e"].map((name) => `apps/sales/${name}.png`)),
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.querySelectorAll("style, [style]")).toHaveLength(0);
		expect(parsed[0]!.querySelectorAll("[data-qorpera-style]")).toHaveLength(6);
		expect(parsed[0]!.getElementById("m")?.getAttribute("title")).toBe("a > b");
		expect(parsed[0]!.querySelector("p")?.getAttribute("data-note")).toBe("style=red");
		expect(parsed[0]!.querySelector("script")?.textContent).toBe("for(let i=0;i<rows.length;i++){/* don't skip */}");
		expect(parsed[0]!.querySelector("textarea")?.value).toBe('<b style="x">');
		expect(parsed[0]!.head.querySelectorAll("noframes")).toHaveLength(1);
		expect(parsed[0]!.body.querySelectorAll("noframes")).toHaveLength(1);

		const opened = await assembleApp(
			fakeFolder(files) as never,
			{ path: "apps/sales", entry: "index.html" },
			new AbortController().signal,
		);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const page = new DOMParser().parseFromString(opened.page, "text/html");
		expect(page.head.querySelectorAll("style")).toHaveLength(2);
		expect(page.querySelector("svg style")?.textContent).toMatch(/^\.s\{fill:url\("qorpera-file-/);
		expect(page.getElementById("m")?.getAttribute("style")).toMatch(/^background:url\("qorpera-file-/);
		expect(page.querySelector("p")?.getAttribute("style")).toBe("color:red");
	});

	it("reads ahead the most recently changed apps first, and stops at the round's bytes", async () => {
		const picture = (fill: number) => new Uint8Array(10 * 1024 * 1024).fill(fill);
		const f = fakeFolder({
			"apps/old/index.html": '<img hidden src="a.png">',
			"apps/old/a.png": picture(1),
			"apps/mid/index.html": '<img hidden src="a.png">',
			"apps/mid/a.png": picture(2),
			"apps/new/index.html": '<img hidden src="a.png">',
			"apps/new/a.png": picture(3),
		});
		const parsed = parseAppManifest('name = "App"\n');
		if (!parsed.ok) throw new Error("manifest");
		const app = (name: string, changed: number): CompanyApp => ({
			name,
			path: `apps/${name}`,
			manifest: parsed.manifest,
			problems: [],
			version: null,
			changed,
		});
		await warmApps(f, [app("old", 1), app("mid", 2), app("new", 3)], new AbortController().signal);
		// 24 MiB a round: the two latest pictures fit, the oldest app's page is read but not its picture.
		expect(f.reads).toEqual(expect.arrayContaining(["apps/new/a.png", "apps/mid/a.png", "apps/old/index.html"]));
		expect(f.reads.indexOf("apps/new/index.html")).toBeLessThan(f.reads.indexOf("apps/old/index.html"));
		const readFile = vi.spyOn(f, "readFile");
		await warmApps(f, [app("old", 1), app("mid", 2), app("new", 3)], new AbortController().signal);
		expect(readFile.mock.calls.map(([file]) => (file as { bytes: number }).bytes).sort()).toEqual(
			[24, 24, 24, 10 * 1024 * 1024, 10 * 1024 * 1024].sort(),
		);
	});

	it("reads ahead past a file that fails, finishing an app's other reads before the next app", async () => {
		const files: Record<string, string> = {};
		for (const name of ["a", "b", "c"]) {
			files[`apps/${name}/app.toml`] = 'name = "App"\n';
			files[`apps/${name}/index.html`] = [1, 2, 3, 4].map((n) => `<img src="${n}.png">`).join("");
			for (const n of [1, 2, 3, 4]) files[`apps/${name}/${n}.png`] = `${name}${n}`;
		}
		const f = fakeFolder(files);
		const apps = await readApps(f, new AbortController().signal);
		const read = f.readFile;
		let active = 0;
		let most = 0;
		let ended = 0;
		let started = 0;
		f.readFile = (async (file: { bytes: number; fileSha256: string }, signal: AbortSignal) => {
			started++;
			active++;
			most = Math.max(most, active);
			try {
				const bytes = await read(file as never, signal);
				const text = new TextDecoder().decode(bytes);
				if (text === "a1") throw new Error("the object fetch failed");
				if (/^[abc]\d$/.test(text)) await new Promise((resolve) => setTimeout(resolve, 30));
				return bytes;
			} finally {
				active--;
				ended++;
			}
		}) as typeof f.readFile;
		await warmApps(f, apps, new AbortController().signal);
		// Two apps of four files at once, at most, and nothing left under way when the round ends.
		expect(most).toBeLessThanOrEqual(8);
		expect(ended).toBe(started);
		expect(f.reads).toEqual(expect.arrayContaining(["apps/a/4.png", "apps/b/4.png", "apps/c/4.png"]));
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
		for (const href of ["app:hiring", "folder:sales/report.md", "folder:sales/missing.md"])
			expect(await open(href), href).toEqual({ ok: true, value: null });
		// A web page opens only from the bar, once the member saw its address (Jonas, 13 November 2026: "Show the address
		// first"): a bridge with no bar opens none (test/app-actions.test.ts has the bar's part).
		expect(await open("https://example.com/")).toEqual({ ok: false, error: "No web page opens from this page" });
		expect(followed).toEqual([
			{ kind: "app", name: "hiring" },
			{ kind: "file", path: "sales/report.md" },
			{ kind: "file", path: "sales/missing.md" },
		]);
		for (const bad of ["folder:QorperaOS/tables/tasks/table.toml", "other.html", "javascript:alert(1)", 7])
			expect(await open(bad), String(bad)).toEqual({
				ok: false,
				error: "A link opens an app (app:name), a company file (folder:path) or a web page (https://…)",
			});
		expect(followed).toHaveLength(3);
		expect(folder.reads).toEqual([]);
		// A bridge given no way to open one (none is today) opens none.
		expect(await open("app:hiring", false)).toMatchObject({ ok: false });
		// Each link is a call of the app's budget: 120 a minute, with its reads. Thirteen are spent: eight links of one
		// call, and the web page's, which costs what a request costs (five) wherever it is refused after that.
		let refused = 0;
		for (let index = 0; index < 115; index++) if (!(await open("app:hiring")).ok) refused++;
		expect(refused).toBe(8);
		expect(followed).toHaveLength(3 + 107);
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

describe("the company's databases on an app's page", () => {
	type Answer = CloudMemberDataAnswer;
	const asOf = "2026-11-13T10:00:00.000Z";
	const result = (etag: string, rows: unknown[][] = [[1]], columns = ["orders"]): Answer => ({
		columns,
		rows,
		more: false,
		etag,
		asOf,
	});
	const shown = (rows: Record<string, unknown>[], columns = ["orders"]) => ({ columns, rows, more: false, asOf });

	/** The member's client of the company's databases: questions answered at once, each watch call held until the test
	 * answers it or it is ended. */
	function fakeClient(answers: Record<string, Answer | Error> = {}) {
		const asked: CloudMemberDataQuestion[] = [];
		const calls: {
			watches: readonly CloudMemberDataWatch[];
			signal: AbortSignal;
			answer: (value: CloudMemberDataWatchAnswer) => void;
			fail: (error: Error) => void;
		}[] = [];
		const client: CompanyDataClient = {
			query: async (question) => {
				asked.push(question);
				const answer = answers[question.question] ?? result(`e-${question.question}`);
				if (answer instanceof Error) throw answer;
				return answer;
			},
			watch: (watches, signal) =>
				new Promise((resolve, reject) => {
					calls.push({ watches, signal, answer: resolve, fail: reject });
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		};
		return { client, asked, calls };
	}

	const manifest = (reads: string[]): CompanyApp & { manifest: NonNullable<CompanyApp["manifest"]> } => {
		const parsed = parseAppManifest('name = "Sales"\n');
		if (!parsed.ok) throw new Error("manifest");
		// APP_READS takes "data" since #1744 (the kits' binding); the cast only lets a case hand over plain strings.
		return {
			name: "sales",
			path: "apps/sales",
			manifest: { ...parsed.manifest, reads: reads as never },
			problems: [],
			version: null,
		};
	};

	function page() {
		const stop = new AbortController();
		const sent: { watch: number; value: unknown }[] = [];
		return {
			stop,
			sent,
			page: { signal: stop.signal, send: (watch: number, value: unknown) => sent.push({ watch, value }) },
		};
	}

	function setup(answers: Record<string, Answer | Error> = {}) {
		const fake = fakeClient(answers);
		const company = new AbortController();
		const data = new CompanyData(() => fake.client, company.signal);
		const bridge = (on: ReturnType<typeof page>, reads = ["data"], key = crypto.randomUUID(), withData = true) =>
			new AppBridge(
				{ folder: () => fakeFolder({}), agents: () => [], ...(withData ? { data } : {}) },
				manifest(reads),
				key,
				new AbortController().signal,
				undefined,
				undefined,
				() => on.page,
			);
		return { ...fake, company, data, bridge };
	}

	let visibility: DocumentVisibilityState = "visible";
	const show = (state: DocumentVisibilityState) => {
		visibility = state;
		document.dispatchEvent(new Event("visibilitychange"));
	};

	beforeEach(() => {
		visibility = "visible";
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const query = (name: unknown, params?: unknown) => ({ method: "query", params: { name, params } });
	const watch = (name: unknown, params?: unknown) => ({ method: "watch", params: { name, params } });

	it("refuses what a page may not ask, and costs a call of the minute", async () => {
		const { bridge, asked } = setup();
		const on = page();
		expect(await bridge(on, []).answer(query("shop/sales"))).toEqual({
			ok: false,
			error: 'Add "data" to reads in app.toml to ask the company\'s databases',
		});
		expect(await bridge(on, ["files"]).answer(watch("shop/sales"))).toMatchObject({
			ok: false,
			error: expect.stringMatching(/^Add "data"/),
		});
		expect(await bridge(on, ["data"], undefined, false).answer(query("shop/sales"))).toEqual({
			ok: false,
			error: "This company's databases can't be asked from here",
		});
		const one = bridge(on);
		for (const name of [
			"shop",
			"shop/sales/x",
			"Shop/sales",
			"1shop/sales",
			"shop/Sales",
			"shop/sales--x",
			`shop/${"a".repeat(61)}`,
			`${"a".repeat(41)}/x`,
			7,
			null,
		])
			expect(await one.answer(query(name)), String(name)).toEqual({
				ok: false,
				error: "Name a question as <database>/<question>",
			});
		expect(await one.answer(query("shop/sales", { viewer: "someone" }))).toEqual({
			ok: false,
			error: ":viewer is filled by Qorpera with the member looking",
		});
		expect(await one.answer(query("shop/sales", [1]))).toMatchObject({ ok: false });
		expect(await one.answer(query("shop/sales", { "a-b": 1 }))).toMatchObject({ ok: false });
		expect(await one.answer(query("shop/sales", { Upper: 1 }))).toMatchObject({ ok: false });
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY])
			expect(await one.answer(query("shop/sales", { since: value })), String(value)).toEqual({
				ok: false,
				error: ":since must be a JSON value",
			});
		expect(await one.answer(query("shop/sales", { since: "x".repeat(65 * 1024) }))).toEqual({
			ok: false,
			error: "A question's parameters take at most 64 KiB together",
		});
		const many = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, index]));
		expect(await one.answer(query("shop/sales", many))).toEqual({
			ok: false,
			error: "A question takes at most 64 parameters",
		});
		expect(asked).toEqual([]);
		expect((await one.answer(query("shop/sales", { ids: [1, 2], meta: { tier: "pro" } }))).ok).toBe(true);
		expect(asked.pop()).toEqual({
			database: "shop",
			question: "sales",
			params: { ids: [1, 2], meta: { tier: "pro" } },
		});
		// A question is one call of the app's 120 a minute.
		const key = crypto.randomUUID();
		let refused = 0;
		for (let index = 0; index < 122; index++)
			if (!(await bridge(on, ["data"], key).answer(query("shop/sales"))).ok) refused++;
		expect(refused).toBe(2);
		expect(asked).toHaveLength(120);
		expect(asked[0]).toEqual({ database: "shop", question: "sales", params: {} });
	});

	it("answers a question with rows as objects by column name, and passes the gateway's refusal on", async () => {
		const { bridge, asked } = setup({
			sales: result("e1", [[23, 4100.5, "a", "b", "x"]], ["orders", "total", "name", "name", "__proto__"]),
			missing: new CloudMemberDataError("No question shop/missing that you may read", 404),
		});
		const answer = await bridge(page()).answer(
			query("shop/sales", { since: "2026-11-01", top: 5, open: true, none: null }),
		);
		expect(asked[0]).toEqual({
			database: "shop",
			question: "sales",
			params: { since: "2026-11-01", top: 5, open: true, none: null },
		});
		// The later of two columns of one name stands; the names are all listed; the etag stays in the web.
		expect(answer).toEqual({
			ok: true,
			value: {
				columns: ["orders", "total", "name", "name", "__proto__"],
				rows: [expect.objectContaining({ orders: 23, total: 4100.5, name: "b" })],
				more: false,
				asOf,
			},
		});
		const row = (answer as { value: { rows: Record<string, unknown>[] } }).value.rows[0]!;
		// A column named __proto__ is a plain key of the row and changes no prototype.
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
		expect(Object.hasOwn(row, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe("x");
		expect(Object.keys(row)).toEqual(["orders", "total", "name", "__proto__"]);
		expect(await bridge(page()).answer(query("shop/missing"))).toEqual({
			ok: false,
			error: "No question shop/missing that you may read",
		});
	});

	it("takes the answers of a call that ran out of time, and watches on with the new etags", async () => {
		const { bridge, calls } = setup();
		const a = page();
		void bridge(a).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(0);
		void bridge(a).answer(watch("shop/by-status"));
		await vi.advanceTimersByTimeAsync(600);
		const call = calls.at(-1)!;
		expect(call.watches.map((one) => one.question)).toEqual(["sales", "by-status"]);
		call.answer({ changed: [{ index: 0, answer: result("e2", [[2]]) }], partial: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(a.sent).toEqual([{ watch: 1, value: shown([{ orders: 2 }]) }]);
		await vi.advanceTimersByTimeAsync(500);
		const next = calls.at(-1)!;
		expect(next).not.toBe(call);
		expect(next.watches.map((one) => one.etag)).toEqual(["e2", "e-by-status"]);
		next.answer({ same: true, partial: true });
		await vi.advanceTimersByTimeAsync(500);
		expect(calls.at(-1)).not.toBe(next);
		expect(calls.at(-1)?.watches.map((one) => one.etag)).toEqual(["e2", "e-by-status"]);
	});

	it("watches a question: its first answer, then each new one, in one held call", async () => {
		const { bridge, calls, asked } = setup();
		const a = page();
		const first = bridge(a).answer(watch("shop/sales", { since: "2026-11-01" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(await first).toEqual({ ok: true, value: { watch: 1, answer: shown([{ orders: 1 }]) } });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.watches).toEqual([
			{ database: "shop", question: "sales", params: { since: "2026-11-01" }, etag: "e-sales" },
		]);
		calls[0]?.answer({ changed: [{ index: 0, answer: result("e2", [[2]]) }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(a.sent).toEqual([{ watch: 1, value: shown([{ orders: 2 }]) }]);
		// The next call holds the new etag; one that says the same is followed by another.
		await vi.advanceTimersByTimeAsync(500);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.watches[0]?.etag).toBe("e2");
		calls[1]?.answer({ same: true });
		await vi.advanceTimersByTimeAsync(500);
		expect(calls).toHaveLength(3);
		expect(calls[2]?.watches[0]?.etag).toBe("e2");
		expect(a.sent).toHaveLength(1);
		expect(asked).toHaveLength(1);
	});

	it("shares a question two pages watch, and starts a new call when the set changes", async () => {
		const { bridge, calls, asked, data } = setup();
		const a = page();
		const b = page();
		const first = bridge(a).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(0);
		const one = ((await first) as { value: { watch: number } }).value.watch;
		expect(calls).toHaveLength(1);
		// The same question with the same parameters: no question asked, the call stands, and the answer is the one held.
		const second = await bridge(b).answer(watch("shop/sales", {}));
		expect(second).toEqual({ ok: true, value: { watch: 2, answer: shown([{ orders: 1 }]) } });
		await vi.advanceTimersByTimeAsync(600);
		expect(asked).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(data.questions).toBe(1);
		// Another question: the call in flight ends and the next holds both.
		const third = bridge(b).answer(watch("shop/by-status"));
		await vi.advanceTimersByTimeAsync(0);
		expect(await third).toMatchObject({ ok: true, value: { watch: 3 } });
		expect(calls[0]?.signal.aborted).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.watches.map((one) => one.question)).toEqual(["sales", "by-status"]);
		// A new answer of the shared question reaches both pages.
		calls[1]?.answer({ changed: [{ index: 0, answer: result("e5", [[5]]) }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(a.sent).toEqual([{ watch: one, value: shown([{ orders: 5 }]) }]);
		expect(b.sent).toEqual([{ watch: 2, value: shown([{ orders: 5 }]) }]);
		await vi.advanceTimersByTimeAsync(500);
		expect(calls).toHaveLength(3);
		// A page stops its own watch only, and that costs nothing: the shared question stays, so the call stands.
		expect(await bridge(a).answer({ method: "unwatch", params: { watch: 2 } })).toEqual({
			ok: false,
			error: "No such watch",
		});
		expect(await bridge(a).answer({ method: "unwatch", params: { watch: one } })).toEqual({ ok: true, value: null });
		expect(await bridge(a).answer({ method: "unwatch", params: { watch: one } })).toEqual({
			ok: false,
			error: "No such watch",
		});
		await vi.advanceTimersByTimeAsync(600);
		expect(calls).toHaveLength(3);
		expect(data.questions).toBe(2);
		// The last watcher of a question gone: a new call without it.
		expect(await bridge(b).answer({ method: "unwatch", params: { watch: 3 } })).toEqual({ ok: true, value: null });
		await vi.advanceTimersByTimeAsync(500);
		expect(calls[2]?.signal.aborted).toBe(true);
		expect(calls[3]?.watches.map((one) => one.question)).toEqual(["sales"]);
	});

	it("holds at most 8 watches a page and 24 questions a company, and a question that fails is no watch", async () => {
		const { bridge, calls, data } = setup({
			missing: new CloudMemberDataError("No question shop/missing that you may read", 404),
		});
		const pages = [page(), page(), page(), page()];
		const start = async (on: ReturnType<typeof page>, name: string) => {
			const answer = bridge(on).answer(watch(name));
			await vi.advanceTimersByTimeAsync(0);
			return answer;
		};
		for (let index = 0; index < 8; index++)
			expect(await start(pages[0]!, `shop/q${index}`)).toMatchObject({ ok: true });
		expect(await start(pages[0]!, "shop/q8")).toEqual({
			ok: false,
			error: "A page watches at most 8 questions at once",
		});
		for (let index = 8; index < 24; index++)
			expect(await start(pages[1 + Math.floor((index - 8) / 8)]!, `shop/q${index}`)).toMatchObject({ ok: true });
		expect(data.questions).toBe(24);
		expect(await start(pages[3]!, "shop/q24")).toEqual({
			ok: false,
			error: "The company's open apps watch at most 24 questions together",
		});
		// One already watched still may be.
		expect(await start(pages[3]!, "shop/q3")).toMatchObject({ ok: true });
		await vi.advanceTimersByTimeAsync(600);
		expect(calls.at(-1)?.watches).toHaveLength(24);
		const other = setup({ missing: new CloudMemberDataError("No question shop/missing that you may read", 404) });
		const lone = page();
		const failed = other.bridge(lone).answer(watch("shop/missing"));
		await vi.advanceTimersByTimeAsync(0);
		expect(await failed).toEqual({ ok: false, error: "No question shop/missing that you may read" });
		expect(other.data.questions).toBe(0);
		await vi.advanceTimersByTimeAsync(600);
		expect(other.calls).toHaveLength(0);
	});

	it("answers a watch that can't start with the refusal's own words, for the page's `failed`", async () => {
		const { bridge } = setup({
			missing: new CloudMemberDataError("No question shop/missing that you may read", 404),
		});
		const on = page();
		const start = async (name: string, reads = ["data"], withData = true) => {
			const answer = bridge(on, reads, undefined, withData).answer(watch(name));
			await vi.advanceTimersByTimeAsync(0);
			return answer;
		};
		expect(await start("shop/sales", [])).toEqual({
			ok: false,
			error: 'Add "data" to reads in app.toml to ask the company\'s databases',
		});
		expect(await start("shop")).toEqual({ ok: false, error: "Name a question as <database>/<question>" });
		expect(await start("shop/missing")).toEqual({ ok: false, error: "No question shop/missing that you may read" });
		expect(await start("shop/sales", ["data"], false)).toEqual({
			ok: false,
			error: "This company's databases can't be asked from here",
		});
		for (let index = 0; index < 8; index++) expect(await start(`shop/q${index}`)).toMatchObject({ ok: true });
		expect(await start("shop/q8")).toEqual({ ok: false, error: "A page watches at most 8 questions at once" });
	});

	it("hands a page no answer larger than it may get, counted as the page gets it, and keeps no watch for one", async () => {
		// Under 1 MiB from the gateway, over it once each row repeats its long column name.
		const wide = "c".repeat(200);
		const big = result(
			"big",
			Array.from({ length: 6000 }, () => [1]),
			[wide],
		);
		expect(JSON.stringify(big).length).toBeLessThan(1024 * 1024);
		const words =
			"The answer is larger than a page may be handed (1 MiB as rows of named columns): ask for fewer rows or columns";
		const answers: Record<string, Answer> = {};
		for (let index = 0; index < 9; index++) answers[`big${index}`] = big;
		const { bridge, calls, data } = setup(answers);
		const on = page();
		expect(await bridge(on).answer(query("shop/big0"))).toEqual({ ok: false, error: words });
		// Nine first answers too large, one after another: none keeps a place, so the page's 8 are all still free.
		for (let index = 0; index < 9; index++) {
			const refused = bridge(on).answer(watch(`shop/big${index}`));
			await vi.advanceTimersByTimeAsync(0);
			expect(await refused, `watch ${index}`).toEqual({ ok: false, error: words });
		}
		expect(data.questions).toBe(0);
		for (let index = 0; index < 8; index++) {
			const started = bridge(on).answer(watch(`shop/q${index}`));
			await vi.advanceTimersByTimeAsync(0);
			expect(await started).toMatchObject({ ok: true });
		}
		// A later answer too large is not sent: the watch ends and gives its place back, and the page keeps what it has.
		const other = page();
		const started = bridge(other).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(600);
		const id = ((await started) as { value: { watch: number } }).value.watch;
		expect(data.questions).toBe(9);
		const call = calls.at(-1)!;
		const index = call.watches.findIndex((one) => one.question === "sales");
		call.answer({ changed: [{ index, answer: big }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(other.sent).toEqual([]);
		expect(data.questions).toBe(8);
		expect(await bridge(other).answer({ method: "unwatch", params: { watch: id } })).toEqual({
			ok: false,
			error: "No such watch",
		});
		await vi.advanceTimersByTimeAsync(600);
		expect(calls.at(-1)?.watches.map((one) => one.question)).not.toContain("sales");
	});

	it("counts an answer's size in UTF-8 bytes, so a name in another script is counted in full", async () => {
		// Under 1 MiB in characters as the page gets it, over it in bytes: each 界 is three.
		const wide = "界".repeat(200);
		const big = result(
			"wide",
			Array.from({ length: 3000 }, () => [1]),
			[wide],
		);
		const text = JSON.stringify(
			shown(
				Array.from({ length: 3000 }, () => ({ [wide]: 1 })),
				[wide],
			),
		);
		expect(text.length).toBeLessThan(1024 * 1024 - 1024);
		expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(1024 * 1024);
		const words =
			"The answer is larger than a page may be handed (1 MiB as rows of named columns): ask for fewer rows or columns";
		const { bridge, calls, data } = setup({ wide: big });
		const on = page();
		expect(await bridge(on).answer(query("shop/wide"))).toEqual({ ok: false, error: words });
		const first = bridge(on).answer(watch("shop/wide"));
		await vi.advanceTimersByTimeAsync(0);
		expect(await first).toEqual({ ok: false, error: words });
		expect(data.questions).toBe(0);
		// A later answer: not sent, and the watch ends.
		const started = bridge(on).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(600);
		expect(await started).toMatchObject({ ok: true });
		calls.at(-1)?.answer({ changed: [{ index: 0, answer: big }] });
		await vi.advanceTimersByTimeAsync(0);
		expect(on.sent).toEqual([]);
		expect(data.questions).toBe(0);
	});

	it("keeps every parameter as given, `__proto__` and `constructor` too, and one question for any order", async () => {
		const { bridge, asked, calls, data } = setup();
		const given = JSON.parse('{"__proto__":"x","constructor":"y","since":"2026-11-01"}') as Record<string, unknown>;
		expect(Object.hasOwn(given, "__proto__")).toBe(true);
		expect(await bridge(page()).answer(query("shop/sales", given))).toMatchObject({ ok: true });
		const sentParams = asked[0]!.params;
		expect(Object.getPrototypeOf(sentParams)).toBe(Object.prototype);
		expect(Object.keys(sentParams)).toEqual(["__proto__", "constructor", "since"]);
		expect(JSON.stringify(sentParams)).toBe('{"__proto__":"x","constructor":"y","since":"2026-11-01"}');
		// Through a watch, into the held call's body, the same.
		const a = page();
		const first = bridge(a).answer(watch("shop/sales", given));
		await vi.advanceTimersByTimeAsync(0);
		expect(await first).toMatchObject({ ok: true });
		expect(JSON.stringify(calls.at(-1)?.watches[0]?.params)).toBe(
			'{"__proto__":"x","constructor":"y","since":"2026-11-01"}',
		);
		// A watch with no parameters is another question, not this one.
		const plain = bridge(a).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(0);
		expect(await plain).toMatchObject({ ok: true });
		expect(data.questions).toBe(2);
		// The same parameters in another order are one question.
		const b = page();
		const ab = bridge(b).answer(watch("shop/by-status", { a: 1, b: 2 }));
		await vi.advanceTimersByTimeAsync(0);
		expect(await ab).toMatchObject({ ok: true });
		const before = asked.length;
		expect(await bridge(b).answer(watch("shop/by-status", { b: 2, a: 1 }))).toMatchObject({ ok: true });
		expect(asked).toHaveLength(before);
		expect(data.questions).toBe(3);
	});

	it("waits 2 s, 5 s, then 10 s after a call that failed, and tells no page", async () => {
		const { bridge, calls } = setup();
		const a = page();
		void bridge(a).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		for (const [index, wait] of [2000, 5000, 10_000, 10_000].entries()) {
			calls[index]?.fail(new Error("The company's databases did not answer (503)"));
			await vi.advanceTimersByTimeAsync(wait - 1);
			expect(calls, `after failure ${index + 1}`).toHaveLength(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toHaveLength(index + 2);
		}
		expect(a.sent).toEqual([]);
		// One that answers starts the count again.
		calls[4]?.answer({ same: true });
		await vi.advanceTimersByTimeAsync(500);
		calls[5]?.fail(new Error("down"));
		await vi.advanceTimersByTimeAsync(2000);
		expect(calls).toHaveLength(7);
	});

	it("ends a watch with 8 calls in flight, and gives its place back", async () => {
		const { bridge, client, data } = setup();
		// A question that never answers holds its call in flight.
		const query = client.query;
		client.query = (asked, signal) =>
			asked.question === "hang" ? new Promise<never>(() => {}) : query(asked, signal);
		const a = page();
		const key = crypto.randomUUID();
		const ids: number[] = [];
		for (let index = 0; index < 8; index++) {
			const started = bridge(a, ["data"], key).answer(watch(`shop/q${index}`));
			await vi.advanceTimersByTimeAsync(0);
			ids.push(((await started) as { value: { watch: number } }).value.watch);
		}
		expect(await bridge(a).answer(watch("shop/q8"))).toEqual({
			ok: false,
			error: "A page watches at most 8 questions at once",
		});
		for (let index = 0; index < 8; index++) void bridge(a, ["data"], key).answer(query8());
		await vi.advanceTimersByTimeAsync(0);
		expect(await bridge(a, ["data"], key).answer(query8())).toEqual({
			ok: false,
			error: "Too many calls: wait a moment and try again",
		});
		// Ending a watch is never refused for the budget or the calls in flight, and its place is free again.
		expect(await bridge(a, ["data"], key).answer({ method: "unwatch", params: { watch: ids[0] } })).toEqual({
			ok: true,
			value: null,
		});
		expect(data.questions).toBe(7);
		const ninth = bridge(a).answer(watch("shop/q8"));
		await vi.advanceTimersByTimeAsync(0);
		expect(await ninth).toMatchObject({ ok: true });
	});
	const query8 = () => ({ method: "query", params: { name: "shop/hang", params: {} } });

	it("stops while the tab is hidden, when the company is put away, and when the page goes", async () => {
		const { bridge, calls, company, data } = setup();
		const a = page();
		void bridge(a).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(1);
		show("hidden");
		expect(calls[0]?.signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(1);
		show("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.watches[0]?.etag).toBe("e-sales");
		// The page goes (its app closed or reloaded): its watches with it.
		a.stop.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls[1]?.signal.aborted).toBe(true);
		expect(data.questions).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(2);
		expect(await bridge(a).answer(watch("shop/sales"))).toEqual({
			ok: false,
			error: "This page can't watch the company's databases",
		});
		// The company put away.
		const b = page();
		void bridge(b).answer(watch("shop/sales"));
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(3);
		company.abort();
		expect(calls[2]?.signal.aborted).toBe(true);
		show("hidden");
		show("visible");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toHaveLength(3);
		expect(data.questions).toBe(0);
	});
});

describe("the company's own numbers on an app's page", () => {
	type Answer = CloudMemberDataAnswer;
	const asOf = "2026-11-14T10:00:00.000Z";
	const result = (etag: string, rows: unknown[][] = [["current", 1200.5]]): Answer => ({
		columns: ["state", "balance"],
		rows,
		more: false,
		etag,
		asOf,
	});
	const shown = (rows: Record<string, unknown>[]) => ({ columns: ["state", "balance"], rows, more: false, asOf });

	const manifest = (reads: string[]): CompanyApp & { manifest: NonNullable<CompanyApp["manifest"]> } => {
		const parsed = parseAppManifest('name = "Money"\n');
		if (!parsed.ok) throw new Error("manifest");
		return {
			name: "money",
			path: "apps/money",
			manifest: { ...parsed.manifest, reads: reads as never },
			problems: [],
			version: null,
		};
	};

	function page() {
		const stop = new AbortController();
		const sent: { watch: number; value: unknown }[] = [];
		return {
			stop,
			sent,
			page: { signal: stop.signal, send: (watch: number, value: unknown) => sent.push({ watch, value }) },
		};
	}

	/** The cloud's answers by question, which a case may change; every ask is kept. */
	function setup(answers: Record<string, Answer | Error> = {}) {
		const asked: CloudMemberDataQuestion[] = [];
		const company = new AbortController();
		const numbers = new CompanyNumbers(async (question) => {
			asked.push(question);
			const answer = answers[question.question] ?? result(`e-${question.question}`);
			if (answer instanceof Error) throw answer;
			return answer;
		}, company.signal);
		// The company's databases beside them: each question answered at once, a held call never answered.
		const held: AbortSignal[] = [];
		const client: CompanyDataClient = {
			query: async (question) => result(`d-${question.question}`, [[1, 2]]),
			watch: (_watches, signal) =>
				new Promise((_resolve, reject) => {
					held.push(signal);
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		};
		const data = new CompanyData(() => client, company.signal);
		const bridge = (on: ReturnType<typeof page>, reads: string[], withNumbers = true) =>
			new AppBridge(
				{ folder: () => fakeFolder({}), agents: () => [], data, ...(withNumbers ? { numbers } : {}) },
				manifest(reads),
				crypto.randomUUID(),
				new AbortController().signal,
				undefined,
				undefined,
				() => on.page,
			);
		return { asked, answers, company, numbers, data, bridge };
	}

	let visibility: DocumentVisibilityState = "visible";
	const show = (state: DocumentVisibilityState) => {
		visibility = state;
		document.dispatchEvent(new Event("visibilitychange"));
	};
	beforeEach(() => {
		visibility = "visible";
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const query = (name: unknown, params?: unknown) => ({ method: "query", params: { name, params } });
	const watch = (name: unknown, params?: unknown) => ({ method: "watch", params: { name, params } });

	it("asks a question of qorpera only with its own read, never with data's, and only one that is there", async () => {
		const { bridge, asked } = setup({
			"site-now": new CloudMemberDataError("qorpera/site-now is not counted yet: the sites' numbers come later"),
		});
		const on = page();
		expect(await bridge(on, ["data"]).answer(query("qorpera/money-now"))).toEqual({
			ok: false,
			error: 'Add "money" to reads in app.toml to ask qorpera/money-now',
		});
		expect(await bridge(on, ["money"]).answer(watch("qorpera/site-now"))).toEqual({
			ok: false,
			error: 'Add "site" to reads in app.toml to ask qorpera/site-now',
		});
		expect(await bridge(on, ["money", "site"]).answer(query("qorpera/orders-now"))).toEqual({
			ok: false,
			error: "No question qorpera/orders-now that you may read",
		});
		// The numbers read no company database, and a name of another shape is told what is wrong with it.
		expect(await bridge(on, ["money"]).answer(query("shop/sales"))).toEqual({
			ok: false,
			error: 'Add "data" to reads in app.toml to ask the company\'s databases',
		});
		expect(await bridge(on, ["money"]).answer(query("qorpera/Money-now"))).toEqual({
			ok: false,
			error: "Name a question as <database>/<question>",
		});
		expect(await bridge(on, ["money"], false).answer(query("qorpera/money-now"))).toEqual({
			ok: false,
			error: "The company's numbers can't be asked from here",
		});
		expect(asked).toEqual([]);
		expect(
			await bridge(on, ["money"]).answer(query("qorpera/money-balance", { from: "2026-11-01", to: null })),
		).toEqual({ ok: true, value: shown([{ state: "current", balance: 1200.5 }]) });
		expect(asked).toEqual([
			{ database: "qorpera", question: "money-balance", params: { from: "2026-11-01", to: null } },
		]);
		expect(await bridge(on, ["site"]).answer(query("qorpera/sites"))).toMatchObject({ ok: true });
		// The cloud's refusal reaches the page in its own words.
		expect(await bridge(on, ["site"]).answer(watch("qorpera/site-now"))).toEqual({
			ok: false,
			error: "qorpera/site-now is not counted yet: the sites' numbers come later",
		});
	});

	it("watches money by asking again every 5 minutes, and tells the page only of a new answer", async () => {
		const { bridge, asked, answers } = setup();
		const a = page();
		expect(await bridge(a, ["money"]).answer(watch("qorpera/money-now"))).toEqual({
			ok: true,
			value: { watch: -1, answer: shown([{ state: "current", balance: 1200.5 }]) },
		});
		expect(asked).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(299_999);
		expect(asked).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(asked).toHaveLength(2);
		// The same etag: nothing for the page.
		expect(a.sent).toEqual([]);
		answers["money-now"] = result("e2", [["current", 990]]);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(asked).toHaveLength(3);
		expect(a.sent).toEqual([{ watch: -1, value: shown([{ state: "current", balance: 990 }]) }]);
		// A failed ask tells the page nothing and is asked again on its clock.
		answers["money-now"] = new CloudMemberDataError("Company numbers are unavailable");
		await vi.advanceTimersByTimeAsync(300_000);
		expect(asked).toHaveLength(4);
		answers["money-now"] = result("e2", [["current", 990]]);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(asked).toHaveLength(5);
		expect(a.sent).toHaveLength(1);
	});

	it("asks who is on a site now every 15 s, and a site's other numbers every minute", async () => {
		expect(numbersPollMs("site-now")).toBe(15_000);
		expect(numbersPollMs("site-days")).toBe(60_000);
		expect(numbersPollMs("sites")).toBe(60_000);
		expect(numbersPollMs("money-kinds")).toBe(300_000);
		const { bridge, asked } = setup();
		const a = page();
		await bridge(a, ["site"]).answer(watch("qorpera/site-now"));
		await bridge(a, ["site"]).answer(watch("qorpera/site-days", { site: "shop" }));
		const count = (question: string) => asked.filter((one) => one.question === question).length;
		await vi.advanceTimersByTimeAsync(15_000);
		expect([count("site-now"), count("site-days")]).toEqual([2, 1]);
		await vi.advanceTimersByTimeAsync(45_000);
		expect([count("site-now"), count("site-days")]).toEqual([5, 2]);
	});

	it("shares a question two pages watch, with ids of their own beside the databases' watches", async () => {
		const { bridge, asked, numbers, data } = setup();
		const a = page();
		const b = page();
		expect(await bridge(a, ["data", "money"]).answer(watch("shop/sales"))).toMatchObject({
			ok: true,
			value: { watch: 1 },
		});
		expect(await bridge(a, ["data", "money"]).answer(watch("qorpera/money-now"))).toMatchObject({
			ok: true,
			value: { watch: -1 },
		});
		expect(await bridge(b, ["money"]).answer(watch("qorpera/money-now", {}))).toMatchObject({
			ok: true,
			value: { watch: -2 },
		});
		expect(asked).toHaveLength(1);
		expect([numbers.questions, data.questions]).toEqual([1, 1]);
		// Each ends as its own source's watch.
		expect(await bridge(a, ["data", "money"]).answer({ method: "unwatch", params: { watch: -1 } })).toEqual({
			ok: true,
			value: null,
		});
		expect([numbers.questions, data.questions]).toEqual([1, 1]);
		expect(await bridge(b, ["money"]).answer({ method: "unwatch", params: { watch: -2 } })).toMatchObject({
			ok: true,
		});
		expect(await bridge(a, ["data", "money"]).answer({ method: "unwatch", params: { watch: 1 } })).toMatchObject({
			ok: true,
		});
		expect([numbers.questions, data.questions]).toEqual([0, 0]);
		expect(await bridge(a, ["money"]).answer({ method: "unwatch", params: { watch: -1 } })).toEqual({
			ok: false,
			error: "No such watch",
		});
		await vi.advanceTimersByTimeAsync(600_000);
		expect(asked).toHaveLength(1);
	});

	it("ends only the page's watches it may no longer ask, and keeps the others", async () => {
		const { bridge, numbers, data } = setup();
		const a = page();
		await bridge(a, ["data", "money", "site"]).answer(watch("shop/sales"));
		await bridge(a, ["data", "money", "site"]).answer(watch("qorpera/money-now"));
		await bridge(a, ["data", "money", "site"]).answer(watch("qorpera/site-now"));
		numbers.release(a.page.signal, (asked) => asked.question.startsWith("site"));
		expect([numbers.questions, data.questions]).toEqual([1, 1]);
		data.release(a.page.signal);
		expect([numbers.questions, data.questions]).toEqual([1, 0]);
		numbers.release(a.page.signal);
		expect(numbers.questions).toBe(0);
	});

	it("asks nothing in a hidden tab, at once when shown past its time, and stops with the page and company", async () => {
		const { bridge, asked, numbers, company } = setup();
		const a = page();
		await bridge(a, ["money"]).answer(watch("qorpera/money-now"));
		show("hidden");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(asked).toHaveLength(1);
		show("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(asked).toHaveLength(2);
		// Shown again before its time: asked when its time comes, not before.
		show("hidden");
		await vi.advanceTimersByTimeAsync(100_000);
		show("visible");
		await vi.advanceTimersByTimeAsync(199_999);
		expect(asked).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(asked).toHaveLength(3);
		// The page goes: its watches with it.
		a.stop.abort();
		expect(numbers.questions).toBe(0);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(asked).toHaveLength(3);
		// The company put away.
		const b = page();
		await bridge(b, ["money"]).answer(watch("qorpera/money-now"));
		expect(asked).toHaveLength(4);
		company.abort();
		show("hidden");
		show("visible");
		await vi.advanceTimersByTimeAsync(600_000);
		expect(asked).toHaveLength(4);
		expect(numbers.questions).toBe(0);
	});

	it("asks the cloud as the member, parses its answer strictly, and keeps its refusal's words", async () => {
		const rpc = vi.fn();
		const cloud = { rpc } as never as Parameters<typeof askCompanyNumbers>[0];
		const environment = "00000000-0000-4000-8000-000000000020";
		const asked = { database: "qorpera", question: "money-now", params: { from: "2026-11-01" } };
		rpc.mockResolvedValueOnce({ columns: ["state"], rows: [["none"]], more: false, asOf, etag: "0123456789abcdef" });
		expect(await askCompanyNumbers(cloud, environment, asked)).toEqual({
			columns: ["state"],
			rows: [["none"]],
			more: false,
			asOf,
			etag: "0123456789abcdef",
		});
		expect(rpc).toHaveBeenCalledWith("qorpera_member_company_numbers", {
			p_environment_id: environment,
			p_question: "money-now",
			p_params: { from: "2026-11-01" },
		});
		rpc.mockResolvedValueOnce({ columns: ["state"], rows: [["none"]], more: false, asOf, etag: "e", schema: "x" });
		await expect(askCompanyNumbers(cloud, environment, asked)).rejects.toThrow(
			"The company's databases gave an answer this page does not know",
		);
		rpc.mockRejectedValueOnce(
			new CloudRpcError(
				"qorpera_member_company_numbers",
				{ message: "No question qorpera/money-now that you may read", code: "P0002" },
				404,
			),
		);
		const refused = await askCompanyNumbers(cloud, environment, asked).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CloudMemberDataError);
		expect(refused).toMatchObject({ message: "No question qorpera/money-now that you may read", status: 404 });
		rpc.mockRejectedValueOnce(
			new CloudRpcError("qorpera_member_company_numbers", { message: "Could not find", code: "PGRST202" }, 404),
		);
		await expect(askCompanyNumbers(cloud, environment, asked)).rejects.toThrow(
			"The company's numbers can't be asked on this cloud yet",
		);
	});
});

describe("an app's card in a message", () => {
	it("keeps a sentence whole around an app's link, with the card under it", () => {
		const prose = markdown("See this [first sketch](app:first-sketch): the desk is by the window.");
		const paragraph = prose.querySelector("p");
		expect(paragraph?.textContent).toBe("See this first sketch: the desk is by the window.");
		expect(paragraph?.querySelector(".app-card")).toBeNull();
		expect(paragraph?.querySelector<HTMLElement>("[data-app-name]")?.dataset.appName).toBe("first-sketch");
		// The card stands in a row of its own, right under the sentence.
		expect(prose.querySelector("p + .app-cards > .app-card")?.getAttribute("data-app-name")).toBe("first-sketch");
		// Alone on its line, it is the card and nothing else: no paragraph is left around it.
		const alone = markdown("[First sketch](app:first-sketch)");
		expect(alone.querySelectorAll("[data-app-name]")).toHaveLength(1);
		expect(alone.querySelector(":scope > .app-cards > .app-card")).not.toBeNull();
		expect(alone.querySelector("p")).toBeNull();
	});

	it("gives an app one card however often a sentence names it, and each app its own", () => {
		const prose = markdown("[Sales](app:sales) is new. Open [it](app:sales), then [Hiring](app:hiring).");
		expect(prose.querySelectorAll("p [data-app-name]")).toHaveLength(3);
		const cards = [...prose.querySelectorAll<HTMLElement>(".app-cards > .app-card")];
		expect(cards.map((card) => card.dataset.appName)).toEqual(["sales", "hiring"]);
		// The card takes its name from the first place the sentence names the app.
		expect(cards[0]?.querySelector(".app-card-title")?.textContent).toBe("Sales");
	});

	it("stands under the words' bubble in a thread, as a part of its own", () => {
		const parts = markdownBubbles("[Sales](app:sales) has new numbers.\n\nMore tomorrow.");
		expect(parts.map((part) => part.className)).toEqual(["message-prose", "app-cards", "message-prose"]);
		expect(parts[0]?.textContent).toBe("Sales has new numbers.");
		expect(parts[0]?.querySelector(".app-card")).toBeNull();
		expect(parts[1]?.querySelector<HTMLElement>(".app-card")?.dataset.appName).toBe("sales");
		expect(parts[2]?.textContent).toBe("More tomorrow.");
		// A message that is only the app is only the row.
		expect(markdownBubbles("[Sales](app:sales)").map((part) => part.className)).toEqual(["app-cards"]);
		// A card in a list stays where the list has it, in the words.
		const [list, ...rest] = markdownBubbles("- [Sales](app:sales)\n- [Hiring](app:hiring)");
		expect(rest).toEqual([]);
		expect(list?.className).toBe("message-prose");
		expect(list?.querySelectorAll("li > .app-card")).toHaveLength(2);
		expect(list?.querySelector(".app-cards")).toBeNull();
	});

	it("draws app: links as a card that names the app", () => {
		const body = markdown("See [Sales this week](app:sales-board) and [x](app:Bad).");
		const card = body.querySelector<HTMLButtonElement>("button.app-card");
		expect(card?.dataset.appName).toBe("sales-board");
		expect(card?.querySelector(".app-card-title")?.textContent).toBe("Sales this week");
		expect(body.querySelectorAll(".app-card")).toHaveLength(1);
		expect(body.querySelector("a")).toBeNull();
	});

	it("says the card and the link open the app's own page", () => {
		const prose = markdown("See [Sales this week](app:sales-board) for the numbers.");
		const [link, card] = prose.querySelectorAll<HTMLButtonElement>("[data-app-name]");
		expect(link?.title).toBe("Open sales-board");
		expect(card?.title).toBe("Open sales-board");
		// Drawn plain, before the company's apps are read: what it is, and that it leads somewhere.
		expect(card?.querySelector(".app-card-note")?.textContent).toBe("App");
		expect(card?.querySelector(".app-card-go svg")).not.toBeNull();
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

	it("tells its readers after every read, unchanged apps too, so icons read beside them follow (review F5 on #1696)", async () => {
		const f = following();
		const read = vi.fn();
		f.apps.onRead(read);
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toHaveBeenCalledTimes(1);
		// The minute's clock, with no hint and nothing changed in the apps: the readers still hear of it.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(read).toHaveBeenCalledTimes(2);
		f.hint();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(read).toHaveBeenCalledTimes(3);
		f.apps.dispose();
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

describe("AppBridge database actions (qorpera.act)", () => {
	const sha = "a".repeat(64);
	const makeApp = (
		writes: readonly string[],
	): CompanyApp & { readonly manifest: NonNullable<CompanyApp["manifest"]> } => {
		const parsed = parseAppManifest(
			`name = "Shop"\nreads = ["data"]\nwrites = [${writes.map((w) => JSON.stringify(w)).join(", ")}]\n`,
		);
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
		return { name: "shop", path: "apps/shop", manifest: parsed.manifest, problems: [], version: "1" };
	};

	it("previews, gates on member approval with the previewed sha256, and shapes returned rows", async () => {
		const previewCalls: unknown[] = [];
		const changeCalls: unknown[] = [];
		const company = new AbortController();
		const client: CompanyDataClient = {
			query: async () => {
				throw new Error("not used");
			},
			watch: async () => ({ same: true }),
			previewChange: async (asked) => {
				previewCalls.push(asked);
				return {
					words: ["Add item ", { name: "sku", value: "SKU-1" }],
					values: [{ name: "sku", value: "SKU-1" }],
					sha256: sha,
				};
			},
			change: async (asked) => {
				changeCalls.push(asked);
				return {
					changed: 1,
					columns: ["id", "sku"],
					rows: [[42, "SKU-1"]],
					more: false,
					asOf: "2026-11-21T12:00:00.000Z",
				};
			},
		};
		const data = new CompanyData(() => client, company.signal);
		let seenAsk: unknown = null;
		const bridge = new AppBridge(
			{ folder: () => fakeFolder({}), agents: () => [], data },
			makeApp(["data:shop/add-item"]),
			crypto.randomUUID(),
			company.signal,
			{
				closed: () => null,
				ask: async () => ({ outcome: "declined" }),
				askData: async (ask, perform) => {
					seenAsk = ask;
					const result = await perform();
					return { outcome: "saved", result };
				},
			},
		);

		const ok = await bridge.answer({
			method: "act",
			params: { name: "shop/add-item", params: { sku: "SKU-1", tags: ["new"], meta: { priority: 1 } } },
		});
		expect(ok).toEqual({
			ok: true,
			value: {
				changed: 1,
				columns: ["id", "sku"],
				rows: [{ id: 42, sku: "SKU-1" }],
				more: false,
				asOf: "2026-11-21T12:00:00.000Z",
			},
		});
		expect(previewCalls).toEqual([
			{ database: "shop", change: "add-item", params: { sku: "SKU-1", tags: ["new"], meta: { priority: 1 } } },
		]);
		expect(changeCalls).toEqual([
			{
				database: "shop",
				change: "add-item",
				params: { sku: "SKU-1", tags: ["new"], meta: { priority: 1 } },
				sha256: sha,
			},
		]);
		expect(seenAsk).toEqual({
			kind: "data",
			database: "shop",
			change: "add-item",
			words: ["Add item ", { name: "sku", value: "SKU-1" }],
			values: [{ name: "sku", value: "SKU-1" }],
			sha256: sha,
		});
		company.abort();
	});

	it("enforces writes allowlist, rejects :viewer and reserved qorpera db, and handles gate decline", async () => {
		const company = new AbortController();
		const client: CompanyDataClient = {
			query: async () => {
				throw new Error("not used");
			},
			watch: async () => ({ same: true }),
			previewChange: async () => ({ words: ["Delete"], values: [], sha256: sha }),
			change: async () => {
				throw new Error("must not run on decline");
			},
		};
		const data = new CompanyData(() => client, company.signal);
		const bridge = new AppBridge(
			{ folder: () => fakeFolder({}), agents: () => [], data },
			makeApp(["data:shop/add-item"]),
			crypto.randomUUID(),
			company.signal,
			{
				closed: () => null,
				ask: async () => ({ outcome: "declined" }),
				askData: async () => ({ outcome: "declined" }),
			},
		);

		expect(await bridge.answer({ method: "act", params: { name: "shop/other-change", params: {} } })).toEqual({
			ok: false,
			error: 'Add "data:shop/other-change" to writes in app.toml to run shop/other-change',
		});
		expect(await bridge.answer({ method: "act", params: { name: "qorpera/money-now", params: {} } })).toEqual({
			ok: false,
			error: "Name a change as <database>/<change>",
		});
		expect(
			await bridge.answer({ method: "act", params: { name: "shop/add-item", params: { viewer: "x" } } }),
		).toEqual({
			ok: false,
			error: ":viewer is filled by Qorpera with the member acting",
		});
		expect(
			await bridge.answer({ method: "act", params: { name: "shop/add-item", params: { sku: "SKU-2" } } }),
		).toEqual({
			ok: false,
			error: "The member said not now",
		});
		company.abort();
	});

	it("prevents inFlight leaks across minute rollovers, blocks DAG/circular/BigInt DoS, serializes concurrent acts, and truncates oversized post-commit rows", async () => {
		const company = new AbortController();
		const sha = "c".repeat(64);
		let previewCount = 0;
		let releasePreview: (() => void) | undefined;
		let changeMode: "huge" | "drop" = "huge";
		const client: CompanyDataClient = {
			query: async () => ({ columns: [], rows: [], more: false, etag: "e", asOf: "2026-11-21T12:00:00.000Z" }),
			watch: async () => ({ same: true }),
			previewChange: async () => {
				previewCount++;
				if (releasePreview === undefined && previewCount === 1) {
					await new Promise<void>((resolve) => {
						releasePreview = resolve;
					});
				}
				return {
					words: ["Run change"],
					values: [],
					sha256: sha,
				};
			},
			change: async () => {
				if (changeMode === "drop") throw new TypeError("fetch failed");
				return {
					changed: 400,
					columns: ["id", "payload"],
					rows: Array.from({ length: 400 }, (_, i) => [i + 1, "x".repeat(4_000)]),
					more: false,
					asOf: "2026-11-21T12:00:00.000Z",
				};
			},
		};
		const data = new CompanyData(() => client, company.signal);
		const key = crypto.randomUUID();
		const bridge = new AppBridge(
			{ folder: () => fakeFolder({}), agents: () => [], data },
			makeApp(["data:shop/add-item"]),
			key,
			company.signal,
			{
				closed: () => null,
				ask: async () => ({ outcome: "declined" }),
				askData: async (_ask, perform) => {
					try {
						return { outcome: "saved", result: await perform() };
					} catch (error) {
						return { outcome: "failed", message: error instanceof Error ? error.message : "failed" };
					}
				},
			},
		);

		let dag: unknown = { a: "0123456789" };
		for (let i = 0; i < 16; i++) dag = [dag, dag, dag, dag];
		expect(await bridge.answer({ method: "act", params: { name: "shop/add-item", params: { dag } } })).toEqual({
			ok: false,
			error: "Not a call the app answers",
		});
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(await bridge.answer({ method: "act", params: { name: "shop/add-item", params: cyclic } })).toEqual({
			ok: false,
			error: "Not a call the app answers",
		});
		expect(await bridge.answer({ method: "act", params: { name: "shop/add-item", params: { n: 1n } } })).toEqual({
			ok: false,
			error: "Not a call the app answers",
		});

		const first = bridge.answer({ method: "act", params: { name: "shop/add-item", params: { sku: "1" } } });
		const second = await bridge.answer({ method: "act", params: { name: "shop/add-item", params: { sku: "2" } } });
		expect(second).toEqual({ ok: false, error: "Another request is waiting for the member's answer" });
		expect(previewCount).toBe(1);
		releasePreview?.();
		const firstRes = await first;
		expect(firstRes.ok).toBe(true);
		if (firstRes.ok) {
			const value = firstRes.value as { changed: number; more: boolean; rows: unknown[] };
			expect(value.changed).toBe(400);
			expect(value.more).toBe(true);
			expect(value.rows.length).toBeGreaterThan(0);
			expect(value.rows.length).toBeLessThan(400);
		}

		changeMode = "drop";
		const dropped = await bridge.answer({ method: "act", params: { name: "shop/add-item", params: { sku: "3" } } });
		expect(dropped.ok).toBe(false);
		if (!dropped.ok) expect(dropped.error).toContain("Check before trying again");

		const nowSpy = vi.spyOn(Date, "now");
		try {
			let clock = 60_000 * 100;
			nowSpy.mockImplementation(() => clock);
			for (let round = 0; round < 10; round++) {
				let finishSlow: (() => void) | undefined;
				const slowClient: CompanyDataClient = {
					query: async () => {
						await new Promise<void>((resolve) => {
							finishSlow = resolve;
						});
						return { columns: [], rows: [], more: false, etag: "e", asOf: "2026-11-21T12:00:00.000Z" };
					},
					watch: async () => ({ same: true }),
				};
				const slowBridge = new AppBridge(
					{
						folder: () => fakeFolder({}),
						agents: () => [],
						data: new CompanyData(() => slowClient, company.signal),
					},
					makeApp([]),
					key,
					company.signal,
				);
				const pending = slowBridge.answer({ method: "query", params: { name: "shop/q", params: {} } });
				clock += 60_000;
				const probe = slowBridge.answer({ method: "agents", params: {} });
				finishSlow?.();
				await Promise.all([pending, probe]);
			}
			const afterRollovers = await bridge.answer({ method: "agents", params: {} });
			expect(afterRollovers.ok).toBe(false);
			if (!afterRollovers.ok) expect(afterRollovers.error).not.toContain("Too many calls");
		} finally {
			nowSpy.mockRestore();
		}
		company.abort();
	});

	it("coalesces concurrent CompanyApps.read() calls so a slow earlier read cannot overwrite newer apps", async () => {
		const company = new AbortController();
		let calls = 0;
		let releaseFirst: (() => void) | undefined;
		const firstFolder = fakeFolder({
			"apps/alpha/app.json": JSON.stringify({ name: "Alpha", entry: "index.html", posted: true }),
			"apps/alpha/index.html": "<p>Alpha</p>",
		});
		const secondFolder = fakeFolder({
			"apps/alpha/app.json": JSON.stringify({ name: "Alpha", entry: "index.html", posted: true }),
			"apps/alpha/index.html": "<p>Alpha</p>",
			"apps/beta/app.json": JSON.stringify({ name: "Beta", entry: "index.html", posted: true }),
			"apps/beta/index.html": "<p>Beta</p>",
		});
		const delayedFirst = {
			...firstFolder,
			list: async (...args: Parameters<typeof firstFolder.list>) => {
				if (args[0] === "apps") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return firstFolder.list(...args);
			},
		};
		const published: string[][] = [];
		const apps = new CompanyApps(
			{
				signal: company.signal,
				folder: () => {
					calls += 1;
					return (calls === 1 ? delayedFirst : secondFolder) as never;
				},
				folderHints: () => ({ close: async () => {} }),
			},
			(list) => published.push(list.map((item) => item.name)),
		);
		const p1 = apps.read();
		const p2 = apps.read();
		const p3 = apps.read();
		await vi.waitFor(() => expect(releaseFirst).toBeDefined());
		expect(calls).toBe(1);
		releaseFirst!();
		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(calls).toBe(2);
		expect(r1.map((item) => item.name)).toEqual(["alpha", "beta"]);
		expect(r2.map((item) => item.name)).toEqual(["alpha", "beta"]);
		expect(r3.map((item) => item.name)).toEqual(["alpha", "beta"]);
		expect(published.at(-1)).toEqual(["alpha", "beta"]);
		apps.dispose();
		company.abort();
	});

	it("bounds readApps concurrency without readMany, batches with readMany, and reuses unchanged manifest versions", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 20; i += 1) {
			const name = `app-${String(i).padStart(2, "0")}`;
			files[`apps/${name}/app.toml`] = `name = "App ${i}"\nentry = "index.html"\n`;
			files[`apps/${name}/index.html`] = `<p>${i}</p>`;
		}
		const base = fakeFolder(files);
		let inFlight = 0;
		let maxInFlight = 0;
		let readFileCalls = 0;
		const { readMany: _omitted, ...withoutReadMany } = base as unknown as Record<string, unknown>;
		const slowFolder = {
			...withoutReadMany,
			read: async (path: string, signal: AbortSignal) => {
				if (path.endsWith("/app.toml")) {
					inFlight += 1;
					if (inFlight > maxInFlight) maxInFlight = inFlight;
					await new Promise((resolve) => setTimeout(resolve, 2));
					inFlight -= 1;
				}
				return base.read(path, signal);
			},
			readFile: async (...args: Parameters<typeof base.readFile>) => {
				readFileCalls += 1;
				return base.readFile(...args);
			},
		};
		const signal = new AbortController().signal;
		const first = await readApps(slowFolder as never, signal);
		expect(first).toHaveLength(20);
		expect(maxInFlight).toBeLessThanOrEqual(8);
		expect(readFileCalls).toBe(20);

		readFileCalls = 0;
		const second = await readApps(slowFolder as never, signal, first);
		expect(second).toHaveLength(20);
		expect(readFileCalls).toBe(0);

		const readManySpy = vi.fn(async (paths: readonly string[], sig: AbortSignal) =>
			Promise.all(paths.map((path) => base.read(path, sig))),
		);
		const readSpy = vi.fn(base.read.bind(base));
		const batchedFolder = { ...base, read: readSpy, readMany: readManySpy };
		const third = await readApps(batchedFolder as never, signal, second);
		expect(third).toHaveLength(20);
		expect(readManySpy).toHaveBeenCalledTimes(1);
		expect(readSpy).toHaveBeenCalledTimes(1);

		const updatedFiles = { ...files, "apps/app-00/app.toml": 'name = "App 0 Updated"\nentry = "index.html"\n' };
		const updatedBase = fakeFolder(updatedFiles);
		let updatedReadFileCalls = 0;
		const updatedFolder = {
			...updatedBase,
			read: async (path: string, sig: AbortSignal) => {
				const answer = await updatedBase.read(path, sig);
				if (path === "apps/app-00/app.toml" && answer.entry) {
					return {
						...answer,
						entry: { ...answer.entry, version: "00000000-0000-4000-8000-000000000099" },
					};
				}
				return answer;
			},
			readFile: async (...args: Parameters<typeof updatedBase.readFile>) => {
				updatedReadFileCalls += 1;
				return updatedBase.readFile(...args);
			},
		};
		const fourth = await readApps(updatedFolder as never, signal, third);
		expect(fourth).toHaveLength(20);
		expect(updatedReadFileCalls).toBe(1);
		expect(fourth.find((item) => item.name === "app-00")?.manifest?.name).toBe("App 0 Updated");
		expect(fourth.find((item) => item.name === "app-01")?.manifest?.name).toBe("App 1");

		const readMany404 = vi.fn(async () => {
			throw new CloudMemberFolderError("Company folder is unavailable (404)", 404);
		});
		const read404Spy = vi.fn(base.read.bind(base));
		const folder404 = { ...base, read: read404Spy, readMany: readMany404 };
		const after404 = await readApps(folder404 as never, signal);
		expect(after404).toHaveLength(20);
		expect(readMany404).toHaveBeenCalledTimes(1);
		expect(read404Spy).toHaveBeenCalledTimes(21);
		const after404Again = await readApps(folder404 as never, signal, after404);
		expect(after404Again).toHaveLength(20);
		expect(readMany404).toHaveBeenCalledTimes(1);

		const readMany503 = vi.fn(async () => {
			throw new CloudMemberFolderError("Company folder is unavailable (503)", 503);
		});
		const folder503 = { ...base, read: vi.fn(base.read.bind(base)), readMany: readMany503 };
		const after503 = await readApps(folder503 as never, signal);
		expect(after503).toHaveLength(20);
		expect(readMany503).toHaveBeenCalledTimes(1);
		await readApps(folder503 as never, signal, after503);
		expect(readMany503).toHaveBeenCalledTimes(2);
	});
});
