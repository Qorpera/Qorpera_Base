import type { PictureCrop } from "./picture-file.ts";

/* Pictures members chose for their accounts. Views draw a person as an
 * initials disc; the application's picture store, while one is mounted, lays
 * the person's picture over the disc once it has loaded, and swaps or removes
 * it in place when they change it. Without a store (tests, signed out) the disc
 * stays as it is. */

/** "failed": the picture could not be read just now; there may be one. */
export type PersonPictureStatus = "loading" | "none" | "picture" | "failed" | "unavailable";

export interface PersonPictureStore {
	/** Shows `userId`'s picture on `element`, now or once it has loaded, and keeps it current. */
	attach(element: HTMLElement, userId: string): void;
	status(userId: string): PersonPictureStatus;
	/** A change of this account's own picture is on its way. */
	busy(userId: string): boolean;
	/** Why the last change of this account's picture failed, until the next attempt. */
	failure(userId: string): unknown;
	/** Makes `crop` of `file` (its centre square without one) this account's picture. */
	choose(userId: string, file: File, crop?: PictureCrop): Promise<void>;
	remove(userId: string): Promise<void>;
	/** Keeps why a change failed before it reached the store (a photo the browser cannot read). */
	fail(userId: string, error: unknown): void;
}

/** Fired on an attached element whenever its person's picture or status changes. */
export const PERSON_PICTURE_EVENT = "qorpera-person-picture";

let store: PersonPictureStore | undefined;
let epoch = 0;

export function setPersonPictures(next: PersonPictureStore | undefined): void {
	store = next;
}

export function personPictures(): PersonPictureStore | undefined {
	return store;
}

export function attachPersonPicture(element: HTMLElement, userId: string): void {
	store?.attach(element, userId);
}

/** Changes whenever the store forgets every picture; a view that keeps discs across
 * renders compares it to know when to attach them again. */
export function personPicturesEpoch(): number {
	return epoch;
}

export function forgetPersonPictures(): void {
	epoch++;
}

export function paintPersonPicture(element: HTMLElement, url: string | undefined): void {
	let picture = element.querySelector<HTMLImageElement>(":scope > img.person-picture");
	if (url) {
		if (!picture) {
			picture = document.createElement("img");
			picture.className = "person-picture";
			picture.alt = "";
			picture.draggable = false;
			element.append(picture);
		}
		if (picture.getAttribute("src") !== url) picture.src = url;
	} else picture?.remove();
	element.classList.toggle("has-picture", Boolean(url));
}
