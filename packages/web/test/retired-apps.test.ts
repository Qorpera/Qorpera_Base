import { bringBackApp, parseRetiredApps, retireApp } from "@qorpera/cloud-client/app-retired";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { readApps, readRetiredApps } from "../src/app/interface-apps.ts";
import { WebCompanyFolderRejectedError } from "../src/cloud/company-folder-writes.ts";
import { changeRetiredApps } from "../src/cloud/retired-apps.ts";
import { fixture, profileA, team, userA } from "./fixtures.ts";
import { folderFake } from "./folder-fake.ts";

/* Retire interface's write (the founder, 15 Nov 2026): a member's change of apps/retired.md, over the version read, tried
 * once more when another member wrote the file in between; and the company's view of it, which a read from before a
 * member's own change never undoes. The rail, the page, the card and the Concepts viewer are in
 * application-lifecycle.test.ts. */

const PATH = "apps/retired.md";
const OTHER = "6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8";
const AT = "2026-11-15T09:30:00Z";
const options = { key: () => `k:${crypto.randomUUID()}`, failure: "Not written.", full: "Full." };
const never = () => {};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("changeRetiredApps", () => {
	it("makes the file when there is none, and writes over the version read after that", async () => {
		const fake = folderFake({ seed: [] });
		fake.mkdir("apps");
		const signal = new AbortController().signal;
		await changeRetiredApps(fake.folder, (text) => retireApp(text, "plan", userA.id, AT), options, signal, never);
		expect(fake.text(PATH)).toBe(`# Retired interfaces\n- plan | ${userA.id} | ${AT}\n`);
		expect(fake.commits.at(-1)?.units).toEqual([{ op: "write", path: PATH, text: fake.text(PATH) }]);
		const version = fake.version(PATH);
		await changeRetiredApps(fake.folder, (text) => bringBackApp(text ?? "", "plan"), options, signal, never);
		expect(fake.text(PATH)).toBe("# Retired interfaces\n");
		expect(fake.commits.at(-1)?.units).toEqual([
			{ op: "write", path: PATH, text: "# Retired interfaces\n", expectedVersion: version },
		]);
		// Nothing to do writes nothing: an app not retired, or no file to bring one back from.
		const sent = fake.commits.length;
		await changeRetiredApps(fake.folder, (text) => bringBackApp(text ?? "", "plan"), options, signal, never);
		fake.remove(PATH);
		await changeRetiredApps(
			fake.folder,
			(text) => (text === null ? null : bringBackApp(text, "plan")),
			options,
			signal,
			never,
		);
		expect(fake.commits).toHaveLength(sent);
	});

	it("tries once more when another member wrote the file in between, and no more", async () => {
		const fake = folderFake({ seed: [] });
		fake.put(PATH, "# Retired interfaces\n");
		const signal = new AbortController().signal;
		const commit = vi.mocked(fake.folder.commit);
		const original = commit.getMockImplementation() as unknown as (
			...args: Parameters<typeof fake.folder.commit>
		) => ReturnType<typeof fake.folder.commit>;
		// Another member's line lands between each read and its write.
		let others = 0;
		commit.mockImplementation(async (...args) => {
			others++;
			fake.put(PATH, `${fake.text(PATH)}- other-${others} | ${OTHER} | ${AT}\n`);
			return original(...args);
		});
		const retire = (text: string | null) => retireApp(text, "plan", userA.id, AT);
		const refused = await changeRetiredApps(fake.folder, retire, options, signal, never).then(
			() => null,
			(error: unknown) => error,
		);
		expect(refused).toBeInstanceOf(WebCompanyFolderRejectedError);
		expect((refused as WebCompanyFolderRejectedError).outcome).toBe("conflict");
		expect(fake.commits).toHaveLength(2);
		expect(parseRetiredApps(fake.text(PATH) ?? "").map((app) => app.name)).toEqual(["other-1", "other-2"]);
		// Once: the second write goes over the newer version, keeping the other member's line.
		commit.mockImplementationOnce(async (...args) => {
			fake.put(PATH, `${fake.text(PATH)}- other-3 | ${OTHER} | ${AT}\n`);
			return original(...args);
		});
		commit.mockImplementation(original);
		await changeRetiredApps(fake.folder, retire, options, signal, never);
		expect(fake.commits).toHaveLength(4);
		expect(parseRetiredApps(fake.text(PATH) ?? "").map((app) => app.name)).toEqual([
			"other-1",
			"other-2",
			"other-3",
			"plan",
		]);
	});

	it("says the file is full when the line would not be read, and refuses a file that is no text", async () => {
		const fake = folderFake({ seed: [] });
		const lines = Array.from({ length: 200 }, (_, n) => `- app-${n} | ${OTHER} | ${AT}`);
		fake.put(PATH, `${lines.join("\n")}\n`);
		const signal = new AbortController().signal;
		const retire = (text: string | null) => retireApp(text, "plan", userA.id, AT);
		await expect(changeRetiredApps(fake.folder, retire, options, signal, never)).rejects.toThrow("Full.");
		fake.remove(PATH);
		fake.mkdir(PATH);
		await expect(changeRetiredApps(fake.folder, retire, options, signal, never)).rejects.toThrow("Not written.");
		expect(fake.commits).toEqual([]);
	});
});

describe("the company's retired interfaces", () => {
	async function company() {
		const f = fixture();
		const controller = new CompanyController(f.api, profileA, userA.id);
		const fake = folderFake({ seed: [] });
		fake.put("apps/plan/app.toml", 'name = "Plan"\nposted = true\n');
		controller.store.set({ loading: false, team, apps: await readApps(fake.folder, new AbortController().signal) });
		controller.appsFolder = () => fake.folder;
		const reread = vi.fn();
		controller.appsReread = reread;
		return { controller, fake, reread };
	}
	const names = (controller: CompanyController) => controller.store.get().appsRetired?.map((app) => app.name);

	it("reads the file with the apps, and a read from before the member's own change never undoes it", async () => {
		const { controller, fake, reread } = await company();
		const signal = new AbortController().signal;
		expect(await readRetiredApps(fake.folder, signal)).toEqual([]);
		// Another member's retire, read.
		fake.put(PATH, `# Retired interfaces\n- old | ${OTHER} | ${AT}\n`);
		controller.publishRetiredApps(await readRetiredApps(fake.folder, signal), performance.now());
		expect(names(controller)).toEqual(["old"]);
		// This member retires plan: it is retired at once, and written.
		const before = performance.now();
		const done = controller.setAppRetired("plan", true);
		expect(names(controller)).toEqual(["old", "plan"]);
		expect(await done).toBe(true);
		expect(parseRetiredApps(fake.text(PATH) ?? "").map((app) => app.name)).toEqual(["old", "plan"]);
		expect(reread).toHaveBeenCalledOnce();
		// A read that began before the write found the old file: plan stays retired.
		controller.publishRetiredApps(parseRetiredApps(`- old | ${OTHER} | ${AT}\n`), before);
		expect(names(controller)).toEqual(["old", "plan"]);
		// One after it settles it, as the file says.
		controller.publishRetiredApps(await readRetiredApps(fake.folder, signal), performance.now());
		expect(names(controller)).toEqual(["old", "plan"]);
		expect(controller.retiredApp("plan")?.by).toBe(userA.id);
		controller.stop();
	});

	it("puts the app back and says so when the write fails, and offers nothing to a member who may not write", async () => {
		const { controller, fake } = await company();
		fake.answer("denied", "denied");
		const done = controller.setAppRetired("plan", true);
		expect(names(controller)).toEqual(["plan"]);
		expect(await done).toBe(false);
		expect(names(controller)).toEqual([]);
		expect(controller.store.get().railError).toBe("Plan could not be retired. Try again.");
		controller.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		expect(controller.mayRetireApps()).toBe(false);
		expect(await controller.setAppRetired("plan", true)).toBe(false);
		expect(fake.commits).toHaveLength(1);
		controller.stop();
	});
});
