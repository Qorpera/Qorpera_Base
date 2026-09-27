import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const styles = join(here, "../src/styles");

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
		for (const url of urls) expect(existsSync(join(here, "../public", url)), url).toBe(true);
	});
});
