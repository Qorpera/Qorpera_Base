// @vitest-environment jsdom
import { createHash } from "node:crypto";
import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import { describe, expect, it } from "vitest";
import {
	AppBridge,
	appReadablePath,
	assembleApp,
	type CompanyApp,
	readApps,
	resolveAppPath,
	sharedFolderHints,
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
});
