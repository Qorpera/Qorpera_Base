import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import {
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	CompanyComputerActionNotStartedError,
	type CompanyComputerEffectContext,
	type CompanyComputerOperation,
	type CompanyComputerScreenBinding,
	type CompanyComputerScreenLease,
	type CompanyComputerToolContent,
	companyComputerRequest,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import type { BrowserContext, Page } from "playwright-core";
import type { CompanyComputerFillKey } from "./cloud-company-account-fill-box.ts";
import {
	COMPANY_ACCOUNT_FILLED_ATTRIBUTE,
	CompanyAccountFillRefusedError,
	CompanyComputerFilledValues,
	fillCompanyAccountBox,
} from "./cloud-company-computer-account-fill.ts";
import { CompanyComputerBrowserNetworkPausedError } from "./cloud-company-computer-browser-control.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import { CompanyComputerActionFailedError, companyComputerActionCheck } from "./cloud-company-computer-leases.ts";
import {
	companyComputerPrivateFieldMasks,
	readCompanyComputerPrivateValues,
	redactCompanyComputerSnapshot,
} from "./cloud-company-computer-private-fields.ts";
import { companyComputerAuthorityUnanswered } from "./cloud-company-computer-registry-http.ts";
import { companyComputerScreenDisplay } from "./cloud-company-computer-screens.ts";
import { type CompanyComputerAction, parseCompanyComputerAction } from "./cloud-company-computer-tools.ts";

export { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";

/**
 * REQUIRED Step 2 guest-containment adapter. It must verify the actual cloud
 * instance/generation, private process/credential boundary, network policy,
 * broker-only profile access and absence of canonical NAS paths/aliases. Path
 * validation above is NOT a sandbox or a mount-authority proof.
 * Existing computers also require a completed state-adoption disposition in
 * the existing journal; unresolved screen-N state must not become a fresh UUID
 * directory implicitly. A fresh installation needs an explicit empty inventory.
 */
export interface CompanyComputerGuestBoundary {
	assertReady(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<void>;
}

export interface CompanyComputerBrowserGrant {
	readonly profileId: string;
	readonly grantId: string;
	readonly version: number;
}

export interface CompanyComputerBrowserAccess {
	/** Live profile grant, owner/audience, adopted-state disposition and sign-in state; never provider-implied. */
	assertGranted(
		grant: CompanyComputerBrowserGrant,
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
	): Promise<void>;
}

export interface CompanyComputerBrowserSession {
	readonly binding: CompanyComputerScreenBinding;
	readonly grant: CompanyComputerBrowserGrant;
	readonly context: BrowserContext;
	assertActive(signal: AbortSignal): Promise<void>;
	/** True once the physical browser has closed or begun closing; a later open starts a fresh one. */
	isEnded?(): boolean;
	close(): Promise<void>;
}

export type CompanyComputerBrowserLaunch = (
	directory: string,
	options: {
		binding: CompanyComputerScreenBinding;
		grant: CompanyComputerBrowserGrant;
		display: string;
		home: string;
		signal: AbortSignal;
	},
) => Promise<{
	context: BrowserContext;
	/** Must close automation/network channels and await the physical namespace,
	 * including detached descendants. Context disconnection alone is not drain. */
	close(): Promise<void>;
}>;

/** Reuses Chrome persistent profiles; closing, reconnecting and VM recovery never copy or delete them. */
export class PersistentCompanyComputerBrowser {
	readonly #layout: CompanyComputerGuestLayout;
	readonly #boundary: CompanyComputerGuestBoundary;
	readonly #access: CompanyComputerBrowserAccess;
	readonly #launch: CompanyComputerBrowserLaunch;
	readonly #profiles = new Map<string, Promise<CompanyComputerBrowserSession>>();
	readonly #stop = new AbortController();
	#closing?: Promise<void>;

	constructor(options: {
		layout: CompanyComputerGuestLayout;
		boundary: CompanyComputerGuestBoundary;
		access: CompanyComputerBrowserAccess;
		launch: CompanyComputerBrowserLaunch;
	}) {
		assertCompanyComputerGuestLayout(options.layout);
		this.#layout = Object.freeze({ ...options.layout });
		this.#boundary = options.boundary;
		this.#access = options.access;
		if (typeof options.launch !== "function") throw new Error("CONTAINED_BROWSER_LAUNCH_REQUIRED");
		this.#launch = options.launch;
	}

	async open(
		binding: CompanyComputerScreenBinding,
		grant: CompanyComputerBrowserGrant,
		signal: AbortSignal,
	): Promise<CompanyComputerBrowserSession> {
		signal = AbortSignal.any([signal, this.#stop.signal]);
		signal.throwIfAborted();
		assertCompanyComputerScreenBinding(binding, binding);
		if (
			!COMPANY_COMPUTER_UUID.test(grant.profileId) ||
			!COMPANY_COMPUTER_UUID.test(grant.grantId) ||
			!Number.isSafeInteger(grant.version) ||
			grant.version < 1
		)
			throw new Error("INVALID_BROWSER_GRANT");
		// Both copies are host-owned and cannot be changed while authorization awaits.
		binding = Object.freeze({ ...binding });
		grant = Object.freeze({ ...grant });
		await companyComputerRequest(async (requestSignal) => {
			await this.#boundary.assertReady(binding, requestSignal);
			await this.#access.assertGranted(grant, binding, requestSignal);
		}, signal);
		const previous = this.#profiles.get(grant.profileId);
		if (previous) {
			const session = await previous;
			assertCompanyComputerScreenBinding(binding, session.binding);
			if (session.grant.grantId !== grant.grantId || session.grant.version !== grant.version)
				throw new Error("BROWSER_PROFILE_IN_USE");
			await session.assertActive(signal);
			return session;
		}
		const opening = this.#open(binding, grant, signal, () => {
			if (this.#profiles.get(grant.profileId) === opening) this.#profiles.delete(grant.profileId);
		});
		this.#profiles.set(grant.profileId, opening);
		try {
			return await opening;
		} catch (error) {
			if (
				!(error instanceof Error && error.message === "BROWSER_DRAIN_FAILED") &&
				this.#profiles.get(grant.profileId) === opening
			)
				this.#profiles.delete(grant.profileId);
			throw error;
		}
	}

	async #open(
		binding: CompanyComputerScreenBinding,
		grant: CompanyComputerBrowserGrant,
		signal: AbortSignal,
		released: () => void,
	): Promise<CompanyComputerBrowserSession> {
		const root = this.#layout.browserProfilesRoot;
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(root)) !== root)
			throw new Error("UNSAFE_BROWSER_PROFILE_ROOT");
		const directory = join(root, grant.profileId);
		await mkdir(directory, { mode: 0o700, recursive: true });
		const info = await lstat(directory);
		if (
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			relative(root, await realpath(directory)) !== grant.profileId
		) {
			throw new Error("UNSAFE_BROWSER_PROFILE_DIRECTORY");
		}
		await this.#boundary.assertReady(binding, signal);
		await this.#access.assertGranted(grant, binding, signal);
		signal.throwIfAborted();
		const launched = await this.#launch(directory, {
			binding,
			grant,
			display: companyComputerScreenDisplay(binding.screenOrdinal),
			home: this.#layout.desktopHome,
			signal,
		});
		const { context } = launched;
		let closing: Promise<void> | undefined;
		let ended = false;
		context.on("close", () => {
			ended = true;
		});
		const close = (): Promise<void> => {
			closing ??= launched.close().then(
				() => {
					signal.removeEventListener("abort", onAbort);
					released();
				},
				() => {
					throw new Error("BROWSER_DRAIN_FAILED");
				},
			);
			return closing;
		};
		const onAbort = (): void => {
			void close().catch(() => undefined);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			await close();
			throw new Error("BROWSER_ACCESS_ENDED");
		}
		return {
			binding,
			grant,
			context,
			close,
			isEnded: () => ended || closing !== undefined,
			assertActive: async (requestSignal) => {
				if (closing || ended) {
					void close().catch(() => undefined);
					throw new Error("BROWSER_ACCESS_ENDED");
				}
				const combined = AbortSignal.any([signal, requestSignal]);
				try {
					await companyComputerRequest(async (checked) => {
						await this.#boundary.assertReady(binding, checked);
						await this.#access.assertGranted(grant, binding, checked);
					}, combined);
				} catch (error) {
					// Nobody entitled present, or no answer: this use is refused, but the
					// window stays on the desktop. Only a refusal closes it.
					if (
						error instanceof CompanyComputerBrowserNetworkPausedError ||
						companyComputerAuthorityUnanswered(error)
					)
						throw new Error("BROWSER_ACCESS_UNCONFIRMED", { cause: error });
					void close().catch(() => undefined);
					throw new Error("BROWSER_ACCESS_ENDED");
				}
			},
		};
	}

	/** Service ownership includes pending starts and profiles whose automation
	 * disconnected before their physical process was confirmed stopped. */
	close(): Promise<void> {
		this.#stop.abort();
		this.#closing ??= companyComputerRequest(async () => {
			await Promise.all(
				[...this.#profiles.values()].map(async (opening) => {
					try {
						await (await opening).close();
					} catch (error) {
						if (error instanceof Error && error.message === "BROWSER_DRAIN_FAILED") throw error;
					}
				}),
			);
			if (this.#profiles.size) throw new Error("BROWSER_DRAIN_FAILED");
		}, new AbortController().signal);
		return this.#closing;
	}
}

export interface CompanyComputerGuestCommands {
	/** Broker-only selected workbench read; no member or canonical paths. */
	readFile?(input: { path: string; signal: AbortSignal }): Promise<Uint8Array>;
	/** Broker-only atomic no-overwrite import of already authorized bytes. */
	writeFile?(input: { path: string; bytes: Uint8Array; sha256: string; signal: AbortSignal }): Promise<void>;
	/** Existing Step 2 contained command runner. No inherited provider/service env; kill/reap descendants on abort. */
	run(input: {
		program: string;
		args: readonly string[];
		stdin?: string;
		environment: Readonly<Record<string, string>>;
		workingDirectory: string;
		timeoutMs: number;
		maxOutputBytes: number;
		signal: AbortSignal;
	}): Promise<{ code: number; stdout: string; stderr: string }>;
	/** Reuse the image's scrot capturer, with a private temporary file, bounded read and cleanup in finally. */
	capturePng(input: { display: string; signal: AbortSignal; maxBytes: number }): Promise<Uint8Array>;
}

export interface CompanyComputerScreenshotPublisher {
	/** Existing immutable artifact/audit path; exact screen, run, audience and receipt. Never raw storage credentials. */
	publish(
		bytes: Uint8Array,
		lease: CompanyComputerScreenLease,
		context: CompanyComputerEffectContext,
		operation: CompanyComputerOperation,
	): Promise<{
		assetId: string;
		sha256: string;
		bytes: number;
		mediaType: "image/png";
	}>;
}

/** Bound JSON-encoded bytes, including escaping, so tab discovery fits the native result envelope. */
function tabPreview(value: string, maxBytes: number): string {
	let end = Math.min(value.length, maxBytes);
	while (Buffer.byteLength(JSON.stringify(value.slice(0, end))) > maxBytes) end--;
	return value.slice(0, end);
}

/** Low-level established automation, called only inside the authorized guest ScreenActionGate. */
/** Where a long snapshot is cut, at or before `limit`: after the last whitespace, or the last line's end when a hidden
 * value holds whitespace itself; 0 when there is none. */
export function companyComputerSnapshotCut(text: string, limit: number, linesOnly: boolean): number {
	for (let at = Math.min(limit, text.length - 1); at >= 0; at--)
		if (text[at] === "\n" || (!linesOnly && /\s/u.test(text[at]!))) return at;
	return 0;
}

export class CompanyComputerGuestAutomation {
	readonly #binding: CompanyComputerScreenBinding;
	readonly #layout: CompanyComputerGuestLayout;
	readonly #boundary: CompanyComputerGuestBoundary;
	readonly #commands?: CompanyComputerGuestCommands;
	readonly #browser?: CompanyComputerBrowserSession;
	readonly #screenBrowser?: (signal: AbortSignal) => Promise<BrowserContext | undefined>;
	readonly #screenshots: CompanyComputerScreenshotPublisher;
	readonly #fileImports: import("./cloud-company-computer-file-imports.ts").CompanyComputerFileImporter | undefined;
	readonly #fileExports:
		| import("./cloud-company-computer-file-transfers.ts").CompanyComputerFileExportPublisher
		| undefined;
	readonly #tabIds = new Map<Page, string>();
	/** This office service's boot key: it alone opens what the vault sealed for a vault_fill (A1-3). */
	readonly #fillKey: CompanyComputerFillKey | undefined;
	/** Secrets the vault typed on this screen, hidden wherever the agent would see them (shared across runs). */
	readonly #filled: CompanyComputerFilledValues;
	#tabLease?: string;
	#page?: Page;

	constructor(options: {
		binding: CompanyComputerScreenBinding;
		layout: CompanyComputerGuestLayout;
		boundary: CompanyComputerGuestBoundary;
		commands?: CompanyComputerGuestCommands;
		browser?: CompanyComputerBrowserSession;
		/** The browser window open on this screen now, whether or not this run drives it; it never opens one. */
		screenBrowser?: (signal: AbortSignal) => Promise<BrowserContext | undefined>;
		screenshots: CompanyComputerScreenshotPublisher;
		fileExports?: import("./cloud-company-computer-file-transfers.ts").CompanyComputerFileExportPublisher;
		fileImports?: import("./cloud-company-computer-file-imports.ts").CompanyComputerFileImporter;
		fillKey?: CompanyComputerFillKey;
		filled?: CompanyComputerFilledValues;
	}) {
		assertCompanyComputerScreenBinding(options.binding, options.binding);
		assertCompanyComputerGuestLayout(options.layout);
		if (options.browser) assertCompanyComputerScreenBinding(options.browser.binding, options.binding);
		this.#binding = Object.freeze({ ...options.binding });
		this.#layout = Object.freeze({ ...options.layout });
		this.#boundary = options.boundary;
		this.#commands = options.commands;
		this.#browser = options.browser;
		this.#screenBrowser = options.screenBrowser;
		this.#screenshots = options.screenshots;
		this.#fileExports = options.fileExports;
		this.#fileImports = options.fileImports;
		this.#fillKey = options.fillKey;
		this.#filled = options.filled ?? new CompanyComputerFilledValues();
	}

	/**
	 * No picture while a page shows a secret the vault typed: as text, in its title or address, or in a box that is
	 * not marked private (a "show password" that made a new box). The page is read; it is never told the value.
	 */
	async #assertFilledNotShown(page: Page): Promise<void> {
		if (this.#filled.current().length === 0) return;
		for (const frame of page.frames()) {
			let shown: unknown;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				shown = await Promise.race([
					frame.evaluate((attribute) => {
						interface Node {
							value?: unknown;
							textContent?: string | null;
							shadowRoot?: Root | null;
							matches?(selector: string): boolean;
						}
						interface Root {
							querySelectorAll(selector: string): Iterable<Node>;
						}
						const global = globalThis as unknown as {
							document: Root & { title: string; documentElement: { innerText?: string } | null };
							location: { href: string };
						};
						const document = global.document;
						// Everything the page shows, or null past 4 MB of it (more than this check reads): then no picture.
						const parts = [document.title, global.location.href, document.documentElement?.innerText ?? ""];
						let size = parts.reduce((total, part) => total + part.length, 0);
						// Boxes not marked private, and the text and boxes inside open shadow roots (innerText skips them).
						const roots: Root[] = [document];
						for (let index = 0; index < roots.length; index++) {
							for (const node of roots[index]!.querySelectorAll("*")) {
								let part: string | undefined;
								if (node.shadowRoot) {
									roots.push(node.shadowRoot);
									part = (node.shadowRoot as unknown as Node).textContent ?? "";
								}
								if (
									typeof node.value === "string" &&
									node.matches?.("input, textarea") &&
									!node.matches(`[${attribute}]`)
								)
									part = part === undefined ? node.value : `${part}\n${node.value}`;
								if (part === undefined) continue;
								size += part.length;
								if (size > 4_000_000) return null;
								parts.push(part);
							}
						}
						return size > 4_000_000 ? null : parts.join("\n");
					}, COMPANY_ACCOUNT_FILLED_ATTRIBUTE),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("timed out")), 5_000);
					}),
				]);
			} catch (error) {
				throw new CompanyComputerActionFailedError(new Error("PRIVATE_FIELD_TAB_UNREADABLE", { cause: error }));
			} finally {
				clearTimeout(timer);
			}
			if (typeof shown !== "string")
				throw new CompanyComputerActionFailedError(new Error("PRIVATE_FIELD_TAB_UNREADABLE"));
			if (this.#filled.showsDecoded(shown))
				throw new CompanyComputerActionFailedError(new Error("PRIVATE_FIELD_ON_SCREEN"));
		}
	}

	/**
	 * A page call that failed has returned (Playwright awaits its own timeouts),
	 * so its failure is the action's own, not a sign that automation is still in
	 * flight. The page itself may still be loading; its network goes through the
	 * relay like any other. Authority checks stay outside this wrapper.
	 */
	async #pageCall<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			if (error instanceof CompanyComputerActionNotStartedError || error instanceof CompanyComputerActionFailedError)
				throw error;
			throw new CompanyComputerActionFailedError(error);
		}
	}

	/**
	 * A whole-screen capture shows the browser unmasked. It is refused while a shown
	 * tab of the window on this screen holds a private value in any frame, and while
	 * a tab cannot answer (crashed or hung): a member closes that tab, or the agent
	 * uses a browser screenshot, which masks.
	 */
	async #assertNoPrivateValueShown(signal: AbortSignal): Promise<void> {
		let pages: Page[];
		try {
			// A window still opening is waited for: it may show a box a moment later.
			const context = (await this.#screenBrowser?.(signal)) ?? this.#browser?.context;
			pages = context?.pages() ?? [];
		} catch (error) {
			signal.throwIfAborted();
			throw new CompanyComputerActionFailedError(new Error("PRIVATE_FIELD_TAB_UNREADABLE", { cause: error }));
		}
		signal.throwIfAborted();
		for (const page of pages) {
			if (page.isClosed()) continue;
			let values: string[];
			try {
				values = await readCompanyComputerPrivateValues(page, { shownOnly: true, allFrames: true });
			} catch (error) {
				throw new CompanyComputerActionFailedError(new Error("PRIVATE_FIELD_TAB_UNREADABLE", { cause: error }));
			}
			if (values.length > 0) throw new CompanyComputerActionFailedError(new Error("PRIVATE_FIELD_ON_SCREEN"));
			await this.#assertFilledNotShown(page);
		}
	}

	/** Cancellation closes the automation channel, not the persistent profile bytes. */
	async stopBrowser(): Promise<void> {
		await this.#browser?.close();
	}

	/**
	 * Drop this run's handles, preserving the shared desktop's tabs. Even a tab
	 * this run created may now contain a member's draft or a JS-written document
	 * while still reporting about:blank. Creation does not prove it is unused.
	 */
	async release(): Promise<void> {
		this.#page = undefined;
		this.#tabLease = undefined;
		this.#tabIds.clear();
	}

	async perform(
		value: CompanyComputerAction,
		lease: CompanyComputerScreenLease,
		effect: CompanyComputerEffectContext,
		operation: CompanyComputerOperation,
	): Promise<CompanyComputerToolContent> {
		const action = parseCompanyComputerAction(value);
		assertCompanyComputerScreenBinding(lease.binding, this.#binding);
		if (
			lease.driver.kind !== "agent" ||
			lease.driver.runId !== effect.identity.runId ||
			effect.identity.companyId !== this.#binding.companyId ||
			effect.identity.environmentId !== this.#binding.environmentId ||
			effect.identity.staffAgentId !== this.#binding.staffAgentId
		)
			throw new Error("COMPUTER_RUN_MISMATCH");
		const { signal } = effect;
		await companyComputerActionCheck(this.#boundary.assertReady(this.#binding, signal));
		// Even pixels/shell can observe the granted browser. Sign-in handoffs suspend all agent access.
		await companyComputerActionCheck(this.#browser?.assertActive(signal) ?? Promise.resolve());
		signal.throwIfAborted();
		if (action.kind === "screen") throw new Error("SCREEN_LIFECYCLE_REQUIRES_CLOUD_REGISTRY");
		if (action.kind === "transfer") {
			if (action.action === "import") {
				if (!this.#commands?.writeFile || !this.#fileImports) throw new Error("OFFICE_FILE_IMPORT_UNAVAILABLE");
				return {
					kind: "json",
					value: await this.#fileImports.perform(lease, effect, operation, (file, checked) =>
						this.#commands!.writeFile!({ ...file, signal: checked }),
					),
				};
			}
			if (!this.#commands?.readFile || !this.#fileExports) throw new Error("OFFICE_FILE_EXPORT_UNAVAILABLE");
			const bytes = await this.#commands.readFile({ path: action.source.path, signal });
			signal.throwIfAborted();
			return { kind: "json", value: await this.#fileExports.publish(bytes, lease, effect, operation) };
		}
		const display = companyComputerScreenDisplay(this.#binding.screenOrdinal);
		if (action.kind === "browser" || (action.kind === "screenshot" && action.surface === "browser")) {
			if (!this.#browser) throw new Error("BROWSER_GRANT_REQUIRED");
			const tabLease = `${lease.leaseId}:${lease.epoch}:${lease.driver.runId}`;
			if (this.#tabLease !== tabLease) {
				this.#tabLease = tabLease;
				this.#tabIds.clear();
				this.#page = undefined;
			}
			// Page objects never leave this already-authorized profile/context. IDs are
			// session-local handles, not Chrome/CDP targets or an authorization grant.
			const pages = this.#browser.context.pages().filter((page) => !page.isClosed());
			const live = new Set(pages);
			for (const page of this.#tabIds.keys()) if (!live.has(page)) this.#tabIds.delete(page);
			for (const page of pages) if (!this.#tabIds.has(page)) this.#tabIds.set(page, randomUUID());
			if (action.kind === "browser" && action.action === "list_tabs") {
				const after = action.afterTabId
					? pages.findIndex((page) => this.#tabIds.get(page) === action.afterTabId)
					: -1;
				if (action.afterTabId && after < 0)
					throw new CompanyComputerActionNotStartedError("BROWSER_TAB_UNAVAILABLE");
				const batch = pages.slice(after + 1, after + 11);
				const tabs: Array<{ tabId: string; titlePreview: string; urlPreview: string }> = [];
				for (const page of batch) {
					if (page.isClosed()) continue;
					let title: string;
					try {
						title = await this.#pageCall(() => page.title());
					} catch (error) {
						if (page.isClosed()) continue;
						throw error;
					}
					if (page.isClosed()) continue;
					tabs.push({
						tabId: this.#tabIds.get(page)!,
						titlePreview: tabPreview(this.#filled.hideText(title), 128),
						urlPreview: tabPreview(this.#filled.hideAddress(page.url()), 256),
					});
				}
				await companyComputerActionCheck(this.#browser.assertActive(signal));
				signal.throwIfAborted();
				return {
					kind: "json",
					value: {
						tabs,
						selectedTabId: this.#page && !this.#page.isClosed() ? (this.#tabIds.get(this.#page) ?? null) : null,
						nextAfterTabId:
							after + 1 + batch.length < pages.length ? this.#tabIds.get(batch[batch.length - 1])! : null,
					},
				};
			}
			if (action.kind === "browser" && action.action === "select_tab") {
				const page = pages.find((candidate) => this.#tabIds.get(candidate) === action.tabId);
				if (!page) throw new CompanyComputerActionNotStartedError("BROWSER_TAB_UNAVAILABLE");
				await companyComputerActionCheck(this.#browser.assertActive(signal));
				signal.throwIfAborted();
				if (page.isClosed()) throw new CompanyComputerActionNotStartedError("BROWSER_TAB_UNAVAILABLE");
				await this.#pageCall(() => page.bringToFront());
				await companyComputerActionCheck(this.#browser.assertActive(signal));
				signal.throwIfAborted();
				this.#page = page;
				return { kind: "json", value: { action: "select_tab", tabId: action.tabId, completed: true } };
			}
			if (this.#page && !live.has(this.#page))
				throw new CompanyComputerActionNotStartedError("BROWSER_TARGET_CLOSED");
			if (!this.#page) {
				// Never silently choose a different tab after a popup or close.
				if (pages.length > 1) throw new CompanyComputerActionNotStartedError("BROWSER_TAB_AMBIGUOUS");
				const context = this.#browser.context;
				this.#page = pages[0] ?? (await this.#pageCall(() => context.newPage()));
				if (!this.#tabIds.has(this.#page)) this.#tabIds.set(this.#page, randomUUID());
			}
			const page = this.#page;
			if (action.kind === "screenshot") {
				// Before and after the picture: a value the page shows by then is never published.
				await this.#assertFilledNotShown(page);
				const png = await this.#pageCall(() =>
					page.screenshot({
						type: "png",
						timeout: 5_000,
						mask: companyComputerPrivateFieldMasks(page),
					}),
				);
				await this.#assertFilledNotShown(page);
				return this.#publish(png, lease, effect, "browser", operation);
			}
			if (action.action === "navigate")
				await this.#pageCall(() => page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 10_000 }));
			else if (action.action === "click" || action.action === "fill") {
				const locator = page.getByRole(action.role, { name: action.name, exact: true });
				if ((await this.#pageCall(() => locator.count())) !== 1)
					throw new CompanyComputerActionNotStartedError("BROWSER_TARGET_AMBIGUOUS");
				if (action.action === "fill") {
					// Both reads settle before either failure counts, so none is left in flight.
					const [type, autocomplete] = await this.#pageCall(async () => {
						const reads = await Promise.allSettled([
							locator.getAttribute("type"),
							locator.getAttribute("autocomplete"),
						]);
						return reads.map((read) => {
							if (read.status === "rejected") throw read.reason;
							return read.value;
						});
					});
					if (type?.toLowerCase() === "password" || /password|one-time-code|cc-/.test(autocomplete ?? ""))
						throw new CompanyComputerActionFailedError(new Error("PRIVATE_SIGN_IN_REQUIRED"));
					await companyComputerActionCheck(this.#browser.assertActive(signal));
					signal.throwIfAborted();
					const text = action.text;
					await this.#pageCall(() => locator.fill(text, { timeout: 5_000 }));
				} else await this.#pageCall(() => locator.click({ timeout: 5_000 }));
			} else if (action.action === "press") {
				const key = action.key;
				await this.#pageCall(() => page.keyboard.press(key));
			} else if (action.action === "vault_fill") {
				// Only this boot's key opens the box, and only for this call, account and field: the value then
				// goes into the one box named, on the account's own website, and nowhere else.
				const sealed = effect.fill;
				const key = this.#fillKey;
				if (!key || !sealed) throw new CompanyComputerActionNotStartedError("ACCOUNT_FILL_UNAVAILABLE");
				let opened: ReturnType<CompanyComputerFillKey["open"]>;
				try {
					opened = key.open(sealed, {
						companyId: this.#binding.companyId,
						companyComputerId: this.#binding.companyComputerId,
						computerGeneration: this.#binding.computerGeneration,
						receiptId: effect.receiptId,
						accountId: action.account,
						field: action.field,
					});
				} catch (error) {
					// A spent box (or computers' clocks far apart) is told apart from one for another call or key.
					throw new CompanyComputerActionNotStartedError(
						error instanceof Error && error.message === "Company account fill expired"
							? "ACCOUNT_FILL_EXPIRED"
							: "ACCOUNT_FILL_UNOPENED",
					);
				}
				const box = page.getByRole(action.role, { name: action.name, exact: true });
				if ((await this.#pageCall(() => box.count())) !== 1)
					throw new CompanyComputerActionNotStartedError("BROWSER_TARGET_AMBIGUOUS");
				await companyComputerActionCheck(this.#browser.assertActive(signal));
				signal.throwIfAborted();
				this.#filled.add(opened.value, opened.field);
				try {
					await fillCompanyAccountBox(page, box, opened);
				} catch (error) {
					// Typed where nothing can empty it: the tab goes, with the value in it. The agent's next action is told
					// its tab closed (never moved to another tab), and the window keeps a tab, as at start.
					let cause: unknown;
					if (error instanceof CompanyAccountFillRefusedError && error.reason === "ACCOUNT_FILL_LOST") {
						const context = this.#browser.context;
						try {
							if (context.pages().every((other) => other === page || other.isClosed())) await context.newPage();
							await page.close();
						} catch (closeError) {
							cause = closeError;
						}
					}
					// The reason, never the value: a page that is not the account's, or a box of the wrong kind.
					throw new CompanyComputerActionFailedError(
						new Error(
							error instanceof CompanyAccountFillRefusedError ? error.reason : "ACCOUNT_FILL_FAILED",
							cause === undefined ? undefined : { cause },
						),
					);
				}
			}
			await companyComputerActionCheck(this.#browser.assertActive(signal));
			signal.throwIfAborted();
			if (action.action === "snapshot") {
				// The aria snapshot copies every box's value; read the private ones on both sides of it.
				const before = await this.#pageCall(() => readCompanyComputerPrivateValues(page));
				const full = await this.#pageCall(() => page.locator("body").ariaSnapshot({ timeout: 5_000 }));
				const after = await this.#pageCall(() => readCompanyComputerPrivateValues(page));
				// Only what can leave is hidden (16 KB, with room for hidden parts): a huge page costs no more. While
				// something is hidden, the cut falls between words, so no part of a value slips past checks that look
				// for whole values: at a space when no value holds one (none the vault makes does), else a line's end.
				const hidden = [...before, ...after, ...this.#filled.current()];
				const aria =
					full.length <= 20_480 || hidden.length === 0
						? full.slice(0, 20_480)
						: full.slice(
								0,
								companyComputerSnapshotCut(
									full,
									20_480,
									hidden.some((value) => /\s/u.test(value)),
								),
							);
				const snapshot = await this.#pageCall(async () => {
					const redacted = redactCompanyComputerSnapshot(aria, [...before, ...after], {
						filled: this.#filled.current(),
					}).replace(
						/(\/url: )(.*)/g,
						(_line, label: string, address: string) => `${label}${this.#filled.hideAddress(address)}`,
					);
					// A secret the vault typed that survives in another spelling refuses the snapshot.
					if (this.#filled.showsDecoded(redacted)) throw new Error("PRIVATE_FIELD_VISIBLE");
					return redacted;
				});
				const title = await this.#pageCall(() => page.title());
				await companyComputerActionCheck(this.#browser.assertActive(signal));
				signal.throwIfAborted();
				return {
					kind: "json",
					value: {
						tabId: this.#tabIds.get(page)!,
						url: this.#filled.hideAddress(page.url()),
						title: this.#filled.hideText(title).slice(0, 1024),
						snapshot: snapshot.slice(0, 16_384),
						truncated: full.length > aria.length || snapshot.length > 16_384,
					},
				};
			}
			return { kind: "json", value: { action: action.action, tabId: this.#tabIds.get(page)!, completed: true } };
		}
		if (!this.#commands) throw new Error("CONTAINED_COMPUTER_COMMANDS_UNAVAILABLE");
		if (action.kind === "screenshot") {
			// The whole screen shows the browser unmasked: no capture while a shown tab holds a private value,
			// checked again after the capture for one typed meanwhile.
			await this.#assertNoPrivateValueShown(signal);
			const png = await this.#commands.capturePng({ display, signal, maxBytes: 8 * 1024 * 1024 });
			await this.#assertNoPrivateValueShown(signal);
			return this.#publish(png, lease, effect, "desktop", operation);
		}
		let args: string[];
		if (action.kind === "shell") args = ["--noprofile", "--norc", "-c", action.command];
		else if (action.action === "click" || action.action === "move")
			args = [
				"mousemove",
				"--sync",
				String(action.x),
				String(action.y),
				...(action.action === "click" ? ["click", String({ left: 1, middle: 2, right: 3 }[action.button])] : []),
			];
		else if (action.action === "scroll")
			args = ["click", "--repeat", String(action.amount), "--delay", "40", action.direction === "up" ? "4" : "5"];
		else if (action.action === "type") args = ["type", "--clearmodifiers", "--file", "-"];
		else {
			const keyNames: Record<string, string> = {
				Control: "ctrl",
				Alt: "alt",
				Shift: "shift",
				Meta: "super",
				Enter: "Return",
				ArrowUp: "Up",
				ArrowDown: "Down",
				ArrowLeft: "Left",
				ArrowRight: "Right",
				Space: "space",
				PageUp: "Prior",
				PageDown: "Next",
			};
			args = [
				"key",
				"--clearmodifiers",
				action.key
					.split("+")
					.map((key) => keyNames[key] ?? key)
					.join("+"),
			];
		}
		const output = await this.#commands
			.run({
				program: action.kind === "shell" ? "/bin/bash" : "/usr/bin/xdotool",
				args,
				...(action.kind === "desktop" && action.action === "type" ? { stdin: action.text } : {}),
				environment: { DISPLAY: display, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
				workingDirectory: this.#layout.workbenchRoot,
				timeoutMs: action.kind === "shell" ? action.timeoutMs : 5_000,
				maxOutputBytes: 16_384,
				signal,
			})
			.catch((error: unknown) => {
				// Reported only once the command's namespace has exited: it stopped at
				// its own limit and nothing of it runs. Any other failure is not typed.
				if (
					error instanceof Error &&
					["OFFICE_COMMAND_TIMEOUT", "OFFICE_COMMAND_OUTPUT_LIMIT"].includes(error.message)
				)
					throw new CompanyComputerActionFailedError(error);
				throw error;
			});
		signal.throwIfAborted();
		await companyComputerActionCheck(this.#boundary.assertReady(this.#binding, signal));
		await companyComputerActionCheck(this.#browser?.assertActive(signal) ?? Promise.resolve());
		signal.throwIfAborted();
		if (
			!Number.isInteger(output.code) ||
			Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > 16_384
		)
			throw new Error("INVALID_COMPUTER_COMMAND_RESULT");
		return { kind: "json", value: { code: output.code, stdout: output.stdout, stderr: output.stderr } };
	}

	async #publish(
		bytes: Uint8Array,
		lease: CompanyComputerScreenLease,
		effect: CompanyComputerEffectContext,
		surface: "browser" | "desktop",
		operation: CompanyComputerOperation,
	): Promise<CompanyComputerToolContent> {
		if (
			bytes.length < 33 ||
			bytes.length > 8 * 1024 * 1024 ||
			!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
			Buffer.from(bytes.subarray(8, 12)).readUInt32BE() !== 13 ||
			Buffer.from(bytes.subarray(12, 16)).toString("ascii") !== "IHDR"
		) {
			throw new Error("INVALID_SCREENSHOT");
		}
		const width = Buffer.from(bytes.subarray(16, 20)).readUInt32BE();
		const height = Buffer.from(bytes.subarray(20, 24)).readUInt32BE();
		// Page captures exclude browser chrome and the desktop panel. Preserve
		// their actual bounded viewport; only desktop images use pixel-control
		// coordinates on the fixed 1920 x 1200 display.
		if (
			width < 1 ||
			height < 1 ||
			width > 1920 ||
			height > 1200 ||
			(surface === "desktop" && (width !== 1920 || height !== 1200))
		)
			throw new Error("INVALID_SCREENSHOT");
		await companyComputerActionCheck(this.#boundary.assertReady(this.#binding, effect.signal));
		await companyComputerActionCheck(this.#browser?.assertActive(effect.signal) ?? Promise.resolve());
		effect.signal.throwIfAborted();
		const digest = createHash("sha256").update(bytes).digest("hex");
		const asset = await this.#screenshots.publish(Uint8Array.from(bytes), lease, effect, operation);
		if (
			!COMPANY_COMPUTER_UUID.test(asset.assetId) ||
			asset.sha256 !== digest ||
			asset.bytes !== bytes.length ||
			asset.mediaType !== "image/png"
		) {
			throw new Error("INVALID_SCREENSHOT_RECEIPT");
		}
		await companyComputerActionCheck(this.#boundary.assertReady(this.#binding, effect.signal));
		await companyComputerActionCheck(this.#browser?.assertActive(effect.signal) ?? Promise.resolve());
		effect.signal.throwIfAborted();
		return { kind: "json", value: { ...asset, screenId: this.#binding.screenId, surface, width, height } };
	}
}
