import { parseUpdateInfo } from "electron-updater/out/providers/Provider.js";
import { describe, expect, it } from "vitest";

const channel = "latest-mac.yml";
const channelUrl = new URL(`https://updates.example.invalid/${channel}`);

describe("desktop updater YAML parsing", () => {
	it("accepts ordinary release metadata", () => {
		const info = parseUpdateInfo(
			"version: 0.20.44\nfiles:\n  - url: QorperaBase-arm64.dmg\n    sha512: reviewed-digest\n    size: 12345\n",
			channel,
			channelUrl,
		);
		expect(info.version).toBe("0.20.44");
		expect(info.files).toEqual([{ url: "QorperaBase-arm64.dmg", sha512: "reviewed-digest", size: 12345 }]);
	});

	it("rejects repeated empty merges that exhaust the parser work budget", () => {
		// Small, bounded reproduction of GHSA-2883-xcg3-v3hh. Empty mappings
		// previously bypassed the budget used by the updater's default loader.
		const document = `empty: &empty [${Array(128).fill("{}").join(",")}]\nrepeated:\n${"  - <<: *empty\n".repeat(80)}`;
		expect(() => parseUpdateInfo(document, channel, channelUrl)).toThrow(
			expect.objectContaining({ code: "ERR_UPDATER_INVALID_UPDATE_INFO" }),
		);
	});
});
