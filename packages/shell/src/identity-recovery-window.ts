import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, dialog, session } from "electron";
import type {
	CloudMemberIdentityRecoveryClient,
	MemberRecoveryDecision,
	MemberRecoveryReview,
} from "./cloud-member-identity-recovery.ts";
import { lockDownRendererSession, lockDownRendererWebContents } from "./renderer-boundary.ts";

function request(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw new Error("Invalid recovery request");
	return value as Record<string, unknown>;
}

/** This window sends human intent only. Key material and restore execution stay
 * in the independent cloud service and the registered replacement guest. */
export async function openIdentityRecoveryWindow(options: {
	owner: BrowserWindow;
	directory: string;
	title: string;
	client: CloudMemberIdentityRecoveryClient;
	current(): boolean;
}): Promise<BrowserWindow> {
	const partition = session.fromPartition(`qorpera-identity-recovery-${randomUUID()}`, { cache: false });
	lockDownRendererSession(partition);
	const html = join(options.directory, "identity-recovery.html");
	const pageUrl = pathToFileURL(html).href;
	const resources = new Set(
		["identity-recovery.html", "identity-recovery.js", "identity-recovery.css"].map(
			(name) => pathToFileURL(join(options.directory, name)).href,
		),
	);
	partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resources.has(details.url) }));
	const window = new BrowserWindow({
		parent: options.owner,
		title: `${options.title} — Cloud recovery`,
		width: 960,
		height: 760,
		minWidth: 720,
		minHeight: 520,
		show: false,
		webPreferences: {
			session: partition,
			preload: join(options.directory, "identity-recovery-preload.cjs"),
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
	let review: MemberRecoveryReview | null = null;
	let active = false;
	window.webContents.ipc.handle("identity-recovery:member", async (event, value: unknown) => {
		try {
			if (
				!options.current() ||
				window.isDestroyed() ||
				options.owner.isDestroyed() ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				event.senderFrame.url !== pageUrl
			)
				throw new Error("This recovery window is no longer authorized");
			if (active) throw new Error("Wait for the current recovery request to finish");
			if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 2048)
				throw new Error("Invalid recovery request");
			const method = (value as Record<string, unknown>).method;
			active = true;
			try {
				const signal = lifetime.signal;
				let result: unknown;
				if (method === "info") {
					request(value, ["method"]);
					result = { title: options.title };
				} else if (method === "identities") {
					const input = request(value, ["method", "after"]);
					if (input.after !== null && typeof input.after !== "string") throw new Error("Invalid recovery page");
					result = await options.client.identities(input.after, signal);
				} else if (method === "targets") {
					const input = request(value, ["method", "computeIdentityId", "after"]);
					if (
						typeof input.computeIdentityId !== "string" ||
						(input.after !== null && typeof input.after !== "string")
					)
						throw new Error("Invalid recovery target page");
					review = null;
					result = await options.client.targets(input.computeIdentityId, input.after, signal);
				} else if (method === "review") {
					const input = request(value, ["method", "computeIdentityId", "targetId"]);
					if (typeof input.computeIdentityId !== "string" || typeof input.targetId !== "string")
						throw new Error("Invalid recovery review");
					review = null;
					const loaded = await options.client.review(input.computeIdentityId, input.targetId, signal);
					review = structuredClone(loaded);
					result = loaded;
				} else if (method === "decision") {
					const input = request(value, ["method", "reviewSha256", "decision", "storageSource"]);
					if (!review || input.reviewSha256 !== review.reviewSha256)
						throw new Error("Refresh and inspect the exact recovery before deciding");
					const reviewed = review;
					const body = reviewed.review;
					let decision: MemberRecoveryDecision;
					let label: string;
					if (input.decision === "request") {
						if (
							!body.canRequest ||
							!body.backup ||
							(input.storageSource !== "nas" && input.storageSource !== "supabase")
						)
							throw new Error("Select an available backup source for this recovery");
						decision = { kind: "request", requestId: randomUUID(), storageSource: input.storageSource };
						label = "Approve exact restore";
					} else if (input.decision === "consent" || input.decision === "cancel") {
						if (
							input.storageSource !== null ||
							(input.decision === "consent" ? !body.canConsent : !body.canCancel)
						)
							throw new Error("This recovery decision is unavailable");
						decision = { kind: input.decision };
						label = input.decision === "consent" ? "Consent to exact restore" : "Cancel restore";
					} else throw new Error("Invalid recovery decision");
					const source = decision.kind === "request" ? decision.storageSource : body.recovery?.storageSource;
					const confirmation = await dialog.showMessageBox(window, {
						type: "warning",
						buttons: ["Go back", label],
						defaultId: 0,
						cancelId: 0,
						message: `${label} for ${body.identity.displayName}?`,
						detail:
							decision.kind === "cancel"
								? "The restore will be cancelled. The old node stays fenced; cancellation does not restore its execution authority."
								: `Company: ${options.title}\nIdentity: ${body.identity.computeIdentityId}\nReplacement node: ${body.target.nodeId}\nRecipient key: ${body.target.recipientKeySha256}\nBackup: ${body.backup?.revision} from ${source}\nBackup digest: ${body.backup?.objectSha256}\n\nOnly this registered replacement may receive the existing key. The old execution generation will be fenced. Provider permissions and credential ownership do not change.`,
					});
					if (confirmation.response !== 1) return { ok: true, cancelled: true };
					if (!options.current() || window.isDestroyed() || options.owner.isDestroyed())
						throw new Error("Recovery membership changed");
					signal.throwIfAborted();
					// Clear before sending. A lost acknowledgement requires a fresh status
					// read; clicking twice never creates a new restore or implicit retry.
					review = null;
					result = await options.client.decide(reviewed, decision, signal);
				} else throw new Error("Unknown recovery request");
				if (!options.current() || options.owner.isDestroyed()) throw new Error("Recovery membership changed");
				signal.throwIfAborted();
				return { ok: true, result };
			} finally {
				active = false;
			}
		} catch {
			return {
				ok: false,
				error: "Recovery is unavailable or its review changed. Refresh its status before deciding. A submitted decision may already have completed.",
			};
		}
	});
	window.once("closed", () => {
		lifetime.abort();
		review = null;
	});
	options.owner.once("closed", () => {
		if (!window.isDestroyed()) window.destroy();
	});
	try {
		await window.loadFile(html);
		if (!options.current() || options.owner.isDestroyed()) throw new Error("Recovery membership changed");
		window.show();
		return window;
	} catch (error) {
		window.destroy();
		throw error;
	}
}
