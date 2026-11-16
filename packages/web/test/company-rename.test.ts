// @vitest-environment jsdom

import { parseCompanyStateFile } from "@qorpera/cloud-client/company-state-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubController } from "../src/app/views/hub.ts";
import { CompanyBrandView, renamedVision, VISION_PATH } from "../src/app/views/settings-brand.ts";
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
	});

	it("leaves a settings block above the heading as it is", () => {
		const text = "---\nowner: cofounder\n---\n# Old\n\nText\n";
		const renamed = renamedVision(text, "Ny");
		expect(renamed).toBe("---\nowner: cofounder\n---\n# Ny\n\nText\n");
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

	it("says so when the name could not be saved", async () => {
		const { folder } = fakeFolder();
		vi.mocked(folder.commit).mockResolvedValue({
			commitId: "x",
			seq: 2,
			replay: false,
			units: [
				{
					unit: 1,
					op: "write",
					path: VISION_PATH,
					to: null,
					version: null,
					outcome: "refused",
					reason: "forbidden",
					problems: [],
				},
			],
		} as unknown as Awaited<ReturnType<WebMemberFolder["commit"]>>);
		const { view, renamed } = brand({ folder });
		await rename(view, "Nordlys Studio", "Enter", false);
		await vi.waitFor(() =>
			expect(view.el.querySelector(".settings-brand-error")?.textContent).toContain("The name could not be saved."),
		);
		expect(renamed).not.toHaveBeenCalled();
		expect(view.el.querySelector<HTMLInputElement>(".settings-brand-name-input")?.value).toBe("Nordlys Studio");
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

	it("goes back to the cloud's name when the rename never arrives", async () => {
		vi.useFakeTimers();
		const { api } = fakeHubApi(["Nordlys"]);
		const hub = new HubController(api);
		await hub.refresh();
		hub.renamed(COMPANY, "Nordlys Studio");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(hub.store.get().profiles[0]?.profileName).toBe("Nordlys");
		hub.dispose();
	});
});
