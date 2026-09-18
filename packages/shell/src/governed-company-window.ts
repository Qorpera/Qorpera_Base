import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CompanyComputerFileExportAsset } from "@qorpera/cloud-client/cloud-file-transfer";
import type { CloudMemberCompanyComputerClient } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { CloudMemberCompanyPresence } from "@qorpera/cloud-client/cloud-member-company-presence";
import { type CompanyPathPresenceView, companyPresencePaths } from "@qorpera/cloud-client/company-path-presence";
import { BrowserWindow, dialog, session } from "electron";
import type {
	CloudMemberCompanyCommand,
	CloudMemberCompanyEdit,
	CloudMemberCompanyFileClient,
	CloudMemberCompanyProposal,
} from "./cloud-member-company-editor.ts";
import { openIdentityRecoveryWindow } from "./identity-recovery-window.ts";
import { openMemberCompanyComputerWindow } from "./member-company-computer-window.ts";
import { savePendingMemberFile, saveSelectedMemberExport, saveSelectedMemberFile } from "./member-file-download.ts";
import { MemberFileUploadSession } from "./member-file-upload.ts";
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
	companyComputer?: CloudMemberCompanyComputerClient;
	companyComputerViews?: Parameters<typeof openMemberCompanyComputerWindow>[0]["views"];
	companyComputerMemberId?: string;
	staffName?(staffAgentId: string): string | undefined;
	presence?(
		signal: AbortSignal,
		onChange: (view: CompanyPathPresenceView) => void,
	): Pick<CloudMemberCompanyPresence, "select" | "close">;
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
	let presence: Pick<CloudMemberCompanyPresence, "select" | "close"> | undefined;
	const trusted = (event: { sender: unknown; senderFrame: unknown }) =>
		!window.isDestroyed() &&
		!lifetime.signal.aborted &&
		options.current() &&
		event.sender === window.webContents &&
		event.senderFrame === window.webContents.mainFrame &&
		window.webContents.mainFrame.url === pageUrl;
	window.webContents.ipc.handle("company-file:presence-select", async (event, value: unknown) => {
		try {
			if (!trusted(event) || !options.presence) throw new Error("Presence unavailable");
			if (!Array.isArray(value)) throw new Error("Invalid presence paths");
			const paths = value.length ? companyPresencePaths(value) : [];
			presence ??= options.presence(lifetime.signal, (view) => {
				if (window.isDestroyed()) return;
				if (!options.current() || lifetime.signal.aborted) {
					window.webContents.send("company-file:presence", {
						schema: "qorpera.company-path-presence-view/v1",
						state: "unavailable",
						observedAt: Date.now(),
						paths: [],
					});
					return;
				}
				const names: Record<string, string> = {};
				if (options.staffName)
					for (const path of view.paths)
						for (const participant of path.participants) {
							const name = options.staffName(participant.staffAgentId);
							if (typeof name === "string" && name.length > 0 && [...name].length <= 160)
								names[participant.staffAgentId] = name;
						}
				window.webContents.send("company-file:presence", options.staffName ? { ...view, names } : view);
			});
			presence.select(paths);
			return { ok: true };
		} catch {
			return { ok: false };
		}
	});
	const uploads = new MemberFileUploadSession({
		signal: lifetime.signal,
		current: () => !window.isDestroyed() && options.current() && options.canWrite,
		upload: (input, signal) => options.client.upload(input, signal),
		chooseFile: async () => {
			const choice = await dialog.showOpenDialog(window, {
				title: "Choose file to upload",
				buttonLabel: "Choose file",
				properties: ["openFile", "dontAddToRecent"],
			});
			return choice.canceled || choice.filePaths.length !== 1 ? null : choice.filePaths[0];
		},
	});
	const reviews = new Map<string, Review>();
	const exports = new Map<string, CompanyComputerFileExportAsset>();
	const previewed = new Map<string, string>();
	let active = 0;
	let downloading = false;
	let recoveryWindow: BrowserWindow | null = null;
	let computerWindow: BrowserWindow | null = null;
	let computerOpening: Promise<BrowserWindow> | undefined;
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
				if (input.method === "info")
					result = {
						title: options.title,
						canWrite: options.canWrite,
						...(options.companyComputer ? { computerAvailable: true } : {}),
						...(options.presence ? { presenceAvailable: true } : {}),
					};
				else if (input.method === "computer") {
					if (Object.keys(input).length !== 1 || !options.companyComputer)
						throw new Error("Company Computer is unavailable");
					if (computerWindow && !computerWindow.isDestroyed()) computerWindow.show();
					else {
						computerOpening ??= openMemberCompanyComputerWindow({
							owner: window,
							directory: options.directory,
							title: options.title,
							client: options.companyComputer,
							views: options.companyComputerViews,
							memberId: options.companyComputerMemberId,
							current: () => !window.isDestroyed() && options.current(),
						});
						try {
							computerWindow = await computerOpening;
						} finally {
							computerOpening = undefined;
						}
					}
					result = { opened: true };
				} else if (input.method === "recovery") {
					if (Object.keys(input).length !== 1) throw new Error("Invalid recovery window request");
					if (recoveryWindow && !recoveryWindow.isDestroyed()) recoveryWindow.show();
					else
						recoveryWindow = await openIdentityRecoveryWindow({
							owner: window,
							directory: options.directory,
							title: options.title,
							client: options.client.identityRecovery,
							current: () => !window.isDestroyed() && options.current(),
						});
					result = { opened: true };
				} else if (input.method === "list") {
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
				} else if (input.method === "download") {
					if (Object.keys(input).sort().join() !== "method,selection")
						throw new Error("Invalid Company File download");
					if (downloading) throw new Error("Finish the current download before starting another");
					downloading = true;
					try {
						result = await saveSelectedMemberFile({
							selection: input.selection,
							signal,
							current: () => !window.isDestroyed() && options.current(),
							download: (selection, signal) => options.client.download(selection, signal),
							chooseDestination: async (name) => {
								const choice = await dialog.showSaveDialog(window, {
									title: "Download Company File",
									defaultPath: name,
									buttonLabel: "Download",
									properties: ["showOverwriteConfirmation"],
								});
								return choice.canceled || !choice.filePath ? null : choice.filePath;
							},
						});
					} finally {
						downloading = false;
					}
				} else if (input.method === "exports") {
					if (
						Object.keys(input).sort().join() !== "after,method" ||
						(input.after !== null && typeof input.after !== "string")
					)
						throw new Error("Invalid shared export page");
					const page = await options.client.exports.list(signal, input.after);
					for (const asset of page.items) {
						if (exports.size >= 200 && !exports.has(asset.assetId)) exports.delete(exports.keys().next().value!);
						exports.set(asset.assetId, asset);
					}
					result = page;
				} else if (input.method === "downloadExport") {
					if (Object.keys(input).sort().join() !== "method,selection")
						throw new Error("Invalid shared export selection");
					const selection = record(input.selection),
						asset = exports.get(String(selection.assetId));
					if (!asset || asset.sha256 !== selection.sha256)
						throw new Error("Reload shared exports before downloading");
					if (downloading) throw new Error("Finish the current download before starting another");
					downloading = true;
					try {
						result = await saveSelectedMemberExport({
							selection,
							name: asset.source.path,
							signal,
							current: () => !window.isDestroyed() && options.current(),
							download: (selection, signal) => options.client.exports.download(selection, signal),
							chooseDestination: async (name) => {
								const choice = await dialog.showSaveDialog(window, {
									title: "Download shared export",
									defaultPath: name,
									buttonLabel: "Download",
									properties: ["showOverwriteConfirmation"],
								});
								return choice.canceled || !choice.filePath ? null : choice.filePath;
							},
						});
					} finally {
						downloading = false;
					}
				} else if (input.method === "chooseUpload") {
					if (Object.keys(input).length !== 1) throw new Error("Invalid upload selection");
					result = await uploads.choose();
				} else if (input.method === "upload") {
					if (Object.keys(input).sort().join() !== "intent,method") throw new Error("Invalid upload request");
					const uploaded = await uploads.submit(input.intent);
					remember([uploaded.command]);
					result = uploaded;
				} else if (input.method === "describe") {
					if (Object.keys(input).sort().join() !== "method,path" || typeof input.path !== "string")
						throw new Error("Invalid Company File path");
					result = await options.client.describe(input.path, signal);
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
				} else if (input.method === "preview" || input.method === "review" || input.method === "downloadReview") {
					if (typeof input.key !== "string") throw new Error("Invalid Company File review");
					const target = reviews.get(input.key);
					if (!target || target.planSha256 !== input.planSha256)
						throw new Error("Reload the Company File review before continuing");
					if (input.method === "downloadReview") {
						if (
							Object.keys(input).sort().join() !== "key,method,planSha256" ||
							target.plan.entry?.kind !== "file"
						)
							throw new Error("Invalid review download");
						if (downloading) throw new Error("Finish the current download before starting another");
						downloading = true;
						try {
							result = await savePendingMemberFile({
								path: target.plan.path,
								planSha256: target.planSha256,
								signal,
								current: () => !window.isDestroyed() && options.current(),
								download: (signal) => options.client.pendingFile(target, signal),
								chooseDestination: async (name) => {
									const choice = await dialog.showSaveDialog(window, {
										title: "Download proposed file",
										defaultPath: name,
										buttonLabel: "Download",
										properties: ["showOverwriteConfirmation"],
									});
									return choice.canceled || !choice.filePath ? null : choice.filePath;
								},
							});
						} finally {
							downloading = false;
						}
					} else if (input.method === "preview") {
						let after = "";
						if (target.plan.entry?.kind === "file") {
							const file = await options.client.pendingFile(target, signal);
							try {
								if (file.bytes.length > 32 * 1024) throw new Error("Large file");
								after = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
								if (after.includes("\0")) throw new Error("Binary file");
							} catch {
								after = `Binary or large file: ${file.bytes.length.toLocaleString()} bytes\nSHA-256: ${target.plan.entry.file.fileSha256}\nDownload the proposed file to inspect it before applying.\n\nFirst ${Math.min(64, file.bytes.length)} bytes (hex):\n${Buffer.from(file.bytes.subarray(0, 64)).toString("hex")}`;
							}
						} else after = await options.client.pendingText(target, signal);
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
		computerWindow?.destroy();
		lifetime.abort();
		void presence?.close();
		uploads.clear();
		reviews.clear();
		exports.clear();
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
