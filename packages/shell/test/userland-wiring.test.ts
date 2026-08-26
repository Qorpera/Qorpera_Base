import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const shell = join(import.meta.dirname, "..");
const userland = join(shell, "userland");
const rendererSource = readFileSync(join(userland, "renderer.js"), "utf-8");
const indexSource = readFileSync(join(userland, "index.html"), "utf-8");
const baseCssSource = readFileSync(join(userland, "base.css"), "utf-8");
const onboardingCssSource = readFileSync(join(userland, "onboarding.css"), "utf-8");
const characterMotionSource = readFileSync(join(userland, "character-motion.css"), "utf-8");
const railResizeCssSource = readFileSync(join(userland, "rail-resize.css"), "utf-8");
const feedbackSource = readFileSync(join(userland, "feedback.js"), "utf-8");
const feedbackCssSource = readFileSync(join(userland, "feedback.css"), "utf-8");
const hubCarouselSource = readFileSync(join(userland, "hub-carousel.js"), "utf-8");
const preloadSource = readFileSync(join(shell, "src", "preload.cjs"), "utf-8");
const mainSource = readFileSync(join(shell, "src", "main.ts"), "utf-8");

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
		expect(rendererSource).toContain('? "Cloud-authoritative" : "Stored on this computer"');
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
			/html\[data-platform="darwin"\] body\.company-shell\.rail-compact \.titlebar-rail \{[^}]*transform: translateY\(var\(--titlebar-height\)\);/s,
		);
		expect(railResizeCssSource).toMatch(
			/html\[data-platform="darwin"\] body\.company-shell\.rail-compact \.rail-scroll \{[^}]*padding-top: calc\(var\(--titlebar-height\) \+ 9px\);/s,
		);
	});

	it("keeps the translucent sidebar preference persistent and accessible", () => {
		expect(rendererSource).toContain('const SIDEBAR_TRANSLUCENCY_KEY = "qorpera.sidebar-translucency/v1"');
		expect(rendererSource).toContain('sidebarTranslucency.setAttribute("role", "switch")');
		expect(rendererSource).toContain('sidebarTranslucency.setAttribute("aria-checked", String(enabled))');
		expect(baseCssSource).toContain('html[data-sidebar-translucency="off"] #primaryNavigation');
		expect(mainSource).toContain('vibrancy: "sidebar" as const');
		expect(mainSource).toContain('ipcMain.handle("settings:sidebar-translucency"');
		expect(mainSource).toContain('slot.window.setVibrancy(enabled ? "sidebar" : null)');
		expect(preloadSource).toContain('ipcRenderer.invoke("settings:sidebar-translucency", enabled)');
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
			'status.textContent = input.status === "failed" ? `Needs review${failure ? ` · ${failure}` : ""}` : ""',
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

	it("routes personal subscription turns without requiring a ready local agent runtime", () => {
		expect(indexSource).toContain('id="cloudSponsorSelect"');
		expect(indexSource).toContain('id="threadSponsorProvenance"');
		expect(preloadSource).toContain('ipcRenderer.invoke("native-execution:begin-login", provider)');
		expect(preloadSource).toContain('ipcRenderer.invoke("native-execution:revoke", providerConnectionId)');
		expect(mainSource).toContain("const cloudSponsoredPrompt = reviewedCloudPrompt?.executionSponsor !== undefined;");
		expect(mainSource).toContain("runtime.wakeChild && !cloudSponsoredPrompt");
		expect(mainSource).toContain(
			"!cloudSponsoredPrompt && runtime.childOptions.staffAgentId && !childRuntimeReady.has(reviewedChild)",
		);
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

	it("leaves cloud wakes to the runner orchestrator", () => {
		expect(mainSource).toMatch(/cloud \$\{cause\} wake is waiting for the runner orchestrator/);
		expect(mainSource).not.toContain("runtimeCloudWakeArbiter(");
		expect(mainSource).not.toContain("completeActiveCloudWake(");
		expect(mainSource).not.toContain("submitCloudWakeProposal(");
	});

	it("requires a sponsored runner job and rejects desktop execution for cloud turns", () => {
		/* The sponsored-turn path lives in requestSponsoredCloudTurn, shared by
		 * the legacy child lane and the childless session anchor. */
		const turnStart = mainSource.indexOf("async function requestSponsoredCloudTurn(");
		const turnEnd = mainSource.indexOf("function trailSessionLeafEntryId(", turnStart);
		expect(turnStart).toBeGreaterThan(-1);
		const turnLane = mainSource.slice(turnStart, turnEnd);
		expect(turnLane).toContain("await control.requestSessionTurn({");
		expect(turnLane).toContain("Cloud turns never use the desktop model runtime.");
		expect(turnLane).not.toContain("enqueueCloudPrompt(");
		expect(turnLane).not.toContain("sendLegacyLocalPrompt(");
		const cloudStart = mainSource.indexOf("const cloudSponsoredPrompt = reviewedCloudPrompt?.executionSponsor");
		const cloudEnd = mainSource.indexOf('if (cloudStaffConversation && frame.type === "prompt")', cloudStart);
		expect(cloudStart).toBeGreaterThan(-1);
		expect(cloudEnd).toBeGreaterThan(cloudStart);
		const cloudComposer = mainSource.slice(cloudStart, cloudEnd);
		expect(cloudComposer).toContain("requestSponsoredCloudTurn(runtime, sendArbiter, sendStaffId, sendRef, reviewed)");
		expect(cloudComposer).not.toContain("sendLegacyLocalPrompt(");
		/* The childless anchor answers the whole session surface. */
		expect(mainSource).toContain("async function anchoredSessionRpc(");
		expect(mainSource).toContain("requestSponsoredCloudTurn(runtime, arbiter, anchor.staffAgentId, ref, reviewed)");
		const legacyStart = mainSource.indexOf("function sendLegacyLocalPrompt(");
		const legacyEnd = mainSource.indexOf("function ", legacyStart + 1);
		const legacyPrompt = mainSource.slice(legacyStart, legacyEnd);
		expect(legacyPrompt).toContain('childProfileTypes.get(child) === "cloud"');
		expect(legacyPrompt).toContain("legacy local executor rejected a cloud prompt");
		expect(mainSource).toContain("function sendLegacyLocalStaffDirective(");
		expect(mainSource).toContain("legacy local executor rejected a cloud staff directive");
		expect(mainSource).not.toContain(".appendPrompt(");
		expect(mainSource).not.toContain("withBrokerOutputCheckpoint(");
		expect(mainSource).not.toContain("childBrokerOutputCheckpoints");
		expect(mainSource).toContain("Cloud company publication is waiting for the active agent run to finish");
		expect(mainSource).toContain("requireDurableExecution,");
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
