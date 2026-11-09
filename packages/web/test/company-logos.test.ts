// @vitest-environment jsdom

import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyLogos } from "../src/app/company-logos.ts";
import { renamedVision, VISION_PATH } from "../src/app/views/settings-brand.ts";
import type { CloudApi } from "../src/cloud/api.ts";
import type { WebMemberFolder } from "../src/cloud/company-folder-writes.ts";
import {
	COMPANY_BRAND_FOLDER,
	COMPANY_LOGO_PATH,
	type CompanyLogo,
	companyLogoName,
	companyLogoSource,
	parseCompanyLogos,
} from "../src/cloud/company-logos.ts";
import { setCompanyLogos } from "../src/ui/company-logos.ts";
import { companyLogo } from "../src/ui/dom.ts";

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
		listCompanyLogos: vi.fn(async () => rows()),
		downloadCompanyLogo: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
		uploadCompanyLogo: vi.fn(async () => true),
		deleteCompanyLogo: vi.fn(async () => {}),
		publishCompanyLogo: vi.fn(async () => ({ previousObjectName: companyLogoName(COMPANY, OLD) })),
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

	it("saves a chosen picture as the folder's logo.svg, making the brand folder when it is missing", async () => {
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
			{ op: "mkdir", path: COMPANY_BRAND_FOLDER },
			{ op: "write", path: COMPANY_LOGO_PATH, text: "<svg>picked</svg>" },
		]);
	});
});

describe("renaming", () => {
	it("rewrites the vision's heading, or adds one", () => {
		expect(renamedVision("# Old name\n\nWhat we build.\n", "New name")).toBe("# New name\n\nWhat we build.\n");
		expect(renamedVision("\n# Old\nText", "Ny")).toBe("\n# Ny\nText");
		expect(renamedVision("What we build.\n", "New name")).toBe("# New name\n\nWhat we build.\n");
	});

	it("writes a name the vision reads back whole, also one ending in #", () => {
		for (const name of ["Acme #", "C#", "Plain"]) {
			const parsed = parseCompanyStateFile(VISION_PATH, renamedVision("# Old\n\nWhat we build.\n", name));
			expect(parsed?.ok && parsed.file.kind === "vision" ? parsed.file.name : null).toBe(name);
		}
	});
});
