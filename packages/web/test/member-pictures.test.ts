// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberPictures } from "../src/app/member-pictures.ts";
import { accountPicture } from "../src/app/views/account-picture.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import {
	parseMemberPictureChange,
	parseMemberPictureObjects,
	parseMemberPictures,
} from "../src/cloud/member-pictures.ts";
import { personAvatar } from "../src/ui/dom.ts";
import { PERSON_PICTURE_EVENT, personPicturesEpoch, setPersonPictures } from "../src/ui/person-pictures.ts";
import { PictureFileError } from "../src/ui/picture-file.ts";
import { deferred, fixture, id, settle as settleMicrotasks, userA } from "./fixtures.ts";

const me = userA.id;
const colleague = id(21);
const stranger = id(22);
const NOW = Date.parse("2026-09-24T06:00:00Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const nameOf = (userId: string, text: string, extension = "webp") => `${userId}/${sha(text)}.${extension}`;
const blob = (text: string, type = "image/webp") => new Blob([text], { type });
const picture = (element: Element) => element.querySelector<HTMLImageElement>(":scope > img.person-picture");
const photo = () => new File(["photo"], "photo.png", { type: "image/png" });

/** Hashing and reading a blob finish outside the microtask queue. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 6; turn++) {
		await settleMicrotasks();
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

let urls = 0;
let revoked: string[] = [];
beforeEach(() => {
	// jsdom's Blob cannot hand back its bytes; the browser's can.
	vi.stubGlobal("Blob", NodeBlob);
	vi.stubGlobal("File", NodeFile);
	urls = 0;
	revoked = [];
	URL.createObjectURL = vi.fn(() => `blob:picture-${++urls}`);
	URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
});
afterEach(() => {
	setPersonPictures(undefined);
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** The cloud as the member pictures migration defines it: a current picture per
 * account and the objects in each folder (four at most). */
function setup(
	options: {
		prepare?: (file: File) => Promise<{ blob: Blob; extension: "webp" | "jpg" }>;
		pictures?: Record<string, string>;
	} = {},
) {
	const { api } = fixture();
	const current = new Map<string, string>();
	const objects = new Map<string, { bytes: string; createdAt: string }>();
	for (const [userId, text] of Object.entries(options.pictures ?? {})) {
		current.set(userId, nameOf(userId, text));
		objects.set(nameOf(userId, text), { bytes: text, createdAt: "2026-09-24T05:00:00Z" });
	}
	const store = new MemberPictures(api, {
		prepare: options.prepare ?? (async () => ({ blob: blob("new"), extension: "webp" })),
		now: () => NOW,
	});
	setPersonPictures(store);
	const list = vi
		.spyOn(api, "listMemberPictures")
		.mockImplementation(async (ids) =>
			ids
				.filter((userId) => current.has(userId))
				.map((userId) => ({ userId, objectName: current.get(userId)!, updatedAt: "2026-09-24T05:00:00Z" })),
		);
	const download = vi.spyOn(api, "downloadMemberPicture").mockImplementation(async (name) => {
		const object = objects.get(name);
		if (!object) throw new Error("No such picture");
		return blob(object.bytes);
	});
	const upload = vi.spyOn(api, "uploadMemberPicture").mockImplementation(async (name, bytes) => {
		if (objects.has(name)) return false;
		const folder = name.slice(0, name.indexOf("/") + 1);
		if ([...objects.keys()].filter((key) => key.startsWith(folder)).length >= 4)
			throw Object.assign(new Error("new row violates row-level security policy"), { statusCode: "403" });
		objects.set(name, { bytes: await bytes.text(), createdAt: new Date(NOW).toISOString() });
		return true;
	});
	const set = vi.spyOn(api, "setMemberPicture").mockImplementation(async (name) => {
		if (!objects.has(name)) throw new Error("upload the picture before choosing it");
		const previous = current.get(me);
		current.set(me, name);
		return previous && previous !== name ? { previousObjectName: previous } : {};
	});
	const clear = vi.spyOn(api, "clearMemberPicture").mockImplementation(async () => {
		const previous = current.get(me);
		current.delete(me);
		return previous ? { previousObjectName: previous } : {};
	});
	const folder = () =>
		[...objects.entries()]
			.filter(([name]) => name.startsWith(`${me}/`))
			.map(([objectName, object]) => ({
				objectName,
				createdAt: object.createdAt,
				ageSeconds: Math.max(0, Math.floor((NOW - Date.parse(object.createdAt)) / 1000)),
			}));
	const own = vi.spyOn(api, "ownMemberPictureObjects").mockImplementation(async () => folder());
	// Like the bucket's delete policy: a current picture is not deleted (and not reported).
	vi.spyOn(api, "deleteMemberPicture").mockImplementation(async (name) => {
		if (![...current.values()].includes(name)) objects.delete(name);
	});
	return { api, store, current, objects, list, download, upload, set, clear, own, folder };
}

describe("member picture parsing", () => {
	it("keeps only well-formed pictures in the owner's own folder", () => {
		const good = { user_id: me, object_name: `${me}/${"a".repeat(64)}.webp`, updated_at: "2026-09-24T05:00:00Z" };
		expect(parseMemberPictures([good])).toEqual([
			{ userId: me, objectName: good.object_name, updatedAt: good.updated_at },
		]);
		expect(() => parseMemberPictures([{ ...good, object_name: `${colleague}/${"a".repeat(64)}.webp` }])).toThrow();
		expect(() => parseMemberPictures([{ ...good, object_name: `${me}/../${"a".repeat(64)}.webp` }])).toThrow();
		expect(() => parseMemberPictures([{ ...good, object_name: `${me}/${"a".repeat(64)}.svg` }])).toThrow();
		expect(
			parseMemberPictureObjects([
				{ object_name: good.object_name, created_at: "2026-09-24T05:00:00Z", age_seconds: 42 },
			]),
		).toEqual([{ objectName: good.object_name, createdAt: "2026-09-24T05:00:00Z", ageSeconds: 42 }]);
		expect(() =>
			parseMemberPictureObjects([
				{ object_name: good.object_name, created_at: "2026-09-24T05:00:00Z", age_seconds: -1 },
			]),
		).toThrow();
		expect(() => parseMemberPictureObjects([{ object_name: `${me}/notes.txt`, created_at: "2026-09-24" }])).toThrow();
		expect(parseMemberPictureChange({ previous_object_name: null })).toEqual({});
		expect(parseMemberPictureChange({ previous_object_name: good.object_name })).toEqual({
			previousObjectName: good.object_name,
		});
	});
});

describe("member pictures on initials discs", () => {
	it("stays initials without a picture store", () => {
		const avatar = personAvatar("Account A", me);
		expect(avatar.textContent).toBe("AA");
		expect(picture(avatar)).toBeNull();
	});

	it("reads every disc of one moment in one call and lays each picture over its disc", async () => {
		const { list, download } = setup({ pictures: { [me]: "mine", [colleague]: "theirs" } });
		const discs = [
			personAvatar("Account A", me),
			personAvatar("Colleague", colleague),
			personAvatar("Colleague", colleague.toUpperCase()),
			personAvatar("Stranger", stranger),
			personAvatar("invitee@example.invalid", "invitee@example.invalid"),
		];
		await settle();
		expect(list).toHaveBeenCalledTimes(1);
		expect(list.mock.calls[0]![0]).toEqual([me, colleague, stranger]);
		expect(download).toHaveBeenCalledTimes(2);
		expect(picture(discs[0]!)?.getAttribute("src")).toMatch(/^blob:picture-/);
		expect(picture(discs[1]!)?.getAttribute("src")).toBe(picture(discs[2]!)?.getAttribute("src"));
		expect(discs[1]!.classList.contains("has-picture")).toBe(true);
		expect(picture(discs[3]!)).toBeNull();
		expect(picture(discs[4]!)).toBeNull();
		// A later disc for the same person shows the loaded picture at once, with no new read.
		const later = personAvatar("Account A", me);
		expect(picture(later)?.getAttribute("src")).toBe(picture(discs[0]!)?.getAttribute("src"));
		await settle();
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("refuses bytes that do not match the picture's name", async () => {
		const { download } = setup({ pictures: { [me]: "mine" } });
		download.mockResolvedValue(blob("tampered"));
		const disc = personAvatar("Account A", me);
		await settle();
		expect(picture(disc)).toBeNull();
	});

	it("shows no change control while the cloud has no member pictures", async () => {
		const { store, list } = setup();
		list.mockRejectedValue(
			new CloudRpcError("qorpera_member_pictures", { message: "missing", code: "PGRST202" }, 404),
		);
		const { picture: control } = accountPicture(userA);
		expect(control.querySelector("button")?.disabled).toBe(true);
		await settle();
		expect(store.status(me)).toBe("unavailable");
		expect(control.querySelector<HTMLButtonElement>(".account-picture-button")!.disabled).toBe(true);
		expect(control.querySelector<HTMLElement>(".account-picture-badge")!.hidden).toBe(true);
		// Nothing else asks once the cloud said so.
		personAvatar("Colleague", colleague);
		await settle();
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("forgets every picture when the account changes, including reads still on their way", async () => {
		const { store, list } = setup({ pictures: { [me]: "mine" } });
		const read = deferred<Awaited<ReturnType<typeof list>>>();
		list.mockReturnValueOnce(read.promise);
		const disc = personAvatar("Account A", me);
		await settle();
		const epoch = personPicturesEpoch();
		store.reset();
		expect(personPicturesEpoch()).toBe(epoch + 1);
		read.resolve([{ userId: me, objectName: nameOf(me, "mine"), updatedAt: "2026-09-24T05:00:00Z" }]);
		await settle();
		expect(picture(disc)).toBeNull();
		const next = personAvatar("Account A", me);
		await settle();
		expect(picture(next)).not.toBeNull();
	});
});

describe("choosing the account's picture", () => {
	it("uploads the square under its hash, makes it the picture, repaints every disc and deletes the old one", async () => {
		const { store, objects, current, upload, set } = setup({ pictures: { [me]: "mine" } });
		const chip = document.createElement("span");
		const { picture: control } = accountPicture(userA);
		store.attach(chip, me);
		document.body.append(control, chip);
		await settle();
		const before = picture(chip)!.getAttribute("src");
		const events = vi.fn();
		control.querySelector(".person-avatar")!.addEventListener(PERSON_PICTURE_EVENT, events);

		await store.choose(me, new File(["photo"], "photo.heic", { type: "image/heic" }));
		await settle();

		const name = nameOf(me, "new");
		expect(upload).toHaveBeenCalledWith(name, expect.any(Blob));
		expect(set).toHaveBeenCalledWith(name);
		expect(current.get(me)).toBe(name);
		expect([...objects.keys()]).toEqual([name]);
		expect(picture(chip)!.getAttribute("src")).not.toBe(before);
		expect(picture(control.querySelector(".person-avatar")!)!.getAttribute("src")).toBe(
			picture(chip)!.getAttribute("src"),
		);
		expect(revoked).toContain(before);
		expect(events).toHaveBeenCalled();
		expect(store.busy(me)).toBe(false);
		expect(store.failure(me)).toBeUndefined();
	});

	it("removes an upload the cloud refused to make the picture, and keeps the reason", async () => {
		const { store, objects, set } = setup({ pictures: { [me]: "mine" } });
		const refusal = new CloudRpcError("qorpera_set_member_picture", { message: "denied", code: "42501" }, 403);
		set.mockRejectedValue(refusal);
		personAvatar("Account A", me);
		await settle();
		await expect(store.choose(me, photo())).rejects.toBe(refusal);
		await settle();
		expect([...objects.keys()]).toEqual([nameOf(me, "mine")]);
		expect(store.status(me)).toBe("picture");
		expect(store.failure(me)).toBe(refusal);
	});

	it("keeps an upload that became the picture although the answer was lost", async () => {
		const { store, objects, current, set } = setup({ pictures: { [me]: "mine" } });
		set.mockImplementation(async (name) => {
			current.set(me, name);
			throw new Error("Failed to fetch");
		});
		personAvatar("Account A", me);
		await settle();
		await expect(store.choose(me, photo())).rejects.toThrow("Failed to fetch");
		await settle();
		expect(objects.has(nameOf(me, "new"))).toBe(true);
	});

	it("never deletes the current picture when the same bytes are chosen again and saving fails", async () => {
		const { store, objects, set, download } = setup({ pictures: { [me]: "new" } });
		// Its first read failed, so the store does not know this is the current picture.
		download.mockRejectedValueOnce(new Error("offline"));
		personAvatar("Account A", me);
		await settle();
		expect(store.status(me)).toBe("failed");
		set.mockRejectedValue(new Error("offline"));
		await expect(store.choose(me, photo())).rejects.toThrow("offline");
		await settle();
		expect(objects.has(nameOf(me, "new"))).toBe(true);
	});

	it("tidies a folder full of uploads never chosen, then stores the new picture", async () => {
		const { store, objects, current, upload } = setup({ pictures: { [me]: "mine" } });
		// Stored "in the future" by this device's clock, which is behind the cloud's.
		for (const text of ["a", "b", "c"])
			objects.set(nameOf(me, text), { bytes: text, createdAt: new Date(NOW + 3_600_000).toISOString() });
		personAvatar("Account A", me);
		await settle();
		await store.choose(me, photo());
		await settle();
		expect(upload).toHaveBeenCalledTimes(2);
		expect(current.get(me)).toBe(nameOf(me, "new"));
		expect([...objects.keys()]).toEqual([nameOf(me, "new")]);
	});

	it("leaves a young upload of another tab alone when tidying after a change", async () => {
		const { store, objects } = setup({ pictures: { [me]: "mine" } });
		const otherTab = nameOf(me, "other tab");
		objects.set(otherTab, { bytes: "other tab", createdAt: new Date(NOW - 10_000).toISOString() });
		const old = nameOf(me, "old attempt");
		objects.set(old, { bytes: "old attempt", createdAt: new Date(NOW - 600_000).toISOString() });
		personAvatar("Account A", me);
		await settle();
		await store.choose(me, photo());
		await settle();
		expect(objects.has(otherTab)).toBe(true);
		expect(objects.has(old)).toBe(false);
		expect(objects.has(nameOf(me, "mine"))).toBe(false);
		expect(objects.has(nameOf(me, "new"))).toBe(true);
	});

	it("keeps the old picture when it is chosen again while the tidy after a change is still running", async () => {
		const texts = ["new", "mine"];
		const { store, objects, current, own, folder, set } = setup({
			pictures: { [me]: "mine" },
			prepare: async () => ({ blob: blob(texts.shift()!), extension: "webp" }),
		});
		personAvatar("Account A", me);
		await settle();
		const listing = deferred<ReturnType<typeof folder>>();
		own.mockReturnValueOnce(listing.promise);
		await store.choose(me, photo());
		await settle();
		// The tidy has read that "mine" is no longer current and waits for the folder.
		const saving = deferred<void>();
		const save = set.getMockImplementation()!;
		set.mockImplementationOnce(async (name) => {
			await saving.promise;
			return save(name);
		});
		const again = store.choose(me, photo());
		await settle();
		// The tidy deletes "mine" now; the choice must upload it again before saving.
		listing.resolve(folder());
		await settle();
		saving.resolve();
		await again;
		await settle();
		expect(current.get(me)).toBe(nameOf(me, "mine"));
		expect(objects.has(nameOf(me, "mine"))).toBe(true);
		expect(store.failure(me)).toBeUndefined();
	});

	it("goes back to initials and deletes the removed picture", async () => {
		const { store, objects } = setup({ pictures: { [me]: "mine" } });
		const disc = personAvatar("Account A", me);
		await settle();
		expect(picture(disc)).not.toBeNull();
		await store.remove(me);
		await settle();
		expect(picture(disc)).toBeNull();
		expect(disc.classList.contains("has-picture")).toBe(false);
		expect(objects.size).toBe(0);
		expect(store.status(me)).toBe("none");
	});

	it("keeps a new picture when an older read of it arrives later", async () => {
		const { store, list } = setup();
		const read = deferred<Awaited<ReturnType<typeof list>>>();
		list.mockReturnValueOnce(read.promise);
		const disc = personAvatar("Account A", me);
		await settle();
		await store.choose(me, photo());
		const chosen = picture(disc)!.getAttribute("src");
		read.resolve([]);
		await settle();
		expect(picture(disc)!.getAttribute("src")).toBe(chosen);
	});
});

describe("the account card's picture control", () => {
	it("opens the file chooser when there is no picture, and shows why a picture failed until the next try", async () => {
		const prepare = vi.fn(async (_file: File): Promise<{ blob: Blob; extension: "webp" | "jpg" }> => {
			throw new PictureFileError("This browser could not read that picture. Try a JPEG or PNG.");
		});
		const { store } = setup({ prepare });
		const { picture: control, error } = accountPicture(userA);
		document.body.append(control, error);
		await settle();
		const trigger = control.querySelector<HTMLButtonElement>(".account-picture-button")!;
		const input = control.querySelector<HTMLInputElement>("input[type=file]")!;
		expect(trigger.disabled).toBe(false);
		expect(trigger.getAttribute("aria-label")).toBe("Add a profile picture");
		expect(trigger.hasAttribute("aria-haspopup")).toBe(false);
		expect(input.accept).toBe("image/*");
		expect(error.hidden).toBe(true);
		const chooser = vi.spyOn(input, "click").mockImplementation(() => {});
		trigger.click();
		expect(chooser).toHaveBeenCalledTimes(1);
		expect(control.querySelector<HTMLElement>("[role=menu]")!.hidden).toBe(true);

		Object.defineProperty(input, "files", {
			configurable: true,
			value: [new File(["x"], "x.tiff", { type: "image/tiff" })],
		});
		input.dispatchEvent(new Event("change"));
		await settle();
		expect(error.hidden).toBe(false);
		expect(error.textContent).toBe("This browser could not read that picture. Try a JPEG or PNG.");
		// A page drawn again keeps showing it.
		expect(accountPicture(userA).error.textContent).toBe(error.textContent);

		prepare.mockResolvedValue({ blob: blob("new"), extension: "webp" });
		const choosing = store.choose(me, photo());
		expect(error.hidden).toBe(true);
		await choosing;
	});

	it("offers another picture or initials from a menu once there is a picture; Escape closes only the menu", async () => {
		const { clear } = setup({ pictures: { [me]: "mine" } });
		const { picture: control } = accountPicture(userA);
		document.body.append(control);
		await settle();
		const trigger = control.querySelector<HTMLButtonElement>(".account-picture-button")!;
		const menu = control.querySelector<HTMLElement>("[role=menu]")!;
		const input = control.querySelector<HTMLInputElement>("input[type=file]")!;
		const chooser = vi.spyOn(input, "click").mockImplementation(() => {});
		expect(trigger.getAttribute("aria-label")).toBe("Change profile picture");
		expect(trigger.getAttribute("aria-haspopup")).toBe("menu");

		trigger.click();
		expect(menu.hidden).toBe(false);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		const items = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
		expect(items.map((item) => item.textContent)).toEqual(["Choose a new picture", "Remove picture"]);
		expect(document.activeElement).toBe(items[0]);
		menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(items[1]);

		const outer = vi.fn();
		document.addEventListener("keydown", outer);
		items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		document.removeEventListener("keydown", outer);
		expect(outer).not.toHaveBeenCalled();
		expect(menu.hidden).toBe(true);
		expect(document.activeElement).toBe(trigger);

		trigger.click();
		items[0]!.click();
		expect(chooser).toHaveBeenCalledTimes(1);
		expect(menu.hidden).toBe(true);
		expect(document.activeElement).toBe(trigger);

		trigger.click();
		items[1]!.click();
		await settle();
		expect(clear).toHaveBeenCalledTimes(1);
		expect(picture(control.querySelector(".person-avatar")!)).toBeNull();
		expect(trigger.getAttribute("aria-label")).toBe("Add a profile picture");
	});

	it("offers both choices when the picture could not be read", async () => {
		const { download } = setup({ pictures: { [me]: "mine" } });
		download.mockRejectedValue(new Error("offline"));
		const { picture: control } = accountPicture(userA);
		document.body.append(control);
		await settle();
		const trigger = control.querySelector<HTMLButtonElement>(".account-picture-button")!;
		expect(trigger.disabled).toBe(false);
		expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
		trigger.click();
		expect(control.querySelector<HTMLElement>("[role=menu]")!.hidden).toBe(false);
	});

	it("says the picture could not be saved when storage keeps refusing, without the policy's words", async () => {
		const { upload } = setup();
		upload.mockRejectedValue(
			Object.assign(new Error("new row violates row-level security policy"), { statusCode: "403" }),
		);
		const { picture: control, error } = accountPicture(userA);
		document.body.append(control, error);
		await settle();
		const input = control.querySelector<HTMLInputElement>("input[type=file]")!;
		Object.defineProperty(input, "files", { configurable: true, value: [photo()] });
		input.dispatchEvent(new Event("change"));
		await settle();
		expect(upload).toHaveBeenCalledTimes(2);
		expect(error.textContent).toBe("Your picture could not be saved. Try again in a moment.");
	});

	it("moves from the menu itself to its first or last item", async () => {
		setup({ pictures: { [me]: "mine" } });
		const { picture: control } = accountPicture(userA);
		document.body.append(control);
		await settle();
		control.querySelector<HTMLButtonElement>(".account-picture-button")!.click();
		const menu = control.querySelector<HTMLElement>("[role=menu]")!;
		const items = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
		menu.focus();
		menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		expect(document.activeElement).toBe(items[1]);
		menu.focus();
		menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement).toBe(items[0]);
	});

	it("disables itself while a change is on its way", async () => {
		const { store, set } = setup();
		const saved = deferred<{ previousObjectName?: string }>();
		set.mockReturnValue(saved.promise);
		const { picture: control } = accountPicture(userA);
		await settle();
		const choosing = store.choose(me, photo());
		await settle();
		const trigger = control.querySelector<HTMLButtonElement>(".account-picture-button")!;
		expect(trigger.disabled).toBe(true);
		expect(trigger.getAttribute("aria-busy")).toBe("true");
		expect(control.classList.contains("is-busy")).toBe(true);
		await expect(store.choose(me, new File(["again"], "again.png"))).rejects.toThrow("still being changed");
		saved.resolve({});
		await choosing;
		expect(trigger.disabled).toBe(false);
		expect(trigger.hasAttribute("aria-busy")).toBe(false);
	});
});
