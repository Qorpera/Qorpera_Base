import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	CompanyComputerAccessCapabilities,
	CompanyComputerAccessStatus,
} from "@qorpera/cloud-client/cloud-company-computer-access";
import {
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { CompanyComputerStartStatus } from "@qorpera/cloud-client/cloud-company-computer-start";
import type {
	CloudCompanyComputerViews,
	CompanyComputerMemberStatus,
} from "@qorpera/cloud-client/cloud-company-computer-views";
import type {
	CloudMemberCompanyComputerClient,
	MemberCompanyComputerCatalog,
} from "@qorpera/cloud-client/cloud-member-company-computer";
import { BrowserWindow, session } from "electron";
import { MemberCompanyBrowserSession } from "./member-company-browser-session.ts";
import { MemberCompanyComputerRelay } from "./member-company-computer-relay.ts";
import { lockDownRendererSession, lockDownRendererWebContents } from "./renderer-boundary.ts";

function input(value: unknown, keys: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys)
		throw new Error("Invalid Company Computer action");
	return value as Record<string, unknown>;
}
/** Member control surface only. Closing it aborts client reads and releases
 * the UI; it never cancels a start, shuts down a computer or revokes a grant. */
export async function openMemberCompanyComputerWindow(options: {
	owner: BrowserWindow;
	directory: string;
	title: string;
	client: CloudMemberCompanyComputerClient;
	memberId?: string;
	views?: (scope: CompanyComputerScope) => CloudCompanyComputerViews;
	current(): boolean;
}): Promise<BrowserWindow> {
	const partition = session.fromPartition(`qorpera-company-computer-${randomUUID()}`, { cache: false });
	lockDownRendererSession(partition);
	const html = join(options.directory, "company-computer.html"),
		pageUrl = pathToFileURL(html).href;
	const resources = new Set(
		[
			"company-computer.html",
			"company-computer.js",
			"company-computer.css",
			"company-computer-view-channel.js",
			"screen-viewer.js",
			"screens.css",
			"vendor/novnc-rfb.js",
		].map((name) => pathToFileURL(join(options.directory, name)).href),
	);
	partition.webRequest.onBeforeRequest((details, callback) =>
		callback({
			cancel:
				!resources.has(details.url) && !(details.resourceType === "image" && /^(data:|blob:)/.test(details.url)),
		}),
	);
	const window = new BrowserWindow({
		parent: options.owner,
		title: `${options.title} — Company Computer`,
		width: 800,
		height: 680,
		minWidth: 600,
		minHeight: 480,
		show: false,
		webPreferences: {
			session: partition,
			preload: join(options.directory, "company-computer-preload.cjs"),
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
	let catalog: MemberCompanyComputerCatalog | undefined,
		start: CompanyComputerStartStatus | null = null,
		busy = false;
	const grants = new Map<string, CompanyComputerAccessStatus>();
	let views: CloudCompanyComputerViews | undefined,
		viewScope: CompanyComputerScope | undefined,
		screens: CompanyComputerMemberStatus | undefined,
		relay: MemberCompanyComputerRelay | undefined,
		viewBusy = false,
		attempt: { id: string; stop: AbortController } | undefined;
	let browser: MemberCompanyBrowserSession | undefined;
	const current = () => {
		lifetime.signal.throwIfAborted();
		if (
			window.isDestroyed() ||
			!options.current() ||
			(viewScope &&
				catalog &&
				(!catalog.scope ||
					catalog.scope.companyComputerId !== viewScope.companyComputerId ||
					catalog.scope.logicalComputerId !== viewScope.logicalComputerId))
		) {
			void relay?.close().catch(() => undefined);
			throw new Error("Company Computer membership changed");
		}
	};
	const trusted = (event: { sender: unknown; senderFrame: unknown }) => {
		if (
			event.sender !== window.webContents ||
			event.senderFrame !== window.webContents.mainFrame ||
			window.webContents.mainFrame.url !== pageUrl
		)
			throw new Error("Company Computer window changed");
	};
	window.webContents.ipc.handle("company-computer:view", async (event, value: unknown) => {
		try {
			trusted(event);
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid display action");
			const method = (value as Record<string, unknown>).method;
			if (method === "read" || method === "send" || method === "close") {
				const request = input(
					value,
					method === "send"
						? "connectionId,data,method"
						: method === "read"
							? "ack,connectionId,method"
							: "connectionId,method",
				);
				if (!relay || relay.connectionId !== request.connectionId) throw new Error("Display connection changed");
				if (method === "close") {
					await relay.close();
					return { ok: true };
				}
				current();
				if (method === "read") return { ok: true, result: await relay.read(request.ack) };
				relay.send(request.data);
				return { ok: true };
			}
			if (JSON.stringify(value).length > 4096) throw new Error("Invalid display action");
			if (method === "abortConnect") {
				const request = input(value, "attemptId,method");
				if (attempt && attempt.id === request.attemptId) attempt.stop.abort();
				return { ok: true };
			}
			current();
			if (viewBusy) throw new Error("Wait for the current display action");
			viewBusy = true;
			try {
				if (!catalog?.scope || !options.views) throw new Error("Refresh Company Computer status");
				if (!views) {
					views = options.views(catalog.scope);
					viewScope = { ...catalog.scope };
				}
				if (method === "status") {
					input(value, "method");
					screens = undefined;
					const status = await views.status(lifetime.signal);
					current();
					screens = status;
					return { ok: true, result: status };
				}
				if (method === "cancel") {
					const request = input(value, "connectionId,method");
					if (!screens?.viewers.some((v) => v.viewerSessionId === request.connectionId))
						throw new Error("Refresh your connections");
					screens = undefined;
					if (relay && relay.connectionId === request.connectionId) await relay.close();
					else await views.cancel(request.connectionId as string, lifetime.signal);
					current();
					return { ok: true };
				}
				const request = input(
					value,
					method === "connectPrivate" ? "attemptId,challengeId,method" : "attemptId,binding,method,mode",
				);
				if (typeof request.attemptId !== "string" || !COMPANY_COMPUTER_UUID.test(request.attemptId))
					throw new Error("Invalid display attempt");
				if (method === "connectPrivate") {
					if (
						!browser ||
						typeof request.challengeId !== "string" ||
						!COMPANY_COMPUTER_UUID.test(request.challengeId)
					)
						throw new Error("Refresh private sign-in");
				} else {
					const selected = input(
						request.binding,
						"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId",
					);
					const observed = screens?.screens.find((screen) => screen.binding.screenId === selected.screenId);
					if (
						method !== "connect" ||
						typeof request.attemptId !== "string" ||
						!COMPANY_COMPUTER_UUID.test(request.attemptId) ||
						(request.mode !== "watch" && request.mode !== "control") ||
						(request.mode === "control" && !catalog.canManage) ||
						!observed
					)
						throw new Error("Refresh the selected screen");
					assertCompanyComputerScreenBinding(
						selected as unknown as CompanyComputerScreenBinding,
						observed.binding,
					);
				}
				const pending = { id: request.attemptId, stop: new AbortController() };
				attempt = pending;
				const signal = AbortSignal.any([lifetime.signal, pending.stop.signal]);
				await relay?.close();
				current();
				signal.throwIfAborted();
				const view =
					method === "connectPrivate"
						? await views.connectPrivate({
								challenge: await browser!.privateChallenge(request.challengeId as string, signal),
								signal,
							})
						: await views.connectScreen({
								binding: request.binding as CompanyComputerScreenBinding,
								mode: request.mode as "watch" | "control",
								signal,
							});
				try {
					current();
					signal.throwIfAborted();
				} catch (error) {
					await view.close().catch(() => undefined);
					throw error;
				}
				relay = new MemberCompanyComputerRelay(view, current);
				return { ok: true, result: relay.metadata };
			} finally {
				viewBusy = false;
				attempt = undefined;
			}
		} catch {
			return {
				ok: false,
				error: "The screen action could not be confirmed. Refresh screens to check access and recover your connections.",
			};
		}
	});
	window.webContents.ipc.handle("company-computer:browser", async (event, value: unknown) => {
		try {
			trusted(event);
			current();
			if (!catalog?.scope || !options.memberId) throw new Error("Refresh Company Computer status");
			if (!browser) {
				viewScope = { ...catalog.scope };
				browser = new MemberCompanyBrowserSession({
					profiles: options.client.browserProfiles(catalog.scope, options.memberId),
					signIn: options.client.signIn(catalog.scope, options.memberId),
					current,
					signal: lifetime.signal,
				});
			}
			return {
				ok: true,
				result: await browser.action(value, {
					staffIds: catalog.staff.map((staff) => staff.staffAgentId),
					screens,
					viewingAvailable: Boolean(options.views),
				}),
			};
		} catch {
			return {
				ok: false,
				error: "The browser action could not be confirmed. Refresh browser status before continuing.",
			};
		}
	});
	window.webContents.ipc.handle("company-computer:member", async (event, value: unknown) => {
		try {
			current();
			if (
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				event.senderFrame.url !== pageUrl
			)
				throw new Error("Company Computer window changed");
			if (busy) throw new Error("Wait for the current Company Computer action");
			if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 4096)
				throw new Error("Invalid Company Computer action");
			busy = true;
			try {
				const method = (value as Record<string, unknown>).method,
					signal = lifetime.signal;
				let result: unknown;
				if (method === "info") {
					input(value, "method");
					result = {
						title: options.title,
						viewingAvailable: Boolean(options.views),
						browserAvailable: Boolean(options.memberId),
					};
				} else if (method === "catalog") {
					const request = input(value, "after,method");
					if (request.after !== null && (!catalog?.nextAfter || request.after !== catalog.nextAfter))
						throw new Error("Refresh the agent list");
					catalog = undefined;
					start = null;
					grants.clear();
					const next = await options.client.catalog(signal, request.after as string | null);
					const status = next.scope ? await options.client.start(next.scope).status(signal) : null;
					current();
					catalog = next;
					start = status;
					result = { catalog, start };
				} else {
					if (!catalog?.scope || !start) throw new Error("Refresh Company Computer status");
					const scope = catalog.scope;
					if (method === "access") {
						if (!catalog.canManage) throw new Error("Company owner or administrator required");
						const request = input(value, "method,staffAgentId");
						if (!catalog.staff.some((staff) => staff.staffAgentId === request.staffAgentId))
							throw new Error("Refresh the agent list");
						const status = await options.client.access(scope, request.staffAgentId as string).status(signal);
						current();
						grants.set(status.staffAgentId, status);
						result = status;
					} else {
						if (!catalog.canManage) throw new Error("Company owner or administrator required");
						if (method === "start") {
							input(value, "method");
							if (start.officeState !== "provisioning" || start.intent)
								throw new Error("Refresh Company Computer status");
							const generation = start.computerGeneration;
							start = null;
							result = await options.client.start(scope).request(generation, randomUUID(), signal);
						} else if (method === "cancelStart") {
							const request = input(value, "intentId,method");
							if (
								!start.intent ||
								start.intent.intentId !== request.intentId ||
								start.intent.state === "cancelled" ||
								start.officeState === "active"
							)
								throw new Error("Refresh Company Computer status");
							const intent = start.intent;
							start = null;
							result = await options.client.start(scope).cancel(intent, signal);
						} else if (method === "configure") {
							const request = input(value, "capabilities,enabled,expectedVersion,method,staffAgentId"),
								observed = grants.get(String(request.staffAgentId));
							if (
								!observed ||
								request.expectedVersion !== (observed.grant?.version ?? 0) ||
								typeof request.enabled !== "boolean"
							)
								throw new Error("Refresh this agent's access");
							grants.delete(observed.staffAgentId);
							result = await options.client.access(scope, observed.staffAgentId).configure(
								{
									expectedVersion: request.expectedVersion as number,
									enabled: request.enabled,
									capabilities: request.capabilities as CompanyComputerAccessCapabilities,
								},
								signal,
							);
						} else throw new Error("Unknown Company Computer action");
					}
				}
				current();
				return { ok: true, result };
			} finally {
				busy = false;
			}
		} catch {
			return {
				ok: false,
				error: "The Company Computer action could not be confirmed. Refresh its status before trying again.",
			};
		}
	});
	window.once("closed", () => {
		lifetime.abort();
		attempt?.stop.abort();
		void relay?.close().catch(() => undefined);
		screens = undefined;
		catalog = undefined;
		start = null;
		grants.clear();
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
