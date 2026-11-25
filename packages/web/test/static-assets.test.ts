import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultVoiceProfiles } from "../src/cloud/default-models.ts";
import { PREVIEWABLE_VOICE_MODELS, type VoicePreviewLocale, voiceSampleRelativePath } from "../src/ui/voice-preview.ts";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "../public");
const styles = join(here, "../src/styles");

function listFiles(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		return entry.isDirectory() ? listFiles(join(dir, entry.name), rel) : [rel];
	});
}

describe("static assets", () => {
	it("ships every asset a stylesheet loads from public/, which the build copies whole", () => {
		const urls = readdirSync(styles)
			.filter((name) => name.endsWith(".css"))
			.flatMap((name) =>
				[...readFileSync(join(styles, name), "utf8").matchAll(/url\("?(\/assets\/[^")]+)"?\)/g)].map(
					(match) => match[1] ?? "",
				),
			);
		expect(urls).toContain("/assets/fonts/source-sans-3-latin-normal.woff2");
		for (const url of urls) expect(existsSync(join(publicDir, url)), url).toBe(true);
	});

	it("ships English and Danish sample clips for every previewable voice model and profile", () => {
		const locales: readonly VoicePreviewLocale[] = ["en", "da"];
		const expected = new Set<string>();
		for (const modelId of PREVIEWABLE_VOICE_MODELS) {
			const profiles = defaultVoiceProfiles(undefined, modelId);
			expect(profiles.length, modelId).toBeGreaterThan(0);
			for (const profile of profiles) {
				for (const locale of locales) {
					const relative = voiceSampleRelativePath(modelId, profile, locale);
					expect(relative, `${modelId}/${locale}/${profile}`).not.toBeNull();
					const normalized = relative!.replace(/^\.\//, "");
					expected.add(normalized);
					const fullPath = join(publicDir, normalized);
					expect(existsSync(fullPath), normalized).toBe(true);
					expect(statSync(fullPath).size, normalized).toBeGreaterThan(1000);
				}
			}
		}
		const shipped = listFiles(join(publicDir, "assets/voice-samples"), "assets/voice-samples");
		expect(shipped.sort()).toEqual([...expected].sort());
	});
});
