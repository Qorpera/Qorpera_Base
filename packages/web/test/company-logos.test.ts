// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyLogos } from "../src/app/company-logos.ts";
import { renamedVision } from "../src/app/views/settings-brand.ts";
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
});
