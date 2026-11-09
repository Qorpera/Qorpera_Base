/* Companies' logos. Views draw a company as its figure (`companyLogo` in dom.ts); the application's logo store, while
 * one is mounted, lays the company's logo over the figure once it has loaded, and swaps or removes it in place when it
 * changes. Without a store (tests, signed out) the figure stays as it is. */

import type { WebMemberFolder } from "../cloud/company-folder-writes.ts";
import type { CompanyLogo } from "../cloud/company-logos.ts";
import type { PictureCrop } from "./picture-file.ts";

export interface CompanyLogoStore {
	/** Shows `profileId`'s logo on `element`, now or once it has loaded, and keeps it current. */
	attach(element: HTMLElement, profileId: string): void;
	/** What the cloud last said about a company's logo, once it has answered. */
	logo(profileId: string): CompanyLogo | undefined;
	/** Brings the logo everyone sees in step with the company folder's logo.svg, when the caller may. */
	sync(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void>;
	/** Saves a chosen picture as the company's logo. */
	choose(
		profileId: string,
		file: File,
		crop: PictureCrop | undefined,
		folder: () => WebMemberFolder,
		signal: AbortSignal,
	): Promise<void>;
	/** Takes the company's logo away. */
	remove(profileId: string, folder: () => WebMemberFolder, signal: AbortSignal): Promise<void>;
}

let store: CompanyLogoStore | undefined;

export function setCompanyLogos(next: CompanyLogoStore | undefined): void {
	store = next;
}

export function companyLogos(): CompanyLogoStore | undefined {
	return store;
}

export function attachCompanyLogo(element: HTMLElement, profileId: string): void {
	store?.attach(element, profileId);
}

/** Lays `url` over a company's figure, or takes the logo away (`undefined`). */
export function paintCompanyLogo(element: HTMLElement, url: string | undefined): void {
	let picture = element.querySelector<HTMLImageElement>(":scope > img.company-logo-picture");
	if (url) {
		if (!picture) {
			picture = document.createElement("img");
			picture.className = "company-logo-picture";
			picture.alt = "";
			picture.draggable = false;
			element.append(picture);
		}
		if (picture.getAttribute("src") !== url) picture.src = url;
	} else picture?.remove();
	element.classList.toggle("has-logo", Boolean(url));
}
