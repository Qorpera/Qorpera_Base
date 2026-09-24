// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberPictures } from "../src/app/member-pictures.ts";
import { accountPicture } from "../src/app/views/account-picture.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { parseMemberPictureChange, parseMemberPictures } from "../src/cloud/member-pictures.ts";
import { personAvatar } from "../src/ui/dom.ts";
import { PERSON_PICTURE_EVENT, setPersonPictures } from "../src/ui/person-pictures.ts";
import { PictureFileError } from "../src/ui/picture-file.ts";
import { deferred, fixture, id, settle as settleMicrotasks, userA } from "./fixtures.ts";

const me = userA.id;
const colleague = id(21);
const stranger = id(22);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const pictureOf = (userId: string, text: string, extension = "webp") => ({
	userId,
	objectName: `${userId}/${sha(text)}.${extension}`,
	updatedAt: "2026-09-24T05:00:00Z",
});
const blob = (text: string, type = "image/webp") => new Blob([text], { type });
const picture = (element: Element) => element.querySelector<HTMLImageElement>(":scope > img.person-picture");

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

function setup(options: { prepare?: (file: File) => Promise<{ blob: Blob; extension: "webp" | "jpg" }> } = {}) {
	const { api } = fixture();
	const store = new MemberPictures(api, {
		prepare: options.prepare ?? (async () => ({ blob: blob("new"), extension: "webp" })),
	});
	setPersonPictures(store);
	const upload = vi.spyOn(api, "uploadMemberPicture").mockResolvedValue();
	const download = vi.spyOn(api, "downloadMemberPicture").mockImplementation(async (name) => {
		if (name.includes(sha("mine"))) return blob("mine");
		if (name.includes(sha("theirs"))) return blob("theirs");
		throw new Error("No such picture");
	});
	const remove = vi.spyOn(api, "deleteMemberPicture").mockResolvedValue();
	return { api, store, upload, download, remove };
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
		const { api, download } = setup();
		const list = vi
			.spyOn(api, "listMemberPictures")
			.mockResolvedValue([pictureOf(me, "mine"), pictureOf(colleague, "theirs")]);
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
		const { api, download } = setup();
		vi.spyOn(api, "listMemberPictures").mockResolvedValue([pictureOf(me, "mine")]);
		download.mockResolvedValue(blob("tampered"));
		const disc = personAvatar("Account A", me);
		await settle();
		expect(picture(disc)).toBeNull();
	});

	it("shows no change control while the cloud has no member pictures", async () => {
		const { api, store } = setup();
		vi.spyOn(api, "listMemberPictures").mockRejectedValue(
			new CloudRpcError("qorpera_member_pictures", { message: "missing", code: "PGRST202" }, 404),
		);
		const control = accountPicture(userA, () => {});
		expect(control.querySelector("button")?.disabled).toBe(true);
		await settle();
		expect(store.status(me)).toBe("unavailable");
		expect(control.querySelector<HTMLButtonElement>(".account-picture-button")!.disabled).toBe(true);
		expect(control.querySelector<HTMLElement>(".account-picture-badge")!.hidden).toBe(true);
		// Nothing else asks once the cloud said so.
		personAvatar("Colleague", colleague);
		await settle();
		expect(api.listMemberPictures).toHaveBeenCalledTimes(1);
	});

	it("forgets every picture when the account changes, including reads still on their way", async () => {
		const { api, store } = setup();
		const read = deferred<ReturnType<typeof pictureOf>[]>();
		const list = vi.spyOn(api, "listMemberPictures").mockReturnValueOnce(read.promise);
		const disc = personAvatar("Account A", me);
		await settle();
		store.reset();
		read.resolve([pictureOf(me, "mine")]);
		await settle();
		expect(picture(disc)).toBeNull();
		list.mockResolvedValue([pictureOf(me, "mine")]);
		const next = personAvatar("Account A", me);
		await settle();
		expect(picture(next)).not.toBeNull();
	});
});

describe("choosing the account's picture", () => {
	it("uploads the square under its hash, makes it the picture, repaints every disc and deletes the old one", async () => {
		const { api, store, upload, remove } = setup();
		vi.spyOn(api, "listMemberPictures").mockResolvedValue([pictureOf(me, "mine")]);
		const set = vi
			.spyOn(api, "setMemberPicture")
			.mockResolvedValue({ previousObjectName: pictureOf(me, "mine").objectName });
		const chip = document.createElement("span");
		const control = accountPicture(userA, () => {});
		store.attach(chip, me);
		document.body.append(control, chip);
		await settle();
		const before = picture(chip)!.getAttribute("src");
		const events = vi.fn();
		control.querySelector(".person-avatar")!.addEventListener(PERSON_PICTURE_EVENT, events);

		await store.choose(me, new File(["photo"], "photo.heic", { type: "image/heic" }));

		const name = `${me}/${sha("new")}.webp`;
		expect(upload).toHaveBeenCalledWith(name, expect.any(Blob));
		expect(set).toHaveBeenCalledWith(name);
		expect(remove).toHaveBeenCalledWith(pictureOf(me, "mine").objectName);
		expect(picture(chip)!.getAttribute("src")).not.toBe(before);
		expect(picture(control.querySelector(".person-avatar")!)!.getAttribute("src")).toBe(
			picture(chip)!.getAttribute("src"),
		);
		expect(revoked).toContain(before);
		expect(events).toHaveBeenCalled();
		expect(store.busy(me)).toBe(false);
	});

	it("removes an upload that never became the picture", async () => {
		const { api, store, remove } = setup();
		vi.spyOn(api, "listMemberPictures").mockResolvedValue([]);
		vi.spyOn(api, "setMemberPicture").mockRejectedValue(new Error("offline"));
		personAvatar("Account A", me);
		await settle();
		await expect(store.choose(me, new File(["photo"], "photo.png", { type: "image/png" }))).rejects.toThrow(
			"offline",
		);
		expect(remove).toHaveBeenCalledWith(`${me}/${sha("new")}.webp`);
		expect(store.status(me)).toBe("none");
	});

	it("goes back to initials and deletes the removed picture", async () => {
		const { api, store, remove } = setup();
		vi.spyOn(api, "listMemberPictures").mockResolvedValue([pictureOf(me, "mine")]);
		vi.spyOn(api, "clearMemberPicture").mockResolvedValue({ previousObjectName: pictureOf(me, "mine").objectName });
		const disc = personAvatar("Account A", me);
		await settle();
		expect(picture(disc)).not.toBeNull();
		await store.remove(me);
		expect(picture(disc)).toBeNull();
		expect(disc.classList.contains("has-picture")).toBe(false);
		expect(remove).toHaveBeenCalledWith(pictureOf(me, "mine").objectName);
		expect(store.status(me)).toBe("none");
	});

	it("keeps a new picture when an older read of it arrives later", async () => {
		const { api, store } = setup();
		const read = deferred<ReturnType<typeof pictureOf>[]>();
		vi.spyOn(api, "listMemberPictures").mockReturnValueOnce(read.promise);
		vi.spyOn(api, "setMemberPicture").mockResolvedValue({});
		const disc = personAvatar("Account A", me);
		await settle();
		await store.choose(me, new File(["photo"], "photo.png", { type: "image/png" }));
		const chosen = picture(disc)!.getAttribute("src");
		read.resolve([]);
		await settle();
		expect(picture(disc)!.getAttribute("src")).toBe(chosen);
	});
});

describe("the account card's picture control", () => {
	it("opens the file chooser when there is no picture, and reports a picture the browser cannot read", async () => {
		const failed = vi.fn();
		const { api } = setup({
			prepare: async () => {
				throw new PictureFileError("This browser could not read that picture. Try a JPEG or PNG.");
			},
		});
		vi.spyOn(api, "listMemberPictures").mockResolvedValue([]);
		const control = accountPicture(userA, failed);
		document.body.append(control);
		await settle();
		const trigger = control.querySelector<HTMLButtonElement>(".account-picture-button")!;
		const input = control.querySelector<HTMLInputElement>("input[type=file]")!;
		expect(trigger.disabled).toBe(false);
		expect(trigger.getAttribute("aria-label")).toBe("Add a profile picture");
		expect(trigger.hasAttribute("aria-haspopup")).toBe(false);
		expect(input.accept).toBe("image/*");
		const chooser = vi.spyOn(input, "click").mockImplementation(() => {});
		trigger.click();
		expect(chooser).toHaveBeenCalledTimes(1);
		expect(control.querySelector<HTMLElement>("[role=menu]")!.hidden).toBe(true);

		Object.defineProperty(input, "files", { value: [new File(["x"], "x.tiff", { type: "image/tiff" })] });
		input.dispatchEvent(new Event("change"));
		await settle();
		expect(failed).toHaveBeenCalledWith("This browser could not read that picture. Try a JPEG or PNG.");
	});

	it("offers another picture or initials from a menu once there is a picture; Escape closes only the menu", async () => {
		const { api } = setup();
		vi.spyOn(api, "listMemberPictures").mockResolvedValue([pictureOf(me, "mine")]);
		const clear = vi.spyOn(api, "clearMemberPicture").mockResolvedValue({});
		const control = accountPicture(userA, () => {});
		document.body.append(control);
		await settle();
		const trigger = control.querySelector<HTMLButtonElement>(".account-picture-button")!;
		const menu = control.querySelector<HTMLElement>("[role=menu]")!;
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
		items[1]!.click();
		await settle();
		expect(clear).toHaveBeenCalledTimes(1);
		expect(picture(control.querySelector(".person-avatar")!)).toBeNull();
		expect(trigger.getAttribute("aria-label")).toBe("Add a profile picture");
	});

	it("disables itself while a change is on its way", async () => {
		const { api, store } = setup();
		vi.spyOn(api, "listMemberPictures").mockResolvedValue([]);
		const saved = deferred<{ previousObjectName?: string }>();
		vi.spyOn(api, "setMemberPicture").mockReturnValue(saved.promise);
		const control = accountPicture(userA, () => {});
		await settle();
		const choosing = store.choose(me, new File(["photo"], "photo.png", { type: "image/png" }));
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
