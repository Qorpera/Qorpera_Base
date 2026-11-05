import type { CloudMemberFolderClient } from "@qorpera/cloud-client/cloud-member-folder";

/* A picture of the company's folder for a preview on the web (an agent's wall item, a question's option): read with the
 * member's own folder client, as Storage reads it. An SVG sketch is a picture too: drawn in an <img>, it runs no script
 * and loads nothing. */

type Folder = Pick<CloudMemberFolderClient, "read" | "readFile">;

const TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};
/** The largest picture a preview reads. */
export const FOLDER_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** The media type of a picture path, or null when it names no picture a preview shows. */
export function folderImageType(path: string): string | null {
	return TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? null;
}

/** A URL an <img> shows the picture by. An SVG is a data: URL, which a browser never opens as a page of the app (a
 * blob: URL of the app's origin would, from "Open image in new tab"); any other picture is a blob: URL, which
 * {@link forgetPictureUrl} lets go. */
export async function pictureUrl(blob: Blob): Promise<string> {
	if (blob.type === "image/svg+xml")
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await blob.text())}`;
	return URL.createObjectURL(blob);
}

export function forgetPictureUrl(url: string): void {
	if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** Reads the picture at `path`: null when it is no picture, no file, or too large to preview. */
export function folderImageReader(folder: () => Folder): (path: string, signal: AbortSignal) => Promise<Blob | null> {
	return async (path, signal) => {
		const type = folderImageType(path);
		if (!type) return null;
		const from = folder();
		const entry = (await from.read(path, signal)).entry;
		if (entry?.kind !== "file" || !entry.file || entry.file.bytes > FOLDER_IMAGE_MAX_BYTES) return null;
		const bytes = await from.readFile(entry.file, signal, FOLDER_IMAGE_MAX_BYTES);
		return new Blob([Uint8Array.from(bytes)], { type });
	};
}
