import { describe, expect, it } from "vitest";
import {
	parseSurfaceManifestToml,
	parseSurfaceOrderFile,
	renderSurfaceManifestToml,
	renderSurfaceOrderFile,
	surfaceManifestPath,
} from "../src/surfaces.ts";

describe("cloud-client surface state files", () => {
	it("round-trips surface.toml manifests and rejects slug mismatches or unknown keys", () => {
		const path = surfaceManifestPath("website");
		const text = renderSurfaceManifestToml({
			schema: "qorpera.surface/v1",
			slug: "website",
			title: "Website",
			group: "products",
			archetype: "live_build",
			icon: "globe",
			status: "active",
			autoPublish: true,
			source: {
				kind: "code_repo",
				repository: "thetaband/website",
				baseBranch: "main",
				siteSlug: "thetaband",
				folderRoot: null,
			},
			preview: {
				mode: "static_site",
				defaultRoute: "/",
				allowCompare: true,
				allowPointToChange: true,
			},
		});

		const parsed = parseSurfaceManifestToml(path, text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected valid manifest");
		expect(parsed.file.slug).toBe("website");
		expect(parsed.file.autoPublish).toBe(true);
		expect(parsed.file.source.siteSlug).toBe("thetaband");
		expect(parsed.file.preview.allowCompare).toBe(true);

		const mismatch = parseSurfaceManifestToml(surfaceManifestPath("brand"), text);
		expect(mismatch.ok).toBe(false);

		const unknownKey = parseSurfaceManifestToml(path, `${text}\nextra_key = true\n`);
		expect(unknownKey.ok).toBe(false);
	});

	it("parses and renders QorperaOS/surfaces/order.md cleanly", () => {
		const rendered = renderSurfaceOrderFile({
			products: ["website", "meditation-app", "headband", "brand"],
			operations: ["inbox", "money", "files"],
		});
		const parsed = parseSurfaceOrderFile(rendered);
		expect(parsed).toEqual({
			products: ["website", "meditation-app", "headband", "brand"],
			operations: ["inbox", "money", "files"],
		});
	});

	it("round-trips Identity global surface.toml fields and rejects bad accent hex", () => {
		const path = surfaceManifestPath("identity");
		const text = renderSurfaceManifestToml({
			schema: "qorpera.surface/v1",
			slug: "identity",
			title: "Identity",
			group: "products",
			archetype: "studio",
			kind: "identity",
			accentHex: "#d76f45",
			isGlobal: true,
			icon: "spark",
			status: "active",
			autoPublish: false,
			source: {
				kind: "folder",
				repository: null,
				baseBranch: null,
				siteSlug: null,
				folderRoot: "identity",
			},
			preview: {
				mode: "studio_overlay",
				defaultRoute: "/",
				allowCompare: false,
				allowPointToChange: false,
			},
		});
		const parsed = parseSurfaceManifestToml(path, text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("expected valid identity manifest");
		expect(parsed.file.kind).toBe("identity");
		expect(parsed.file.accentHex).toBe("#d76f45");
		expect(parsed.file.isGlobal).toBe(true);

		const badAccent = parseSurfaceManifestToml(path, text.replace("#d76f45", "not-a-color"));
		expect(badAccent.ok).toBe(false);
	});
});
