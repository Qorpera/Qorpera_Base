// @vitest-environment jsdom

import { type StudioBinaryRef, SURFACE_LAYOUT_SCHEMA } from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCompanyIdentityLogos } from "../src/app/company-identity-logo.ts";
import { CompanyLogos } from "../src/app/company-logos.ts";
import type { CompanyIdentityFiles, SurfacesStore } from "../src/app/surfaces-store.ts";
import { CompanyBrandView } from "../src/app/views/settings-brand.ts";
import type { CloudApi } from "../src/cloud/api.ts";
import type { WebMemberFolder } from "../src/cloud/company-folder-writes.ts";
import {
	COMPANY_IDENTITY_FOLDER,
	COMPANY_IDENTITY_LOGO_PATH,
	COMPANY_LOGO_PATH,
	type CompanyLogo,
	type CompanyLogoChange,
	companyLogoName,
	companyLogoSource,
	parseCompanyLogos,
} from "../src/cloud/company-logos.ts";
import { setCompanyLogos } from "../src/ui/company-logos.ts";
import { companyLogo } from "../src/ui/dom.ts";
import { folderFake } from "./folder-fake.ts";

const COMPANY = "11111111-1111-4111-8111-000000000003";
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

let urls = 0;
beforeEach(() => {
	urls = 0;
	URL.createObjectURL = vi.fn(() => `blob:logo-${++urls}`);
	URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
	setCompanyLogos(undefined);
	document.body.replaceChildren();
	delete document.documentElement.dataset.theme;
	for (let index = localStorage.length - 1; index >= 0; index--) {
		const key = localStorage.key(index);
		if (key?.startsWith("qorpera.web.company-identity-logos.")) localStorage.removeItem(key);
	}
	vi.restoreAllMocks();
});

function row(extra: Partial<CompanyLogo> = {}): CompanyLogo {
	return {
		profileId: COMPANY,
		objectName: companyLogoName(COMPANY, OLD),
		updatedAt: "2026-11-09T10:00:00Z",
		publisher: false,
		sourceSha256: null,
		...extra,
	};
}

function fakeApi(rows: () => CompanyLogo[]) {
	return {
		listCompanyLogos: vi.fn(async (_ids: readonly string[]) => rows()),
		downloadCompanyLogo: vi.fn(async (_name: string) => new Blob(["png"], { type: "image/png" })),
		uploadCompanyLogo: vi.fn(async (_name: string, _png: Blob) => true),
		deleteCompanyLogo: vi.fn(async (_name: string) => {}),
		publishCompanyLogo: vi.fn(
			async (_profileId: string, _name: string | null): Promise<CompanyLogoChange> => ({
				previousObjectName: companyLogoName(COMPANY, OLD),
			}),
		),
		listCompanyLogoObjects: vi.fn(async (): Promise<{ objectName: string; createdAt: number }[]> => []),
	};
}

function fakeFolder(entry: { fileSha256: string; version: string } | null, svg = "<svg/>") {
	const file = entry && {
		manifestSha256: "c".repeat(64),
		fileSha256: entry.fileSha256,
		bytes: svg.length,
		mediaType: "image/svg+xml",
		executable: false,
	};
	return {
		read: vi.fn(async (path: string) => ({
			asOfSeq: 1,
			entry: path === COMPANY_LOGO_PATH && file ? { path, kind: "file", version: entry!.version, file } : null,
		})),
		readFile: vi.fn(async () => new TextEncoder().encode(svg)),
		commit: vi.fn(async (_key: string, units: { op: string; path: string }[]) => ({
			commitId: "x",
			seq: 2,
			replay: false,
			units: units.map((unit, index) => ({
				unit: index + 1,
				op: unit.op,
				path: unit.path,
				to: null,
				version: "v2",
				outcome: "saved",
				reason: null,
				problems: [],
			})),
		})),
		list: vi.fn(),
		stateFolders: vi.fn(),
	};
}

describe("company logo answers", () => {
	it("reads the logo, who may publish, and which SVG the folder holds", () => {
		const [logo] = parseCompanyLogos([
			{
				profile_id: COMPANY,
				object_name: `${COMPANY}/${OLD}.png`,
				updated_at: "2026-11-09T10:00:00Z",
				publisher: true,
				source_sha256: NEW,
				source_bytes: 900,
			},
		]);
		expect(logo).toEqual({
			profileId: COMPANY,
			objectName: `${COMPANY}/${OLD}.png`,
			updatedAt: "2026-11-09T10:00:00Z",
			publisher: true,
			sourceSha256: NEW,
		});
		expect(companyLogoSource(logo!.objectName!)).toBe(OLD);
		expect(() => parseCompanyLogos([{ profile_id: COMPANY, object_name: `someone-else/${OLD}.png` }])).toThrow();
	});
});

describe("company logos on the page", () => {
	it("lays a company's logo over its figure, asked once for every figure of it", async () => {
		const api = fakeApi(() => [row()]);
		setCompanyLogos(new CompanyLogos(api as unknown as CloudApi));
		const first = companyLogo(COMPANY);
		const second = companyLogo(COMPANY);
		await vi.waitFor(() =>
			expect(first.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1"),
		);
		expect(second.classList.contains("has-logo")).toBe(true);
		expect(api.listCompanyLogos).toHaveBeenCalledTimes(1);
		expect(api.downloadCompanyLogo).toHaveBeenCalledTimes(1);
	});

	it("loads logos again after the account changed while a read was out", async () => {
		let answer!: (rows: CompanyLogo[]) => void;
		const api = fakeApi(() => [row()]);
		api.listCompanyLogos.mockImplementationOnce(
			() =>
				new Promise<CompanyLogo[]>((resolve) => {
					answer = resolve;
				}),
		);
		const logos = new CompanyLogos(api as unknown as CloudApi);
		setCompanyLogos(logos);
		companyLogo(COMPANY);
		await vi.waitFor(() => expect(api.listCompanyLogos).toHaveBeenCalledTimes(1));
		logos.reset();
		const figure = companyLogo(COMPANY);
		await vi.waitFor(() => expect(figure.querySelector("img.company-logo-picture")).not.toBeNull());
		answer([row()]);
		expect(api.listCompanyLogos).toHaveBeenCalledTimes(2);
	});

	it("drops an older read that answers after a newer one, also one that says there is no logo", async () => {
		let answer!: (rows: CompanyLogo[]) => void;
		const api = fakeApi(() => [row({ objectName: companyLogoName(COMPANY, NEW) })]);
		api.listCompanyLogos.mockImplementationOnce(
			() =>
				new Promise<CompanyLogo[]>((resolve) => {
					answer = resolve;
				}),
		);
		const logos = new CompanyLogos(api as unknown as CloudApi);
		setCompanyLogos(logos);
		const figure = companyLogo(COMPANY);
		await vi.waitFor(() => expect(answer).toBeDefined());
		// A sync publishes and shows B while the page's first read is still out.
		await logos.refresh(COMPANY);
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1");
		answer([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1");
		expect(logos.logo(COMPANY)?.objectName).toBe(companyLogoName(COMPANY, NEW));
	});

	it("asks again after the retry time when the read after publishing failed", async () => {
		let now = Date.parse("2026-11-09T12:00:00Z");
		let answer!: (rows: CompanyLogo[]) => void;
		let current = row({ objectName: null, publisher: true, sourceSha256: NEW });
		const api = fakeApi(() => [current]);
		api.listCompanyLogos.mockImplementationOnce(
			() =>
				new Promise<CompanyLogo[]>((resolve) => {
					answer = resolve;
				}),
		);
		api.publishCompanyLogo.mockImplementation(async () => {
			current = row({ objectName: companyLogoName(COMPANY, NEW), publisher: true, sourceSha256: NEW });
			api.listCompanyLogos.mockRejectedValueOnce(new Error("offline"));
			return {};
		});
		const logos = new CompanyLogos(api as unknown as CloudApi, {
			rasterize: async () => new Blob(["drawn"]),
			now: () => now,
		});
		setCompanyLogos(logos);
		companyLogo(COMPANY);
		await vi.waitFor(() => expect(answer).toBeDefined());
		const folder = fakeFolder({ fileSha256: NEW, version: "v1" });
		await logos.sync(COMPANY, () => folder as unknown as WebMemberFolder, new AbortController().signal);
		answer([]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		now += 61_000;
		const figure = companyLogo(COMPANY);
		await vi.waitFor(() =>
			expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1"),
		);
		expect(logos.logo(COMPANY)?.objectName).toBe(companyLogoName(COMPANY, NEW));
	});

	it("releases a shown logo's URL when a read of it fails, and shows the logo again after the retry", async () => {
		let now = Date.parse("2026-11-09T12:00:00Z");
		const api = fakeApi(() => [row()]);
		const logos = new CompanyLogos(api as unknown as CloudApi, { now: () => now });
		setCompanyLogos(logos);
		const figure = companyLogo(COMPANY);
		await vi.waitFor(() =>
			expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1"),
		);
		api.listCompanyLogos.mockRejectedValueOnce(new Error("offline"));
		await logos.refresh(COMPANY);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:logo-1");
		expect(figure.querySelector("img.company-logo-picture")).toBeNull();
		now += 61_000;
		const again = companyLogo(COMPANY);
		await vi.waitFor(() =>
			expect(again.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-2"),
		);
		logos.reset();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:logo-2");
	});

	it("keeps the newest logo when an older download finishes last", async () => {
		const downloads: ((blob: Blob) => void)[] = [];
		let current = row();
		const api = fakeApi(() => [current]);
		api.downloadCompanyLogo.mockImplementation(() => new Promise<Blob>((resolve) => downloads.push(resolve)));
		const logos = new CompanyLogos(api as unknown as CloudApi);
		setCompanyLogos(logos);
		const figure = companyLogo(COMPANY);
		await vi.waitFor(() => expect(downloads).toHaveLength(1));
		current = row({ objectName: companyLogoName(COMPANY, NEW) });
		const refreshed = logos.refresh(COMPANY);
		await vi.waitFor(() => expect(downloads).toHaveLength(2));
		downloads[1]!(new Blob(["new"]));
		await refreshed;
		downloads[0]!(new Blob(["old"]));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1");
		expect(logos.logo(COMPANY)?.objectName).toBe(companyLogoName(COMPANY, NEW));
	});

	it("keeps the figure for a company without a logo", async () => {
		const api = fakeApi(() => []);
		setCompanyLogos(new CompanyLogos(api as unknown as CloudApi));
		const figure = companyLogo(COMPANY);
		await vi.waitFor(() => expect(api.listCompanyLogos).toHaveBeenCalled());
		expect(figure.querySelector("img.company-logo-picture")).toBeNull();
	});
});

describe("keeping the logo in step with the folder", () => {
	it("draws and publishes the folder's new logo.svg, then deletes the old drawing", async () => {
		let current = row({ publisher: true, sourceSha256: NEW });
		const api = fakeApi(() => [current]);
		api.publishCompanyLogo.mockImplementation(async () => {
			current = row({ objectName: companyLogoName(COMPANY, NEW), publisher: true, sourceSha256: NEW });
			return { previousObjectName: companyLogoName(COMPANY, OLD) };
		});
		const rasterize = vi.fn(async () => new Blob(["drawn"], { type: "image/png" }));
		const logos = new CompanyLogos(api as unknown as CloudApi, { rasterize });
		const folder = fakeFolder({ fileSha256: NEW, version: "v1" }, "<svg>new</svg>");
		await logos.sync(COMPANY, () => folder as unknown as WebMemberFolder, new AbortController().signal);
		expect(rasterize).toHaveBeenCalledWith("<svg>new</svg>", 512);
		expect(api.uploadCompanyLogo).toHaveBeenCalledWith(companyLogoName(COMPANY, NEW), expect.any(Blob));
		expect(api.publishCompanyLogo).toHaveBeenCalledWith(COMPANY, companyLogoName(COMPANY, NEW));
		expect(api.deleteCompanyLogo).toHaveBeenCalledWith(companyLogoName(COMPANY, OLD));
		expect(logos.logo(COMPANY)?.objectName).toBe(companyLogoName(COMPANY, NEW));
	});

	it("deletes its upload when publishing fails, and clears drawings no sync published", async () => {
		const now = Date.parse("2026-11-09T12:00:00Z");
		const stale = companyLogoName(COMPANY, "c".repeat(64));
		const fresh = companyLogoName(COMPANY, "d".repeat(64));
		let current = row({ publisher: true, sourceSha256: NEW });
		const api = fakeApi(() => [current]);
		api.listCompanyLogoObjects.mockResolvedValue([
			{ objectName: companyLogoName(COMPANY, OLD), createdAt: now - 3_600_000 },
			{ objectName: stale, createdAt: now - 3_600_000 },
			{ objectName: fresh, createdAt: now - 60_000 },
		]);
		api.publishCompanyLogo.mockImplementation(async () => {
			current = row({ publisher: true, sourceSha256: "e".repeat(64) });
			throw new Error("the folder moved on");
		});
		const logos = new CompanyLogos(api as unknown as CloudApi, {
			rasterize: async () => new Blob(["drawn"]),
			now: () => now,
		});
		const folder = fakeFolder({ fileSha256: NEW, version: "v1" });
		await expect(
			logos.sync(COMPANY, () => folder as unknown as WebMemberFolder, new AbortController().signal),
		).rejects.toThrow("the folder moved on");
		// The logo everyone sees and another member's fresh upload stay; the stale drawing and the failed upload go.
		expect(api.deleteCompanyLogo.mock.calls.map(([name]) => name)).toEqual([stale, companyLogoName(COMPANY, NEW)]);
	});

	it("keeps a drawing that failed to publish while it still matches the folder, for whoever publishes it", async () => {
		const api = fakeApi(() => [row({ publisher: true, sourceSha256: NEW })]);
		// Another member uploaded the same drawing and has not published it yet.
		api.uploadCompanyLogo.mockResolvedValue(false);
		api.publishCompanyLogo.mockRejectedValue(new Error("network"));
		const logos = new CompanyLogos(api as unknown as CloudApi, { rasterize: async () => new Blob(["drawn"]) });
		await expect(
			logos.sync(
				COMPANY,
				() => fakeFolder({ fileSha256: NEW, version: "v1" }) as unknown as WebMemberFolder,
				new AbortController().signal,
			),
		).rejects.toThrow("network");
		expect(api.deleteCompanyLogo).not.toHaveBeenCalled();
		// The page still shows the logo the cloud had.
		expect(logos.logo(COMPANY)?.objectName).toBe(companyLogoName(COMPANY, OLD));
	});

	it("deletes the oldest other drawings while the folder is full, however fresh", async () => {
		const now = Date.parse("2026-11-09T12:00:00Z");
		const others = ["c", "d", "e"].map((hex, index) => ({
			objectName: companyLogoName(COMPANY, hex.repeat(64)),
			createdAt: now - 60_000 + index,
		}));
		const api = fakeApi(() => [row({ publisher: true, sourceSha256: NEW })]);
		api.listCompanyLogoObjects.mockResolvedValue([
			{ objectName: companyLogoName(COMPANY, OLD), createdAt: now - 3_600_000 },
			...others,
		]);
		const logos = new CompanyLogos(api as unknown as CloudApi, {
			rasterize: async () => new Blob(["drawn"]),
			now: () => now,
		});
		await logos.sync(
			COMPANY,
			() => fakeFolder({ fileSha256: NEW, version: "v1" }) as unknown as WebMemberFolder,
			new AbortController().signal,
		);
		expect(api.deleteCompanyLogo.mock.calls.map(([name]) => name).slice(0, 1)).toEqual([others[0]!.objectName]);
		expect(api.uploadCompanyLogo).toHaveBeenCalled();
	});

	it("syncs again after a removal made while a sync was running", async () => {
		let release!: () => void;
		let current = row({ publisher: true, sourceSha256: OLD });
		const api = fakeApi(() => [current]);
		const download = api.downloadCompanyLogo.getMockImplementation()!;
		api.downloadCompanyLogo.mockImplementationOnce(async (name: string) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return download(name);
		});
		api.publishCompanyLogo.mockImplementation(async () => {
			current = row({ objectName: null, publisher: true });
			return { previousObjectName: companyLogoName(COMPANY, OLD) };
		});
		const logos = new CompanyLogos(api as unknown as CloudApi);
		const folder = fakeFolder({ fileSha256: OLD, version: "v1" });
		const opening = logos.sync(COMPANY, () => folder as unknown as WebMemberFolder, new AbortController().signal);
		await vi.waitFor(() => expect(release).toBeDefined());
		// The SVG is deleted while the opening sync is still downloading the logo it found.
		current = row({ publisher: true, sourceSha256: null });
		folder.read.mockResolvedValue({ asOfSeq: 2, entry: null });
		const removing = logos.remove(COMPANY, () => folder as unknown as WebMemberFolder, new AbortController().signal);
		release();
		await Promise.all([opening, removing]);
		expect(api.publishCompanyLogo).toHaveBeenCalledWith(COMPANY, null);
		expect(logos.logo(COMPANY)?.objectName).toBeNull();
	});

	it("does nothing when the drawing is current, or the member may not publish", async () => {
		for (const answer of [
			row({ publisher: true, sourceSha256: OLD }),
			row({ publisher: false, sourceSha256: null }),
		]) {
			const api = fakeApi(() => [answer]);
			const folder = fakeFolder({ fileSha256: NEW, version: "v1" });
			await new CompanyLogos(api as unknown as CloudApi).sync(
				COMPANY,
				() => folder as unknown as WebMemberFolder,
				new AbortController().signal,
			);
			expect(api.uploadCompanyLogo).not.toHaveBeenCalled();
			expect(api.publishCompanyLogo).not.toHaveBeenCalled();
		}
	});

	it("takes the drawing away once the folder has no logo", async () => {
		let current = row({ publisher: true, sourceSha256: null });
		const api = fakeApi(() => [current]);
		api.publishCompanyLogo.mockImplementation(async () => {
			current = row({ objectName: null, publisher: true });
			return { previousObjectName: companyLogoName(COMPANY, OLD) };
		});
		const logos = new CompanyLogos(api as unknown as CloudApi);
		await logos.sync(COMPANY, () => fakeFolder(null) as unknown as WebMemberFolder, new AbortController().signal);
		expect(api.publishCompanyLogo).toHaveBeenCalledWith(COMPANY, null);
		expect(api.deleteCompanyLogo).toHaveBeenCalledWith(companyLogoName(COMPANY, OLD));
	});

	it("saves a chosen picture as the Identity logo.svg, making the identity folder when it is missing", async () => {
		const api = fakeApi(() => [row({ objectName: null, publisher: true, sourceSha256: null })]);
		const wrap = vi.fn(async () => "<svg>picked</svg>");
		const logos = new CompanyLogos(api as unknown as CloudApi, { wrap });
		const folder = fakeFolder(null);
		await logos.choose(
			COMPANY,
			new File(["x"], "logo.png", { type: "image/png" }),
			{ x: 0, y: 0, side: 10 },
			() => folder as unknown as WebMemberFolder,
			new AbortController().signal,
		);
		expect(folder.commit).toHaveBeenCalledTimes(1);
		expect(folder.commit.mock.calls[0]![1]).toEqual([
			{ op: "mkdir", path: COMPANY_IDENTITY_FOLDER },
			{ op: "write", path: COMPANY_IDENTITY_LOGO_PATH, text: "<svg>picked</svg>" },
		]);
		logos.dispose();
	});

	it("parses source_path and syncs Identity svg and raster logos", async () => {
		const [parsed] = parseCompanyLogos([
			{
				profile_id: COMPANY,
				object_name: null,
				updated_at: null,
				publisher: true,
				source_sha256: NEW,
				source_path: "identity/logo.png",
			},
		]);
		expect(parsed?.sourcePath).toBe("identity/logo.png");

		let current = row({ publisher: true, sourceSha256: NEW, sourcePath: "identity/logo.png" });
		const api = fakeApi(() => [current]);
		api.publishCompanyLogo.mockImplementation(async () => {
			current = row({
				objectName: companyLogoName(COMPANY, NEW),
				publisher: true,
				sourceSha256: NEW,
				sourcePath: "identity/logo.png",
			});
			return { previousObjectName: companyLogoName(COMPANY, OLD) };
		});
		const rasterizeImage = vi.fn(async () => new Blob(["png-out"], { type: "image/png" }));
		const logos = new CompanyLogos(api as unknown as CloudApi, { rasterizeImage });
		const fake = {
			...fakeFolder(null),
			read: vi.fn(async (path: string) => ({
				asOfSeq: 1,
				entry:
					path === "identity/logo.png"
						? {
								path,
								kind: "file" as const,
								version: "v1",
								file: {
									manifestSha256: "c".repeat(64),
									fileSha256: NEW,
									bytes: 4,
									mediaType: "image/png",
									executable: false,
								},
							}
						: null,
			})),
			readFile: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
		};
		await logos.sync(COMPANY, () => fake as unknown as WebMemberFolder, new AbortController().signal);
		expect(rasterizeImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]), "image/png", 512);
		expect(api.uploadCompanyLogo).toHaveBeenCalledWith(companyLogoName(COMPANY, NEW), expect.any(Blob));
		expect(api.publishCompanyLogo).toHaveBeenCalledWith(COMPANY, companyLogoName(COMPANY, NEW));
		logos.dispose();
	});

	it("removes both Identity logos and legacy brand logo on remove", async () => {
		const { folder, put } = folderFake();
		put("identity/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
		put("identity/logo-dark.svg", '<svg xmlns="http://www.w3.org/2000/svg"><circle fill="#fff" r="4"/></svg>');
		put(COMPANY_LOGO_PATH, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
		const api = fakeApi(() => [row({ objectName: null, publisher: true, sourceSha256: null })]);
		const logos = new CompanyLogos(api as unknown as CloudApi);
		await logos.remove(COMPANY, () => folder as unknown as WebMemberFolder, new AbortController().signal);
		expect(await folder.read("identity/logo.svg", new AbortController().signal)).toMatchObject({ entry: null });
		expect(await folder.read("identity/logo-dark.svg", new AbortController().signal)).toMatchObject({ entry: null });
		expect(await folder.read(COMPANY_LOGO_PATH, new AbortController().signal)).toMatchObject({ entry: null });
		logos.dispose();
	});

	it("writes choose to custom layout svg path and clears competing dark logo", async () => {
		const { folder, put } = folderFake();
		put(
			"identity/layout.json",
			JSON.stringify({
				schema: SURFACE_LAYOUT_SCHEMA,
				tabs: [
					{
						id: "overview",
						title: "Overview",
						blocks: [
							{
								type: "brand_mark",
								id: "logo",
								heading: "Logo",
								from: "/identity/mark.svg",
								grounds: ["light", "dark"],
							},
							{ type: "brand_mark", id: "wordmark", heading: "Wordmark", from: "/identity/wordmark.svg" },
						],
					},
				],
			}),
		);
		put("identity/logo-dark.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff"/></svg>');
		const api = fakeApi(() => [row({ objectName: null, publisher: true, sourceSha256: null })]);
		const logos = new CompanyLogos(api as unknown as CloudApi, {
			wrap: async () => '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#123"/></svg>',
		});
		setCompanyLogos(logos);
		const figure = companyLogo(COMPANY);
		await logos.choose(
			COMPANY,
			new File(["x"], "logo.png", { type: "image/png" }),
			{ x: 0, y: 0, side: 10 },
			() => folder as unknown as WebMemberFolder,
			new AbortController().signal,
		);
		const written = await folder.read("identity/mark.svg", new AbortController().signal);
		expect(written.entry?.kind).toBe("file");
		expect(await folder.read("identity/logo-dark.svg", new AbortController().signal)).toMatchObject({ entry: null });
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toContain("data:image/svg+xml");
		logos.dispose();
	});
});

const LIGHT_LOGO =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="#111" width="64" height="64"/></svg>';
const DARK_LOGO =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect fill="#fff" width="64" height="64"/></svg>';
const STAGED_LOGO =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle fill="#0a7" cx="32" cy="32" r="24"/></svg>';
const WORDMARK_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 60"><rect fill="#333" width="240" height="60"/></svg>';

function makeFakeSurfacesStore(initial: {
	identity: CompanyIdentityFiles | null;
	loaded?: boolean;
	readBinary?: (ref: StudioBinaryRef) => Promise<Uint8Array>;
}) {
	let current = initial.identity;
	let loaded = initial.loaded ?? true;
	const listeners = new Set<() => void>();
	const store = {
		get state() {
			return {
				source: loaded ? "cloud" : "loading",
				mode: "preview",
				surfaces: current
					? [{ id: current.surfaceId, status: "active", isGlobal: true, activeSessionCount: 0, slug: "identity" }]
					: [],
				surfaceLooks: {},
				cloudSurfaceFiles: current ? { [current.surfaceId]: current.baseFiles } : {},
				localStudioBase: {},
				workspaces: {},
			};
		},
		fellBackAfterLoadError: false,
		store: {
			subscribe(listener: () => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		companyIdentityFiles() {
			return current;
		},
		readStudioBinary: vi.fn(async (ref: StudioBinaryRef) => {
			if (initial.readBinary) return initial.readBinary(ref);
			return new Uint8Array([137, 80, 78, 71]);
		}),
		set(next: CompanyIdentityFiles | null, nextLoaded = true) {
			current = next;
			loaded = nextLoaded;
			for (const listener of [...listeners]) listener();
		},
	};
	return store;
}

describe("linking company logo to the Identity interface", () => {
	it("resolves logo brand_mark blocks from layout.json while ignoring wordmarks", () => {
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
									id: "logo",
									heading: "Logo",
									from: "/identity/emblem.svg",
									grounds: ["light", "dark"],
								},
								{
									type: "brand_mark",
									id: "wordmark",
									heading: "Wordmark",
									from: "/identity/wordmark.svg",
									grounds: ["light", "dark"],
								},
							],
						},
					],
				},
			],
		});
		const identity: CompanyIdentityFiles = {
			surfaceId: "s-id",
			folderRoot: "identity",
			files: {
				"identity/layout.json": layout,
				"identity/emblem.svg": LIGHT_LOGO,
				"identity/logo-dark.svg": DARK_LOGO,
				"identity/wordmark.svg": WORDMARK_SVG,
			},
			baseFiles: {
				"identity/layout.json": layout,
				"identity/emblem.svg": LIGHT_LOGO,
				"identity/logo-dark.svg": DARK_LOGO,
				"identity/wordmark.svg": WORDMARK_SVG,
			},
			binaries: {},
			baseBinaries: {},
		};
		const resolved = resolveCompanyIdentityLogos(identity);
		expect(resolved.light).toEqual({
			kind: "svg",
			path: "identity/emblem.svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_LOGO)}`,
		});
		expect(resolved.dark).toEqual({
			kind: "svg",
			path: "identity/logo-dark.svg",
			src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(DARK_LOGO)}`,
		});
		expect(resolved.writePath).toBe("identity/emblem.svg");
	});

	it("paints the Identity logo live, follows theme and Preview changes, and triggers cloud sync on base changes", async () => {
		document.documentElement.dataset.theme = "light";
		const api = fakeApi(() => []);
		const logos = new CompanyLogos(api as unknown as CloudApi, { scope: "https://test.supabase.co" });
		logos.setAccount("user-1", false);
		setCompanyLogos(logos);

		const onBaseLogoChange = vi.fn();
		const fakeStore = makeFakeSurfacesStore({
			identity: {
				surfaceId: "s-id",
				folderRoot: "identity",
				files: { "identity/logo.svg": LIGHT_LOGO, "identity/logo-dark.svg": DARK_LOGO },
				baseFiles: { "identity/logo.svg": LIGHT_LOGO, "identity/logo-dark.svg": DARK_LOGO },
				binaries: {},
				baseBinaries: {},
			},
		});
		const ac = new AbortController();
		logos.bindIdentity(COMPANY, fakeStore as unknown as SurfacesStore, ac.signal, { onBaseLogoChange });

		const figure = companyLogo(COMPANY);
		expect(figure.classList.contains("has-logo")).toBe(true);
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe(
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_LOGO)}`,
		);
		expect(logos.hasLogo(COMPANY)).toBe(true);

		document.documentElement.dataset.theme = "dark";
		window.dispatchEvent(new CustomEvent("qorpera-theme-change"));
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe(
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(DARK_LOGO)}`,
		);

		document.documentElement.dataset.theme = "light";
		window.dispatchEvent(new CustomEvent("qorpera-theme-change"));
		fakeStore.set({
			surfaceId: "s-id",
			folderRoot: "identity",
			files: { "identity/logo.svg": STAGED_LOGO },
			baseFiles: { "identity/logo.svg": LIGHT_LOGO, "identity/logo-dark.svg": DARK_LOGO },
			binaries: {},
			baseBinaries: {},
		});
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe(
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(STAGED_LOGO)}`,
		);
		expect(onBaseLogoChange).not.toHaveBeenCalled();

		fakeStore.set({
			surfaceId: "s-id",
			folderRoot: "identity",
			files: { "identity/logo.svg": STAGED_LOGO },
			baseFiles: { "identity/logo.svg": STAGED_LOGO },
			binaries: {},
			baseBinaries: {},
		});
		expect(onBaseLogoChange).toHaveBeenCalledTimes(1);

		fakeStore.set({
			surfaceId: "s-id",
			folderRoot: "identity",
			files: {},
			baseFiles: { "identity/logo.svg": STAGED_LOGO },
			binaries: {},
			baseBinaries: {},
		});
		expect(figure.querySelector("img.company-logo-picture")).toBeNull();
		expect(figure.classList.contains("has-logo")).toBe(false);

		ac.abort();
		logos.dispose();
	});

	it("renders binary raster Identity logos from SurfacesStore", async () => {
		const api = fakeApi(() => []);
		const logos = new CompanyLogos(api as unknown as CloudApi);
		setCompanyLogos(logos);
		const ref: StudioBinaryRef = {
			manifestSha256: "m".repeat(64),
			fileSha256: "f".repeat(64),
			bytes: 4,
			mediaType: "image/png",
		};
		const fakeStore = makeFakeSurfacesStore({
			identity: {
				surfaceId: "s-id",
				folderRoot: "identity",
				files: {},
				baseFiles: {},
				binaries: { "identity/logo.png": ref },
				baseBinaries: { "identity/logo.png": ref },
			},
		});
		const ac = new AbortController();
		logos.bindIdentity(COMPANY, fakeStore as unknown as SurfacesStore, ac.signal);
		const figure = companyLogo(COMPANY);
		await vi.waitFor(() =>
			expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1"),
		);
		ac.abort();
		logos.dispose();
	});

	it("prefetches Identity logos, persists them per account, and prefers newer cloud logos on Hub", async () => {
		const { folder, put } = folderFake();
		put("identity/logo.svg", LIGHT_LOGO);
		put("identity/logo-dark.svg", DARK_LOGO);

		const now = Date.parse("2026-11-25T07:00:00Z");
		const api = fakeApi(() => []);
		const first = new CompanyLogos(api as unknown as CloudApi, { scope: "https://test.supabase.co", now: () => now });
		first.setAccount("user-1", false);
		setCompanyLogos(first);
		await first.prefetchIdentity(COMPANY, () => folder);
		const figure = companyLogo(COMPANY);
		expect(figure.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe(
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_LOGO)}`,
		);
		first.dispose();

		const cloudApi = fakeApi(() => [
			row({ objectName: companyLogoName(COMPANY, NEW), updatedAt: "2026-11-25T08:00:00Z" }),
		]);
		const second = new CompanyLogos(cloudApi as unknown as CloudApi, {
			scope: "https://test.supabase.co",
			now: () => now,
		});
		second.setAccount("user-1", false);
		setCompanyLogos(second);
		const reloaded = companyLogo(COMPANY);
		expect(reloaded.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe(
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_LOGO)}`,
		);
		await vi.waitFor(() =>
			expect(reloaded.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe("blob:logo-1"),
		);

		second.setAccount("user-2", true);
		expect(localStorage.getItem("qorpera.web.company-identity-logos.v1:https://test.supabase.co:user-1")).toBeNull();
		second.dispose();
	});

	it("updates Settings CompanyBrandView label and logo when Identity logo arrives", async () => {
		const api = fakeApi(() => []);
		const logos = new CompanyLogos(api as unknown as CloudApi);
		setCompanyLogos(logos);
		const ac = new AbortController();
		const fakeStore = makeFakeSurfacesStore({
			identity: {
				surfaceId: "s-id",
				folderRoot: "identity",
				files: {},
				baseFiles: {},
				binaries: {},
				baseBinaries: {},
			},
		});
		logos.bindIdentity(COMPANY, fakeStore as unknown as SurfacesStore, ac.signal);

		const brand = new CompanyBrandView({
			profileId: COMPANY,
			name: () => "Rivernote",
			canManage: () => true,
			folder: () => fakeFolder(null) as unknown as WebMemberFolder,
			signal: ac.signal,
			renamed: () => {},
		});
		const button = brand.el.querySelector<HTMLButtonElement>(".settings-brand-logo")!;
		expect(button.getAttribute("aria-label")).toBe("Add a company logo");

		fakeStore.set({
			surfaceId: "s-id",
			folderRoot: "identity",
			files: { "identity/logo.svg": LIGHT_LOGO },
			baseFiles: { "identity/logo.svg": LIGHT_LOGO },
			binaries: {},
			baseBinaries: {},
		});
		expect(button.getAttribute("aria-label")).toBe("Change the company logo");
		expect(brand.el.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe(
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_LOGO)}`,
		);
		ac.abort();
		logos.dispose();
	});

	it("clears the live Identity logo immediately on remove and notifies logoChanged", async () => {
		const { folder, put } = folderFake();
		put("identity/logo.svg", LIGHT_LOGO);
		const api = fakeApi(() => [row({ objectName: null, publisher: true, sourceSha256: null })]);
		const logos = new CompanyLogos(api as unknown as CloudApi);
		setCompanyLogos(logos);
		const ac = new AbortController();
		const fakeStore = makeFakeSurfacesStore({
			identity: {
				surfaceId: "s-id",
				folderRoot: "identity",
				files: { "identity/logo.svg": LIGHT_LOGO },
				baseFiles: { "identity/logo.svg": LIGHT_LOGO },
				binaries: {},
				baseBinaries: {},
			},
		});
		logos.bindIdentity(COMPANY, fakeStore as unknown as SurfacesStore, ac.signal);
		const logoChanged = vi.fn();
		const brand = new CompanyBrandView({
			profileId: COMPANY,
			name: () => "Rivernote",
			canManage: () => true,
			folder: () => folder as unknown as WebMemberFolder,
			signal: ac.signal,
			renamed: () => {},
			logoChanged,
		});
		expect(brand.el.querySelector("img.company-logo-picture")?.getAttribute("src")).toBe(
			`data:image/svg+xml;charset=utf-8,${encodeURIComponent(LIGHT_LOGO)}`,
		);
		brand.el.querySelector<HTMLButtonElement>(".settings-brand-logo")!.click();
		brand.el.querySelector<HTMLButtonElement>(".account-picture-remove")!.click();
		await vi.waitFor(() => expect(logoChanged).toHaveBeenCalledTimes(1));
		expect(brand.el.querySelector("img.company-logo-picture")).toBeNull();
		expect(brand.el.querySelector<HTMLButtonElement>(".settings-brand-logo")!.getAttribute("aria-label")).toBe(
			"Add a company logo",
		);
		ac.abort();
		logos.dispose();
	});
});
