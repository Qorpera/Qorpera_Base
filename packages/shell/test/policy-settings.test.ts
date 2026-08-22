import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const userland = join(import.meta.dirname, "..", "userland");

describe("policy settings", () => {
	it("renders the compact auto-saving Ask, Act, Auto controls", () => {
		const index = readFileSync(join(userland, "index.html"), "utf-8");
		const renderer = readFileSync(join(userland, "renderer.js"), "utf-8");
		const styles = readFileSync(join(userland, "policy-settings.css"), "utf-8");

		expect(index).toContain(">Policy</button>");
		expect(index).toContain('href="./policy-settings.css"');
		for (const label of ["Spending", "External Communication", "Hard-to-reverse Changes", "Information Sharing"]) {
			expect(renderer).toContain(`label: "${label}"`);
		}
		for (const option of ["Ask", "Act", "Auto"])
			expect(renderer).toContain(`["${option.toLowerCase()}", "${option}"]`);
		expect(renderer).toContain("Instructions, not permissions");
		expect(renderer).toContain("policy: { [category.key]: requestedValue }");
		expect(renderer).not.toContain("Save gates");
		expect(renderer).not.toContain("Enforced safeguards");
		expect(styles).toContain("border: 0;");
		expect(styles).toContain("background-color: transparent;");
	});
});
