import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, dialog, session } from "electron";
import type {
	CloudMemberCompanyCommand,
	CloudMemberCompanyEdit,
	CloudMemberCompanyFileClient,
	CloudMemberCompanyProposal,
} from "./cloud-member-company-editor.ts";
import { lockDownRendererSession, lockDownRendererWebContents } from "./renderer-boundary.ts";

type Review = CloudMemberCompanyCommand | CloudMemberCompanyProposal;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Company File request");
	return value as Record<string, unknown>;
}

/** A fixed, isolated human surface. It has no service key, provider account,
 * filesystem bridge, arbitrary IPC or network access in its renderer. */
export async function openGovernedCompanyWindow(options: {
	owner: BrowserWindow;
	directory: string;
	title: string;
	client: CloudMemberCompanyFileClient;
	canWrite: boolean;
	current(): boolean;
}): Promise<BrowserWindow> {
	const partition = session.fromPartition(`qorpera-company-file-${randomUUID()}`, { cache: false });
	lockDownRendererSession(partition);
	const html = join(options.directory, "company-file.html");
	const pageUrl = pathToFileURL(html).href;
	const resources = new Set(
		["company-file.html", "company-file.js", "company-file.css"].map(
			(name) => pathToFileURL(join(options.directory, name)).href,
		),
	);
	partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resources.has(details.url) }));
	const window = new BrowserWindow({
		parent: options.owner,
		title: `${options.title} — Company File`,
		width: 1100,
		height: 760,
		minWidth: 760,
		minHeight: 500,
		show: false,
		webPreferences: {
			session: partition,
			preload: join(options.directory, "company-file-preload.cjs"),
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
	const reviews = new Map<string, Review>();
	const previewed = new Map<string, string>();
	let active = 0;
	const remember = (targets: Review[]): void => {
		for (const target of targets) {
			const key = "commandId" in target ? `edit:${target.commandId}` : `proposal:${target.proposalId}`;
			if (reviews.size >= 200 && !reviews.has(key)) {
				const first = reviews.keys().next().value;
				if (first) {
					reviews.delete(first);
					previewed.delete(first);
				}
			}
			reviews.set(key, target);
		}
	};
	window.webContents.ipc.handle("company-file:governed", async (event, value: unknown) => {
		try {
			if (
				!options.current() ||
				window.isDestroyed() ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				event.senderFrame.url !== pageUrl
			)
				throw new Error("This Company File window is no longer authorized");
			if (active >= 4) throw new Error("Wait for the current Company File request to finish");
			const input = record(value);
			if (JSON.stringify(input).length > 256 * 1024) throw new Error("Company File request is too large");
			active++;
			try {
				const signal = lifetime.signal;
				let result: unknown;
				if (input.method === "info") result = { title: options.title, canWrite: options.canWrite };
				else if (input.method === "list") {
					if (
						typeof input.path !== "string" ||
						(input.after !== null && typeof input.after !== "string") ||
						(input.snapshotId !== null && typeof input.snapshotId !== "string")
					)
						throw new Error("Invalid Company File page");
					result = await options.client.list(input.path, signal, input.after, input.snapshotId);
				} else if (input.method === "read") {
					if (typeof input.path !== "string") throw new Error("Invalid Company File path");
					result = await options.client.read(input.path, signal);
				} else if (input.method === "edit") {
					if (!options.canWrite) throw new Error("This Company File is read-only for your membership");
					const command = await options.client.edit(record(input.intent) as CloudMemberCompanyEdit, signal);
					remember([command]);
					result = command;
				} else if (input.method === "reviews") {
					if (input.after !== null && typeof input.after !== "string")
						throw new Error("Invalid Company File review page");
					if (input.kind !== "edits" && input.kind !== "proposals")
						throw new Error("Invalid Company File review kind");
					const page =
						input.kind === "edits"
							? await options.client.edits(signal, input.after)
							: await options.client.proposals(signal, input.after);
					remember(page.items);
					result = page;
				} else if (input.method === "preview" || input.method === "review") {
					if (typeof input.key !== "string") throw new Error("Invalid Company File review");
					const target = reviews.get(input.key);
					if (!target || target.planSha256 !== input.planSha256)
						throw new Error("Reload the Company File review before continuing");
					if (input.method === "preview") {
						const after = await options.client.pendingText(target, signal);
						let before: string;
						try {
							before = (await options.client.read(target.plan.path, signal)).text;
						} catch {
							before =
								"The current file cannot be previewed. Apply still requires the exact current version and permissions.";
						}
						previewed.set(input.key, target.planSha256);
						result = { target, before, after };
					} else {
						if (!options.canWrite) throw new Error("This Company File is read-only for your membership");
						if (input.decision !== "approve" && input.decision !== "reject" && input.decision !== "skip")
							throw new Error("Invalid Company File decision");
						if (input.decision === "approve") {
							if (previewed.get(input.key) !== target.planSha256)
								throw new Error("Preview this exact change before approving it");
							const confirmation = await dialog.showMessageBox(window, {
								type: "warning",
								buttons: ["Cancel", "Apply exact change"],
								defaultId: 0,
								cancelId: 0,
								message: `Apply this change to ${options.title}?`,
								detail: `${target.plan.entry === null ? "Delete" : target.plan.entry.kind === "directory" ? "Create folder" : "Write file"}: ${target.plan.path}\nThe cloud will reject this change if its version or permissions have changed.`,
							});
							if (confirmation.response !== 1) return { ok: true, cancelled: true };
						}
						if (!options.current()) throw new Error("Company File membership changed");
						result = await options.client.review(target, input.decision, signal);
						reviews.delete(input.key);
						previewed.delete(input.key);
					}
				} else throw new Error("Unknown Company File request");
				if (!options.current()) throw new Error("This Company File window is no longer authorized");
				signal.throwIfAborted();
				return { ok: true, result };
			} finally {
				active--;
			}
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message.slice(0, 300) : "Company File request failed",
			};
		}
	});
	window.webContents.on("will-prevent-unload", (event) => {
		const choice = dialog.showMessageBoxSync(window, {
			type: "warning",
			buttons: ["Keep editing", "Discard unsaved text"],
			defaultId: 0,
			cancelId: 0,
			message: "Close the Company File editor?",
			detail:
				"Unsaved text is not sent to the cloud. A save already submitted may have completed; reopen the file to check.",
		});
		if (choice === 1) event.preventDefault();
	});
	window.once("closed", () => {
		lifetime.abort();
		reviews.clear();
		previewed.clear();
	});
	try {
		await window.loadFile(html);
		if (!options.current()) throw new Error("Company File membership changed");
		window.show();
		return window;
	} catch (error) {
		window.destroy();
		throw error;
	}
}
