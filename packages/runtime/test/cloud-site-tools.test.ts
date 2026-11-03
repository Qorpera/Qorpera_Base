import { createHash, randomUUID } from "node:crypto";
import type { CloudCompanyFolderClient, CloudCompanyFolderEntry } from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { cloudSiteTools } from "@qorpera/runtime/cloud-site-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const URL_OF = (slug: string) => `https://sites.qorpera.com/${slug}/`;

/** A company folder of files (path → text or bytes), as the run's own view lists and reads it. */
function folderOf(files: Record<string, string | Uint8Array>, links: string[] = []) {
	const bytes = new Map(
		Object.entries(files).map(([path, value]) => [
			path,
			typeof value === "string" ? new TextEncoder().encode(value) : value,
		]),
	);
	const entry = (path: string): CloudCompanyFolderEntry => {
		const content = bytes.get(path);
		const base = { path, version: randomUUID(), seq: 1, updatedAt: "2026-11-03T10:00:00Z", authority: {} };
		if (content)
			return {
				...base,
				kind: "file",
				file: {
					manifestSha256: "f".repeat(64),
					fileSha256: sha(content),
					bytes: content.byteLength,
					mediaType: "application/octet-stream",
					executable: false,
				},
			} as unknown as CloudCompanyFolderEntry;
		if (links.includes(path))
			return { ...base, kind: "symlink", target: "elsewhere" } as unknown as CloudCompanyFolderEntry;
		return { ...base, kind: "folder" } as unknown as CloudCompanyFolderEntry;
	};
	const folders = () => {
		const all = new Set<string>();
		for (const path of [...bytes.keys(), ...links]) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join("/"));
		}
		return all;
	};
	const read = vi.fn(async (path: string) => {
		if (bytes.has(path) || links.includes(path) || folders().has(path)) return { asOfSeq: 1, entry: entry(path) };
		return { asOfSeq: 1, entry: null };
	});
	const listAll = vi.fn(async (parent: string, options: { maxEntries: number }) => {
		const under = [...bytes.keys(), ...links, ...folders()].filter((path) => path.startsWith(`${parent}/`)).sort();
		if (under.length > options.maxEntries) throw new Error("Company folder listing has more entries than its bound");
		return { asOfSeq: 1, entries: under.map(entry) };
	});
	const readRange = vi.fn(async (file: { path: string }, offset: number, length: number) => {
		const content = bytes.get(file.path);
		if (!content) throw new Error("no such file");
		return content.subarray(offset, offset + length);
	});
	const client = { read, listAll, readRange } as unknown as CloudCompanyFolderClient;
	return { client, bytes, read, listAll, readRange };
}

interface Database {
	mode?: "new" | "update";
	refuse?: Partial<Record<string, CloudControlRpcRefused>>;
	unchanged?: boolean;
}

/** The site tools behind the boundary, with a review that lets every call run (recording what it read). */
async function fixture(
	files: Record<string, string | Uint8Array>,
	options: Database & { links?: string[]; review?: false } = {},
) {
	const { binding, authority } = nativeToolAuthorityFixture();
	const run = await CloudNativeToolRun.open(
		binding,
		{ describeToolAuthority: async () => authority },
		new AbortController().signal,
	);
	runs.push(run);
	const folder = folderOf(files, options.links);
	const versionId = randomUUID();
	let missing: string[] = [];
	let slug = "";
	const call = vi.fn<CloudCompanyPathControl["call"]>(async (method, args) => {
		const refusal = options.refuse?.[method];
		if (refusal) throw refusal;
		if (method === "qorpera_site_publish_check")
			return {
				schema: "qorpera.site-publish-check/v1",
				slug: args.p_slug,
				url: URL_OF(args.p_slug as string),
				mode: options.mode ?? "new",
				siteId: null,
				liveSource: options.mode === "update" ? "product/webshop" : null,
			};
		if (method === "qorpera_site_publish_begin") {
			const request = args.p_request as { slug: string; files: { path: string; bytes: number }[] };
			missing = options.unchanged ? [] : request.files.map((file) => file.path).sort();
			slug = request.slug;
			return {
				schema: "qorpera.site-publish/v1",
				siteId: randomUUID(),
				slug: request.slug,
				url: URL_OF(request.slug),
				mode: options.mode ?? "new",
				versionId,
				state: options.unchanged ? "live" : "uploading",
				unchanged: options.unchanged === true,
				files: request.files.length,
				bytes: request.files.reduce((sum, file) => sum + file.bytes, 0),
				missing,
			};
		}
		if (method === "qorpera_site_publish_put") {
			const sent = (args.p_files as { path: string }[]).map((file) => file.path);
			missing = missing.filter((path) => !sent.includes(path));
			return { schema: "qorpera.site-publish-put/v1", versionId, missing };
		}
		if (method === "qorpera_site_publish_finish")
			return {
				schema: "qorpera.site-publish/v1",
				siteId: randomUUID(),
				slug,
				url: URL_OF(slug),
				mode: options.mode ?? "new",
				versionId,
				state: "live",
				unchanged: false,
				files: 2,
				bytes: 10,
				missing: [],
			};
		if (method === "qorpera_site_unpublish")
			return { schema: "qorpera.site-unpublish/v1", slug: args.p_slug, removed: args.p_slug === "wristband-shop" };
		throw new Error(`unexpected ${method}`);
	});
	const reviewed: unknown[] = [];
	const contents: unknown[] = [];
	const reviewId = randomUUID();
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools: cloudSiteTools({ binding, identity: run.identity, control: { call }, folder: folder.client }),
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
		...(options.review === false
			? {}
			: {
					review: {
						check: async (request: {
							parsed: unknown;
							tool: { reviewContents?: (parsed: never) => unknown };
						}) => {
							reviewed.push(request.parsed);
							contents.push(request.tool.reviewContents?.(request.parsed as never));
							return { run: true as const, reviewId };
						},
					},
				}),
	});
	const calls = (method: string) => call.mock.calls.filter(([name]) => name === method).map(([, args]) => args);
	return { binding, boundary, call, calls, folder, reviewed, contents, reviewId };
}

function outcome(response: Awaited<ReturnType<CloudNativeToolBoundary["invoke"]>>) {
	const result = JSON.parse(response.contentItems[0].text) as { status: string; content: { text: string } };
	return {
		status: result.status,
		text: result.content.text,
		answer: result.status === "ok" ? JSON.parse(result.content.text) : null,
	};
}

const SHOP = {
	"product/webshop/index.html": "<h1>Wristbands</h1><a href='about.html'>About</a>",
	"product/webshop/about.html": "<p>About us</p>",
	"product/webshop/img/logo.png": new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
	"product/webshop/notes.md": "# internal notes",
	"product/webshop/.DS_Store": "x",
};

describe("publish_site", () => {
	it("publishes a folder's web files: the review reads what goes out, then begin, the bytes and the switch", async () => {
		const f = await fixture(SHOP);
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
				title: "Wristbands",
			}),
		);
		expect(result.status, result.text).toBe("ok");
		// The review read the prepared call: the link, the files and whether the site is new.
		expect(f.reviewed).toHaveLength(1);
		expect(f.reviewed[0]).toMatchObject({
			slug: "wristband-shop",
			source: "product/webshop",
			title: "Wristbands",
			kind: "folder",
			mode: "new",
			url: URL_OF("wristband-shop"),
			liveSource: null,
			files: 3,
			paths: ["about.html", "img/logo.png", "index.html"],
			skipped: [".DS_Store", "notes.md"],
		});
		// The reviewer reads every path that goes out, and what is left out.
		expect(f.contents[0]).toEqual({
			files: ["about.html", "img/logo.png", "index.html"],
			filesNotListed: 0,
			leftOut: [".DS_Store", "notes.md"],
			leftOutNotListed: 0,
		});
		const [check] = f.calls("qorpera_site_publish_check");
		expect(check).toEqual({ p_binding: f.binding, p_slug: "wristband-shop" });
		const [begin] = f.calls("qorpera_site_publish_begin") as Array<Record<string, unknown>>;
		expect(begin?.p_call_id).toBe("call_1");
		expect(begin?.p_review_id).toBe(f.reviewId);
		const request = begin?.p_request as {
			files: { path: string; bytes: number; sha256: string }[];
			manifestSha256: string;
		};
		expect(request.files.map((file) => file.path).sort()).toEqual(["about.html", "img/logo.png", "index.html"]);
		// The manifest is the database's: `<path> TAB <sha256> TAB <bytes>` lines in path order, joined by LF.
		const lines = [...request.files]
			.sort((a, b) => (a.path < b.path ? -1 : 1))
			.map((file) => `${file.path}\t${file.sha256}\t${file.bytes}`)
			.join("\n");
		expect(request.manifestSha256).toBe(createHash("sha256").update(lines).digest("hex"));
		expect(request.manifestSha256).toBe((f.reviewed[0] as { manifestSha256: string }).manifestSha256);
		// Every file's bytes, in base64, then the switch.
		const puts = f.calls("qorpera_site_publish_put") as Array<{ p_files: { path: string; content: string }[] }>;
		expect(puts.flatMap((put) => put.p_files.map((file) => file.path)).sort()).toEqual([
			"about.html",
			"img/logo.png",
			"index.html",
		]);
		const logo = puts.flatMap((put) => put.p_files).find((file) => file.path === "img/logo.png");
		expect(Buffer.from(logo?.content ?? "", "base64")).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
		expect(f.calls("qorpera_site_publish_finish")).toHaveLength(1);
		expect(result.answer).toMatchObject({ state: "live", url: URL_OF("wristband-shop"), mode: "new" });
		expect(result.answer.leftOut).toEqual([".DS_Store", "notes.md"]);
		expect(result.text).toContain("Settings → Sites");
		expect(result.text).not.toMatch(/password":\s*"[a-z0-9]{4}-/);
	});

	it("publishes one HTML file as the site's home page", async () => {
		const f = await fixture({ "product/webshop-preview.html": "<h1>Shop</h1>" });
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop-preview.html",
			}),
		);
		expect(result.status, result.text).toBe("ok");
		const [begin] = f.calls("qorpera_site_publish_begin") as Array<{ p_request: { files: { path: string }[] } }>;
		expect(begin?.p_request.files.map((file) => file.path)).toEqual(["index.html"]);
		expect(f.reviewed[0]).toMatchObject({ kind: "file", files: 1 });
	});

	it("answers an unchanged site without uploading anything", async () => {
		const f = await fixture(SHOP, { mode: "update", unchanged: true });
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
			}),
		);
		expect(result.answer).toMatchObject({ state: "live", unchanged: true, mode: "update" });
		expect(f.calls("qorpera_site_publish_put")).toEqual([]);
		expect(f.calls("qorpera_site_publish_finish")).toEqual([]);
		expect(result.answer.password).toContain("unchanged");
	});

	it("uploads in batches of at most 4 MiB, a larger file alone", async () => {
		const big = (n: number) => new Uint8Array(6 * 1024 * 1024).fill(n);
		const f = await fixture({
			"site/index.html": "<p>x</p>",
			"site/a.mp4": big(1),
			"site/b.mp4": big(2),
			"site/c.mp4": big(3),
		});
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", { slug: "videos", source: "site" }),
		);
		expect(result.status, result.text).toBe("ok");
		const puts = f.calls("qorpera_site_publish_put") as Array<{ p_files: { content: string }[] }>;
		expect(puts.length).toBeGreaterThanOrEqual(3);
		for (const put of puts) {
			const bytes = put.p_files.map((file) => Buffer.from(file.content, "base64").byteLength);
			expect(bytes.length === 1 || bytes.reduce((sum, n) => sum + n, 0) <= 4 * 1024 * 1024).toBe(true);
		}
	});

	it.each([
		["a slug in capitals", { slug: "Wristband-Shop", source: "product/webshop" }],
		["a slug with a dot", { slug: "shop.v2", source: "product/webshop" }],
		["a two-letter slug", { slug: "ab", source: "product/webshop" }],
		["the platform's folder", { slug: "secrets", source: "QorperaOS/agents" }],
		["a platform folder in other letters", { slug: "secrets", source: "qorperaos" }],
		["the bank's folder", { slug: "money", source: "bank" }],
		["an absolute path", { slug: "shop", source: "/product/webshop" }],
		["a parent path", { slug: "shop", source: "product/../QorperaOS" }],
		["an extra field", { slug: "shop", source: "product/webshop", password: "hunter2hunter2" }],
		["a two-line title", { slug: "shop", source: "product/webshop", title: "a\nb" }],
	])("refuses %s before reading anything", async (_label, args) => {
		const f = await fixture(SHOP);
		const result = outcome(await f.boundary.invoke("bad", "qorpera", "publish_site", args));
		expect(result.status).toBe("denied");
		expect(f.call).not.toHaveBeenCalled();
		expect(f.folder.read).not.toHaveBeenCalled();
	});

	it.each([
		["a missing source", { "other/index.html": "x" }, [], "SITE_SOURCE_MISSING"],
		["a folder with no index.html", { "product/webshop/home.html": "x" }, [], "SITE_NO_INDEX"],
		[
			"a file name a link would escape",
			{ "product/webshop/index.html": "x", "product/webshop/my page.html": "y" },
			[],
			"SITE_FILE_NAME",
		],
		["a single file that is not HTML", { "product/webshop": "x" }, [], "SITE_SOURCE_NOT_HTML"],
		["a source that is a link", {}, ["product/webshop"], "SITE_SOURCE_LINK"],
		[
			"a file over 10 MiB",
			{ "product/webshop/index.html": "x", "product/webshop/film.mp4": new Uint8Array(10 * 1024 * 1024 + 1) },
			[],
			"SITE_FILE_TOO_LARGE",
		],
		[
			"a site over 25 MiB",
			Object.fromEntries([
				["product/webshop/index.html", "x"],
				...[1, 2, 3].map((n) => [`product/webshop/${n}.mp4`, new Uint8Array(9 * 1024 * 1024)]),
			]),
			[],
			"SITE_TOO_LARGE",
		],
		[
			"more than 500 web files",
			Object.fromEntries([
				["product/webshop/index.html", "x"],
				...Array.from({ length: 500 }, (_, n) => [`product/webshop/p${n}.html`, "x"]),
			]),
			[],
			"SITE_TOO_MANY_FILES",
		],
		[
			"a folder of more than 2000 entries",
			Object.fromEntries(Array.from({ length: 2001 }, (_, n) => [`product/webshop/n${n}.md`, "x"])),
			[],
			"SITE_TOO_MANY_FILES",
		],
	])("refuses %s before the review and any effect", async (_label, files, links, code) => {
		const f = await fixture(files as Record<string, string | Uint8Array>, { links: links as string[] });
		const result = outcome(
			await f.boundary.invoke("bad", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
			}),
		);
		expect(result.status).toBe("denied");
		expect(result.text).toContain(`REFUSED: ${code}`);
		expect(f.reviewed).toEqual([]);
		expect(f.calls("qorpera_site_publish_begin")).toEqual([]);
	});

	it("leaves hidden files, links and other types out, and names them", async () => {
		const f = await fixture(
			{ ...SHOP, "product/webshop/.git/config": "x", "product/webshop/run.php": "<?php" },
			{
				links: ["product/webshop/shortcut.html"],
			},
		);
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
			}),
		);
		expect(result.status, result.text).toBe("ok");
		const [begin] = f.calls("qorpera_site_publish_begin") as Array<{ p_request: { files: { path: string }[] } }>;
		expect(begin?.p_request.files.map((file) => file.path).sort()).toEqual([
			"about.html",
			"img/logo.png",
			"index.html",
		]);
		expect(result.answer.leftOut).toEqual([".DS_Store", ".git/config", "notes.md", "run.php", "shortcut.html"]);
	});

	it("relays the database's refusal of the check before the review", async () => {
		const f = await fixture(SHOP, {
			refuse: {
				qorpera_site_publish_check: new CloudControlRpcRefused(
					"55000",
					"SITE_NAME_TAKEN: another site already has this name; choose another",
				),
			},
		});
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
			}),
		);
		expect(result.status).toBe("denied");
		expect(result.text).toContain("SITE_NAME_TAKEN");
		expect(f.reviewed).toEqual([]);
	});

	it("relays the begin's refusal (a new site without approval) as a call that changed nothing", async () => {
		const f = await fixture(SHOP, {
			refuse: {
				qorpera_site_publish_begin: new CloudControlRpcRefused(
					"42501",
					"SITE_APPROVAL_REQUIRED: a new website goes out only after an owner or admin approves it on a card",
				),
			},
		});
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
			}),
		);
		expect(result.status).toBe("denied");
		expect(result.text).toContain("SITE_APPROVAL_REQUIRED");
		expect(f.calls("qorpera_site_publish_put")).toEqual([]);
	});

	it("tells a refused upload as not live, never as nothing changed", async () => {
		const f = await fixture(SHOP, {
			refuse: {
				qorpera_site_publish_put: new CloudControlRpcRefused(
					"22023",
					"SITE_FILE_CHANGED: a file's bytes are not the ones named when the publish began; publish again",
				),
			},
		});
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
			}),
		);
		expect(result.status).toBe("ok");
		expect(result.answer).toMatchObject({ state: "not_live", slug: "wristband-shop" });
		expect(result.answer.reason).toContain("SITE_FILE_CHANGED");
		expect(f.calls("qorpera_site_publish_finish")).toEqual([]);
	});

	it("refuses when the files changed after the review", async () => {
		const f = await fixture(SHOP);
		const original = f.folder.listAll.getMockImplementation();
		let listed = 0;
		f.folder.listAll.mockImplementation(async (parent, options) => {
			listed++;
			// The second listing (after the review) finds an edited page.
			if (listed === 2) f.folder.bytes.set("product/webshop/about.html", new TextEncoder().encode("<p>Edited</p>"));
			return original!(parent, options);
		});
		const result = outcome(
			await f.boundary.invoke("call_1", "qorpera", "publish_site", {
				slug: "wristband-shop",
				source: "product/webshop",
			}),
		);
		expect(result.status).toBe("denied");
		expect(result.text).toContain("SITE_SOURCE_CHANGED");
		expect(f.calls("qorpera_site_publish_begin")).toEqual([]);
	});

	it("sends no review id when the call ran without a review, which the database refuses for a new site", async () => {
		const f = await fixture(SHOP, { review: false });
		await f.boundary.invoke("call_1", "qorpera", "publish_site", {
			slug: "wristband-shop",
			source: "product/webshop",
		});
		const [begin] = f.calls("qorpera_site_publish_begin") as Array<Record<string, unknown>>;
		expect(begin?.p_review_id).toBeNull();
	});
});

describe("unpublish_site", () => {
	it("takes the company's site offline through the run binding", async () => {
		const f = await fixture(SHOP);
		const removed = outcome(
			await f.boundary.invoke("call_1", "qorpera", "unpublish_site", { slug: "wristband-shop" }),
		);
		expect(removed.answer).toEqual({
			schema: "qorpera.site-unpublish-result/v1",
			slug: "wristband-shop",
			removed: true,
		});
		expect(f.calls("qorpera_site_unpublish")).toEqual([{ p_binding: f.binding, p_slug: "wristband-shop" }]);
		const none = outcome(await f.boundary.invoke("call_2", "qorpera", "unpublish_site", { slug: "other-site" }));
		expect(none.answer).toMatchObject({ removed: false });
		expect(none.answer.note).toContain("nothing was taken offline");
	});

	it("refuses a bad slug without calling the cloud", async () => {
		const f = await fixture(SHOP);
		const result = outcome(await f.boundary.invoke("bad", "qorpera", "unpublish_site", { slug: "../x" }));
		expect(result.status).toBe("denied");
		expect(f.call).not.toHaveBeenCalled();
	});
});
