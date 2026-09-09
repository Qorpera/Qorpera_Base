import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CloudMemberBrowserRecovery } from "@qorpera/cloud-client/cloud-member-browser-recovery";
import { BrowserWindow, session } from "electron";
import { MemberBrowserRecoverySession } from "./member-browser-recovery-session.ts";
import { lockDownRendererSession, lockDownRendererWebContents } from "./renderer-boundary.ts";

export async function openMemberBrowserRecoveryWindow(options: {
	owner: BrowserWindow;
	directory: string;
	client: CloudMemberBrowserRecovery;
	current(): boolean;
}): Promise<BrowserWindow> {
	const partition = session.fromPartition(`qorpera-browser-cleanup-${randomUUID()}`, { cache: false });
	lockDownRendererSession(partition);
	const html = join(options.directory, "browser-recovery.html"),
		pageUrl = pathToFileURL(html).href;
	const resources = new Set(
		["browser-recovery.html", "browser-recovery.js", "company-computer.css"].map(
			(name) => pathToFileURL(join(options.directory, name)).href,
		),
	);
	partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resources.has(details.url) }));
	const window = new BrowserWindow({
		parent: options.owner,
		title: "Your browser profile cleanup",
		width: 800,
		height: 680,
		minWidth: 600,
		minHeight: 480,
		show: false,
		webPreferences: {
			session: partition,
			preload: join(options.directory, "browser-recovery-preload.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: false,
			webSecurity: true,
			spellcheck: false,
		},
	});
	lockDownRendererWebContents(window.webContents);
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.on("will-attach-webview", (event) => event.preventDefault());
	const lifetime = new AbortController();
	const current = () => {
		lifetime.signal.throwIfAborted();
		if (window.isDestroyed() || options.owner.isDestroyed() || !options.current())
			throw new Error("Browser cleanup account changed");
	};
	const recovery = new MemberBrowserRecoverySession({ client: options.client, current, signal: lifetime.signal });
	window.webContents.ipc.handle("browser-recovery:member", async (event, value: unknown) => {
		try {
			current();
			if (
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				window.webContents.mainFrame.url !== pageUrl
			)
				throw new Error("Browser cleanup window changed");
			return { ok: true, result: await recovery.action(value) };
		} catch {
			return { ok: false, error: "Browser cleanup could not be confirmed. Refresh status before continuing." };
		}
	});
	window.once("closed", () => lifetime.abort());
	options.owner.once("closed", () => {
		if (!window.isDestroyed()) window.destroy();
	});
	try {
		await window.loadFile(html);
		current();
		window.show();
		return window;
	} catch (error) {
		window.destroy();
		throw error;
	}
}
