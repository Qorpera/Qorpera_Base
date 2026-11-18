import { describe, expect, it } from "vitest";
import {
	isProgramFileName,
	isProgramVersion,
	type Program,
	parseProgram,
	parseProgramHandIn,
	programFormsInOrder,
	writeProgram,
} from "../src/app-program.ts";
import { parseAppManifest } from "../src/interface-apps.ts";

const SHA = "a".repeat(64);
const program: Program = {
	version: "0.2",
	forms: [{ for: "android", file: "fokusur-0.2.apk" }],
	screens: { phone: "screens/phone.png" },
	versions: [
		{
			version: "0.2",
			date: "2026-11-20T09:30:00.000Z",
			forms: [{ for: "android", file: "fokusur-0.2.apk", bytes: 17_600_000, sha256: SHA }],
		},
		{
			version: "0.1",
			date: "2026-11-18T13:00:00.000Z",
			forms: [
				{ for: "linux", file: "fokusur-0.1-linux-x64.tar.gz", bytes: 19_000_000, sha256: SHA },
				{ for: "android", file: "fokusur-0.1.apk", bytes: 17_600_000, sha256: SHA },
			],
		},
	],
};

describe("program apps", () => {
	it("reads a manifest of the program kit, which opens no page of its own", () => {
		const parsed = parseAppManifest('name = "Fokusur"\nkit = "program"\n');
		expect(parsed.ok && parsed.manifest.kit).toBe("program");
		expect(parsed.ok && parsed.manifest.entry).toBe("index.html");
	});

	it("reads an agent's hand-in: a version, one file for each kind, and its screens", () => {
		expect(
			parseProgramHandIn(
				JSON.stringify({
					version: "1.0.0-beta+2",
					forms: [
						{ for: "mac", file: "Fokusur.dmg" },
						{ for: "windows", file: "Fokusur Setup 1.0.exe" },
					],
					screens: { desktop: "./screens/desktop.webp" },
				}),
			),
		).toEqual({
			handIn: {
				version: "1.0.0-beta+2",
				forms: [
					{ for: "mac", file: "Fokusur.dmg" },
					{ for: "windows", file: "Fokusur Setup 1.0.exe" },
				],
				screens: { desktop: "screens/desktop.webp" },
			},
		});
		expect(parseProgramHandIn(JSON.stringify({ version: "0.1", forms: [{ for: "linux", file: "a.deb" }] }))).toEqual({
			handIn: { version: "0.1", forms: [{ for: "linux", file: "a.deb" }], screens: {} },
		});
	});

	it("says what is wrong with a hand-in", () => {
		const problem = (value: unknown) => {
			const parsed = parseProgramHandIn(typeof value === "string" ? value : JSON.stringify(value));
			return "problem" in parsed ? parsed.problem : null;
		};
		expect(problem("[]")).toBe("program.json must be one JSON object");
		expect(problem({ version: "0.1", forms: [] })).toContain("forms must be a list of 1 to 5");
		const six = ["android", "linux", "windows", "mac", "iphone", "android"].map((kind) => ({ for: kind, file: "a" }));
		expect(problem({ version: "0.1", forms: six })).toContain("forms must be a list of 1 to 5");
		expect(problem({ version: "0.1", forms: [{ for: "ios", file: "a.ipa" }] })).toContain("for must be one of");
		expect(problem({ version: "0.1", forms: [{ for: "iphone", file: "../a.ipa" }] })).toContain(
			"file must be one file's name",
		);
		expect(
			problem({ version: "0.1", forms: [{ for: "iphone", file: "a.ipa" }], screens: { tablet: "t.png" } }),
		).toContain('screens must be {"phone", "desktop"}');
		expect(
			problem({ version: "0.1", forms: [{ for: "iphone", file: "a.ipa" }], screens: { phone: "/x.png" } }),
		).toContain("screens.phone must be");
	});

	it("takes short versions and plain file names only", () => {
		for (const version of ["0.1", "2026.11.18", "1.0.0-rc.1", "v3"])
			expect(isProgramVersion(version), version).toBe(true);
		for (const version of ["", ".1", "0..1", "a/b", "0.1 beta", "x".repeat(25), 1])
			expect(isProgramVersion(version), String(version)).toBe(false);
		for (const name of ["fokusur.apk", "Fokusur Setup.exe", "fokusur-0.1-linux-x64.tar.gz"])
			expect(isProgramFileName(name), name).toBe(true);
		for (const name of ["", "a/b.apk", "..", ".", "a\\b", 'a"b', "x".repeat(201)])
			expect(isProgramFileName(name), name).toBe(false);
	});

	it("writes and reads back the kept versions, newest first, and refuses a list that does not hold together", () => {
		expect(parseProgram(writeProgram(program))).toEqual(program);
		expect(JSON.parse(writeProgram({ ...program, screens: {} }))).not.toHaveProperty("screens");
		type Kept = { version: string; versions: { version: string; date: string; forms: { sha256: string }[] }[] };
		const broken = (change: (copy: Kept) => void) => {
			const copy = JSON.parse(writeProgram(program)) as Kept;
			change(copy);
			return parseProgram(JSON.stringify(copy));
		};
		expect(
			broken((copy) => {
				copy.version = "0.1";
			}),
		).toBeNull();
		expect(
			broken((copy) => {
				copy.versions = [];
			}),
		).toBeNull();
		expect(
			broken((copy) => {
				copy.versions[1] = copy.versions[0]!;
			}),
		).toBeNull();
		expect(
			broken((copy) => {
				copy.versions[0]!.date = "soon";
			}),
		).toBeNull();
		expect(
			broken((copy) => {
				copy.versions[0]!.forms[0]!.sha256 = "x";
			}),
		).toBeNull();
		expect(parseProgram("not json")).toBeNull();
	});

	it("puts forms in the fixed order of kinds", () => {
		expect(
			programFormsInOrder([
				{ for: "iphone", file: "a" },
				{ for: "linux", file: "b" },
				{ for: "android", file: "c" },
				{ for: "mac", file: "d" },
				{ for: "windows", file: "e" },
			]).map((form) => form.for),
		).toEqual(["android", "linux", "windows", "mac", "iphone"]);
	});
});
