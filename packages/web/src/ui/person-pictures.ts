/* Pictures members chose for their accounts. Views draw a person as an
 * initials disc; the application's picture store, while one is mounted, lays
 * the person's picture over the disc once it has loaded, and swaps or removes
 * it in place when they change it. Without a store (tests, signed out) the disc
 * stays as it is. */

export type PersonPictureStatus = "loading" | "none" | "picture" | "unavailable";

export interface PersonPictureStore {
	/** Shows `userId`'s picture on `element`, now or once it has loaded, and keeps it current. */
	attach(element: HTMLElement, userId: string): void;
	status(userId: string): PersonPictureStatus;
	/** A change of this account's own picture is on its way. */
	busy(userId: string): boolean;
	choose(userId: string, file: File): Promise<void>;
	remove(userId: string): Promise<void>;
}

/** Fired on an attached element whenever its person's picture or status changes. */
export const PERSON_PICTURE_EVENT = "qorpera-person-picture";

let store: PersonPictureStore | undefined;

export function setPersonPictures(next: PersonPictureStore | undefined): void {
	store = next;
}

export function personPictures(): PersonPictureStore | undefined {
	return store;
}

export function attachPersonPicture(element: HTMLElement, userId: string): void {
	store?.attach(element, userId);
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
