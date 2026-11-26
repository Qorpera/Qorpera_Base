// @vitest-environment jsdom

import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubController } from "../src/app/views/hub.ts";
import {
	CompanyBrandView,
	IDENTITY_BRIEF_PATH,
	IDENTITY_COMPANY_JSON_PATH,
	IDENTITY_TOKENS_JSON_PATH,
	renamedCanonicalJson,
	renamedIdentityBrief,
	renamedVision,
	VISION_PATH,
} from "../src/app/views/settings-brand.ts";
import type { CloudApi } from "../src/cloud/api.ts";
import type { WebMemberFolder } from "../src/cloud/company-folder-writes.ts";
import type { HostedProfile } from "../src/cloud/types.ts";

const COMPANY = "11111111-1111-4111-8111-000000000003";
const VISION = "# Nordlys\n\nWhat we build.\n";

afterEach(() => {
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function visionName(text: string): string | null {
	const parsed = parseCompanyStateFile(VISION_PATH, text);
	return parsed?.ok && parsed.file.kind === "vision" ? parsed.file.name : null;
}

describe("the vision's first line", () => {
	it("rewrites the heading and keeps every other byte", () => {
		expect(renamedVision(VISION, "Nordlys Studio")).toBe("# Nordlys Studio\n\nWhat we build.\n");
		expect(renamedVision("\n# Old\nText", "Ny")).toBe("\n# Ny\nText");
		expect(renamedVision("# Old\r\n\r\nText\r\n", "Ny")).toBe("# Ny\r\n\r\nText\r\n");
		expect(renamedVision("﻿# Old\nText", "Ny")).toBe("﻿# Ny\nText");
	});

	it("adds a heading to a vision without one", () => {
		expect(renamedVision("What we build.\n", "Nordlys")).toBe("# Nordlys\n\nWhat we build.\n");
		expect(visionName(renamedVision("What we build.\n", "Nordlys"))).toBe("Nordlys");
	});

	it("writes names the vision reads back whole, also ones ending in #", () => {
		for (const name of ["Acme #", "C#", "Plain", "Æble & Co."])
			expect(visionName(renamedVision("# Old\n\nWhat we build.\n", name))).toBe(name);
	});
});

function fakeFolder(options: { conflicts?: number; texts?: string[] } = {}) {
	let version = 1;
	let conflicts = options.conflicts ?? 0;
	const texts = options.texts ?? [VISION];
	const written: { path: string; text: string; expectedVersion: string }[] = [];
	const folder = {
		read: vi.fn(async (path: string) => {
			const text = texts[Math.min(version - 1, texts.length - 1)]!;
			return {
				asOfSeq: version,
				entry:
					path === VISION_PATH
						? {
								path,
								kind: "file",
								version: `v${version}`,
								file: {
									manifestSha256: "c".repeat(64),
									fileSha256: "d".repeat(64),
									bytes: new TextEncoder().encode(text).length,
									mediaType: "text/markdown",
									executable: false,
								},
							}
						: null,
			};
		}),
		readFile: vi.fn(async () => new TextEncoder().encode(texts[Math.min(version - 1, texts.length - 1)]!)),
		commit: vi.fn(
			async (_key: string, units: { op: string; path: string; text: string; expectedVersion: string }[]) => {
				const unit = units[0]!;
				const conflict = conflicts > 0;
				if (conflict) {
					conflicts--;
					version++;
				} else written.push({ path: unit.path, text: unit.text, expectedVersion: unit.expectedVersion });
				return {
					commitId: "x",
					seq: version,
					replay: false,
					units: [
						{
							unit: 1,
							op: unit.op,
							path: unit.path,
							to: null,
							version: conflict ? null : "v9",
							outcome: conflict ? "conflict" : "saved",
							reason: conflict ? "version_changed" : null,
							problems: [],
						},
					],
				};
			},
		),
		list: vi.fn(),
		stateFolders: vi.fn(),
	};
	return { folder: folder as unknown as WebMemberFolder, commit: folder.commit, written };
}

function brand(options: { manage?: boolean; folder?: WebMemberFolder; name?: () => string } = {}) {
	const renamed = vi.fn();
	const view = new CompanyBrandView({
		profileId: COMPANY,
		name: options.name ?? (() => "Nordlys"),
		canManage: () => options.manage ?? true,
		folder: () => options.folder ?? fakeFolder().folder,
		signal: new AbortController().signal,
		renamed,
	});
	document.body.append(view.el);
	return { view, renamed };
}

async function rename(view: CompanyBrandView, name: string, key = "Enter", closes = true) {
	view.el.querySelector<HTMLButtonElement>(".settings-brand-rename")!.click();
	const input = view.el.querySelector<HTMLInputElement>(".settings-brand-name-input")!;
	expect(document.activeElement).toBe(input);
	input.value = name;
	input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	if (closes) await vi.waitFor(() => expect(view.el.querySelector(".settings-brand-name-input")).toBeNull());
}

describe("renaming in Settings → Brand", () => {
	it("gives owners and admins a pencil, and no one else", () => {
		expect(brand().view.el.querySelector(".settings-brand-rename")?.getAttribute("aria-label")).toBe(
			"Rename the company",
		);
		expect(brand({ manage: false }).view.el.querySelector(".settings-brand-rename")).toBeNull();
	});

	it("names a company with no name yet from an empty field", async () => {
		const { folder, written } = fakeFolder({ texts: ["# No name yet\n\nWhat we build.\n"] });
		const { view, renamed } = brand({ folder, name: () => "No name yet" });
		view.el.querySelector<HTMLButtonElement>(".settings-brand-rename")!.click();
		const input = view.el.querySelector<HTMLInputElement>(".settings-brand-name-input")!;
		expect(input.value).toBe("");
		expect(input.placeholder).toBe("Company name");
		input.value = "Nordlys";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(renamed).toHaveBeenCalledWith("Nordlys"));
		expect(written[0]?.text).toBe("# Nordlys\n\nWhat we build.\n");
	});

	it("writes the new name as the vision's first line and shows it at once", async () => {
		const { folder, written } = fakeFolder();
		const { view, renamed } = brand({ folder });
		await rename(view, "  Nordlys   Studio ");
		expect(written).toEqual([
			{ path: VISION_PATH, text: "# Nordlys Studio\n\nWhat we build.\n", expectedVersion: "v1" },
		]);
		expect(renamed).toHaveBeenCalledWith("Nordlys Studio");
		expect(view.el.querySelector(".settings-brand-name strong")?.textContent).toBe("Nordlys Studio");
		expect(view.el.querySelector(".settings-brand-error")?.textContent).toBe("");
	});

	it("reads the vision again when it changed in between, and keeps what changed", async () => {
		const { folder, written } = fakeFolder({
			conflicts: 1,
			texts: [VISION, "# Nordlys\n\nWhat we build, now for cafés.\n"],
		});
		const { view } = brand({ folder });
		await rename(view, "Nordlys Studio");
		expect(written).toEqual([
			{ path: VISION_PATH, text: "# Nordlys Studio\n\nWhat we build, now for cafés.\n", expectedVersion: "v2" },
		]);
	});

	it("writes nothing for the same name, and Escape leaves it as it was", async () => {
		const { folder, commit } = fakeFolder();
		const { view, renamed } = brand({ folder });
		await rename(view, "Nordlys");
		await rename(view, "Something else", "Escape");
		expect(commit).not.toHaveBeenCalled();
		expect(renamed).not.toHaveBeenCalled();
		expect(view.el.querySelector(".settings-brand-name strong")?.textContent).toBe("Nordlys");
	});

	function answer(outcome: string, reason: string, problems: { message: string }[] = []) {
		return {
			commitId: "x",
			seq: 2,
			replay: false,
			units: [{ unit: 1, op: "write", path: VISION_PATH, to: null, version: null, outcome, reason, problems }],
		} as unknown as Awaited<ReturnType<WebMemberFolder["commit"]>>;
	}

	for (const [outcome, reason, problems, said] of [
		[
			"denied",
			"no_grant",
			[],
			"The name could not be saved. Only someone who may change the company's files can rename it.",
		],
		[
			"refused",
			"invalid",
			[{ message: "the company's name must be at most 120 characters" }],
			"The name could not be saved. The name was not accepted: the company's name must be at most 120 characters.",
		],
		["refused", "hook", [], "The name could not be saved. Try again."],
	] as const)
		it(`says why when the save is ${outcome} (${reason}), and keeps what was typed`, async () => {
			const { folder } = fakeFolder();
			vi.mocked(folder.commit).mockResolvedValue(answer(outcome, reason, [...problems]));
			const { view, renamed } = brand({ folder });
			await rename(view, "Nordlys Studio", "Enter", false);
			await vi.waitFor(() => expect(view.el.querySelector(".settings-brand-error")?.textContent).toBe(said));
			expect(renamed).not.toHaveBeenCalled();
			const input = view.el.querySelector<HTMLInputElement>(".settings-brand-name-input")!;
			expect(input.value).toBe("Nordlys Studio");
			expect(input.disabled).toBe(false);
			expect(document.activeElement).toBe(input);
		});

	it("holds the field and both buttons while the name is being saved", async () => {
		const { folder, written } = fakeFolder();
		let land!: () => void;
		const landed = new Promise<void>((resolve) => {
			land = resolve;
		});
		const commit = folder.commit;
		vi.mocked(folder).commit = vi.fn(async (...args: Parameters<WebMemberFolder["commit"]>) => {
			await landed;
			return commit(...args);
		});
		const { view, renamed } = brand({ folder });
		await rename(view, "Nordlys Studio", "Enter", false);
		await vi.waitFor(() => expect(vi.mocked(folder.commit)).toHaveBeenCalled());
		const slot = view.el.querySelector(".settings-brand-name")!;
		const controls = [...slot.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")];
		expect(controls.map((control) => control.disabled)).toEqual([true, true, true]);
		const input = controls[0] as HTMLInputElement;
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(slot.querySelector(".settings-brand-name-input")).not.toBeNull();
		land();
		await vi.waitFor(() => expect(renamed).toHaveBeenCalledWith("Nordlys Studio"));
		expect(written).toHaveLength(1);
		expect(view.el.querySelector(".settings-brand-name strong")?.textContent).toBe("Nordlys Studio");
	});
});

function profile(name: string): HostedProfile {
	return { profileId: COMPANY, profileName: name } as HostedProfile;
}

function fakeHubApi(names: string[]) {
	let reads = 0;
	const listProfiles = vi.fn(async () => [profile(names[Math.min(reads++, names.length - 1)]!)]);
	const api = {
		cloud: { config: { projectUrl: "https://cloud.test" } },
		listProfiles,
		listIncomingInvitations: vi.fn(async () => []),
		companyFoundingAvailable: vi.fn(async () => false),
		listCompanyFoundings: vi.fn(async () => []),
	};
	return { api: api as unknown as CloudApi, listProfiles };
}

describe("the company list after a rename", () => {
	it("shows the new name at once and keeps it until the cloud has copied it from the vision", async () => {
		vi.useFakeTimers();
		const { api, listProfiles } = fakeHubApi(["Nordlys", "Nordlys", "Nordlys Studio", "Nordlys Studio"]);
		const hub = new HubController(api);
		await hub.refresh();
		const shown = () => hub.store.get().profiles[0]?.profileName;
		expect(shown()).toBe("Nordlys");
		hub.renamed(COMPANY, "Nordlys Studio");
		expect(shown()).toBe("Nordlys Studio");
		await vi.advanceTimersByTimeAsync(1500);
		expect(listProfiles).toHaveBeenCalledTimes(2);
		expect(shown()).toBe("Nordlys Studio");
		await vi.advanceTimersByTimeAsync(2500);
		expect(listProfiles).toHaveBeenCalledTimes(3);
		expect(shown()).toBe("Nordlys Studio");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(listProfiles).toHaveBeenCalledTimes(3);
		hub.dispose();
	});

	it("keeps the new name while the cloud is slow, like the rest of the app", async () => {
		vi.useFakeTimers();
		const { api, listProfiles } = fakeHubApi(["Nordlys"]);
		const hub = new HubController(api);
		await hub.refresh();
		hub.renamed(COMPANY, "Nordlys Studio");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(hub.store.get().profiles[0]?.profileName).toBe("Nordlys Studio");
		expect(listProfiles.mock.calls.length).toBeLessThanOrEqual(7);
		await hub.refresh();
		expect(hub.store.get().profiles[0]?.profileName).toBe("Nordlys Studio");
		hub.dispose();
	});

	it("ends on the last name after two renames in a row, while the cloud still has the middle one", async () => {
		vi.useFakeTimers();
		const { api } = fakeHubApi(["A", "A", "B", "B", "C"]);
		const hub = new HubController(api);
		await hub.refresh();
		const shown = () => hub.store.get().profiles[0]?.profileName;
		hub.renamed(COMPANY, "B");
		hub.renamed(COMPANY, "C");
		expect(shown()).toBe("C");
		await vi.advanceTimersByTimeAsync(1500 + 2500);
		expect(shown()).toBe("C");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(shown()).toBe("C");
		hub.dispose();
	});

	it("keeps the new name when the company was not listed yet at the rename", async () => {
		vi.useFakeTimers();
		const { api } = fakeHubApi(["Nordlys", "Nordlys", "Nordlys Studio"]);
		const hub = new HubController(api);
		hub.renamed(COMPANY, "Nordlys Studio");
		await hub.refresh();
		expect(hub.store.get().profiles[0]?.profileName).toBe("Nordlys Studio");
		await vi.advanceTimersByTimeAsync(1500);
		expect(hub.store.get().profiles[0]?.profileName).toBe("Nordlys Studio");
		hub.dispose();
	});

	it("takes the cloud's name once it is neither the old nor the new one", async () => {
		vi.useFakeTimers();
		const { api } = fakeHubApi(["Nordlys", "Nordlys", "Nordlys Kaffe"]);
		const hub = new HubController(api);
		await hub.refresh();
		hub.renamed(COMPANY, "Nordlys Studio");
		await vi.advanceTimersByTimeAsync(1500);
		expect(hub.store.get().profiles[0]?.profileName).toBe("Nordlys Studio");
		await vi.advanceTimersByTimeAsync(2500);
		expect(hub.store.get().profiles[0]?.profileName).toBe("Nordlys Kaffe");
		hub.dispose();
	});
});

describe("canonical identity file rewrites during rename", () => {
	it("updates canonical JSON name and brand fields without inventing missing keys", () => {
		expect(renamedCanonicalJson('{\n  "name": "Nordlys",\n  "tagline": "Bright"\n}\n', "name", "Solstice")).toBe(
			'{\n  "name": "Solstice",\n  "tagline": "Bright"\n}\n',
		);
		expect(renamedCanonicalJson('{"brand":"Nordlys","accent":"#000"}', "brand", "Solstice")).toBe(
			'{\n  "brand": "Solstice",\n  "accent": "#000"\n}',
		);
		expect(renamedCanonicalJson('{"name":"Solstice"}', "name", "Solstice")).toBeNull();
		expect(renamedCanonicalJson('{"other":"Nordlys"}', "name", "Solstice")).toBeNull();
		expect(renamedCanonicalJson("{bad json", "name", "Solstice")).toBeNull();
	});

	it("updates identity/brief.md only when the H1 matches the old company name", () => {
		expect(renamedIdentityBrief("# Nordlys\n\nBody.\n", "Nordlys", "Solstice")).toBe("# Solstice\n\nBody.\n");
		expect(renamedIdentityBrief("# Nordlys — Brand Brief\n\nBody.\n", "Nordlys", "Solstice")).toBe(
			"# Solstice — Brand Brief\n\nBody.\n",
		);
		expect(renamedIdentityBrief("# Brand Brief\n\nAbout Nordlys.\n", "Nordlys", "Solstice")).toBeNull();
		expect(renamedIdentityBrief("# Nordlyset\n\nBody.\n", "Nordlys", "Solstice")).toBeNull();
	});

	it("commits vision.md and existing canonical identity files atomically and shows status text", async () => {
		const files: Record<string, string> = {
			[VISION_PATH]: VISION,
			[IDENTITY_COMPANY_JSON_PATH]: '{\n  "name": "Nordlys"\n}\n',
			[IDENTITY_TOKENS_JSON_PATH]: '{\n  "brand": "Nordlys",\n  "accent": "#111"\n}\n',
			[IDENTITY_BRIEF_PATH]: "# Nordlys — Brand Brief\n\nVoice.\n",
		};
		const committedUnits: Array<Array<{ path: string; text?: string }>> = [];
		const folder = {
			read: vi.fn(async (path: string) => {
				const text = files[path];
				if (text === undefined) return { asOfSeq: 1, entry: null };
				return {
					asOfSeq: 1,
					entry: {
						path,
						kind: "file",
						version: `v-${path}`,
						file: {
							manifestSha256: `m-${path}`,
							fileSha256: path,
							bytes: new TextEncoder().encode(text).length,
							mediaType: "text/plain",
							executable: false,
						},
					},
				};
			}),
			readFile: vi.fn(async (file: { fileSha256: string }) => new TextEncoder().encode(files[file.fileSha256]!)),
			commit: vi.fn(async (_key: string, units: Array<{ op: string; path: string; text?: string }>) => {
				committedUnits.push(units.map((u) => ({ path: u.path, text: u.text })));
				return {
					commitId: "c1",
					seq: 2,
					replay: false,
					units: units.map((u, idx) => ({
						unit: idx + 1,
						op: u.op,
						path: u.path,
						to: null,
						version: `v2-${idx}`,
						outcome: "saved",
						reason: null,
						problems: [],
					})),
				};
			}),
			list: vi.fn(),
			stateFolders: vi.fn(),
		} as unknown as WebMemberFolder;

		const { view, renamed } = brand({ folder });
		await rename(view, "Solstice");
		expect(renamed).toHaveBeenCalledWith("Solstice");
		expect(committedUnits).toHaveLength(1);
		expect(committedUnits[0]!.map((u) => u.path)).toEqual([
			VISION_PATH,
			IDENTITY_COMPANY_JSON_PATH,
			IDENTITY_TOKENS_JSON_PATH,
			IDENTITY_BRIEF_PATH,
		]);
		expect(committedUnits[0]![1]!.text).toContain('"name": "Solstice"');
		expect(committedUnits[0]![2]!.text).toContain('"brand": "Solstice"');
		expect(committedUnits[0]![3]!.text).toBe("# Solstice — Brand Brief\n\nVoice.\n");
		expect(view.el.querySelector(".settings-brand-error")?.textContent).toBe("");
		expect(view.el.querySelector(".settings-brand-status")?.textContent).toBe(
			"Name updated. Your Co-Founder is updating the rest of the company.",
		);
	});

	it("falls back to a vision-only commit when an optional identity unit fails", async () => {
		const files: Record<string, string> = {
			[VISION_PATH]: VISION,
			[IDENTITY_COMPANY_JSON_PATH]: '{"name":"Nordlys"}\n',
		};
		const committedCounts: number[] = [];
		const folder = {
			read: vi.fn(async (path: string) => {
				const text = files[path];
				if (text === undefined) return { asOfSeq: 1, entry: null };
				return {
					asOfSeq: 1,
					entry: {
						path,
						kind: "file",
						version: `v-${path}`,
						file: {
							manifestSha256: `m-${path}`,
							fileSha256: path,
							bytes: new TextEncoder().encode(text).length,
							mediaType: "text/plain",
							executable: false,
						},
					},
				};
			}),
			readFile: vi.fn(async (file: { fileSha256: string }) => new TextEncoder().encode(files[file.fileSha256]!)),
			commit: vi.fn(async (_key: string, units: Array<{ op: string; path: string }>) => {
				committedCounts.push(units.length);
				if (units.length > 1) {
					return {
						commitId: "c1",
						seq: 2,
						replay: false,
						units: units.map((u, idx) => ({
							unit: idx + 1,
							op: u.op,
							path: u.path,
							to: null,
							version: null,
							outcome: "refused",
							reason: "hook",
							problems: [],
						})),
					};
				}
				return {
					commitId: "c2",
					seq: 3,
					replay: false,
					units: [
						{
							unit: 1,
							op: "write",
							path: VISION_PATH,
							to: null,
							version: "v2",
							outcome: "saved",
							reason: null,
							problems: [],
						},
					],
				};
			}),
			list: vi.fn(),
			stateFolders: vi.fn(),
		} as unknown as WebMemberFolder;

		const { view, renamed } = brand({ folder });
		await rename(view, "Solstice");
		expect(committedCounts).toEqual([2, 1]);
		expect(renamed).toHaveBeenCalledWith("Solstice");
	});
});
