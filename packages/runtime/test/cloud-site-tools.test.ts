import { createHash, randomUUID } from "node:crypto";
import type { JsonValue } from "@qorpera/contracts";
import { cloudActionEffect, describeCloudAction, siteAccessCheck } from "@qorpera/runtime/cloud-action-review";
import type { CloudCompanyFolderClient, CloudCompanyFolderEntry } from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudControlRpcRefused } from "@qorpera/runtime/cloud-control-errors";
import {
	type CloudMachineCommandGateway,
	CloudMachineCommandRefusal,
} from "@qorpera/runtime/cloud-machine-command-http";
import { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { type CloudNativeTool, CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import type { CloudNativeToolOperations } from "@qorpera/runtime/cloud-native-tool-operations";
import { cloudSiteTools } from "@qorpera/runtime/cloud-site-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const URL_OF = (slug: string) => `https://sites.qorpera.com/${slug}/`;
const APP_URL_OF = (slug: string) => `https://${slug}-preview.qorpera.com/`;
/** A one-time claim as the database issues it (base64url). */
const CLAIM = "q7Zx_3kPmA9vB2nC4dE6fG8hJ0kL1mN3pQ5rS7tU9wY";
const MACHINE_IDS: Record<string, string> = { "shop-server": randomUUID(), "old-server": randomUUID() };

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
	/** share_app's check, as the database answers it: the machine refused, or the slug new, the company's live app link
	 * (on `machine` and `port`, default shop-server and 3000) or taken; a review for a new link or another machine or
	 * port, unless `needsReview` says; the app's link, unless `url` says. */
	share?: {
		state?: "new" | "update" | "taken";
		refused?: string;
		needsReview?: boolean;
		machine?: string;
		port?: number;
		url?: unknown;
	};
	/** Fields of the share's answer to replace. */
	shared?: Record<string, unknown>;
	/** The run has no machines (share_app's program cannot start). */
	noMachines?: true;
	/** The company's machines as machine_list gives them (default: shop-server and old-server, running). */
	machines?: { name: string; state: string }[];
	/** How the machine's executor answers the program's start: a running command (default), one that ended at once,
	 * one whose start is unconfirmed, a refusal, or a failure. */
	start?: "running" | "failed" | "unconfirmed" | "MACHINE_NOT_RUNNING" | "throw";
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
		if (method === "qorpera_site_share_check") {
			const share = options.share ?? {};
			if (share.refused) return { state: "refused", reason: share.refused, needsReview: false };
			const state = share.state ?? "new";
			const live = share.machine ?? "shop-server";
			const livePort = share.port ?? 3000;
			return {
				state,
				needsReview:
					share.needsReview ??
					(state === "new" || (state === "update" && (live !== args.p_machine || livePort !== args.p_port))),
				url: "url" in share ? share.url : APP_URL_OF(args.p_slug as string),
				...(state === "update" ? { machine: live, port: livePort } : {}),
			};
		}
		if (method === "qorpera_native_machine_manage")
			return {
				schema: "qorpera.machine-list/v1",
				machines: (
					options.machines ?? [
						{ name: "shop-server", state: "running" },
						{ name: "old-server", state: "running" },
					]
				).map((machine) => ({ ...machine, machineId: MACHINE_IDS[machine.name] ?? randomUUID() })),
			};
		if (method === "qorpera_site_share_app") {
			const request = args.p_request as { slug: string; machine: string; port: number };
			return {
				slug: request.slug,
				url: APP_URL_OF(request.slug),
				machine: request.machine,
				port: request.port,
				newPassword: (options.share?.state ?? "new") === "new",
				claim: CLAIM,
				claimExpiresAt: "2026-11-04T10:15:00.000Z",
				clientUrl: `${APP_URL_OF(request.slug)}.qorpera/client.mjs`,
				connectUrl: `wss://${request.slug}-preview.qorpera.com/.qorpera/connect`,
				...options.shared,
			};
		}
		throw new Error(`unexpected ${method}`);
	});
	const reviewed: unknown[] = [];
	const contents: unknown[] = [];
	const reviewId = randomUUID();
	// The machine's executor, behind the run's operations as machine_run uses them (one receipt, then the start).
	const start = vi.fn<CloudMachineCommandGateway["start"]>(async (scope, input) => {
		if (options.start === "MACHINE_NOT_RUNNING") throw new CloudMachineCommandRefusal("MACHINE_NOT_RUNNING");
		if (options.start === "throw") throw new Error("executor unreachable");
		return {
			schema: "qorpera.machine-command-result/v1",
			machineId: scope.machineId,
			commandId: input.commandId,
			inputSha256: input.inputSha256,
			state: options.start === "failed" || options.start === "unconfirmed" ? options.start : "running",
			exitCode: options.start === "failed" ? 1 : null,
			output: "",
			truncated: false,
			log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 64 * 1024 * 1024, limitReached: false },
		};
	});
	const operations = vi.fn<CloudNativeToolOperations["execute"]>(async ({ operation, authorize, perform, signal }) => {
		await authorize(operation, run.identity, signal);
		return (
			await perform(operation, {
				identity: run.identity,
				receiptId: randomUUID(),
				inputSha256: "c".repeat(64),
				idempotencyKey: "k",
				signal,
			})
		).content;
	});
	const tools = cloudSiteTools({
		binding,
		identity: run.identity,
		control: { call },
		folder: folder.client,
		...(options.noMachines ? {} : { machines: { gateway: { start } as never, operations: { execute: operations } } }),
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: run.identity.companyId,
		runId: run.identity.runId,
		identity: run.identity,
		tools,
		assertActive: (signal) => run.assertActive(signal),
		signal: run.signal,
		...(options.review === false
			? {}
			: {
					review: {
						check: async (request: {
							parsed: JsonValue;
							tool: Pick<CloudNativeTool, "name" | "source"> & { reviewContents?: (parsed: never) => unknown };
						}) => {
							// As the gate: reads and changes that stay inside are never reviewed.
							if (["read", "internal"].includes(cloudActionEffect(request.tool, request.parsed)))
								return { run: true as const };
							reviewed.push(request.parsed);
							contents.push(request.tool.reviewContents?.(request.parsed as never));
							return { run: true as const, reviewId };
						},
					},
				}),
	});
	const calls = (method: string) => call.mock.calls.filter(([name]) => name === method).map(([, args]) => args);
	return { binding, boundary, call, calls, folder, reviewed, contents, reviewId, tools, start, operations };
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

describe("share_app", () => {
	const SHARE = { slug: "saml-shop", title: "SAML shop", machine: "shop-server", port: 3000 };
	// One file a link, written whole before it runs; the host suffix the database's link has as the fourth word.
	const COMMAND = `curl -fsS https://saml-shop-preview.qorpera.com/.qorpera/client.mjs -o /root/.qorpera-app-link-saml-shop.mjs.tmp && mv -f /root/.qorpera-app-link-saml-shop.mjs.tmp /root/.qorpera-app-link-saml-shop.mjs && exec node /root/.qorpera-app-link-saml-shop.mjs saml-shop 3000 ${CLAIM} -preview.qorpera.com`;

	it("shares a new app link: the check, an access check on a card that names the link, machine and port, the share, then its link program on the machine", async () => {
		const f = await fixture({});
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status, result.text).toBe("ok");
		// The check is told the machine and port too: it refuses a machine the share would refuse, and says whether a
		// review is needed.
		expect(f.calls("qorpera_site_share_check")).toEqual([
			{ p_binding: f.binding, p_slug: "saml-shop", p_machine: "shop-server", p_port: 3000 },
		]);
		// The review read the prepared share, not the bare arguments.
		expect(f.reviewed).toEqual([
			{
				slug: "saml-shop",
				title: "SAML shop",
				machine: "shop-server",
				port: 3000,
				mode: "new",
				needsReview: true,
				url: APP_URL_OF("saml-shop"),
				liveMachine: null,
				livePort: null,
			},
		]);
		const tool = { name: "share_app", source: "runtime" as const };
		const prepared = f.reviewed[0] as JsonValue;
		expect(cloudActionEffect(tool, prepared)).toBe("external");
		expect(describeCloudAction(tool, prepared)).toEqual({
			title: "Share a private, password-protected app link",
			target: "https://saml-shop-preview.qorpera.com/",
			details: {
				title: "SAML shop",
				"from machine": "shop-server",
				port: "3000",
				effect:
					"Anyone with the link and its password can open the app on this port of the machine while it runs, through a link program the platform starts there; owners and admins see the password in Settings",
			},
		});
		// Whatever the reviewer called it, a first share is an access change an owner or admin approves.
		expect(
			siteAccessCheck(
				{ tool, parsed: prepared },
				{ decision: "allow", ruleIds: [], builtIn: "none", reason: "Requested.", proposedRule: null },
			),
		).toMatchObject({
			builtIn: "access_change",
			proposedRule: "share a password-protected app link for the company",
		});
		expect(f.calls("qorpera_site_share_app")).toEqual([
			{
				p_binding: f.binding,
				p_call_id: "call_1",
				p_request: { slug: "saml-shop", title: "SAML shop", machine: "shop-server", port: 3000 },
				p_review_id: f.reviewId,
			},
		]);
		// The tool starts the link program itself, as machine_run starts a command: on the named machine, no time limit,
		// no notify, under a machine_run receipt (the executor's authority for a start).
		expect(f.operations).toHaveBeenCalledTimes(1);
		const [{ operation }] = f.operations.mock.calls[0]!;
		expect(operation).toMatchObject({
			tool: "machine_run",
			arguments: { machine: "shop-server", command: COMMAND, notify: false },
			target: { realm: "company_machine", machineId: MACHINE_IDS["shop-server"] },
			requiresCompanyRevision: false,
		});
		expect(operation.logicalOperationKey).toMatch(/^share-app\.[0-9a-f]{32}$/);
		expect(f.start).toHaveBeenCalledTimes(1);
		expect(f.start.mock.calls[0]?.[0]).toEqual({ machineId: MACHINE_IDS["shop-server"] });
		expect(f.start.mock.calls[0]?.[1]).toMatchObject({ command: COMMAND, timeoutMs: null, notify: false });
		const commandId = f.start.mock.calls[0]?.[1].commandId;
		expect(result.answer).toEqual({
			schema: "qorpera.app-share-result/v1",
			state: "connecting",
			url: "https://saml-shop-preview.qorpera.com/",
			slug: "saml-shop",
			title: "SAML shop",
			machine: "shop-server",
			port: 3000,
			newPassword: true,
			linkProgram: { commandId, state: "running" },
			next: expect.stringContaining("The platform started the link program on shop-server"),
			password: expect.stringContaining("new password"),
		});
		expect(result.answer.next).toContain("the password is in Settings → Sites");
		// The tool's answer never holds the claim.
		expect(result.text).not.toContain(CLAIM);
		expect(result.text).not.toContain("curl");
	});

	it("shares its own live link again on the same machine and port without a review, for a new link program", async () => {
		const f = await fixture({}, { share: { state: "update" } });
		const result = outcome(
			await f.boundary.invoke("call_2", "qorpera", "share_app", {
				slug: "saml-shop",
				machine: "shop-server",
				port: 3000,
			}),
		);
		expect(result.status, result.text).toBe("ok");
		expect(f.reviewed).toEqual([]);
		const [shared] = f.calls("qorpera_site_share_app");
		// No title: the link keeps its own.
		expect(shared).toMatchObject({
			p_request: { slug: "saml-shop", machine: "shop-server", port: 3000 },
			p_review_id: null,
		});
		expect(result.answer).toMatchObject({ state: "connecting", newPassword: false });
		expect(f.start.mock.calls[0]?.[1]).toMatchObject({ command: COMMAND });
		expect(result.answer.password).toContain("unchanged");
	});

	it("bases what it says of the password on the database's newPassword, not on whether the link was live", async () => {
		// A link the agent turned off keeps its password: shared again, it is new as a link, not as a password.
		const f = await fixture({}, { shared: { newPassword: false } });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(f.reviewed).toHaveLength(1);
		expect(result.answer).toMatchObject({ newPassword: false });
		expect(result.answer.password).toContain("unchanged");
	});

	it("reviews a share of the live link on another port as an access check, naming the port it had", async () => {
		const f = await fixture({}, { share: { state: "update", port: 8080 } });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status, result.text).toBe("ok");
		expect(f.reviewed[0]).toMatchObject({
			mode: "update",
			needsReview: true,
			liveMachine: "shop-server",
			livePort: 8080,
		});
		const tool = { name: "share_app", source: "runtime" as const };
		expect(cloudActionEffect(tool, f.reviewed[0] as JsonValue)).toBe("external");
		expect(describeCloudAction(tool, f.reviewed[0] as JsonValue)).toMatchObject({
			title: "Share an app link from another port",
			details: { "from machine": "shop-server", port: "3000", "until now port": "8080" },
		});
		expect(f.calls("qorpera_site_share_app")[0]?.p_review_id).toBe(f.reviewId);
	});

	it("reviews a share of the live link from another machine as an access check, as the database says", async () => {
		const f = await fixture({}, { share: { state: "update", machine: "old-server" } });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status, result.text).toBe("ok");
		expect(f.reviewed).toHaveLength(1);
		expect(f.reviewed[0]).toMatchObject({
			mode: "update",
			needsReview: true,
			liveMachine: "old-server",
			livePort: 3000,
		});
		const card = describeCloudAction({ name: "share_app", source: "runtime" }, f.reviewed[0] as JsonValue);
		expect(card).toMatchObject({
			title: "Share an app link from another machine",
			target: APP_URL_OF("saml-shop"),
			details: { "from machine": "shop-server", "until now from machine": "old-server" },
		});
		expect(f.calls("qorpera_site_share_app")[0]?.p_review_id).toBe(f.reviewId);
	});

	it.each([
		[
			"APP_MACHINE_NOT_FOUND",
			"REFUSED: APP_MACHINE_NOT_FOUND: the company has no machine named shop-server; start an always-on one with machine_start (lifetime always-on), or name one from machine_list",
		],
		[
			"APP_MACHINE_NOT_ALWAYS_ON",
			"REFUSED: APP_MACHINE_NOT_ALWAYS_ON: shop-server is a task machine, which sleeps when its task is done, so its link would stop; run the app on an always-on machine (machine_start with lifetime always-on) and share from that",
		],
	])("refuses a machine the check refuses (%s) in plain words, with no card and no share", async (reason, text) => {
		const f = await fixture({}, { share: { refused: reason } });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status).toBe("denied");
		expect(result.text).toBe(text);
		expect(f.reviewed).toEqual([]);
		expect(f.calls("qorpera_site_share_app")).toEqual([]);
	});

	it.each([
		["no link", { url: undefined }],
		["a link that is not the app's", { url: "https://sites.qorpera.com/saml-shop/" }],
		["a refusal it does not name", { refused: "APP_MACHINE_ON_FIRE" }],
	])("shares nothing on a check with %s", async (_label, share) => {
		const f = await fixture({}, { share });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status).toBe("denied");
		expect(result.text).toMatch(/^TOOL_UNAVAILABLE: What this call changes could not be read/);
		expect(f.reviewed).toEqual([]);
		expect(f.calls("qorpera_site_share_app")).toEqual([]);
	});

	it.each([
		["a slug in capitals", { ...SHARE, slug: "SAML-shop" }],
		["a machine in capitals", { ...SHARE, machine: "Shop-Server" }],
		["a machine name with a space", { ...SHARE, machine: "shop server" }],
		["port 0", { ...SHARE, port: 0 }],
		["port 65536", { ...SHARE, port: 65536 }],
		["a port in words", { ...SHARE, port: "3000" }],
		["a fractional port", { ...SHARE, port: 3000.5 }],
		["no machine", { slug: "saml-shop", port: 3000 }],
		["no port", { slug: "saml-shop", machine: "shop-server" }],
		["an extra field", { ...SHARE, command: "rm -rf /" }],
		["a two-line title", { ...SHARE, title: "a\nb" }],
	])("refuses %s before asking the database", async (_label, args) => {
		const f = await fixture({});
		const result = outcome(await f.boundary.invoke("bad", "qorpera", "share_app", args));
		expect(result.status).toBe("denied");
		expect(result.text).toMatch(/^INVALID_ARGUMENTS/);
		expect(f.call).not.toHaveBeenCalled();
	});

	it("refuses a slug another site has, or one of the company's websites, before the review", async () => {
		const f = await fixture({}, { share: { state: "taken" } });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status).toBe("denied");
		expect(result.text).toContain("REFUSED: APP_NAME_TAKEN");
		expect(f.reviewed).toEqual([]);
		expect(f.calls("qorpera_site_share_app")).toEqual([]);
	});

	it.each([
		[
			"a machine that is not running",
			{ machines: [{ name: "shop-server", state: "stopped" }] },
			"REFUSED: APP_MACHINE_NOT_RUNNING: shop-server is stopped; wake it with machine_start (pass only machine with its name), and call share_app again once it runs",
		],
		[
			"a machine the list does not have",
			{ machines: [{ name: "old-server", state: "running" }] },
			"REFUSED: APP_MACHINE_NOT_FOUND: the company has no machine named shop-server; start an always-on one with machine_start (lifetime always-on), or name one from machine_list",
		],
		[
			"a run without machines",
			{ noMachines: true as const },
			"REFUSED: APP_MACHINES_UNAVAILABLE: this run cannot start programs on the company's machines, so no link can connect; try again later",
		],
	])("refuses %s before the review and the share", async (_label, options, text) => {
		const f = await fixture({}, options);
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status).toBe("denied");
		expect(result.text).toBe(text);
		expect(f.reviewed).toEqual([]);
		expect(f.calls("qorpera_site_share_app")).toEqual([]);
		expect(f.start).not.toHaveBeenCalled();
	});

	it("tells a share whose link program did not start, the machine having stopped, as shared but not connected", async () => {
		const f = await fixture({}, { start: "MACHINE_NOT_RUNNING" });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status, result.text).toBe("ok");
		expect(result.answer).toMatchObject({ state: "not_connected", url: APP_URL_OF("saml-shop"), newPassword: true });
		expect(result.answer.reason).toBe(
			"The link is shared, but its link program did not start: shop-server stopped before the program started.",
		);
		expect(result.answer.next).toContain("call share_app again");
		expect(result.text).not.toContain(CLAIM);
	});

	it.each([
		["the executor answers unconfirmed", "unconfirmed" as const, "machine_read (machine shop-server, command"],
		["the executor cannot be reached", "throw" as const, "If machine_list shows no running command on shop-server"],
	])(
		"tells a link program whose start could not be confirmed (%s) to look before sharing again",
		async (_label, start, look) => {
			const f = await fixture({}, { start });
			const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
			expect(result.status, result.text).toBe("ok");
			expect(result.answer).toMatchObject({ state: "program_unconfirmed", url: APP_URL_OF("saml-shop") });
			expect(result.answer.reason).toBe(
				"The link is shared, but the start of its link program could not be confirmed.",
			);
			expect(result.answer.next).toContain(look);
			expect(result.answer.next).toContain(
				"call share_app again; a new program replaces any earlier one of this link",
			);
			expect(result.text).not.toContain("ended at once");
			expect(result.text).not.toContain(CLAIM);
		},
	);

	it("tells a link program that ended at once where to read why", async () => {
		const f = await fixture({}, { start: "failed" });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.answer).toMatchObject({ state: "program_ended", linkProgram: { state: "failed" } });
		expect(result.answer.next).toContain("machine_read");
	});

	it("relays the check's refusal in plain words before the review", async () => {
		const f = await fixture(
			{},
			{
				refuse: {
					qorpera_site_share_check: new CloudControlRpcRefused(
						"0A000",
						"APPS_OFF: sharing apps is not switched on yet",
					),
				},
			},
		);
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status).toBe("denied");
		expect(result.text).toBe("REFUSED: APPS_OFF: sharing apps is not switched on yet");
		expect(f.reviewed).toEqual([]);
	});

	it.each([
		[
			"a task machine",
			new CloudControlRpcRefused(
				"55000",
				"APP_MACHINE_NOT_ALWAYS_ON: shop-server is a task machine, which sleeps; share from an always-on machine",
			),
			"REFUSED: APP_MACHINE_NOT_ALWAYS_ON: shop-server is a task machine, which sleeps; share from an always-on machine",
		],
		[
			"no approval",
			new CloudControlRpcRefused(
				"42501",
				"SITE_APPROVAL_REQUIRED: a new app link goes out only after an owner or admin approves it on a card",
			),
			"REFUSED: SITE_APPROVAL_REQUIRED: a new app link goes out only after an owner or admin approves it on a card",
		],
		[
			"words that are not plain",
			new CloudControlRpcRefused("55000", "APP‮REFUSED"),
			"REFUSED: NOT_AVAILABLE: sharing apps is not available now",
		],
	])("relays the share's refusal (%s) as a call that changed nothing", async (_label, refusal, text) => {
		const f = await fixture({}, { refuse: { qorpera_site_share_app: refusal } });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status).toBe("denied");
		expect(result.text).toBe(text);
	});

	it.each([
		["a claim a shell would split", { claim: "abc def ghi jkl mno pqr" }],
		["no word on the password", { newPassword: undefined }],
		["another link than the check's", { url: "https://saml-shop-apps.example.com/" }],
		["a claim a shell would expand", { claim: "$(touch /tmp/x)aaaaaaaaaaaa" }],
		["the program from another host", { clientUrl: "https://evil.example/.qorpera/client.mjs" }],
		["another machine", { machine: "other-server" }],
		["another port", { port: 8080 }],
		["a link that is not the app's", { url: "https://sites.qorpera.com/saml-shop/" }],
	])("never starts a link program from an answer with %s", async (_label, shared) => {
		const f = await fixture({}, { shared });
		const result = outcome(await f.boundary.invoke("call_1", "qorpera", "share_app", SHARE));
		expect(result.status).toBe("unconfirmed");
		expect(result.text).toBe("TOOL_OUTCOME_UNCONFIRMED");
		expect(f.start).not.toHaveBeenCalled();
	});

	it("is registered beside publish_site, with a description that says when to use it", async () => {
		const { tools } = await fixture({});
		expect(tools.map((tool) => tool.name)).toEqual(["publish_site", "unpublish_site", "share_app"]);
		const share = tools.find((tool) => tool.name === "share_app")!;
		expect(share.description).toContain("always-on");
		expect(share.description).toContain("/company/code/<owner>/<name>/worktrees/<workerId>");
		expect(share.description).toContain("publish_site");
		expect(share.description).toContain("The platform starts the link program");
		expect(share.description).toContain("only that program can use it again");
		expect(share.description).not.toContain("timeoutMs");
		expect(share.description).toContain("Settings → Sites");
		expect(Buffer.byteLength(share.description)).toBeLessThanOrEqual(4096);
	});
});
