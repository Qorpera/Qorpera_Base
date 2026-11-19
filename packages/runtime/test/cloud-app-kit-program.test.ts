import { parseProgram } from "@qorpera/cloud-client/app-program";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import type { JsonValue } from "@qorpera/contracts";
import { APP_GUIDES, appGuide } from "@qorpera/runtime/cloud-app-guides";
import { PROGRAM_NO_SCREENS } from "@qorpera/runtime/cloud-app-kit-program";
import { cloudAppTools } from "@qorpera/runtime/cloud-folder-app-tools";
import type { CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import {
	type CloudNativeTool,
	type CloudToolContent,
	CloudToolRefusal,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { afterEach, expect, it } from "vitest";
import { folderWriterFixture, sha } from "./fixtures/folder-writer-fixture.ts";

const runs: CloudNativeToolRun[] = [];
afterEach(() => {
	for (const run of runs.splice(0)) run.close();
});

const APK = "PK apk bytes of 0.1";
const TAR = "linux tarball of 0.1";

async function fixture(seed: Parameters<typeof folderWriterFixture>[0] = {}, unread = false) {
	const f = await folderWriterFixture(seed);
	runs.push(f.run);
	let now = new Date("2026-11-18T13:00:00.000Z");
	const tools = cloudAppTools({
		folder: f.folder,
		operations: f.operations(),
		identity: f.identity,
		clock: () => now,
	});
	const tool = (name: string) => tools.find((candidate) => candidate.name === name) as CloudNativeTool;
	const call = async (name: string, value: JsonValue) => {
		const parsed = tool(name).parseArguments(value);
		const prepared = (await tool(name).prepare?.(parsed, f.context)) ?? parsed;
		return tool(name).execute(prepared, f.context);
	};
	if (!unread) for (const about of APP_GUIDES) await call("app_guide", { about });
	return {
		...f,
		call,
		at: (iso: string) => {
			now = new Date(iso);
		},
	};
}

const read = (content: CloudToolContent) => JSON.parse(String(content.value));
async function refuses(call: Promise<unknown>, text: string) {
	const error = await call.then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(CloudToolRefusal);
	expect((error as Error).message).toContain(text);
}

const built = {
	folders: ["apps", "apps/fokusur", "apps/fokusur/versions", "apps/fokusur/versions/0.1", "apps/fokusur/screens"],
	files: {
		"apps/fokusur/versions/0.1/fokusur-0.1.apk": APK,
		"apps/fokusur/versions/0.1/fokusur-0.1-linux-x64.tar.gz": TAR,
		"apps/fokusur/screens/phone.png": "png",
		"apps/fokusur/screens/desktop.png": "png",
	},
};

const handIn = (version: string, forms: { for: string; file: string }[], screens?: Record<string, string>) =>
	JSON.stringify({ version, forms, ...(screens ? { screens } : {}) });
const first = handIn(
	"0.1",
	[
		{ for: "linux", file: "fokusur-0.1-linux-x64.tar.gz" },
		{ for: "android", file: "fokusur-0.1.apk" },
	],
	{ phone: "screens/phone.png", desktop: "screens/desktop.png" },
);
const save = (key: string, text: string, manifest: JsonValue = { title: "Fokusur", kit: "program" }) => ({
	name: "fokusur",
	operationKey: key,
	manifest,
	files: [{ path: "program.json", text }],
});

it("keeps a program's first version with its files, its date and the screens, and writes no page", async () => {
	const f = await fixture(built);
	const saved = read(await f.call("save_app", save("first", first)));
	expect(saved.state).toBe("applied");
	expect(saved.link).toBe("app:fokusur");
	expect(saved.look).toBeUndefined();
	const manifest = parseAppManifest(f.text("apps/fokusur/app.toml") ?? "");
	expect(manifest.ok && manifest.manifest.kit).toBe("program");
	expect(f.text("apps/fokusur/index.html")).toBeNull();
	const program = parseProgram(f.text("apps/fokusur/program.json") ?? "");
	expect(program).toEqual({
		version: "0.1",
		forms: [
			{ for: "linux", file: "fokusur-0.1-linux-x64.tar.gz" },
			{ for: "android", file: "fokusur-0.1.apk" },
		],
		screens: { phone: "screens/phone.png", desktop: "screens/desktop.png" },
		versions: [
			{
				version: "0.1",
				date: "2026-11-18T13:00:00.000Z",
				forms: [
					{ for: "linux", file: "fokusur-0.1-linux-x64.tar.gz", bytes: TAR.length, sha256: sha(TAR) },
					{ for: "android", file: "fokusur-0.1.apk", bytes: APK.length, sha256: sha(APK) },
				],
			},
		],
	});
});

it("adds a new version first and keeps the earlier ones and their files", async () => {
	const f = await fixture({
		folders: [...built.folders, "apps/fokusur/versions/0.2"],
		files: { ...built.files, "apps/fokusur/versions/0.2/fokusur-0.2.apk": "apk 0.2" },
	});
	await f.call("save_app", save("first", first));
	f.at("2026-11-20T09:30:00.000Z");
	const next = read(
		await f.call(
			"save_app",
			save(
				"second",
				handIn("0.2", [{ for: "android", file: "fokusur-0.2.apk" }], { phone: "screens/phone.png" }),
				null,
			),
		),
	);
	expect(next.state).toBe("applied");
	const program = parseProgram(f.text("apps/fokusur/program.json") ?? "");
	expect(program?.version).toBe("0.2");
	expect(program?.screens).toEqual({ phone: "screens/phone.png" });
	expect(program?.versions.map((each) => [each.version, each.date, each.forms.map((form) => form.for)])).toEqual([
		["0.2", "2026-11-20T09:30:00.000Z", ["android"]],
		["0.1", "2026-11-18T13:00:00.000Z", ["linux", "android"]],
	]);
	expect(f.text("apps/fokusur/versions/0.1/fokusur-0.1.apk")).toBe(APK);
	const units = f.commits.at(-1)?.units ?? [];
	expect(units.some((unit) => unit.op === "delete")).toBe(false);
});

it("keeps who added a member's version through an agent's save, and never marks the agent's own", async () => {
	const member = "35000000-0000-4000-8000-000000000001";
	const kept = JSON.stringify({
		version: "1",
		forms: [{ for: "windows", file: "Lagerliste.exe" }],
		versions: [
			{
				version: "1",
				date: "2026-11-18T12:00:00.000Z",
				forms: [{ for: "windows", file: "Lagerliste.exe", bytes: 3, sha256: sha("exe") }],
				userId: member,
			},
		],
	});
	const f = await fixture({
		folders: [...built.folders, "apps/fokusur/versions/1"],
		files: {
			...built.files,
			"apps/fokusur/app.toml": 'name = "Fokusur"\nkit = "program"\n',
			"apps/fokusur/program.json": kept,
			"apps/fokusur/versions/1/Lagerliste.exe": "exe",
		},
	});
	expect(read(await f.call("save_app", save("agent", first, null))).state).toBe("applied");
	const program = parseProgram(f.text("apps/fokusur/program.json") ?? "");
	expect(program?.versions.map((each) => [each.version, each.userId])).toEqual([
		["0.1", undefined],
		["1", member],
	]);
	await refuses(
		f.call("save_app", save("marked", JSON.stringify({ ...JSON.parse(first), userId: member }), null)),
		"userId is not a field of program.json",
	);
});

it("saves the newest version again with the same files under its first date, and takes new screens", async () => {
	const f = await fixture(built);
	await f.call("save_app", save("first", first));
	f.at("2026-11-19T08:00:00.000Z");
	const again = handIn(
		"0.1",
		[
			{ for: "android", file: "fokusur-0.1.apk" },
			{ for: "linux", file: "fokusur-0.1-linux-x64.tar.gz" },
		],
		{ desktop: "screens/desktop.png" },
	);
	expect(read(await f.call("save_app", save("again", again, null))).state).toBe("applied");
	const program = parseProgram(f.text("apps/fokusur/program.json") ?? "");
	expect(program?.screens).toEqual({ desktop: "screens/desktop.png" });
	expect(program?.versions.map((each) => [each.version, each.date])).toEqual([["0.1", "2026-11-18T13:00:00.000Z"]]);
});

it("refuses a kept version with other files, and an earlier version, saving nothing", async () => {
	const f = await fixture({
		folders: [...built.folders, "apps/fokusur/versions/0.2"],
		files: {
			...built.files,
			"apps/fokusur/versions/0.1/fokusur-0.1-rebuilt.apk": "another build",
			"apps/fokusur/versions/0.2/fokusur-0.2.apk": "apk 0.2",
		},
	});
	await f.call("save_app", save("first", first));
	const before = f.commits.length;
	await refuses(
		f.call("save_app", save("other", handIn("0.1", [{ for: "android", file: "fokusur-0.1-rebuilt.apk" }]), null)),
		"PROGRAM_VERSION_KEPT: this call saved nothing. Version 0.1 is kept with other files: a new build takes a new version",
	);
	await f.call("save_app", save("second", handIn("0.2", [{ for: "android", file: "fokusur-0.2.apk" }]), null));
	await refuses(
		f.call("save_app", save("back", first, null)),
		"PROGRAM_VERSION_EARLIER: this call saved nothing. 0.1 is an earlier version than 0.2, the newest",
	);
	expect(f.commits.length).toBe(before + 1);
});

it("refuses a file that is not in the app's folder, naming it and where it must be", async () => {
	const f = await fixture(built);
	await refuses(
		f.call("save_app", save("missing", handIn("0.1", [{ for: "windows", file: "Fokusur Setup.exe" }]))),
		"PROGRAM_FILE_MISSING: this call saved nothing. versions/0.1/Fokusur Setup.exe is not in the app's folder: copy it there from a machine, to /company/apps/fokusur/versions/0.1/Fokusur Setup.exe, then make this call again.",
	);
	await refuses(
		f.call(
			"save_app",
			save("screen", handIn("0.1", [{ for: "android", file: "fokusur-0.1.apk" }], { phone: "screens/none.png" })),
		),
		"PROGRAM_FILE_MISSING: this call saved nothing. screens/none.png is not in the app's folder",
	);
	const fresh = await fixture();
	await refuses(
		fresh.call("save_app", save("new", first)),
		"PROGRAM_FILE_MISSING: this call saved nothing. versions/0.1/fokusur-0.1-linux-x64.tar.gz is not in the app's folder",
	);
	expect(f.commits).toEqual([]);
	expect(fresh.commits).toEqual([]);
});

it("refuses program data that does not read, in words for its maker", async () => {
	const f = await fixture(built);
	const cases: [string, string][] = [
		["{", "APP_DATA_INVALID: program.json is not JSON"],
		[JSON.stringify({ version: "0.1" }), 'forms must be a list of 1 to 5 {"for", "file"}'],
		[handIn("../0.1", [{ for: "android", file: "a.apk" }]), "version must be short text such as 0.1"],
		[
			handIn("0.1", [{ for: "symbian", file: "a.sis" }]),
			"form 1's for must be one of android, linux, windows, mac, iphone",
		],
		[
			handIn("0.1", [{ for: "android", file: "bin/a.apk" }]),
			"form 1's file must be one file's name in versions/<version>/",
		],
		[
			handIn("0.1", [
				{ for: "android", file: "a.apk" },
				{ for: "android", file: "b.apk" },
			]),
			"forms name android twice: one file for each kind",
		],
		[
			handIn("0.1", [{ for: "android", file: "a.apk" }], { phone: "screens/phone.gif" }),
			"screens.phone must be a .png, .jpg or .webp",
		],
		[
			JSON.stringify({ version: "0.1", forms: [{ for: "android", file: "a.apk" }], versions: [] }),
			"versions is kept by save_app: leave it out",
		],
		[
			JSON.stringify({ version: "0.1", forms: [{ for: "android", file: "a.apk" }], title: "x" }),
			"title is not a field of program.json",
		],
	];
	for (const [index, [text, said]] of cases.entries())
		await refuses(f.call("save_app", save(`bad-${index}`, text)), said);
	expect(f.commits).toEqual([]);
});

it("says once when a program has no screens, and saves only in a run that read the guide", async () => {
	const f = await fixture(built);
	const saved = read(
		await f.call("save_app", save("plain", handIn("0.1", [{ for: "android", file: "fokusur-0.1.apk" }]))),
	);
	expect(saved.look).toEqual([PROGRAM_NO_SCREENS]);
	const unread = await fixture(built, true);
	await refuses(
		unread.call("save_app", save("unread", first)),
		"APP_GUIDE_UNREAD: this call saved nothing. Read the program kit's guide first",
	);
	await refuses(
		(await fixture(built)).call("save_app", {
			name: "fokusur",
			operationKey: "none",
			manifest: { title: "Fokusur", kit: "program" },
			files: [],
		}),
		"APP_DATA_MISSING: the program app's program.json is not in its folder",
	);
});

it("tells an agent how to hand in a program, with an example save_app takes", () => {
	const guide = appGuide("program");
	for (const said of [
		"copy each file into /company/apps/<name>/versions/<version>/",
		"Take real screenshots of the running program",
		"Then call save_app with manifest.kit program and one file among files, program.json",
		"at most one for each of android, linux, windows, mac and iphone",
		"never tell a member to open a machine, a folder or a path",
	])
		expect(guide).toContain(said);
	expect(Buffer.byteLength(guide)).toBeLessThan(4608);
	const example = /```json\n([\s\S]*?)\n```/.exec(guide)?.[1] ?? "";
	expect(JSON.parse(example)).toMatchObject({ version: "0.1", forms: [{ for: "android" }, { for: "linux" }] });
});
