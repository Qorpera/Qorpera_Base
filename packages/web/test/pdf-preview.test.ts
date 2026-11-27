// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PDF_PREVIEW_DATA,
	PDF_PREVIEW_READY,
	PDF_PREVIEW_URL,
	SurfacePdfViewer,
} from "../src/app/views/surface-blocks/pdf.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const headers = readFileSync(resolve(root, "public/_headers"), "utf8");
const previewPage = readFileSync(resolve(root, "public/pdf-preview/index.html"), "utf8");
const previewScript = readFileSync(resolve(root, "public/pdf-preview/preview.js"), "utf8");

function rule(path: string): string[] {
	const lines = headers.split(/\r?\n/);
	const start = lines.indexOf(path);
	const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && !line.startsWith("#"));
	return lines
		.slice(start + 1, end < 0 ? undefined : end)
		.filter((line) => !line.startsWith("#"))
		.map((line) => line.trim());
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("pdf preview door", () => {
	it("isolates blob framing to /pdf-preview/* while keeping /* free of frame-src", () => {
		const door = rule("/pdf-preview/*");
		expect(door.slice(0, 3)).toEqual(["! Content-Security-Policy", "! X-Frame-Options", "! Permissions-Policy"]);
		expect(door).toContain("Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()");
		expect(door).toContain("X-Frame-Options: SAMEORIGIN");
		const policy = door.find((line) => line.startsWith("Content-Security-Policy:"))!;
		const directives = policy
			.slice("Content-Security-Policy:".length)
			.split(";")
			.map((part) => part.trim());
		expect(directives).toEqual([
			"default-src 'none'",
			"script-src 'self'",
			"frame-src blob:",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'self'",
		]);
		const app = rule("/*").find((line) => line.startsWith("Content-Security-Policy:"))!;
		expect(app).toContain("default-src 'self';");
		expect(app).toContain("object-src 'none';");
		expect(app).not.toMatch(/frame-src|child-src/);
		expect(previewPage).toContain('<script src="./preview.js"></script>');
		expect(previewPage).not.toMatch(/<script>|http-equiv/);
	});

	it("accepts only parent same-origin bytes once, pins application/pdf, and revokes on pagehide", () => {
		const parent = { postMessage: vi.fn() };
		const listeners = new Map<string, ((event: unknown) => void)[]>();
		const fakeWindow = {
			parent,
			addEventListener: (type: string, handler: (event: unknown) => void) => {
				const list = listeners.get(type) ?? [];
				list.push(handler);
				listeners.set(type, list);
			},
		};
		let blobType = "";
		const createObjectURL = vi.fn((blob: Blob) => {
			blobType = blob.type;
			return "blob:pdf-inner";
		});
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		try {
			const origin = "https://app.qorpera.com";
			new Function("window", "location", "document", previewScript)(fakeWindow, { origin }, document);
			expect(parent.postMessage).toHaveBeenCalledWith({ type: PDF_PREVIEW_READY }, origin);

			const emit = (type: string, event: unknown) => {
				for (const fn of listeners.get(type) ?? []) fn(event);
			};
			const sample = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
			emit("message", { source: {}, origin, data: { type: PDF_PREVIEW_DATA, bytes: sample } });
			emit("message", {
				source: parent,
				origin: "https://evil.example",
				data: { type: PDF_PREVIEW_DATA, bytes: sample },
			});
			emit("message", { source: parent, origin, data: { type: "other", bytes: sample } });
			emit("message", { source: parent, origin, data: { type: PDF_PREVIEW_DATA, bytes: "not-bytes" } });
			expect(createObjectURL).not.toHaveBeenCalled();
			expect(document.querySelector("iframe")).toBeNull();

			emit("message", { source: parent, origin, data: { type: PDF_PREVIEW_DATA, bytes: sample, title: "Deck" } });
			expect(createObjectURL).toHaveBeenCalledTimes(1);
			expect(blobType).toBe("application/pdf");
			const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
			expect(frame).not.toBeNull();
			expect(frame.src).toBe("blob:pdf-inner");
			expect(frame.title).toBe("Deck");

			emit("message", { source: parent, origin, data: { type: PDF_PREVIEW_DATA, bytes: sample, title: "Second" } });
			expect(createObjectURL).toHaveBeenCalledTimes(1);

			emit("pagehide", {});
			expect(revokeObjectURL).toHaveBeenCalledWith("blob:pdf-inner");
		} finally {
			Reflect.deleteProperty(URL, "createObjectURL");
			Reflect.deleteProperty(URL, "revokeObjectURL");
		}
	});

	it("only posts PDF bytes to the matching same-origin preview frame", async () => {
		const createObjectURL = vi.fn(() => "blob:download");
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		const controller = new AbortController();
		const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
		const viewer = new SurfacePdfViewer(async () => bytes, controller.signal);
		try {
			const card = viewer.renderCard({
				path: "reports/q3.pdf",
				title: "Q3 Report",
				ref: {
					manifestSha256: "a".repeat(64),
					fileSha256: "b".repeat(64),
					bytes: 4,
					mediaType: "application/pdf",
				},
				changed: false,
			});
			document.body.append(card);
			await vi.waitFor(() =>
				expect(card.querySelector("iframe.studio-pdf-frame")?.getAttribute("src")).toBe(PDF_PREVIEW_URL),
			);
			const frame = card.querySelector<HTMLIFrameElement>("iframe.studio-pdf-frame")!;
			const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});

			const wrongOrigin = new MessageEvent("message", {
				data: { type: PDF_PREVIEW_READY },
				origin: "https://other.example",
			});
			Object.defineProperty(wrongOrigin, "source", { value: frame.contentWindow });
			window.dispatchEvent(wrongOrigin);
			expect(post).not.toHaveBeenCalled();

			const wrongSource = new MessageEvent("message", {
				data: { type: PDF_PREVIEW_READY },
				origin: location.origin,
			});
			Object.defineProperty(wrongSource, "source", { value: window });
			window.dispatchEvent(wrongSource);
			expect(post).not.toHaveBeenCalled();

			const ready = new MessageEvent("message", {
				data: { type: PDF_PREVIEW_READY },
				origin: location.origin,
			});
			Object.defineProperty(ready, "source", { value: frame.contentWindow });
			window.dispatchEvent(ready);
			expect(post).toHaveBeenCalledTimes(1);
			expect(post).toHaveBeenCalledWith({ type: PDF_PREVIEW_DATA, bytes, title: "Q3 Report" }, location.origin);

			window.dispatchEvent(ready);
			expect(post).toHaveBeenCalledTimes(1);

			card.remove();
			document.body.append(card);
			const reloadedWindow = { postMessage: vi.fn() } as unknown as Window;
			Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => reloadedWindow });
			const reloadedReady = new MessageEvent("message", {
				data: { type: PDF_PREVIEW_READY },
				origin: location.origin,
			});
			Object.defineProperty(reloadedReady, "source", { value: reloadedWindow });
			window.dispatchEvent(reloadedReady);
			expect(reloadedWindow.postMessage).toHaveBeenCalledTimes(1);
			expect(reloadedWindow.postMessage).toHaveBeenCalledWith(
				{ type: PDF_PREVIEW_DATA, bytes, title: "Q3 Report" },
				location.origin,
			);

			viewer.dispose();
			await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:download"));
		} finally {
			viewer.dispose();
			Reflect.deleteProperty(URL, "createObjectURL");
			Reflect.deleteProperty(URL, "revokeObjectURL");
		}
	});
});
