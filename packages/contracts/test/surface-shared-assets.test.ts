import { describe, expect, it } from "vitest";
import {
	compileIdentityTokens,
	compileIdentityTokensCss,
	IDENTITY_TOKENS_CSS_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	PRODUCT_CATALOG_PATH,
	sharedAssetsConsumedBy,
	sharedAssetsProducedBy,
} from "../src/surface-shared-assets.ts";

describe("surface shared assets & live Identity CSS compiler", () => {
	it("compiles identity/tokens.json colors, fonts, radius, and spacing into CSS custom properties", () => {
		const compiled = compileIdentityTokens(
			JSON.stringify({
				brand: "Thetaband",
				colors: {
					primary: "#1c1917",
					accent: "#c65d3b",
					surface: "#f8f5f0",
					muted: "#ede7de",
				},
				typography: {
					heading: "Fraunces",
					body: "Plus Jakarta Sans",
					mono: "JetBrains Mono",
				},
				radius: {
					card: "14px",
					pill: "999px",
				},
				spacing: {
					section: "72px",
				},
			}),
		);
		expect(compiled.vars["--q-color-accent"]).toBe("#c65d3b");
		expect(compiled.vars["--brand-accent"]).toBe("#c65d3b");
		expect(compiled.vars["--q-color-surface"]).toBe("#f8f5f0");
		expect(compiled.vars["--brand-surface"]).toBe("#f8f5f0");
		expect(compiled.vars["--q-font-heading"]).toContain("Fraunces");
		expect(compiled.vars["--font-body"]).toContain('"Plus Jakarta Sans"');
		expect(compiled.vars["--q-radius-card"]).toBe("14px");
		expect(compiled.vars["--q-space-section"]).toBe("72px");
		expect(compiled.css).toMatch(/^:root \{[\s\S]+\}\n$/);
	});

	it("rejects CSS injection payloads while keeping safe sibling tokens", () => {
		const css = compileIdentityTokensCss(
			JSON.stringify({
				colors: {
					accent: "#2563eb",
					evil: "#fff; } body { background: url(https://evil.example/x); }",
					nestedEvil: "url(javascript:alert(1))",
				},
				typography: {
					heading: "Inter; } script { display: block",
					body: "Inter",
				},
			}),
		);
		expect(css).toContain("--q-color-accent: #2563eb;");
		expect(css).toContain("--q-font-body: Inter,");
		expect(css).not.toContain("evil.example");
		expect(css).not.toContain("javascript:");
		expect(css).not.toContain("script");
	});

	it("declares bidirectional cross-surface shared company file links", () => {
		expect(
			sharedAssetsProducedBy("identity").some((link) => link.sourcePaths.includes(IDENTITY_TOKENS_CSS_PATH)),
		).toBe(true);
		expect(
			sharedAssetsConsumedBy("website").some((link) => link.sourcePaths.includes(IDENTITY_TOKENS_JSON_PATH)),
		).toBe(true);
		expect(sharedAssetsConsumedBy("website").some((link) => link.sourcePaths.includes(PRODUCT_CATALOG_PATH))).toBe(
			true,
		);
		expect(sharedAssetsProducedBy("product").some((link) => link.sourcePaths.includes(PRODUCT_CATALOG_PATH))).toBe(
			true,
		);
	});
});
