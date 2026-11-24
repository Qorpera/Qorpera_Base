import type { CloudMemberFolderEntry } from "@qorpera/cloud-client/cloud-member-folder";

export type FileCategory = "folder" | "document" | "spreadsheet" | "image" | "pdf" | "link" | "other";

export const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
};

export const MARKDOWN = new Set(["md", "markdown", "mdown"]);

export function folderBaseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function folderExtension(path: string): string {
	const name = folderBaseName(path);
	return name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
}

export function fileCategory(item: Pick<CloudMemberFolderEntry, "kind" | "path">): FileCategory {
	if (item.kind === "folder") return "folder";
	if (item.kind === "symlink") return "link";
	const ext = folderExtension(item.path);
	if (IMAGE_TYPES[ext] || ["svg", "heic", "ico"].includes(ext)) return "image";
	if (["csv", "tsv", "xls", "xlsx", "numbers"].includes(ext)) return "spreadsheet";
	if (ext === "pdf") return "pdf";
	if (MARKDOWN.has(ext) || ["txt", "rtf", "doc", "docx", "odt", "pages"].includes(ext)) return "document";
	return "other";
}

const SVG = "http://www.w3.org/2000/svg";

function svgNode(name: string, attributes: Record<string, string | number>, text?: string): SVGElement {
	const node = document.createElementNS(SVG, name);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
	if (text) node.textContent = text;
	return node;
}

export function tileGlyph(
	item: Pick<CloudMemberFolderEntry, "path">,
	category: FileCategory,
	tagged = true,
): SVGSVGElement {
	const svg = svgNode("svg", { class: "storage-glyph", viewBox: "0 0 64 64", "aria-hidden": "true" }) as SVGSVGElement;
	if (category === "folder") {
		svg.append(
			svgNode("path", {
				class: "storage-glyph-back",
				d: "M6 16a4 4 0 0 1 4-4h14l5 5h25a4 4 0 0 1 4 4v29a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4Z",
			}),
			svgNode("path", {
				class: "storage-glyph-front",
				d: "M6 24a4 4 0 0 1 4-4h44a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4Z",
			}),
		);
		return svg;
	}
	svg.append(
		svgNode("path", {
			class: "storage-glyph-page",
			d: "M15 5h24l13 13v38a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z",
		}),
		svgNode("path", { class: "storage-glyph-fold", d: "M39 5v10a3 3 0 0 0 3 3h10" }),
	);
	if (category === "image")
		svg.append(
			svgNode("path", { class: "storage-glyph-mark", d: "M19 44l7-8 5 5 4-4 9 7Z" }),
			svgNode("circle", { class: "storage-glyph-mark", cx: 36, cy: 29, r: 3 }),
		);
	else if (category === "link")
		svg.append(
			svgNode("path", {
				class: "storage-glyph-line",
				d: "M27 38h-2a5 5 0 0 1 0-10h2M37 28h2a5 5 0 0 1 0 10h-2M27 33h10",
			}),
		);
	else svg.append(svgNode("path", { class: "storage-glyph-line", d: "M20 26h18M20 32h24M20 38h14" }));
	const tag = category === "link" || !tagged ? "" : folderExtension(item.path).slice(0, 4).toUpperCase();
	if (tag) {
		const width = Math.max(22, tag.length * 7 + 10);
		svg.append(
			svgNode("rect", { class: "storage-glyph-tag", x: 32 - width / 2, y: 46, width, height: 12, rx: 3 }),
			svgNode("text", { class: "storage-glyph-tag-text", x: 32, y: 54.6, "text-anchor": "middle" }, tag),
		);
	}
	return svg;
}
