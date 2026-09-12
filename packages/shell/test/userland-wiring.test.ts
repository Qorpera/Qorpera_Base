import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
	removedAgentRuntimeExports,
	removedLocalLaneModules,
	removedMainSymbols,
} from "../../../scripts/check-cloud-runtime-boundaries.mjs";

const shell = join(import.meta.dirname, "..");
const userland = join(shell, "userland");
const rendererSource = readFileSync(join(userland, "renderer.js"), "utf-8");
const indexSource = readFileSync(join(userland, "index.html"), "utf-8");
const tokensCssSource = readFileSync(join(userland, "tokens.css"), "utf-8");
const baseCssSource = readFileSync(join(userland, "base.css"), "utf-8");
const onboardingCssSource = readFileSync(join(userland, "onboarding.css"), "utf-8");
const characterMotionSource = readFileSync(join(userland, "character-motion.css"), "utf-8");
const railResizeCssSource = readFileSync(join(userland, "rail-resize.css"), "utf-8");
const pinnedAgentsCssSource = readFileSync(join(userland, "pinned-agents.css"), "utf-8");
const railResizeSource = readFileSync(join(userland, "rail-resize.js"), "utf-8");
const feedbackSource = readFileSync(join(userland, "feedback.js"), "utf-8");
const feedbackCssSource = readFileSync(join(userland, "feedback.css"), "utf-8");
const hubCarouselSource = readFileSync(join(userland, "hub-carousel.js"), "utf-8");
const preloadSource = readFileSync(join(shell, "src", "preload.cjs"), "utf-8");
const mainSource = readFileSync(join(shell, "src", "main.ts"), "utf-8");
const agentRuntimeSource = readFileSync(join(shell, "src", "agent-runtime.ts"), "utf-8");
const repositoryRoot = join(shell, "..", "..");

describe("userland wiring", () => {
	it("only calls toast helpers that renderer.js actually defines", () => {
		// showControllerToast survived its own deletion as 19 call sites: every
		// settings error path threw ReferenceError inside an async onclick and
		// the failure vanished. Invitations went missing exactly this way.
		const called = new Set([...rendererSource.matchAll(/\b(show\w*Toast)\(/g)].map((match) => match[1]));
		expect(called.size).toBeGreaterThan(0);
		for (const name of called) {
			expect(rendererSource, `${name} is called but never defined`).toContain(`function ${name}(`);
		}
	});

	it("keeps settings tab buttons and SETTINGS_TABS in sync", () => {
		const registered = rendererSource.match(/const SETTINGS_TABS = new Set\(\[(.*?)\]\)/);
		expect(registered).not.toBeNull();
		const tabs = [...(registered?.[1] ?? "").matchAll(/"(\w+)"/g)].map((match) => match[1]);
		const buttons = [...indexSource.matchAll(/data-tab="(\w+)"/g)].map((match) => match[1]);
		expect(new Set(buttons)).toEqual(new Set(tabs));
		// Every button's click handler must open its own tab.
		for (const tab of buttons) {
			expect(indexSource).toContain(`onclick="openSettings('${tab}')"`);
		}
	});

	it("routes the company menu through settings and the company hub", () => {
		const switcherStart = rendererSource.indexOf("function openCompanySwitcher()");
		const switcherEnd = rendererSource.indexOf("function renderCompanySwitcher()", switcherStart);
		const switcher = rendererSource.slice(switcherStart, switcherEnd);
		expect(switcher).toContain('openSettings("company")');
		expect(switcher).toContain('"switch-company"');
		expect(switcher).toContain('"company-switcher-switch-company"');
		expect(switcher).toContain("await window.qorpera.showHub()");
		expect(switcher).not.toContain("window.qorpera.listCompanies()");
		expect(baseCssSource).toMatch(/\.rail-bottom \.company-switcher-menu \{[^}]*width: 100%;/s);
		expect(baseCssSource).toMatch(
			/\.company-switcher-switch-company \.company-switcher-menu-icon \{[^}]*justify-self: center;/s,
		);
	});

	it("keeps company avatars and carousel behavior in their owning render paths", () => {
		expect(rendererSource).toContain("const COMPANY_AVATARS = [");
		expect(rendererSource).toContain("function renderCompanyAvatarChoices(");
		expect(rendererSource).toContain("companyAvatarSettingsSection()");
		expect(indexSource).not.toContain("company-avatars.js");
		expect(indexSource).toContain('aria-roledescription="carousel"');
		expect(indexSource).toContain('id="hubCarouselStatus" class="sr-only" aria-live="polite"');
		expect(hubCarouselSource).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
		expect(hubCarouselSource).toContain('grid.addEventListener("keydown"');
		expect(hubCarouselSource).toContain("status.textContent = announcement");
		expect(hubCarouselSource).toContain('dot.setAttribute("aria-current", "true")');
		expect(hubCarouselSource).toContain('dot.removeAttribute("aria-current")');
		expect(hubCarouselSource).not.toContain('item.setAttribute("aria-posinset"');
		expect(hubCarouselSource).not.toContain('item.setAttribute("aria-setsize"');
		expect(onboardingCssSource).toMatch(/\.profile-setup-label \{[^}]*display: block;/s);
		expect(onboardingCssSource).toMatch(/\.hub-carousel-pagination button \{[^}]*width: 24px;[^}]*height: 24px;/s);
		expect(onboardingCssSource).toContain("@media (prefers-reduced-motion: reduce)");
	});

	it("keeps non-actionable hosting internals out of settings", () => {
		for (const label of [
			"Product and execution",
			"Profile placement",
			"Company workspaces",
			"Execution on local computer",
			"Keep running in the background",
		]) {
			expect(rendererSource).not.toContain(label);
		}
	});

	it("keeps the remaining company controls actionable and accessible", () => {
		expect(rendererSource).toContain("window.qorpera.openCompanyFile()");
		expect(rendererSource).toContain("Cloud-authoritative");
		expect(rendererSource).not.toContain("Stored on this computer");
		expect(rendererSource).toContain('"Opened a synced copy. Cloud revisions remain authoritative."');
		expect(rendererSource).toContain('info.profile?.name || info.company?.name || state.name || "Company"');
		expect(rendererSource).toContain('window.qorpera.resolveCompanyFileConflict("local")');
		expect(rendererSource).toContain('window.qorpera.resolveCompanyFileConflict("cloud")');
		expect(preloadSource).toContain('ipcRenderer.invoke("company-file:open-conflict-remote")');
		expect(rendererSource).not.toContain("window.qorpera.enableCloudProfile()");
		expect(indexSource).not.toContain("data-profile-placement");
		expect(rendererSource).toContain("companyCreatorCreationId");
		expect(preloadSource).toContain('ipcRenderer.invoke("company:pending-creation")');
		expect(mainSource).toContain('schema: "qorpera.pending-company-creation/v1"');
		expect(rendererSource).toContain("pending?.clientCreationId ?? crypto.randomUUID()");
		expect(indexSource).toContain("The first 50 GB is included");
		expect(rendererSource).toContain('event.key !== "Tab"');
		expect(rendererSource).toMatch(/item\.setAttribute\("aria-label", `\$\{name\}, \$\{role\}`\)/);
		expect(rendererSource).toContain("Pick from your friends or add someone first");
		expect(baseCssSource).not.toMatch(/\.company-person-actions \{[^}]*visibility:\s*hidden/s);
		expect(baseCssSource).toMatch(/\.company-person-actions \{[^}]*opacity:\s*0/s);
		expect(baseCssSource).toContain(".company-person-row:focus-within .company-person-actions");
	});

	it("keeps macOS native window controls clear of titlebar actions", () => {
		expect(preloadSource).toContain("document.documentElement.dataset.platform = process.platform");
		expect(preloadSource).toContain("navigator.windowControlsOverlay?.visible === false");
		expect(preloadSource).toContain(
			'navigator.windowControlsOverlay?.addEventListener("geometrychange", syncWindowControlsVisibility)',
		);
		expect(preloadSource).not.toContain("window.outerWidth");
		expect(mainSource).toContain("titleBarOverlay: TITLE_BAR_OVERLAY");
		expect(indexSource.indexOf('id="railSearch"')).toBeGreaterThan(indexSource.indexOf('id="conav"'));
		expect(indexSource.indexOf('id="railSearch"')).toBeGreaterThan(indexSource.indexOf("</header>"));
		expect(baseCssSource).toContain("#f9f8f4 var(--rail-width) 100%");
		expect(baseCssSource).toMatch(/body\.company-shell #titlebar::before \{[^}]*background: #d9d9d9;/s);
		expect(baseCssSource).toMatch(/#titlebar \.thread-header \{[^}]*padding: 2px 142px 3px 7px;/s);
		expect(baseCssSource).toMatch(/html\[data-platform="darwin"\] \.titlebar-rail \{ padding-left: 78px; \}/);
		expect(baseCssSource).toMatch(
			/html\[data-platform="darwin"\] #titlebar \.thread-header \{ padding-right: 10px; \}/,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell \.rail-company-switcher \{[^}]*position: fixed;[^}]*top: 9px;[^}]*left: 78px;/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\]\[data-window-controls="hidden"\][^{]*\.rail-company-switcher \{[^}]*left: 10px;/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell \.rail-bottom #companySwitcherButton > strong \{[^}]*display: none;/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell \.company-switcher-menu \{[^}]*top: calc\(100% \+ 5px\);[^}]*bottom: auto;[^}]*width: 218px;[^}]*backdrop-filter: blur\(28px\) saturate\(1\.25\);/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell \.company-switcher-mark \{[^}]*width: 18px;[^}]*height: 18px;/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell \.company-switcher-menu button:hover,[^}]*background: #0a84ff;[^}]*color: #fff;/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell\.rail-compact \.titlebar-rail \{[^}]*padding-inline: 0;[^}]*transform: translateY\(var\(--titlebar-height\)\);/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell\.rail-compact \.rail-scroll \{[^}]*padding-top: calc\(var\(--titlebar-height\) \+ 9px\);/s,
		);
		expect(railResizeSource).toContain('getPropertyValue("--rail-compact-width")');
		expect(railResizeSource).toContain("Math.floor(window.innerWidth * 0.4)");
		expect(railResizeSource).not.toContain("MAX_WIDTH");
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell\.rail-compact \.rail-company-switcher \{[^}]*top: auto;[^}]*bottom: 9px;[^}]*left: 23px;[^}]*width: 34px;[^}]*height: 34px;/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell\.rail-compact \.company-switcher-menu \{[^}]*top: auto;[^}]*bottom: calc\(100% \+ 5px\);[^}]*left: 0;/s,
		);
	});

	it("tracks macOS native window-control visibility across overlay transitions", () => {
		const geometryListeners = new Map<string, () => void>();
		const dataset: Record<string, string> = {};
		const windowControlsOverlay = {
			visible: true,
			addEventListener: (type: string, listener: () => void) => geometryListeners.set(type, listener),
		};
		runInNewContext(preloadSource, {
			require: (id: string) => {
				expect(id).toBe("electron");
				return {
					contextBridge: { exposeInMainWorld: () => undefined },
					ipcRenderer: { invoke: () => Promise.resolve(undefined), on: () => undefined },
				};
			},
			process: { platform: "darwin", argv: [] },
			document: { documentElement: { dataset }, getElementById: () => null },
			window: { addEventListener: () => undefined },
			navigator: { windowControlsOverlay },
		});

		expect(dataset.windowControls).toBe("visible");
		windowControlsOverlay.visible = false;
		geometryListeners.get("geometrychange")?.();
		expect(dataset.windowControls).toBe("hidden");
		windowControlsOverlay.visible = true;
		geometryListeners.get("geometrychange")?.();
		expect(dataset.windowControls).toBe("visible");
	});

	it("keeps active agent selection blue across hover and pinned layouts", () => {
		expect(baseCssSource).toMatch(
			/#staffNavigation \.staff-nav-row\.active,[^}]*#staffNavigation \.staff-nav-row\.active:hover[^}]*\{[^}]*background: var\(--sidebar-selection\);[^}]*color: var\(--sidebar-selection-text\);/s,
		);
		expect(pinnedAgentsCssSource).toMatch(
			/\.staff-pinned-grid \.staff-pinned-card\.active,[^}]*\.staff-pinned-grid \.staff-pinned-card\.active:hover[^}]*\{[^}]*background: var\(--sidebar-selection\);[^}]*color: var\(--sidebar-selection-text\);/s,
		);
		expect(pinnedAgentsCssSource).not.toMatch(
			/\.staff-pinned-grid \.staff-pinned-card\.active[^}]*\{[^}]*background: #e9e9e7;/s,
		);
	});

	it("defers background roster replacement while a pointer interaction owns its rows", () => {
		const guardStart = rendererSource.indexOf("function renderRosterRailWhenIdle()");
		const guardEnd = rendererSource.indexOf("function renderRosterRail(", guardStart);
		const guard = rendererSource.slice(guardStart, guardEnd);
		expect(guardStart).toBeGreaterThan(-1);
		expect(guard).toContain('container.matches(":hover")');
		expect(guard).toContain('container.classList.contains("staff-reordering")');
		expect(guard).toContain("rosterRailRenderPending = true");
		const result = runInNewContext(`
			let rosterRailRenderPending = false;
			let rosterRailRenderFrame = null;
			let renders = 0;
			const frames = [];
			const root = {
				hovered: true,
				reordering: false,
				matches: () => root.hovered,
				classList: { contains: () => root.reordering },
			};
			const $ = () => root;
			const requestAnimationFrame = (callback) => {
				frames.push(callback);
				return frames.length;
			};
			function renderRosterRail() {
				renders += 1;
				rosterRailRenderPending = false;
			}
			${guard}
			renderRosterRailWhenIdle();
			flushPendingRosterRailRender();
			flushPendingRosterRailRender();
			root.hovered = false;
			frames.shift()();
			({ renders, pending: rosterRailRenderPending, queuedFrames: frames.length });
		`) as { renders: number; pending: boolean; queuedFrames: number };
		expect(result).toEqual({ renders: 1, pending: false, queuedFrames: 0 });
		expect(rendererSource).toContain(
			'$("staffNavigation").addEventListener("pointerleave", flushPendingRosterRailRender)',
		);
		expect(rendererSource).toContain('window.addEventListener("pointerup", flushPendingRosterRailRender)');
		const dragWireStart = rendererSource.indexOf("window.qorperaStaffDrag?.wire({");
		const dragWireEnd = rendererSource.indexOf("\n\t});", dragWireStart);
		const dragWire = rendererSource.slice(dragWireStart, dragWireEnd);
		expect(dragWireStart).toBeGreaterThan(-1);
		expect(dragWire).toContain("renderRosterRailWhenIdle()");
		expect(dragWire).not.toContain("renderRosterRail()");
		const runnerStart = rendererSource.indexOf("window.qorpera.onRunnerActivity?.(");
		const runnerEnd = rendererSource.indexOf("setInterval(() => {", runnerStart);
		const runnerActivity = rendererSource.slice(runnerStart, runnerEnd);
		expect(runnerActivity).toContain("renderRosterRailWhenIdle()");
		expect(runnerActivity).not.toContain("renderRosterRail()");
	});

	it("matches the Messages rail scale, surface, and selected icon contrast", () => {
		expect(tokensCssSource).toContain("--sidebar-surface: #eeedeb;");
		expect(tokensCssSource).toContain("--sidebar-vibrancy-tint: rgba(232, 235, 240, 0.32);");
		expect(rendererSource).toContain('"qorpera-cobalt": "#0071e3"');
		expect(baseCssSource).toMatch(
			/\.staff-nav-row,[^}]*\.company-runtime-row \{[^}]*grid-template-columns: 50px minmax\(0, 1fr\);/s,
		);
		expect(baseCssSource).toMatch(
			/html\[data-staff-avatar-style="creatures"\] \.staff-nav-row \.staff-avatar,[^}]*width: 50px;[^}]*height: 50px;/s,
		);
		expect(pinnedAgentsCssSource).toMatch(
			/\.staff-pinned-grid \.staff-pinned-card \.staff-avatar \{[^}]*width: 64px;[^}]*height: 64px;/s,
		);
		expect(baseCssSource).toMatch(
			/#staffNavigation \.staff-nav-row\.active \.staff-creature-image,[^}]*filter: brightness\(0\) invert\(1\) !important;/s,
		);
		expect(baseCssSource).toMatch(
			/#staffNavigation \.staff-nav-row\.active \.staff-face i,[^}]*background: var\(--sidebar-selection\);/s,
		);
		expect(railResizeCssSource).toMatch(
			/body\.company-shell \.titlebar-rail \.rail-add-staff \{[^}]*justify-self: center;/s,
		);
		expect(railResizeCssSource).toMatch(
			/body\.company-shell \.staff-create-row \.staff-create-mark \{[^}]*justify-self: center;[^}]*padding: 0;[^}]*background: #ececea;/s,
		);
	});

	it("preserves system avatar colors in forced-color mode", () => {
		expect(baseCssSource).toMatch(
			/@media \(forced-colors: active\) \{\s*\.staff-avatar \{ --staff-creature-filter: none !important; \}\s*\.staff-creature-image \{ filter: none !important; \}/s,
		);
		expect(baseCssSource).toMatch(
			/@media \(forced-colors: none\) \{\s*#staffNavigation \.staff-nav-row\.active \.staff-avatar,[\s\S]*?--staff-creature-filter: brightness\(0\) invert\(1\) !important;[\s\S]*?#staffNavigation \.staff-nav-row\.active \.staff-creature-image,[\s\S]*?filter: brightness\(0\) invert\(1\) !important;[\s\S]*?#staffNavigation \.staff-nav-row\.active \.staff-face i,[\s\S]*?background: var\(--sidebar-selection\);/,
		);
	});

	it("keeps the translucent sidebar preference persistent and accessible", () => {
		const themeRow = rendererSource.indexOf('setRow(appearanceGroup, "Theme", "", theme)');
		const translucencyRow = rendererSource.indexOf('sidebarTranslucency.id = "sidebarTranslucencyToggle"');
		expect(themeRow).toBeGreaterThan(-1);
		expect(translucencyRow).toBeGreaterThan(themeRow);
		expect(rendererSource).not.toContain("SIDEBAR_TRANSLUCENCY_KEY");
		expect(rendererSource).toContain('dataset.platform === "darwin"');
		expect(rendererSource).toContain('sidebarTranslucency.id = "sidebarTranslucencyToggle"');
		expect(rendererSource).toContain('sidebarTranslucency.setAttribute("role", "switch")');
		expect(rendererSource).toContain('toggle.setAttribute("aria-checked", String(enabled))');
		expect(baseCssSource).toContain('html[data-sidebar-translucency="off"] #primaryNavigation');
		expect(mainSource).toContain('readSidebarTranslucency(app.getPath("userData"))');
		expect(mainSource).toContain("additionalArguments: [`--qorpera-sidebar-translucency=");
		expect(mainSource).toContain('ipcMain.handle("settings:sidebar-translucency"');
		expect(mainSource).toContain('current.window.setVibrancy(enabled ? "sidebar" : null)');
		expect(preloadSource).toContain('ipcRenderer.invoke("settings:sidebar-translucency", enabled)');
		expect(preloadSource).toContain('ipcRenderer.on("sidebar-translucency"');
	});

	it("always exposes updater state and a manual check on the company hub", () => {
		expect(indexSource).toContain('id="hubUpdateButton"');
		expect(preloadSource).toContain('ipcRenderer.invoke("update:state")');
		expect(preloadSource).toContain('ipcRenderer.invoke("update:check")');
		expect(preloadSource).toContain('ipcRenderer.on("update-state"');
		expect(mainSource).toContain('ipcMain.handle("update:state"');
		expect(mainSource).toContain('ipcMain.handle("update:check"');
		expect(mainSource).toContain('sendAll("update-state", state)');
		expect(rendererSource).toContain('"Check for updates"');
		expect(rendererSource).toContain("Downloading v");
		expect(rendererSource).toContain("Restart to update v");
		expect(baseCssSource).toContain('.hub-foot .hub-update-button[data-phase="ready"]');
	});

	it("keeps product feedback private and in-app", () => {
		expect(indexSource).toContain('id="feedbackModal"');
		expect(indexSource).toContain('src="./feedback.js"');
		expect(indexSource).toContain('href="./feedback.css"');
		expect(rendererSource).toContain('window.qorperaFeedback.open($("companySwitcherButton"))');
		expect(feedbackSource).toContain('!previousFocus.closest?.("[hidden]")');
		expect(feedbackSource).toContain("window.qorpera.submitFeedback({");
		expect(feedbackSource).toContain('category: selectedCategory ?? "other"');
		expect(feedbackSource).toContain("includeDiagnostics: true");
		expect(indexSource).not.toContain('id="feedbackDiagnostics"');
		expect(indexSource).not.toContain('id="feedbackDescription"');
		expect(feedbackCssSource).toContain(".feedback-modal");
		expect(preloadSource).toContain('ipcRenderer.invoke("feedback:submit", input)');
		expect(mainSource).toContain('ipcMain.handle("feedback:submit"');
		expect(mainSource).toContain("parseProductFeedbackRequest(input)");
		expect(mainSource).not.toContain("Qorpera/Qorpera_Base/issues/new");
	});

	it("renders durable queued prompts and remote staff activity", () => {
		expect(preloadSource).toContain('ipcRenderer.on("staff-session-queue"');
		expect(rendererSource).toContain("pendingSessionQueueByStaff");
		/* Queued bubbles read as ordinary sent messages: no author, no
		 * Processing/Queued meta — only a failure surfaces, as Needs review. */
		expect(rendererSource).toContain(
			'status.textContent = input.status === "failed" ? `Needs review$' +
				"{failure ? ` · $" +
				'{failure}` : ""}` : ""',
		);
		expect(rendererSource).not.toContain('? "Processing"');
		expect(rendererSource).toContain("result.queued");
		expect(rendererSource).toContain("displayText: text");
		expect(rendererSource).toContain("const pendingPromptSendFallbacks = new Map()");
		expect(rendererSource).toContain("window.qorpera.stagePromptSend(pending.id, frame)");
		expect(rendererSource).toContain("window.qorpera.pendingPromptSend()");
		expect(preloadSource).toContain('ipcRenderer.invoke("prompt-send:ack", id)');
		expect(preloadSource).toContain('ipcRenderer.invoke("staff-session:resolve-recovery"');
		expect(preloadSource).toContain('ipcRenderer.invoke("staff-session:resolve-execution-recovery"');
		expect(preloadSource).toContain('ipcRenderer.invoke("staff-session:resolve-operation"');
		expect(preloadSource).toContain('ipcRenderer.invoke("staff-session:resolve-run-operation"');
		expect(preloadSource).toContain('ipcRenderer.on("runner-activity"');
		expect(mainSource).toContain('ipcMain.handle("prompt-send:stage"');
		expect(mainSource).toContain('"staff-session:resolve-recovery"');
		expect(mainSource).toContain('"staff-session:resolve-execution-recovery"');
		expect(mainSource).toContain('"staff-session:resolve-operation"');
		expect(mainSource).toContain('"staff-session:resolve-run-operation"');
		expect(mainSource).toContain('"runner-activity"');
		expect(mainSource).toContain("body?.displayText ?? body?.text");
		expect(mainSource).toContain("text: reviewed.displayText ?? reviewed.message");
		expect(baseCssSource).toContain(".msg.user.session-queued");
		expect(preloadSource).toContain('ipcRenderer.on("presence-activity"');
		expect(rendererSource).toContain("remoteStaffActivity");
		expect(rendererSource).toContain("remoteStaffDoingLine");
		expect(rendererSource).toContain("presencePeers.map((member) => member.clientId)");
		expect(mainSource).not.toContain("continuing solo");
		expect(mainSource).toContain("qorpera.staff-intro-retry/v1");
		expect(mainSource).toContain("await checkpointCloudCompanyFile({");
		expect(preloadSource).toContain('ipcRenderer.invoke(\n\t\t\t"company-file:retry-proposal-review"');
		expect(mainSource).toContain('"company-file:retry-proposal-review"');
		expect(rendererSource).toContain("Waiting for the configured agent reviews.");
		expect(rendererSource).toContain(
			'publishProposal.textContent = requestedChanges.length > 0 ? "Revise" : "Publish"',
		);
	});

	it("builds historical conversations off-DOM before one visible attachment", () => {
		const renderHistory = rendererSource.slice(
			rendererSource.indexOf("function renderHistory("),
			rendererSource.indexOf("function navigationNode(", rendererSource.indexOf("function renderHistory(")),
		);
		expect(renderHistory).toContain("document.createDocumentFragment()");
		expect(renderHistory).toContain("conversationRenderTarget = fragment");
		expect(renderHistory).toContain("messagesElement.appendChild(fragment)");
		expect(rendererSource).toContain("function scrollConversationToEnd()");
		expect(rendererSource).toContain("if (conversationRenderTarget) return;");
	});

	it("presents large agent sidepanels before attaching the complete routine list", () => {
		const sidepanelRenderer = rendererSource.slice(
			rendererSource.indexOf("function createAgentRoutineRow("),
			rendererSource.indexOf(
				"function agentSettingsSvg(",
				rendererSource.indexOf("function createAgentRoutineRow("),
			),
		);
		expect(sidepanelRenderer).toContain("document.createDocumentFragment()");
		expect(sidepanelRenderer).toContain('routines.setAttribute("aria-busy", "true")');
		expect(sidepanelRenderer).toContain("requestAnimationFrame(() => {");
		expect(sidepanelRenderer).toContain("routines.appendChild(fragment)");
		expect(sidepanelRenderer).toContain('routines.removeAttribute("aria-busy")');
		expect(rendererSource).toContain("renderGeneration !== agentSidepanelRenderGeneration");
		expect(baseCssSource).toContain("content-visibility: auto");
		expect(baseCssSource).toContain("contain-intrinsic-block-size: 47px");
	});

	it("routes personal subscription turns without requiring a ready local agent runtime", () => {
		expect(indexSource).toContain('id="cloudSponsorSelect"');
		expect(indexSource).toContain('id="threadSponsorProvenance"');
		expect(preloadSource).toContain('ipcRenderer.invoke("native-execution:begin-login", provider)');
		expect(preloadSource).toContain('ipcRenderer.invoke("native-execution:revoke", providerConnectionId)');
		/* There is no local agent runtime to wait for: rpc:send hands every
		 * frame to the anchored cloud conversation or rejects it. */
		expect(mainSource).toContain("const anchor = runtime.sessionAnchor;");
		expect(mainSource).toContain("await control.requestSessionTurn({");
		expect(rendererSource).toContain("const executionSponsor = selectedNativeExecutionSponsor()");
		expect(rendererSource).toContain("message.qorperaRunId");
		/* Founder ruling (2026-08-26): the thread shows the conversation, not
		 * the machinery — no provider tags on bubbles or in the header, and no
		 * visible sponsor selector; the first active connection sponsors. */
		expect(rendererSource).not.toContain("nativeTurnProvenanceLabel");
		expect(rendererSource).toContain('".msg.assistant .native-turn-provenance"');
		expect(rendererSource).toContain("select.hidden = true");
		const sendPrompt = rendererSource.slice(
			rendererSource.indexOf("async function sendPrompt("),
			rendererSource.indexOf("function modelFailureInfo", rendererSource.indexOf("async function sendPrompt(")),
		);
		expect(sendPrompt.indexOf("const executionSponsor = selectedNativeExecutionSponsor()")).toBeLessThan(
			sendPrompt.indexOf("if (agentExited && !executionSponsor)"),
		);
	});

	it("keeps the local execution lane and cloud wake claims out of the desktop", () => {
		/* One list, shared with scripts/check-cloud-runtime-boundaries.mjs:
		 * the desktop no longer runs a child, ticks wakes, or runs rooms; it
		 * only observes the durable queues the Runner Orchestrator drains. */
		expect(removedMainSymbols.length).toBeGreaterThan(0);
		for (const { symbol } of removedMainSymbols) {
			expect(mainSource, `main.ts still contains ${JSON.stringify(symbol)}`).not.toContain(symbol);
		}
		for (const file of removedLocalLaneModules) {
			expect(existsSync(join(repositoryRoot, file)), `${file} was removed with the local lane`).toBe(false);
		}
		for (const name of removedAgentRuntimeExports) {
			expect(agentRuntimeSource).not.toMatch(new RegExp(`export (async )?function ${name}\\(`));
		}
	});

	it("requires a sponsored runner job and rejects desktop execution for cloud turns", () => {
		/* The sponsored-turn path lives in requestSponsoredCloudTurn, reached
		 * only through the childless session anchor. */
		const turnStart = mainSource.indexOf("async function requestSponsoredCloudTurn(");
		const turnEnd = mainSource.indexOf("function trailSessionLeafEntryId(", turnStart);
		expect(turnStart).toBeGreaterThan(-1);
		expect(turnEnd).toBeGreaterThan(turnStart);
		const turnLane = mainSource.slice(turnStart, turnEnd);
		expect(turnLane).toContain("await control.requestSessionTurn({");
		expect(turnLane).toContain("Cloud turns never use the desktop model runtime.");
		expect(turnLane).not.toContain("enqueueCloudPrompt(");
		/* The childless anchor answers the whole session surface. */
		expect(mainSource).toContain("async function anchoredSessionRpc(");
		expect(mainSource).toContain("requestSponsoredCloudTurn(runtime, arbiter, anchor.staffAgentId, ref, reviewed)");
		/* rpc:send routes only through the anchor and otherwise refuses. */
		const rpcStart = mainSource.indexOf('ipcMain.handle("rpc:send"');
		const rpcEnd = mainSource.indexOf("ipcMain.handle(", rpcStart + 1);
		expect(rpcStart).toBeGreaterThan(-1);
		expect(rpcEnd).toBeGreaterThan(rpcStart);
		const rpcSend = mainSource.slice(rpcStart, rpcEnd);
		expect(rpcSend).toContain("const anchor = runtime.sessionAnchor;");
		expect(rpcSend).toContain("return anchoredSessionRpc(");
		expect(rpcSend).toContain("Agents execute in the cloud.");
	});

	it("renders agent details from the titlebar with only supported figure controls", () => {
		expect(indexSource).toContain('id="agentSettingsPopover"');
		expect(rendererSource).toContain("function openAgentSettingsPopover()");
		expect(rendererSource).toContain('title.textContent = "Responsibility map"');
		expect(rendererSource).not.toContain('className = "agent-settings-fullscreen-button"');
		expect(rendererSource).not.toContain('className = "agent-settings-escape"');
		const picker = rendererSource.slice(
			rendererSource.indexOf("function renderAgentFigurePicker"),
			rendererSource.indexOf("function renderResponsibilityPreview"),
		);
		expect(picker).toContain("STAFF_CREATURE_IDS");
		expect(picker).toContain("STAFF_AVATAR_COLORS");
		expect(picker).toContain(
			'makeStaffAvatar({ appearance: { color: staffColor(staff), creature, shape: "round" } }, "idle")',
		);
		expect(picker).not.toContain("Generate");
		expect(picker).not.toContain("Upload");
		expect(rendererSource).toContain("STAFF_CREATURE_FILTERS[staffColor(staffOrTemplate)]");
		expect(baseCssSource).toMatch(/\.agent-figure-grid \{[^}]*justify-content: center/s);
		expect(characterMotionSource).toContain(".staff-avatar > .staff-face i:first-child");
		expect(characterMotionSource).toContain(".staff-creature-choice:has(> .staff-avatar)::before");
		expect(baseCssSource).not.toContain("--creature-eye-top");
		expect(rendererSource).toContain("figurePicker.hidden = true");
		expect(rendererSource).toContain('figureTrigger?.setAttribute("aria-expanded", "false")');
		expect(baseCssSource).toContain('filter: url("./staff-creature-colors.svg#gray") !important;');
		expect(baseCssSource).toContain(".agent-settings-popover.is-fullscreen");
		expect(mainSource).toContain('key !== "appearance"');
	});
});
