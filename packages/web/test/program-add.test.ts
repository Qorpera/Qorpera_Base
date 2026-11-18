// @vitest-environment jsdom

import { File as NodeFile } from "node:buffer";
import { parseProgram, writeProgram } from "@qorpera/cloud-client/app-program";
import type { CloudMemberFolderUnit, CloudMemberFolderUploadFile } from "@qorpera/cloud-client/cloud-member-folder";
import { CloudMemberFolderError } from "@qorpera/cloud-client/cloud-member-folder";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	nextMemberVersion,
	ProgramAdd,
	programFolderName,
	programKindOf,
	programNameOf,
	readDrop,
} from "../src/app/program-add.ts";
import { NewProgramPage, type ProgramAddHost, ProgramDrop } from "../src/app/views/program-add.ts";
import { ProgramPage, readProgram } from "../src/app/views/program-page.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { type FolderFake, folderFake } from "./folder-fake.ts";

const ME = "35000000-0000-4000-8000-000000000001";
const ANNA = "35000000-0000-4000-8000-000000000002";
const disposers: { dispose(): void }[] = [];

beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const each of disposers.splice(0)) each.dispose();
	openMenu()?.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	setLanguagePreference("en");
});

const file = (name: string, text = `bytes of ${name}`) => new NodeFile([text], name) as unknown as File;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
	for (let n = 0; n < 200 && !check(); n++) await settle();
	expect(check()).toBe(true);
}

function company(fake: FolderFake = folderFake({ seed: ["apps"] })) {
	const uploads: { path: string; key: string }[] = [];
	let hold: Promise<void> | undefined;
	let refuse: unknown;
	const uploadFile = vi.fn(
		async (
			path: string,
			blob: Blob,
			prepared: CloudMemberFolderUploadFile,
			options: { operationKey: string; signal: AbortSignal; onProgress?: (sent: number, total: number) => void },
		) => {
			options.signal.throwIfAborted();
			if (refuse) throw refuse;
			uploads.push({ path, key: options.operationKey });
			options.onProgress?.(Math.floor(prepared.bytes * 0.4), prepared.bytes);
			if (hold) await hold;
			options.signal.throwIfAborted();
			const parts = path.split("/");
			const units: CloudMemberFolderUnit[] = [
				...[1, 2, 3, 4].map((depth) => ({ op: "mkdir" as const, path: parts.slice(0, depth).join("/") })),
				{ op: "write", path, text: await blob.text() },
			];
			return fake.folder.commit(options.operationKey, units, options.signal);
		},
	);
	const folder = { ...fake.folder, uploadFile };
	const opened: string[] = [];
	const host: ProgramAddHost = {
		writer: () => folder,
		userId: ME,
		canWrite: () => true,
		companyName: () => "Fokusur",
		appNames: () => fake.children("apps").map((path) => path.slice("apps/".length)),
		opened: (folder) => opened.push(folder),
		system: "mac",
	};
	return {
		fake,
		folder,
		host,
		uploads,
		opened,
		holdUploads: () => {
			let release = () => {};
			hold = new Promise((resolve) => {
				release = resolve;
			});
			return () => {
				hold = undefined;
				release();
			};
		},
		refuseUploads: (error: unknown) => {
			refuse = error;
		},
	};
}

describe("what a dropped file is", () => {
	it("knows a program's kind by its name, and asks for any other", () => {
		expect(
			["a.apk", "a.ipa", "A.EXE", "a.msi", "a.dmg", "a.pkg", "a.AppImage", "a.deb", "a.rpm", "a.flatpak"].map(
				programKindOf,
			),
		).toEqual(["android", "iphone", "windows", "windows", "mac", "mac", "linux", "linux", "linux", "linux"]);
		expect(["a.tar.gz", "a.tar.xz", "a.tgz"].map(programKindOf)).toEqual(["linux", "linux", "linux"]);
		expect(["a.zip", "a.jar", "readme", ".apk", "a.gz"].map(programKindOf)).toEqual([null, null, null, null, null]);
	});

	it("names the program after the file, without its ending, version and installer words", () => {
		expect(programNameOf("Lagerliste-1.0-setup.exe")).toBe("Lagerliste");
		expect(programNameOf("fokusur_0.3.1_amd64.deb")).toBe("fokusur");
		expect(programNameOf("Stock Count v2 Installer.msi")).toBe("Stock Count");
		expect(programNameOf("Fokusur-0.2.AppImage")).toBe("Fokusur");
		expect(programNameOf("app.tar.gz")).toBe("app");
		expect(programNameOf("1.0.exe")).toBe("1.0");
		expect(programFolderName("Lagerliste", new Set())).toBe("lagerliste");
		expect(programFolderName("Lagerliste", new Set(["lagerliste", "lagerliste-2"]))).toBe("lagerliste-3");
		expect(programFolderName("Kø på Ærø", new Set())).toBe("koe-paa-aeroe");
		expect(programFolderName("!!!", new Set())).toBe("program");
	});

	it("numbers a member's versions 1, 2 and on: the next whole number not kept", () => {
		expect(nextMemberVersion(null)).toBe("1");
		const kept = (...versions: string[]) => ({
			versions: versions.map((version) => ({ version, date: "2026-11-18T00:00:00Z", forms: [] })),
		});
		expect(nextMemberVersion(kept("1"))).toBe("2");
		expect(nextMemberVersion(kept("0.1", "0.2"))).toBe("1");
		expect(nextMemberVersion(kept("2", "1", "3"))).toBe("4");
		expect(nextMemberVersion(kept("1", "3"))).toBe("2");
	});

	it("refuses a drop of two files of one kind, too many files, an empty file and one past 256 MiB", () => {
		expect(readDrop([file("a.exe"), file("b.msi")])).toEqual({ problem: "twice", kind: "windows" });
		expect(readDrop(["a.apk", "b.ipa", "c.exe", "d.dmg", "e.deb", "f.zip"].map((name) => file(name)))).toEqual({
			problem: "many",
		});
		expect(readDrop([file("a.exe", "")])).toEqual({ problem: "empty", name: "a.exe" });
		const huge = Object.defineProperty(file("big.exe"), "size", { value: 256 * 1024 * 1024 + 1 });
		expect(readDrop([huge])).toEqual({ problem: "large", name: "big.exe", bytes: 256 * 1024 * 1024 + 1 });
		const fine = readDrop([file("a.exe"), file("a.zip")]);
		expect("files" in fine && fine.files.map((each) => each.kind)).toEqual(["windows", null]);
	});
});

describe("a member's new program", () => {
	it("puts the file at its version's path, then the app and its kept version in one change set", async () => {
		const c = company();
		await new ProgramAdd(c.host.writer, { folder: "lagerliste", name: "Lagerliste", isNew: true }).run({
			target: { folder: "lagerliste", name: "Lagerliste", isNew: true },
			files: [{ file: file("Lagerliste-1.0-setup.exe"), kind: "windows" }],
			userId: ME,
			signal: new AbortController().signal,
			now: () => new Date("2026-11-18T12:00:00.000Z"),
		});
		expect(c.uploads.map((each) => each.path)).toEqual(["apps/lagerliste/versions/1/Lagerliste-1.0-setup.exe"]);
		const text = c.fake.commits.at(-1)?.units;
		expect(text?.map((unit) => `${unit.op} ${"path" in unit ? unit.path : ""}`)).toEqual([
			"write apps/lagerliste/app.toml",
			"write apps/lagerliste/program.json",
		]);
		const manifest = parseAppManifest(c.fake.text("apps/lagerliste/app.toml") ?? "");
		expect(manifest.ok && manifest.manifest).toMatchObject({
			name: "Lagerliste",
			kit: "program",
			owner: null,
			posted: true,
			emblem: "page",
		});
		const program = parseProgram(c.fake.text("apps/lagerliste/program.json") ?? "");
		expect(program?.versions).toEqual([
			{
				version: "1",
				date: "2026-11-18T12:00:00.000Z",
				forms: [
					{
						for: "windows",
						file: "Lagerliste-1.0-setup.exe",
						bytes: "bytes of Lagerliste-1.0-setup.exe".length,
						sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
					},
				],
				userId: ME,
			},
		]);
		const read = await readProgram(c.fake.folder, "apps/lagerliste", new AbortController().signal);
		expect(read.ok).toBe(true);
	});

	it("takes the next version and moves its files there when another member added the same one first", async () => {
		const c = company();
		c.fake.put("apps/lagerliste/app.toml", 'name = "Lagerliste"\nkit = "program"\nposted = true\n');
		const first = {
			version: "1",
			forms: [{ for: "windows" as const, file: "a.exe" }],
			screens: {},
			versions: [
				{
					version: "1",
					date: "2026-11-18T10:00:00.000Z",
					forms: [{ for: "windows" as const, file: "a.exe", bytes: 1, sha256: "a".repeat(64) }],
					userId: ANNA,
				},
			],
		};
		c.fake.put("apps/lagerliste/program.json", writeProgram(first));
		const release = c.holdUploads();
		const add = new ProgramAdd(c.host.writer, { folder: "lagerliste", name: "Lagerliste", isNew: false });
		const running = add.run({
			target: { folder: "lagerliste", name: "Lagerliste", isNew: false },
			files: [{ file: file("b.exe"), kind: "windows" }],
			userId: ME,
			signal: new AbortController().signal,
		});
		await until(() => c.uploads.length === 1);
		expect(c.uploads[0]?.path).toBe("apps/lagerliste/versions/2/b.exe");
		c.fake.put(
			"apps/lagerliste/program.json",
			writeProgram({
				...first,
				version: "2",
				versions: [{ ...first.versions[0]!, version: "2", userId: ANNA }, ...first.versions],
			}),
		);
		release();
		await running;
		const program = parseProgram(c.fake.text("apps/lagerliste/program.json") ?? "");
		expect(program?.versions.map((each) => [each.version, each.userId])).toEqual([
			["3", ME],
			["2", ANNA],
			["1", ANNA],
		]);
		expect(c.fake.has("apps/lagerliste/versions/3/b.exe")).toBe(true);
		expect(c.fake.has("apps/lagerliste/versions/2/b.exe")).toBe(false);
	});

	it("says a program.json past the commit route's 64 KiB takes no member's version, before any byte goes up", async () => {
		const c = company();
		c.fake.put("apps/full/app.toml", 'name = "Full"\nkit = "program"\nposted = true\n');
		const versions = Array.from({ length: 300 }, (_, n) => ({
			version: `0.${n}`,
			date: "2026-11-18T10:00:00.000Z",
			forms: [{ for: "linux" as const, file: `full-0.${n}-linux-x86_64.tar.gz`, bytes: 1, sha256: "a".repeat(64) }],
		}));
		c.fake.put(
			"apps/full/program.json",
			writeProgram({
				version: "0.0",
				forms: [{ for: "linux", file: "full-0.0-linux-x86_64.tar.gz" }],
				screens: {},
				versions,
			}),
		);
		const error = await new ProgramAdd(c.host.writer, { folder: "full", name: "Full", isNew: false })
			.run({
				target: { folder: "full", name: "Full", isNew: false },
				files: [{ file: file("full.exe"), kind: "windows" }],
				userId: ME,
				signal: new AbortController().signal,
			})
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({ reason: "full" });
		expect(c.uploads).toEqual([]);
	});
});

describe("the New program page", () => {
	const page = (host: ProgramAddHost) => {
		const shown = new NewProgramPage({
			...host,
			cofounder: () => {
				const figure = document.createElement("div");
				figure.className = "figure";
				return figure;
			},
		});
		disposers.push(shown);
		document.body.append(shown.el);
		return shown;
	};
	const drop = (target: Element, files: File[]) => {
		const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
		target.dispatchEvent(event);
	};

	it("is one drop area with a real file chooser and the Co-Founder's word, and no buttons besides", () => {
		const shown = page(company().host);
		expect(shown.el.querySelector(".program-name")?.textContent).toBe("New program");
		expect(shown.el.querySelector(".program-drop-line")?.textContent).toBe("Drop a program here");
		const choose = shown.el.querySelector<HTMLButtonElement>(".program-drop-choose")!;
		expect(choose.textContent).toBe("or choose a file");
		const input = shown.el.querySelector<HTMLInputElement>("input[type=file]")!;
		const click = vi.spyOn(input, "click").mockImplementation(() => {});
		choose.click();
		expect(click).toHaveBeenCalled();
		expect(input.multiple).toBe(true);
		expect(shown.el.querySelector(".bubble")?.textContent).toBe(
			"Made something yourself? Drop it here and everyone in Fokusur can get it.",
		);
		expect([...shown.el.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			"or choose a file",
		]);
	});

	it("reads Choose a program on a phone, where nothing is dropped", () => {
		const shown = page({ ...company().host, system: "android" });
		expect(shown.el.querySelector("button.program-drop-area")?.textContent).toBe("Choose a program");
		expect(shown.el.querySelector(".program-drop-line")?.textContent).toBe("Choose a program");
	});

	it("shows the tile filling while the file goes up, with a quiet Stop, then opens the new program", async () => {
		const c = company();
		const release = c.holdUploads();
		const shown = page(c.host);
		drop(shown.el.querySelector(".program-drop")!, [file("Lagerliste-1.0-setup.exe")]);
		await until(() => c.uploads.length === 1);
		expect(shown.el.querySelector(".program-tile-initial")?.textContent).toBe("L");
		expect(shown.el.querySelector(".program-tile-file strong")?.textContent).toBe("Lagerliste-1.0-setup.exe");
		expect(shown.el.querySelector(".program-drop-progress")?.textContent).toBe(
			"Putting Lagerliste-1.0-setup.exe in place… 40%",
		);
		expect(shown.el.querySelector<HTMLElement>(".program-drop-tile")?.style.getPropertyValue("--share")).toBe("40%");
		expect(shown.el.querySelector(".program-drop-status button")?.textContent).toBe("Stop");
		expect(shown.el.querySelector(".spinner")).toBeNull();
		release();
		await until(() => c.opened.length === 1);
		expect(c.opened).toEqual(["lagerliste"]);
		expect(c.fake.has("apps/lagerliste/app.toml")).toBe(true);
	});

	it("asks what an unknown kind of file is for, and a click on a kind answers", async () => {
		const c = company();
		const shown = page(c.host);
		drop(shown.el.querySelector(".program-drop")!, [file("Kassen.zip")]);
		expect(shown.el.querySelector(".program-drop-ask")?.textContent).toBe("What is it for?");
		const kinds = [...shown.el.querySelectorAll<HTMLButtonElement>(".program-kind.is-choice")];
		expect(kinds.map((kind) => kind.textContent)).toEqual(["Android", "Linux", "Windows", "Mac", "iPhone"]);
		expect(c.uploads).toEqual([]);
		kinds[3]!.click();
		await until(() => c.opened.length === 1);
		const program = parseProgram(c.fake.text("apps/kassen/program.json") ?? "");
		expect(program?.forms).toEqual([{ for: "mac", file: "Kassen.zip" }]);
	});

	it("says in plain words what refused it: too large, two of a kind, not allowed, paused, a dropped line", async () => {
		const c = company();
		const shown = page(c.host);
		const area = () => shown.el.querySelector(".program-drop")!;
		const huge = Object.defineProperty(file("big.exe"), "size", { value: 300 * 1024 * 1024 });
		drop(area(), [huge]);
		expect(shown.el.querySelector(".program-drop-problem")?.textContent).toBe(
			"300 MiB: too large. The most is 256 MiB.",
		);
		drop(area(), [file("a.exe"), file("b.exe")]);
		expect(shown.el.querySelector(".program-drop-problem")?.textContent).toBe(
			"Two files for Windows: drop one for each kind.",
		);
		for (const [status, words] of [
			[403, "You can't add programs in this company."],
			[423, "The company is paused. Add the program when it runs again."],
			[null, "The connection dropped."],
		] as const) {
			c.refuseUploads(new CloudMemberFolderError("refused", status));
			drop(area(), [file("Lagerliste.exe")]);
			await until(() => shown.el.querySelector(".program-drop-status.is-said") !== null);
			expect(shown.el.querySelector(".program-drop-status.is-said span")?.textContent).toBe(words);
			const buttons = [...shown.el.querySelectorAll<HTMLButtonElement>(".program-drop-status.is-said button")];
			expect(buttons.map((button) => button.textContent)).toEqual(
				status === null ? ["Try again", "Cancel"] : ["Cancel"],
			);
			if (status === null) {
				c.refuseUploads(undefined);
				buttons[0]!.click();
				await until(() => c.opened.length === 1);
			} else buttons[0]!.click();
		}
		expect(c.uploads.map((each) => each.path)).toEqual(["apps/lagerliste/versions/1/Lagerliste.exe"]);
	});

	it("leaves nothing in the company when the member leaves while the file goes up", async () => {
		const c = company();
		const release = c.holdUploads();
		const shown = page(c.host);
		drop(shown.el.querySelector(".program-drop")!, [file("Lagerliste.exe")]);
		await until(() => c.uploads.length === 1);
		shown.dispose();
		disposers.splice(disposers.indexOf(shown), 1);
		release();
		await settle();
		await settle();
		expect(c.fake.has("apps/lagerliste")).toBe(false);
		expect(c.opened).toEqual([]);
	});

	it("speaks Danish", () => {
		setLanguagePreference("da");
		const shown = page(company().host);
		expect(shown.el.querySelector(".program-name")?.textContent).toBe("Nyt program");
		expect(shown.el.querySelector(".program-drop-line")?.textContent).toBe("Slip et program her");
		expect(shown.el.querySelector(".bubble")?.textContent).toBe(
			"Har du selv lavet noget? Slip det her, så alle i Fokusur kan hente det.",
		);
	});
});

describe("a program a member made", () => {
	async function shown(owner: string | null, adds: boolean) {
		const c = company();
		c.fake.put(
			"apps/lagerliste/app.toml",
			`name = "Lagerliste"\nkit = "program"\nposted = true\n${owner ? `owner = "${owner}"\n` : ""}`,
		);
		c.fake.put("apps/lagerliste/versions/1/Lagerliste.exe", "exe");
		const signal = new AbortController().signal;
		const sha = (await c.fake.folder.read("apps/lagerliste/versions/1/Lagerliste.exe", signal)).entry?.file
			?.fileSha256;
		c.fake.put(
			"apps/lagerliste/program.json",
			writeProgram({
				version: "1",
				forms: [{ for: "windows", file: "Lagerliste.exe" }],
				screens: {},
				versions: [
					{
						version: "1",
						date: "2026-11-18T10:00:00.000Z",
						forms: [{ for: "windows", file: "Lagerliste.exe", bytes: 3, sha256: sha ?? "a".repeat(64) }],
						userId: ANNA,
					},
				],
			}),
		);
		const read = await readProgram(c.fake.folder, "apps/lagerliste", signal);
		if (!read.ok) throw new Error(read.message);
		const parsed = parseAppManifest(c.fake.text("apps/lagerliste/app.toml") ?? "");
		if (!parsed.ok) throw new Error("manifest");
		const changed = vi.fn();
		const page = new ProgramPage(
			{
				folder: () => c.fake.folder,
				system: "windows",
				userId: ME,
				memberName: (userId) => (userId === ANNA ? "Anna" : null),
				changed,
				...(adds ? { adds: c.host } : {}),
			},
			{ name: "lagerliste", path: "apps/lagerliste", manifest: parsed.manifest },
			read.program,
			read.key,
		);
		disposers.push(page);
		document.body.append(page.el);
		const menu = () => {
			page.el.querySelector<HTMLButtonElement>(".program-more")!.click();
			const items = [
				...document.querySelectorAll<HTMLElement>(".context-menu [role^=menuitem], .context-menu-caption"),
			];
			return items;
		};
		return { c, page, menu, changed };
	}

	it("says who added the version, and offers Add a version above the earlier ones", async () => {
		const { page, menu } = await shown(null, true);
		expect(page.el.querySelector(".program-state")?.textContent).toBe("Version 1 · added by Anna");
		const items = menu();
		expect(items.map((item) => item.textContent?.trim())).toEqual(["Add a version", "Earlier versions", "None yet"]);
		items[0]!.click();
		expect(page.el.querySelector(".program-drop-line")?.textContent).toBe("Drop a program here");
		expect(page.el.querySelector(".program-back-button")?.textContent).toBe("Back to Lagerliste");
		page.el.querySelector<HTMLButtonElement>(".program-back-button")!.click();
		expect(page.el.querySelector(".program-download")).not.toBeNull();
	});

	it("adds the dropped file as the next version, added by you, and asks for the page to be read again", async () => {
		const { c, page, changed } = await shown(null, true);
		const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
		Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file("Lagerliste.apk")] } });
		page.el.dispatchEvent(event);
		await until(() => changed.mock.calls.length === 1);
		expect(c.uploads.map((each) => each.path)).toEqual(["apps/lagerliste/versions/2/Lagerliste.apk"]);
		const program = parseProgram(c.fake.text("apps/lagerliste/program.json") ?? "");
		expect(program?.versions.map((each) => [each.version, each.userId])).toEqual([
			["2", ME],
			["1", ANNA],
		]);
		const read = await readProgram(c.fake.folder, "apps/lagerliste", new AbortController().signal);
		if (!read.ok) throw new Error(read.message);
		const parsed = parseAppManifest(c.fake.text("apps/lagerliste/app.toml") ?? "");
		if (!parsed.ok) throw new Error("manifest");
		const again = new ProgramPage(
			{ folder: () => c.fake.folder, system: "android", userId: ME },
			{ name: "lagerliste", path: "apps/lagerliste", manifest: parsed.manifest },
			read.program,
			read.key,
		);
		disposers.push(again);
		expect(again.el.querySelector(".program-state")?.textContent).toBe("Version 2 · added by you");
	});

	it("offers no Add a version for an agent's program, nor to a viewer, and takes no drop there", async () => {
		for (const [owner, adds] of [
			["35000000-0000-4000-8000-0000000000a1", true],
			[null, false],
		] as const) {
			const { c, page, menu } = await shown(owner, adds);
			expect(menu().map((item) => item.textContent?.trim())).toEqual(["Earlier versions", "None yet"]);
			openMenu()?.close();
			const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
			Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file("x.apk")] } });
			page.el.dispatchEvent(event);
			await settle();
			expect(c.uploads).toEqual([]);
			expect(page.el.querySelector(".program-drop")).toBeNull();
		}
	});
});

describe("a drop into a program that is no longer the one shown", () => {
	it("is not taken while another file of the drop area goes up", async () => {
		const c = company();
		c.holdUploads();
		const area = new ProgramDrop(c.host, { kind: "new" }, () => {});
		disposers.push(area);
		area.take([file("a.exe")]);
		await until(() => c.uploads.length === 1);
		area.take([file("b.exe")]);
		await settle();
		expect(c.uploads).toHaveLength(1);
		expect(area.going).toBe(true);
	});
});
