// @vitest-environment jsdom
import { type StudioBinaryRef, SURFACE_LAYOUT_SCHEMA } from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { resolveCompanyWordmarks, wordmarkForTheme } from "../src/app/company-wordmark.ts";
import type { Route } from "../src/app/router.ts";
import { attachSurfaces, type CompanyIdentityFiles } from "../src/app/surfaces-store.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { h } from "../src/ui/dom.ts";
import { fixture, profileA, session, staff, stubFigureMotion, team, userA } from "./fixtures.ts";
import {
	CHANGES,
	fakeClient,
	folderContents,
	SESSION,
	storeWith,
	summary,
	session as surfaceSession,
	workspace,
} from "./surface-fixtures.ts";
import "./register-lazy.ts";

const LIGHT_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60"><rect fill="#0e2a47" width="240" height="60"/></svg>';
const DARK_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60"><rect fill="#ffffff" width="240" height="60"/></svg>';
const LOGO_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><circle fill="#0e2a47" cx="30" cy="30" r="24"/></svg>';

function identityFiles(
	files: Readonly<Record<string, string>>,
	binaries: Readonly<Record<string, StudioBinaryRef>> = {},
	folderRoot = "identity",
): CompanyIdentityFiles {
	return {
		surfaceId: "identity-surface",
		folderRoot,
		files,
		baseFiles: files,
		binaries,
		baseBinaries: binaries,
	};
}

function pngRef(sha: string): StudioBinaryRef {
	return {
		manifestSha256: `m-${sha}`,
		fileSha256: sha,
		bytes: 16,
		mediaType: "image/png",
	};
}

function setTheme(theme: "light" | "dark"): void {
	document.documentElement.dataset.theme = theme;
	window.dispatchEvent(new Event("qorpera-theme-change"));
}

describe("resolveCompanyWordmarks", () => {
	it("resolves canonical light and dark SVG wordmarks", () => {
		const marks = resolveCompanyWordmarks(
			identityFiles({
				"identity/logo.svg": LOGO_SVG,
				"identity/wordmark.svg": LIGHT_SVG,
				"identity/wordmark-dark.svg": DARK_SVG,
			}),
		);
		expect(marks.light).toEqual({
			kind: "svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_SVG)}`,
		});
		expect(marks.dark).toEqual({
			kind: "svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DARK_SVG)}`,
		});
		expect(wordmarkForTheme(marks, "light")).toEqual(marks.light);
		expect(wordmarkForTheme(marks, "dark")).toEqual(marks.dark);
	});

	it("uses a single universal wordmark on both light and dark themes", () => {
		const marks = resolveCompanyWordmarks(identityFiles({ "identity/wordmark.svg": LIGHT_SVG }));
		expect(marks.light?.kind).toBe("svg");
		expect(marks.dark).toEqual(marks.light);
	});

	it("keeps theme-specific canonical files scoped to their ground", () => {
		const darkOnly = resolveCompanyWordmarks(identityFiles({ "identity/wordmark-dark.svg": DARK_SVG }));
		expect(darkOnly.light).toBeUndefined();
		expect(darkOnly.dark?.kind).toBe("svg");

		const lightOnly = resolveCompanyWordmarks(identityFiles({ "identity/wordmark-light.svg": LIGHT_SVG }));
		expect(lightOnly.light?.kind).toBe("svg");
		expect(lightOnly.dark).toBeUndefined();
	});

	it("respects split light and dark wordmark brand_mark blocks in layout.json and ignores logo blocks", () => {
		const layout = JSON.stringify({
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{
					id: "overview",
					title: "Overview",
					blocks: [
						{
							type: "row",
							blocks: [
								{
									type: "brand_mark",
									id: "logo-light",
									from: "/identity/logo.svg",
									grounds: ["light"],
									heading: "Logo on light",
								},
								{
									type: "brand_mark",
									id: "wordmark-light",
									from: "/identity/marks/brooks-ink.svg",
									grounds: ["light"],
									heading: "Wordmark on light",
								},
							],
						},
						{
							type: "row",
							blocks: [
								{
									type: "brand_mark",
									id: "logo-dark",
									from: "/identity/logo-dark.svg",
									grounds: ["dark"],
									heading: "Logo on dark",
								},
								{
									type: "brand_mark",
									id: "wordmark-dark",
									from: "/identity/marks/brooks-paper.svg",
									grounds: ["dark"],
									heading: "Wordmark on dark",
								},
							],
						},
					],
				},
			],
		});
		const both = resolveCompanyWordmarks(
			identityFiles({
				"identity/layout.json": layout,
				"identity/logo.svg": LOGO_SVG,
				"identity/logo-dark.svg": LOGO_SVG,
				"identity/marks/brooks-ink.svg": LIGHT_SVG,
				"identity/marks/brooks-paper.svg": DARK_SVG,
			}),
		);
		expect(both.light).toEqual({
			kind: "svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_SVG)}`,
		});
		expect(both.dark).toEqual({
			kind: "svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DARK_SVG)}`,
		});

		const lightMissingDark = resolveCompanyWordmarks(
			identityFiles({
				"identity/layout.json": layout,
				"identity/marks/brooks-ink.svg": LIGHT_SVG,
			}),
		);
		expect(lightMissingDark.light?.kind).toBe("svg");
		expect(lightMissingDark.dark).toBeUndefined();
	});

	it("supports a brand_mark block with an explicit dark binding and falls back when dark is absent", () => {
		const layout = JSON.stringify({
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{
					id: "overview",
					title: "Overview",
					blocks: [
						{
							type: "brand_mark",
							id: "wordmark",
							from: "/identity/custom-wordmark.svg",
							dark: "/identity/custom-wordmark-dark.svg",
							grounds: ["light", "dark"],
							heading: "Wordmark",
						},
					],
				},
			],
		});
		const both = resolveCompanyWordmarks(
			identityFiles({
				"identity/layout.json": layout,
				"identity/custom-wordmark.svg": LIGHT_SVG,
				"identity/custom-wordmark-dark.svg": DARK_SVG,
			}),
		);
		expect(both.light).toEqual({
			kind: "svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_SVG)}`,
		});
		expect(both.dark).toEqual({
			kind: "svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DARK_SVG)}`,
		});

		const fallback = resolveCompanyWordmarks(
			identityFiles({
				"identity/layout.json": layout,
				"identity/custom-wordmark.svg": LIGHT_SVG,
			}),
		);
		expect(fallback.light).toEqual(fallback.dark);
	});

	it("resolves binary wordmarks, extended starter layouts, and skips invalid SVG files", () => {
		const lightPng = pngRef("a".repeat(64));
		const darkPng = pngRef("b".repeat(64));
		const binaryMarks = resolveCompanyWordmarks(
			identityFiles(
				{
					"brand/layout.json": JSON.stringify({
						schema: SURFACE_LAYOUT_SCHEMA,
						extends: "starter",
						tabs: [{ id: "extra", title: "Extra", blocks: [{ type: "artifacts" }] }],
					}),
					"brand/wordmark.svg": "not valid svg",
				},
				{
					"brand/wordmark.png": lightPng,
					"brand/wordmark-dark.png": darkPng,
				},
				"brand",
			),
		);
		expect(binaryMarks.light).toEqual({ kind: "binary", ref: lightPng });
		expect(binaryMarks.dark).toEqual({ kind: "binary", ref: darkPng });
	});
});

describe("sidepanel company selector wordmark", () => {
	const cleanup: (() => void)[] = [];

	beforeEach(() => {
		stubFigureMotion();
		document.documentElement.dataset.theme = "light";
		vi.stubGlobal("innerWidth", 1280);
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	});

	afterEach(() => {
		for (const dispose of cleanup.splice(0).reverse()) dispose();
		openMenu()?.close();
		delete document.documentElement.dataset.theme;
		document.body.replaceChildren();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	function mountRail(options: {
		readonly files?: Readonly<Record<string, string>>;
		readonly binaries?: Readonly<Record<string, StudioBinaryRef>>;
		readonly readCloudBinary?: (file: StudioBinaryRef, signal: AbortSignal) => Promise<Uint8Array>;
		readonly stagedDarkSvg?: string;
	}) {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({
			loading: false,
			staff: [{ ...staff, templateId: "co-founder", displayName: "Co-Founder" }],
			sessions: [session],
			team,
		});
		const identitySurface = summary({
			id: "22222222-2222-4222-8222-222222222299",
			slug: "identity",
			title: "Identity",
			group: "products",
			archetype: "studio",
			kind: "identity",
			isGlobal: true,
			icon: "palette",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "identity",
			siteSlug: null,
			liveUrl: null,
			activeSessionCount: options.stagedDarkSvg ? 1 : 0,
		});
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [identitySurface]),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace(
					options.stagedDarkSvg
						? [
								surfaceSession(["staged"], {
									id: SESSION,
									surfaceId: identitySurface.id,
									changes: [
										{
											id: CHANGES[0],
											sessionId: SESSION,
											surfaceId: identitySurface.id,
											seq: 1,
											title: "Add dark wordmark",
											summary: "",
											kind: "folder_patch",
											status: "staged",
											parentSha: null,
											headSha: null,
											dependsOnChangeIds: [],
											diffStats: null,
											affectedPaths: ["identity/wordmark-dark.svg"],
											conflictPaths: null,
											landedChangeNumber: null,
											canUndo: false,
											createdAt: "2026-11-25T05:00:00.000Z",
											resolvedAt: null,
											patchManifest: [
												{
													op: "write_text",
													path: "identity/wordmark-dark.svg",
													content: options.stagedDarkSvg,
												},
											],
										},
									],
								}),
							]
						: [],
					{ surface: identitySurface },
				),
			),
		});
		const store = storeWith(client, {
			loadCloudFiles: vi.fn(async () => folderContents(options.files ?? {}, options.binaries ?? {})),
			...(options.readCloudBinary ? { readCloudBinary: options.readCloudBinary } : {}),
		});
		attachSurfaces(company, store);
		cleanup.push(() => {
			store.dispose();
			company.stop();
		});
		const rail = h("aside", { class: "rail" });
		document.body.append(h("div", { class: "frame" }, rail));
		const auth = new AuthController(f.cloud);
		cleanup.push(() => auth.dispose());
		const route: Route = { name: "company", profileId: profileA.profileId, section: "home" };
		const draw = () =>
			renderRail(rail, company, {
				profiles: [profileA],
				user: userA,
				route,
				auth,
				invitations: 0,
				openSettings: () => {},
				openFeedback: () => {},
				openFriends: () => {},
			});
		cleanup.push(company.store.subscribe(draw));
		cleanup.push(store.store.subscribe(draw));
		draw();
		return { company, store, rail, identitySurface, draw };
	}

	it("projects the light and dark identity wordmarks matching the website theme and switches live", async () => {
		const { store, rail, identitySurface } = mountRail({
			files: {
				"identity/wordmark.svg": LIGHT_SVG,
				"identity/wordmark-dark.svg": DARK_SVG,
			},
		});
		await store.load();
		await store.refreshCloudFiles(identitySurface);

		const button = rail.querySelector<HTMLButtonElement>(".rail-company")!;
		const img = button.querySelector<HTMLImageElement>(".rail-company-wordmark")!;
		const name = button.querySelector<HTMLElement>(".rail-company-name")!;

		expect(button.classList.contains("has-wordmark")).toBe(true);
		expect(img.hidden).toBe(false);
		expect(name.hidden).toBe(true);
		expect(img.alt).toBe(profileA.profileName);
		expect(img.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_SVG)}`);

		setTheme("dark");
		expect(img.hidden).toBe(false);
		expect(name.hidden).toBe(true);
		expect(img.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(DARK_SVG)}`);

		setTheme("light");
		expect(img.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_SVG)}`);

		button.click();
		expect(document.querySelector(".context-menu")).not.toBeNull();
	});

	it("falls back to the company name when the active theme has no matching wordmark or the image fails", async () => {
		const splitLayout = JSON.stringify({
			schema: SURFACE_LAYOUT_SCHEMA,
			tabs: [
				{
					id: "overview",
					title: "Overview",
					blocks: [
						{
							type: "brand_mark",
							id: "wordmark-light",
							from: "/identity/wordmark.svg",
							grounds: ["light"],
							heading: "Wordmark on light",
						},
						{
							type: "brand_mark",
							id: "wordmark-dark",
							from: "/identity/wordmark-dark.svg",
							grounds: ["dark"],
							heading: "Wordmark on dark",
						},
					],
				},
			],
		});
		const { store, rail, identitySurface } = mountRail({
			files: {
				"identity/layout.json": splitLayout,
				"identity/wordmark.svg": LIGHT_SVG,
			},
		});
		await store.load();
		await store.refreshCloudFiles(identitySurface);

		const button = rail.querySelector<HTMLButtonElement>(".rail-company")!;
		const img = button.querySelector<HTMLImageElement>(".rail-company-wordmark")!;
		const name = button.querySelector<HTMLElement>(".rail-company-name")!;

		expect(img.hidden).toBe(false);
		expect(name.hidden).toBe(true);

		setTheme("dark");
		expect(button.classList.contains("has-wordmark")).toBe(false);
		expect(img.hidden).toBe(true);
		expect(name.hidden).toBe(false);
		expect(name.textContent).toBe(profileA.profileName);

		setTheme("light");
		expect(img.hidden).toBe(false);
		img.dispatchEvent(new Event("error"));
		expect(button.classList.contains("has-wordmark")).toBe(false);
		expect(img.hidden).toBe(true);
		expect(name.hidden).toBe(false);
	});

	it("reflects staged preview wordmarks in preview mode and live files in live mode", async () => {
		const { store, rail, identitySurface } = mountRail({
			files: { "identity/wordmark.svg": LIGHT_SVG },
			stagedDarkSvg: DARK_SVG,
		});
		await store.load();
		await store.openSurface("identity");
		await store.refreshCloudFiles(identitySurface);

		const img = rail.querySelector<HTMLImageElement>(".rail-company-wordmark")!;
		setTheme("dark");
		expect(img.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(DARK_SVG)}`);

		store.setMode("live");
		await Promise.resolve();
		expect(img.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_SVG)}`);
	});

	it("loads binary wordmarks, swaps by theme, and revokes blob URLs on dispose", async () => {
		const created: string[] = [];
		const revoked: string[] = [];
		const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
			const url = `blob:wordmark-${created.length + 1}`;
			created.push(url);
			return url;
		});
		const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
			revoked.push(url);
		});
		const lightPng = pngRef("c".repeat(64));
		const darkPng = pngRef("d".repeat(64));
		const { company, store, rail, identitySurface } = mountRail({
			binaries: {
				"identity/wordmark.png": lightPng,
				"identity/wordmark-dark.png": darkPng,
			},
			readCloudBinary: vi.fn(
				async (ref) => new Uint8Array(ref.fileSha256 === lightPng.fileSha256 ? [1, 2] : [3, 4]),
			),
		});
		await store.load();
		await store.refreshCloudFiles(identitySurface);
		await Promise.resolve();
		await Promise.resolve();

		const img = rail.querySelector<HTMLImageElement>(".rail-company-wordmark")!;
		expect(createUrl).toHaveBeenCalledTimes(2);
		expect(img.hidden).toBe(false);
		expect(img.getAttribute("src")).toBe("blob:wordmark-1");

		setTheme("dark");
		expect(img.getAttribute("src")).toBe("blob:wordmark-2");

		company.stop();
		expect(revokeUrl).toHaveBeenCalledTimes(2);
		expect(revoked).toEqual(["blob:wordmark-1", "blob:wordmark-2"]);
	});
});
