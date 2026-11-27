import {
	readSurfaceFolderFiles,
	type SurfaceFolderContents,
	surfaceFolderRoots,
} from "@qorpera/cloud-client/surface-folder-files";
import { CloudSurfacesClient } from "@qorpera/cloud-client/surfaces";
import { inferSurfaceKind, type StudioBinaryRef, type SurfaceSummary } from "@qorpera/contracts";
import type { User } from "@supabase/supabase-js";
import { withAbortScopes } from "../cloud/abort-scope.ts";
import { CloudApi } from "../cloud/api.ts";
import { forgetChatGptPlanSignIn, takeChatGptPlanReturn } from "../cloud/chatgpt-plan-sign-in.ts";
import { type Cloud, CloudRpcError, describeError, translateCloudErrors } from "../cloud/client.ts";
import { createWebCompanyAgents } from "../cloud/company-agents.ts";
import { WebCompanyFiles } from "../cloud/company-files.ts";
import { askCompanyNumbers } from "../cloud/company-numbers.ts";
import { createWebConnectors, takeConnectorReturn } from "../cloud/connectors.ts";
import { createDigitalPostKeys, readDigitalPost } from "../cloud/digital-post.ts";
import { createWebEventHooks } from "../cloud/event-hooks.ts";
import { interfacePageCalls } from "../cloud/interface-pages.ts";
import { connectExistingGoogleMailbox, pauseGoogleMailbox, reusableGoogleMailAccounts } from "../cloud/mail.ts";
import { createWebMemberNotifications } from "../cloud/member-notifications.ts";
import { createWebNativeSubscription } from "../cloud/native-subscription.ts";
import { UUID_PATTERN } from "../cloud/parse.ts";
import { type CodeReleases, codeReleaseCalls } from "../cloud/releases.ts";
import { createWebRoutines } from "../cloud/routines.ts";
import { createWebSessionAttachments } from "../cloud/session-attachments.ts";
import { createWebSessionInputWriter } from "../cloud/session-input.ts";
import { createWebSessionModel } from "../cloud/session-model.ts";
import { createWebSessionRunControl } from "../cloud/session-run-control.ts";
import { type CompanySiteHostingState, createWebSiteHosting } from "../cloud/site-hosting.ts";
import { type CompanySite, createWebSites } from "../cloud/sites.ts";
import { loadSkillSuggestions, SkillLists } from "../cloud/skills.ts";
import type { HostedProfile } from "../cloud/types.ts";
import { agentFigure, nativeColorOf } from "../ui/avatar.ts";
import { watchBrowserBar } from "../ui/browser-bar.ts";
import { companyLogos, setCompanyLogos } from "../ui/company-logos.ts";
import { companyInSentence, companyNameText } from "../ui/company-name.ts";
import { waitForDeferredStyles } from "../ui/deferred-styles.ts";
import { button, h, icon, notice, replace } from "../ui/dom.ts";
import { installHoverGlides } from "../ui/hover-glide.ts";
import { disposeCardPictures, type InteractionCardApp, refreshAppPreviews } from "../ui/interaction-card.ts";
import { interfaceEmblem } from "../ui/interface-emblem.ts";
import { isPhoneLayout } from "../ui/layout.ts";
import { personPictures, setPersonPictures } from "../ui/person-pictures.ts";
import { applyLanguage, presentationLocale, t, watchTheme } from "../ui/preferences.ts";
import { RailLayout } from "../ui/rail-layout.ts";
import { blankSkeleton, pageSkeleton, railSkeleton, threadSkeleton } from "../ui/skeleton.ts";
import { deferOffFrame } from "../ui/time-slice.ts";
import { AgentNotes } from "./agent-notes.ts";
import type { AppTellSource, HeldNote } from "./app-actions.ts";
import { AuthController, accountName, displayName, needsPassword } from "./auth.ts";
import { offersWaitingOn } from "./automation-owner.ts";
import {
	agentWorks,
	CompanyController,
	hostingNotingPublic,
	readSitesOncePublished,
	siteServed,
	startPublicRead,
} from "./company.ts";
import { CompanyDatabases } from "./company-data.ts";
import { CompanyLogos } from "./company-logos.ts";
import { CompanyMail } from "./company-mail.ts";
import { CompanyReading, readCompanyStanding } from "./company-reading.ts";
import { CompanyWordmarkCache, companyWordmarks, setCompanyWordmarks } from "./company-wordmark.ts";
import { DATA_PAGE, wantDataList } from "./data-page.ts";
import { folderImageReader } from "./folder-images.ts";
import type { FoundingController } from "./founding.ts";
import {
	type CompanyApp,
	CompanyApps,
	CompanyData,
	CompanyNumbers,
	companyConcepts,
	sharedFolderHints,
} from "./interface-apps.ts";
import { type InterfaceWrites, writesUnderSurfaceBar } from "./interface-claims.ts";
import { CompanyInterfaceFolder } from "./interface-folder.ts";
import { CompanyInterfacePages } from "./interface-pages.ts";
import { companyInterfaces, pagesOn } from "./interfaces.ts";
import { MemberPictures } from "./member-pictures.ts";
import { newVersionNotice, runningBuildFiles, watchNewVersion } from "./new-version.ts";
import { watchOnline } from "./online-mark.ts";
import { OpenQuestions } from "./open-questions.ts";
import { COMPANY_PRESENCE_PLACE } from "./presence-place.ts";
import { type CompanyReleaseReads, companyReleaseReads } from "./release-reads.ts";
import { currentRoute, navigate, type Route, routeHash } from "./router.ts";
import { createConversationStarter } from "./start-conversation.ts";
import { debounce } from "./state.ts";
import {
	attachSurfaces,
	isLocalSurfaceId,
	SurfacesStore,
	surfacesDisabledOf,
	surfacesOf,
	surfacesStoreOf,
} from "./surfaces-store.ts";
import { showWaitingInTitle } from "./tab-title.ts";
import { noteReceiver, type TellAccounts, tellAgent } from "./tell-agent.ts";
import { createGroupDeleter, createGroupUpdater } from "./update-group.ts";
import type { AccountViewState } from "./views/account.ts";
import type { AgentDetails } from "./views/agent-details.ts";
import { savedAgentDraft } from "./views/agent-edits.ts";
import { AppPanel, type AppPanelHost, type SidePanelTarget, sameTarget } from "./views/app-panel.ts";
import type { CachedFolderListing, CompanyFolderBrowser } from "./views/company-folder.ts";
import { type ComputerPanelsLike, LazyComputerPanels } from "./views/computer-lazy.ts";
import type { ConceptsView } from "./views/concepts.ts";
import { type AgentPage, ConversationView } from "./views/conversation.ts";
import { ExecutionNotices } from "./views/execution-notices.ts";
import type { FeedbackView } from "./views/feedback.ts";
import type { FoundingView } from "./views/founding.ts";
import type { FriendsWindow } from "./views/friends-window.ts";
import { takeGoodWillReturn } from "./views/good-will-format.ts";
import type { GroupDetails } from "./views/group-details.ts";
import { HubController, renderHub } from "./views/hub.ts";
import { _bootHub } from "./views/lazy-boot-hub.ts";
import type { MemberChatView } from "./views/member-chat.ts";
import {
	hasWebsiteIdea,
	keepWebsiteIdea,
	relabelNewCompany,
	renderNewCompany,
	type Viewer,
} from "./views/new-company.ts";
import type { NewConversationView } from "./views/new-conversation.ts";
import type { NewProgramPage, ProgramAddHost } from "./views/program-add.ts";
import type { QuestionDockHost } from "./views/question-dock.ts";
import { whatsNewEntry } from "./views/release-desk.ts";
import type { SettingsView } from "./views/settings.ts";
import type { MyGoodWillView } from "./views/settings-good-will.ts";
import type { SettingsTab } from "./views/settings-places.ts";
import {
	appLook,
	clearShellCompanyState,
	installSearchShortcut,
	invalidateShellSearchFiles,
	renderRail,
	renderTopbar,
	type ShellContext,
} from "./views/shell.ts";
import { renderNameAsk, renderPasswordAsk, renderSignIn } from "./views/signin.ts";
import type { SiteView } from "./views/site-view.ts";
import { landStartCrown, settleStartCrown } from "./views/start-crown.ts";
import { decorateSurfaceFigure, surfacesBySlug } from "./views/surface-figure-row.ts";
import type { SurfaceMount, SurfaceView } from "./views/surface-view.ts";
import type { TeamFeedback } from "./views/team.ts";
import type { WhatsNewView } from "./views/whats-new.ts";
import type { WorkspaceActions } from "./workspace-actions.ts";

interface LazyModule<T> {
	value: T | undefined;
	promise: Promise<T> | undefined;
}

function lazyModule<T>(load: () => Promise<T>): {
	get: () => T | undefined;
	set: (mod: T) => void;
	load: () => Promise<T>;
} {
	const state: LazyModule<T> = { value: undefined, promise: undefined };
	return {
		get: () => state.value,
		set: (mod: T) => {
			state.value = mod;
		},
		load: () => {
			if (state.value) return Promise.resolve(state.value);
			state.promise ??= load().then(
				(mod) => {
					state.value = mod;
					return mod;
				},
				(error: unknown) => {
					state.promise = undefined;
					throw error;
				},
			);
			return state.promise;
		},
	};
}

// WHY: Keep lazy-boot-hub anchored in main's static graph so lazy barrels never emit a separate hub chunk.
void _bootHub;

// WHY: Wait for deferred view stylesheets alongside lazy bundles so Surface and secondary views paint without FOUC.
const surfaceViewModule = lazyModule(() =>
	Promise.all([import("./views/surface-view.ts"), waitForDeferredStyles()]).then(([mod]) => mod),
);
// WHY: Splitting secondary views into four domain barrels keeps Cmd+K small without exploding boot preload chunks.
const lazyQuickModule = lazyModule(() =>
	Promise.all([import("./views/lazy-quick.ts"), waitForDeferredStyles()]).then(([mod]) => mod),
);
const lazyOpsModule = lazyModule(() =>
	Promise.all([import("./views/lazy-ops.ts"), waitForDeferredStyles()]).then(([mod]) => mod),
);
const lazySettingsModule = lazyModule(() =>
	Promise.all([import("./views/lazy-settings.ts"), waitForDeferredStyles()]).then(([mod]) => mod),
);
const lazyFoundingModule = lazyModule(() =>
	Promise.all([import("./views/lazy-founding.ts"), waitForDeferredStyles()]).then(([mod]) => mod),
);
const interfaceViewModule = lazyModule(() => lazyOpsModule.load().then((mod) => mod.interfaceView));
const companyFolderModule = lazyModule(() => lazyOpsModule.load().then((mod) => mod.companyFolder));
const foundingModule = lazyModule(() =>
	lazyFoundingModule.load().then((mod) => ({
		FoundingController: mod.foundingController.FoundingController,
		FoundingView: mod.foundingView.FoundingView,
	})),
);
const conceptsModule = lazyModule(() => lazyOpsModule.load().then((mod) => mod.concepts));
const newProgramModule = lazyModule(() => lazyOpsModule.load().then((mod) => mod.newProgram));
const siteViewModule = lazyModule(() => lazyOpsModule.load().then((mod) => mod.siteView));
const settingsViewModule = lazyModule(() => lazySettingsModule.load().then((mod) => mod.settingsView));
const friendsWindowModule = lazyModule(() => lazySettingsModule.load().then((mod) => mod.friendsWindow));
const feedbackViewModule = lazyModule(() => lazySettingsModule.load().then((mod) => mod.feedbackView));
const accountViewModule = lazyModule(() =>
	lazySettingsModule.load().then((mod) => ({
		renderAccount: mod.account.renderAccount,
		MyGoodWillView: mod.goodWill.MyGoodWillView,
	})),
);
const teamViewModule = lazyModule(() => lazySettingsModule.load().then((mod) => mod.teamView));
const memberChatModule = lazyModule(() => lazyQuickModule.load().then((mod) => mod.memberChat));
const newConversationModule = lazyModule(() => lazyQuickModule.load().then((mod) => mod.newConversation));
const whatsNewModule = lazyModule(() => lazyOpsModule.load().then((mod) => mod.whatsNew));
const agentDetailsModule = lazyModule(() => lazyOpsModule.load().then((mod) => mod.agentDetails));
const groupDetailsModule = lazyModule(() => lazyQuickModule.load().then((mod) => mod.groupDetails));

export function registerLazyApplicationModules(modules: {
	readonly lazyQuick?: typeof import("./views/lazy-quick.ts");
	readonly lazyOps?: typeof import("./views/lazy-ops.ts");
	readonly lazySettings?: typeof import("./views/lazy-settings.ts");
	readonly lazyFounding?: typeof import("./views/lazy-founding.ts");
	readonly interfaceView?: typeof import("./views/interface.ts");
	readonly surfaceView?: typeof import("./views/surface-view.ts");
	readonly companyFolder?: typeof import("./views/company-folder.ts");
	readonly founding?: {
		readonly FoundingController: typeof FoundingController;
		readonly FoundingView: typeof FoundingView;
	};
	readonly concepts?: typeof import("./views/concepts.ts");
	readonly newProgram?: typeof import("./views/program-add.ts");
	readonly siteView?: typeof import("./views/site-view.ts");
	readonly settingsView?: typeof import("./views/settings.ts");
	readonly friendsWindow?: typeof import("./views/friends-window.ts");
	readonly feedbackView?: typeof import("./views/feedback.ts");
	readonly accountView?: {
		readonly renderAccount: typeof import("./views/account.ts").renderAccount;
		readonly MyGoodWillView: typeof MyGoodWillView;
	};
	readonly teamView?: typeof import("./views/team.ts");
	readonly memberChat?: typeof import("./views/member-chat.ts");
	readonly newConversation?: typeof import("./views/new-conversation.ts");
	readonly whatsNew?: typeof import("./views/whats-new.ts");
	readonly agentDetails?: typeof import("./views/agent-details.ts");
	readonly groupDetails?: typeof import("./views/group-details.ts");
}): void {
	if (modules.lazyQuick) {
		const mod = modules.lazyQuick;
		lazyQuickModule.set(mod);
		memberChatModule.set(mod.memberChat);
		newConversationModule.set(mod.newConversation);
		groupDetailsModule.set(mod.groupDetails);
	}
	if (modules.lazyOps) {
		const mod = modules.lazyOps;
		lazyOpsModule.set(mod);
		interfaceViewModule.set(mod.interfaceView);
		companyFolderModule.set(mod.companyFolder);
		conceptsModule.set(mod.concepts);
		newProgramModule.set(mod.newProgram);
		siteViewModule.set(mod.siteView);
		whatsNewModule.set(mod.whatsNew);
		agentDetailsModule.set(mod.agentDetails);
	}
	if (modules.lazySettings) {
		const mod = modules.lazySettings;
		lazySettingsModule.set(mod);
		settingsViewModule.set(mod.settingsView);
		friendsWindowModule.set(mod.friendsWindow);
		feedbackViewModule.set(mod.feedbackView);
		accountViewModule.set({
			renderAccount: mod.account.renderAccount,
			MyGoodWillView: mod.goodWill.MyGoodWillView,
		});
		teamViewModule.set(mod.teamView);
	}
	if (modules.lazyFounding) {
		const mod = modules.lazyFounding;
		lazyFoundingModule.set(mod);
		foundingModule.set({
			FoundingController: mod.foundingController.FoundingController,
			FoundingView: mod.foundingView.FoundingView,
		});
	}
	if (modules.interfaceView) interfaceViewModule.set(modules.interfaceView);
	if (modules.surfaceView) surfaceViewModule.set(modules.surfaceView);
	if (modules.companyFolder) companyFolderModule.set(modules.companyFolder);
	if (modules.founding) foundingModule.set(modules.founding);
	if (modules.concepts) conceptsModule.set(modules.concepts);
	if (modules.newProgram) newProgramModule.set(modules.newProgram);
	if (modules.siteView) siteViewModule.set(modules.siteView);
	if (modules.settingsView) settingsViewModule.set(modules.settingsView);
	if (modules.friendsWindow) friendsWindowModule.set(modules.friendsWindow);
	if (modules.feedbackView) feedbackViewModule.set(modules.feedbackView);
	if (modules.accountView) accountViewModule.set(modules.accountView);
	if (modules.teamView) teamViewModule.set(modules.teamView);
	if (modules.memberChat) memberChatModule.set(modules.memberChat);
	if (modules.newConversation) newConversationModule.set(modules.newConversation);
	if (modules.whatsNew) whatsNewModule.set(modules.whatsNew);
	if (modules.agentDetails) agentDetailsModule.set(modules.agentDetails);
	if (modules.groupDetails) groupDetailsModule.set(modules.groupDetails);
}

/* Entry point. One cloud client, one auth controller, one company controller
 * at a time. The route decides the view; every view renders from cloud state
 * and re-renders on store changes. */

/** Each company's skill lists, shared by its conversations' composers. */
const skillLists = new WeakMap<CompanyController, SkillLists>();

function sitesListed(list: readonly CompanySite[]): { siteCount: number; siteList: readonly CompanySite[] } {
	return { siteCount: list.length, siteList: list };
}

const appsByNameCache = new WeakMap<readonly CompanyApp[], Map<string, CompanyApp>>();
function appsByName(apps: readonly CompanyApp[]): Map<string, CompanyApp> {
	let index = appsByNameCache.get(apps);
	if (!index) {
		index = new Map(apps.map((app) => [app.name, app]));
		appsByNameCache.set(apps, index);
	}
	return index;
}

/** An app of the company a question option's preview names (`app:<name>`): its title, emblem and cover, from the
 * company's apps as last read. Undefined while they have not been read, or when no such app is there. */
function cardAppOf(apps: readonly CompanyApp[] | undefined, name: string): InteractionCardApp | undefined {
	const found = apps ? appsByName(apps).get(name) : undefined;
	const manifest = found?.manifest;
	return manifest
		? {
				title: manifest.name,
				emblem: manifest.emblem,
				cover: manifest.cover ? `${found.path}/${manifest.cover}` : null,
			}
		: undefined;
}

export function mountApplication(
	root: HTMLElement,
	cloud: Cloud,
	api = new CloudApi(cloud),
	workspaceActions: WorkspaceActions = {},
	options?: { readonly localeReady?: Promise<void> },
): () => void {
	translateCloudErrors(t);
	const auth = new AuthController(cloud);
	let hub = new HubController(api);
	/** The founding table on screen, if any; one at a time, like the company. */
	let founding: { controller: FoundingController; view: FoundingView } | undefined;
	function teardownFounding(): void {
		if (!founding) return;
		founding.controller.dispose();
		founding = undefined;
		// Leaving a table's page: joins, answers and closes made there show on the hub.
		void hub.refresh();
	}
	// Every initials disc on the page shows the person's own picture through this store.
	const pictures = new MemberPictures(api);
	setPersonPictures(pictures);
	// Every company figure shows the company's own logo through this store, once it has one.
	const logos = new CompanyLogos(api, { scope: cloud.config.projectUrl });
	setCompanyLogos(logos);
	const wordmarks = new CompanyWordmarkCache(cloud.config.projectUrl);
	setCompanyWordmarks(wordmarks);

	const topbar = h("header", { class: "topbar" });
	const rail = h("aside", { id: "company-navigation", class: "rail", "aria-label": t("Company navigation") });
	const main = h("main", { class: "main", tabindex: "-1" });
	// Company notices are no popup: the open conversation places this above its composer.
	const executionNotices = h("div", { class: "company-notices" });
	const backdrop = h("button", {
		type: "button",
		class: "navigation-backdrop",
		"aria-label": t("Close company navigation"),
		onclick: () => setNavigationOpen(false),
	});
	const reopenRailBtn = h(
		"button",
		{
			type: "button",
			class: "icon-button rail-reopen-btn",
			"aria-label": t("Show sidebar"),
			title: t("Show sidebar"),
			"aria-controls": "company-navigation",
			"aria-expanded": "false",
			hidden: true,
			onclick: () => {
				railLayout.setHidden(false);
				syncRailReopen();
				render();
			},
		},
		icon("navigation"),
	);
	// A deploy since this tab loaded: one quiet line offers the new build (app/new-version.ts).
	const versionLine = h("div", { class: "app-version-notice", hidden: true });
	const versionWatch = new AbortController();
	const frame = h(
		"div",
		{ class: "frame" },
		topbar,
		h("div", { class: "body" }, backdrop, rail, reopenRailBtn, main),
		versionLine,
	);
	watchNewVersion(
		runningBuildFiles(),
		() => {
			versionLine.replaceChildren(
				newVersionNotice(root, () =>
					[...(company?.conversations.values() ?? [])].some((store) => (store.get().draft ?? "").trim() !== ""),
				),
			);
			versionLine.hidden = false;
		},
		versionWatch.signal,
	);
	const railLayout = new RailLayout(frame, rail);
	rail.after(railLayout.el);
	function syncRailReopen(): void {
		const show = !rail.hidden && railLayout.hidden && !isPhoneLayout();
		reopenRailBtn.hidden = !show;
		reopenRailBtn.setAttribute("aria-expanded", String(!railLayout.hidden));
	}
	window.addEventListener("qorpera-rail-resize", syncRailReopen, { signal: versionWatch.signal });
	installHoverGlides(versionWatch.signal);
	syncRailReopen();
	applyLanguage();
	// Interface text and times are read when they are drawn: a new language or
	// time zone redraws the screens in place (see redrawScreens).
	window.addEventListener("languagechange", onLanguage);
	window.addEventListener("qorpera-language-change", onLanguage);
	window.addEventListener("qorpera-time-zone-change", redrawScreens);
	const unwatchTheme = watchTheme();
	const unwatchBrowserBar = watchBrowserBar(root);
	let disposed = false;
	let localePending = Boolean(options?.localeReady);
	let settings: SettingsView | undefined;
	let feedback: FeedbackView | undefined;
	let friendsWindow: FriendsWindow | undefined;
	/** Friends see this account online while a tab is in front (online-mark.ts). */
	const online = watchOnline(
		() => api.markOnline(),
		() => Boolean(auth.userId),
	);
	function closeFriends(restoreFocus = true): void {
		if (!friendsWindow) return;
		friendsWindow.dispose();
		friendsWindow = undefined;
		if (!restoreFocus) return;
		// Opened over Settings, Friends give the focus back to Settings' own Friends button.
		(
			settings?.el.querySelector<HTMLElement>(".settings-friends") ??
			frame.querySelector<HTMLElement>(".account-friends")
		)?.focus();
	}
	/** Friends as a window of its own, over whatever is open: Settings stay open behind it (Jonas, 9 Nov 2026). */
	function openFriends(): void {
		if (friendsWindow || feedback || !auth.userId) return;
		const mount = (Loaded: typeof FriendsWindow) => {
			if (disposed || friendsWindow || feedback || !auth.userId) return;
			friendsWindow = new Loaded(api, hub, () => closeFriends(), settings?.friends);
			root.append(friendsWindow.el);
			friendsWindow.open();
		};
		const cached = friendsWindowModule.get();
		if (cached) mount(cached.FriendsWindow);
		else void friendsWindowModule.load().then((mod) => mount(mod.FriendsWindow));
	}
	function closeFeedback(restoreFocus = true): void {
		if (!feedback) return;
		feedback.dispose();
		feedback = undefined;
		if (restoreFocus) frame.querySelector<HTMLElement>(".account-trigger")?.focus();
	}
	function openFeedback(): void {
		if (feedback || settings || friendsWindow || !auth.userId) return;
		const mount = (Loaded: typeof FeedbackView) => {
			if (disposed || feedback || settings || friendsWindow || !auth.userId) return;
			feedback = new Loaded(api, () => closeFeedback());
			root.append(feedback.el);
			feedback.open();
		};
		const cached = feedbackViewModule.get();
		if (cached) mount(cached.FeedbackView);
		else void feedbackViewModule.load().then((mod) => mount(mod.FeedbackView));
	}
	function closeSettings(restoreFocus = true): void {
		// A Friends window over Settings uses their friends list: it closes with them (access to the company lost).
		if (settings) closeFriends(false);
		settings?.dispose();
		settings = undefined;
		frame.inert = false;
		if (restoreFocus) frame.querySelector<HTMLElement>(".account-trigger")?.focus();
	}
	let filesShown: { owner: CompanyController; browser: CompanyFolderBrowser } | undefined;
	let filesPending: { owner: CompanyController; path: string } | undefined;
	function filesSlug(controller: CompanyController): string {
		return (
			surfacesOf(controller)?.state.surfaces.find(
				(surface) => surface.archetype === "ops" && inferSurfaceKind(surface) === "files",
			)?.slug ?? "files"
		);
	}
	function openInFiles(path: string): void {
		const controller = company;
		if (!controller) return;
		if (settings) closeSettings(false);
		const shown = filesShown?.owner === controller ? filesShown.browser : undefined;
		shown?.reveal(path);
		filesPending = shown?.opened || surfacesDisabledOf(controller) ? undefined : { owner: controller, path };
		navigate({
			name: "company",
			profileId: controller.profile.profileId,
			section: "surface",
			id: filesSlug(controller),
		});
	}
	function openSettings(tab?: SettingsTab): void {
		if (settings || feedback || !auth.userId) return;
		closeFriends(false);
		const mount = (Loaded: typeof SettingsView) => {
			if (disposed || settings || feedback || !auth.userId) return;
			settings = new Loaded(
				api,
				auth,
				hub,
				profiles,
				company?.store.get().accessLost ? undefined : company,
				() => closeSettings(),
				companyRemovedHandler(),
				tab,
				openFriends,
				executionNotices,
			);
			frame.inert = true;
			root.append(settings.el);
			notices?.reveal();
			settings.focus();
		};
		const cached = settingsViewModule.get();
		if (cached) mount(cached.SettingsView);
		else void settingsViewModule.load().then((mod) => mount(mod.SettingsView));
	}
	/** Shows a Company File page beside the open chat. Again on what is shown already, it reads it again. */
	function openSide(target: SidePanelTarget): void {
		if (!conversation?.el.isConnected || !sidePanel) return;
		const shown = conversation.beside;
		if (shown instanceof AppPanel && sameTarget(shown.target, target)) {
			void shown.reload(true);
			shown.focus();
			return;
		}
		conversation.showBeside(sidePanel(target));
	}
	/** Opens an agent's app as a page of its own (`#/c/{id}/a/{name}`), or a concept of the company's product in the
	 * Concepts viewer (`#/c/{id}/concepts/{name}`); shown already, it reads it again. */
	function openApp(name: string): void {
		const controller = company;
		if (!controller) return;
		const route = currentRoute();
		if (isConcept(controller, name)) {
			if (
				conceptsView &&
				route.name === "company" &&
				route.profileId === controller.profile.profileId &&
				route.section === "concepts" &&
				conceptsView.selected === name
			) {
				conceptsView.reload();
				return;
			}
			navigate({ name: "company", profileId: controller.profile.profileId, section: "concepts", id: name });
			return;
		}
		if (
			appPage &&
			route.name === "company" &&
			route.profileId === controller.profile.profileId &&
			route.section === "app" &&
			route.id === name
		) {
			void appPage.reload(true);
			appPage.focus();
			return;
		}
		navigate({ name: "company", profileId: controller.profile.profileId, section: "app", id: name });
	}
	/** Whether the open company's app `name` is a concept of its product, as its apps were last read. */
	function isConcept(controller: CompanyController, name: string): boolean {
		return companyConcepts(controller.store.get().apps ?? []).some((app) => app.name === name);
	}
	function onFolderLink(event: MouseEvent): void {
		const page = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-open-page]") : null;
		if (page?.dataset.openPage && company && !event.defaultPrevented) {
			event.preventDefault();
			const profileId = company.profile.profileId;
			wantDataList(profileId, page.dataset.openAt);
			navigate({ name: "company", profileId, section: "interface", id: page.dataset.openPage });
			return;
		}
		const app = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-app-name]") : null;
		if (app?.dataset.appName && !event.defaultPrevented) {
			event.preventDefault();
			openApp(app.dataset.appName);
			return;
		}
		const surfaceTarget =
			event.target instanceof Element ? event.target.closest<HTMLElement>("[data-surface-slug]") : null;
		if (surfaceTarget?.dataset.surfaceSlug && company && !event.defaultPrevented) {
			event.preventDefault();
			const slug = surfaceTarget.dataset.surfaceSlug;
			const tab = surfaceTarget.dataset.surfaceTab;
			if (tab) surfacesOf(company)?.requestStudioTab(slug, tab);
			if (settings) closeSettings(false);
			if (surfaceView?.company === company && surfaceView.view.slug === slug && main.contains(surfaceView.view.el)) {
				surfaceView.view.update();
			} else {
				const before = location.hash;
				navigate({ name: "company", profileId: company.profile.profileId, section: "surface", id: slug });
				if (location.hash === before) render();
			}
			return;
		}
		// A link to the page of the app that is already open (its icon in the rail) leads nowhere new, and the app's page
		// has no Reload of its own: an ordinary press on it reads the app again, which also lets it ask again (§5). A
		// modified click stays the link's own (a new tab), and a link to any other place goes there by itself.
		const here = event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-href]") : null;
		if (here && !event.defaultPrevented && appPage && here.getAttribute("data-href") === location.hash) {
			const route = currentRoute();
			const ordinary = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
			if (ordinary && route.name === "company" && route.section === "app" && route.id) {
				event.preventDefault();
				openApp(route.id);
				return;
			}
		}
		const link = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-folder-path]") : null;
		const path = link?.dataset.folderPath;
		if (path === undefined || event.defaultPrevented) return;
		event.preventDefault();
		const fromConversation = conversation !== undefined && main.contains(link);
		// An HTML page in an agent's message opens beside the chat, live.
		if (fromConversation && conversation?.el.isConnected && sidePanel && /\.html?$/i.test(path)) {
			openSide({ kind: "page", path });
			return;
		}
		openInFiles(path);
	}
	root.addEventListener("click", onFolderLink);
	installSearchShortcut();
	// An app's card in a message names it by its folder; once the company's apps are read it shows the app as the drawer
	// does (its emblem in its colour there, views/shell.ts `appLook`) and what it is about in one line, whole on a
	// hover (ui/markdown.ts draws the card plain, as it has no company). The card a note from an app opens with keeps
	// what the note is about as its line, and takes the app's own name as its title.
	// A question card's option that previews an app gets the app's cover, or its emblem and title, the same way: in a
	// thread, in an app's page and in the Concepts viewer's dock, all on this page, and without redrawing the card, so
	// a pick or an answer being typed stays (ui/interaction-card.ts refreshAppPreviews; review r1 of #1763, F1).
	const APP_CARD_SELECTOR = ".app-card[data-app-name], .surface-card[data-surface-slug], [data-preview-app]";
	const pendingCardRoots = new Set<Element>();
	let observedCardTarget: Element | undefined;
	const isDirectAppCard = (node: Element): boolean =>
		(node.classList.contains("app-card") && node.hasAttribute("data-app-name")) ||
		(node.classList.contains("surface-card") && node.hasAttribute("data-surface-slug")) ||
		node.hasAttribute("data-preview-app");
	const collectDecoratableRoots = (records: readonly MutationRecord[]): boolean => {
		let found = false;
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (!(node instanceof Element)) continue;
				if (isDirectAppCard(node)) {
					pendingCardRoots.add(node);
					found = true;
					continue;
				}
				// WHY: Skip leaf streaming nodes in O(1) instead of running DOM selector scans across the tree.
				if (node.childElementCount === 0) continue;
				if (node.querySelector(APP_CARD_SELECTOR) !== null) {
					pendingCardRoots.add(node);
					found = true;
				}
			}
		}
		return found;
	};
	const decorateCardElement = (
		card: HTMLElement,
		activeCompany: CompanyController,
		byName: Map<string, CompanyApp>,
	): void => {
		const app = card.dataset.appName ? byName.get(card.dataset.appName) : undefined;
		const look = app && appLook(activeCompany, app);
		if (!app?.manifest || !look) return;
		const about = app.manifest.about ?? "";
		const shown = JSON.stringify([look.key, about, app.manifest.name]);
		if (card.dataset.shown === shown) return;
		card.dataset.shown = shown;
		card.querySelector(".app-card-emblem")?.replaceChildren(look.emblem());
		if (look.colour) card.style.setProperty("--app-colour", look.colour);
		else card.style.removeProperty("--app-colour");
		if (card.classList.contains("is-note")) {
			const title = card.querySelector<HTMLElement>(".app-card-title");
			if (title) title.textContent = app.manifest.name;
			return;
		}
		const note = card.querySelector<HTMLElement>(".app-card-note");
		if (!note) return;
		note.textContent = about || t("App");
		if (about) note.title = about;
		else note.removeAttribute("title");
	};
	const decorateAppCards = (roots?: readonly Element[]) => {
		const activeCompany = company;
		if (!activeCompany) return;
		const targets = roots ?? (observedCardTarget ? [observedCardTarget] : []);
		if (!targets.length) return;
		const surfaces = surfacesOf(activeCompany);
		if (surfaces?.state.surfaces.length) {
			const bySlug = surfacesBySlug(surfaces);
			for (const target of targets) {
				if (!target.isConnected) continue;
				if (
					target instanceof HTMLElement &&
					target.classList.contains("surface-card") &&
					target.dataset.surfaceSlug
				) {
					decorateSurfaceFigure(target, surfaces, bySlug);
					continue;
				}
				for (const card of target.querySelectorAll<HTMLElement>(".surface-card[data-surface-slug]")) {
					decorateSurfaceFigure(card, surfaces, bySlug);
				}
			}
		}
		const apps = activeCompany.store.get().apps;
		if (!apps?.length) return;
		const byName = appsByName(apps);
		const reader = cardImages.get(activeCompany);
		for (const target of targets) {
			if (!target.isConnected) continue;
			refreshAppPreviews(target, (name) => cardAppOf(apps, name), reader);
			if (target instanceof HTMLElement && target.classList.contains("app-card") && target.dataset.appName) {
				decorateCardElement(target, activeCompany, byName);
				continue;
			}
			for (const card of target.querySelectorAll<HTMLElement>(".app-card[data-app-name]")) {
				decorateCardElement(card, activeCompany, byName);
			}
		}
	};
	const hasDecoratableTargets = (): boolean =>
		Boolean(
			company &&
				((company.store.get().apps?.length ?? 0) > 0 || (surfacesOf(company)?.state.surfaces.length ?? 0) > 0),
		);
	let decorating = false;
	const appCardObserver = new MutationObserver((records) => {
		if (decorating || !hasDecoratableTargets() || !collectDecoratableRoots(records)) return;
		decorating = true;
		queueMicrotask(() => {
			try {
				const roots = [...pendingCardRoots];
				pendingCardRoots.clear();
				if (!disposed && roots.length) decorateAppCards(roots);
			} finally {
				appCardObserver.takeRecords();
				decorating = false;
			}
		});
	});
	const activeCardTarget = (): Element | undefined => {
		const route = currentRoute();
		if (route.name !== "company") return undefined;
		if (route.section === "chat" && conversation?.el.isConnected) return conversation.el;
		if (route.section === "app" && appPage?.el.isConnected) return appPage.el;
		if (route.section === "concepts" && conceptsView?.el.isConnected) return conceptsView.el;
		return undefined;
	};
	const syncAppCardObserver = (target: Element | undefined = activeCardTarget()): void => {
		const nextTarget =
			!disposed && company && !company.store.get().accessLost && hasDecoratableTargets() ? target : undefined;
		if (nextTarget === observedCardTarget) return;
		appCardObserver.disconnect();
		pendingCardRoots.clear();
		observedCardTarget = nextTarget;
		if (nextTarget) appCardObserver.observe(nextTarget, { childList: true, subtree: true });
	};
	let routeRevision = 0;
	let accountRevision = 0;
	holdWebsiteIdea();
	// Taken from the page hash once at startup and on every route change; the
	// broker appends it after the provider consent (see cloud/connectors.ts).
	let connectorReturn = takeConnectorReturn();
	// "Continue with ChatGPT": OpenAI's callback sends the member back with a one-time confirmation.
	let planReturn = takeChatGptPlanReturn();
	// Stripe's card page sends the member back to the account page.
	let checkoutReturn = takeGoodWillReturn();
	let accountUserId: string | undefined;
	let navigationOpen = false;
	let navigationFocus: "rail" | "toggle" | undefined;
	/** Why the app could not start, when reading the cloud session failed. */
	let startError: HTMLElement | undefined;
	let pendingCompany:
		| { profileId: string; revision: number; promise: Promise<CompanyController | undefined> }
		| undefined;
	let resolvingRoute: number | undefined;
	let routeError: string | undefined;
	function captureRoute(): () => boolean {
		const revision = routeRevision,
			userId = auth.userId,
			hash = location.hash;
		return () => !disposed && revision === routeRevision && userId === auth.userId && hash === location.hash;
	}
	function setNavigationOpen(open: boolean, restoreFocus = true): void {
		navigationFocus = restoreFocus ? (open ? "rail" : navigationOpen ? "toggle" : undefined) : undefined;
		navigationOpen = open;
		frame.classList.toggle("navigation-open", open);
		syncNavigation();
		render();
	}
	function syncNavigation(): void {
		main.inert = navigationOpen && isPhoneLayout();
	}
	function onEscape(event: KeyboardEvent): void {
		if (
			event.key === "Escape" &&
			!event.isComposing &&
			navigationOpen &&
			!settings &&
			!feedback &&
			!event.defaultPrevented
		) {
			setNavigationOpen(false);
		}
	}
	function onRouteChange(): void {
		holdWebsiteIdea();
		connectorReturn = takeConnectorReturn() ?? connectorReturn;
		planReturn = takeChatGptPlanReturn() ?? planReturn;
		checkoutReturn = takeGoodWillReturn() ?? checkoutReturn;
		closeSettings(false);
		closeFeedback(false);
		// An accepted company invitation opens the company: the Friends window gives way to it.
		closeFriends(false);
		settingsAfterHome = undefined;
		routeRevision++;
		resolvingRoute = undefined;
		routeError = undefined;
		homeReason = undefined;
		setNavigationOpen(false, false);
	}
	window.addEventListener("keydown", onEscape);
	window.addEventListener("resize", syncNavigation);

	const WARM_COMPANIES_MAX = 3;
	const WARM_SURFACES_MAX = 3;
	const warmCompanies = new Map<string, CompanyController>();
	const warmSurfaces = new Map<string, SurfaceView>();
	let companyActiveAbort: AbortController | undefined;
	let company: CompanyController | undefined;
	let notices: ExecutionNotices | undefined;
	let shownAccountAlerts = 0;
	/** Which of the open company's two pages are on (Interfaces C6a), read with its folder. */
	let interfacePages: CompanyInterfacePages | undefined;
	let companyDatabases: CompanyDatabases | undefined;
	/** What the open company's pages read from its folder, its tables and files, followed there (Interfaces step I7). */
	let interfaceFolder: CompanyInterfaceFolder | undefined;
	let surfaceFolderHints: { close(): Promise<void> } | undefined;
	/** The agents' interface apps in the open company's folder, followed there (RUNTIME-INTERFACE-APPS.md §4). */
	let companyApps: CompanyApps | undefined;
	/** The agents' next runs for the rail's line under each name (app/agent-notes.ts), while the company is open. */
	let agentNotes: AgentNotes | undefined;
	/** Makes the side panel of a Company File page for the open company: set while one is drawn. */
	let sidePanel: ((target: SidePanelTarget) => AppPanel) | undefined;
	/** The agent's app on its own page (`#/c/{id}/a/{name}`), while that route shows. */
	let appPage: AppPanel | undefined;
	/** The open company's last conversation, where an app's page leads back to. */
	let appReturn: string | undefined;
	/** The company's concepts, full screen (`#/c/{id}/concepts`), while that route shows. */
	let conceptsView: ConceptsView | undefined;
	/** The company whose sites were read for the apps drawer. */
	let sitesRead: CompanyController | undefined;
	let sitesOncePublished: ReturnType<typeof readSitesOncePublished> | undefined;
	/** One of the company's websites, live with its numbers (`#/c/{id}/site/{slug}`), kept while that route shows. */
	let siteView:
		| {
				readonly company: CompanyController;
				readonly slug: string;
				readonly view: SiteView;
				readonly el: HTMLElement;
		  }
		| undefined;
	/** The company's What's new page (`#/c/{id}/whats-new`), kept while that route shows, and the company read for the
	 * apps drawer's entry. */
	let whatsNewPage:
		| { readonly company: CompanyController; readonly view: WhatsNewView; readonly el: HTMLElement }
		| undefined;
	let newProgramPage: { readonly company: CompanyController; readonly view: NewProgramPage } | undefined;
	let surfaceView: { readonly company: CompanyController; readonly view: SurfaceView } | undefined;
	const pendingSurfaceDisposals = new Set<() => void>();
	const flushPendingSurfaceDisposals = (): void => {
		for (const run of [...pendingSurfaceDisposals]) run();
	};
	const deferSurfaceDisposal = (view: SurfaceView): void => {
		view.deactivate();
		let cancel: (() => void) | undefined;
		const finish = () => {
			if (!pendingSurfaceDisposals.delete(finish)) return;
			cancel?.();
			cancel = undefined;
			view.dispose();
		};
		pendingSurfaceDisposals.add(finish);
		cancel = deferOffFrame(finish);
	};
	const disposeWarmSurfaces = (): void => {
		for (const view of warmSurfaces.values()) view.dispose();
		warmSurfaces.clear();
	};
	const stopWarmCompany = (profileId: string): void => {
		const cached = warmCompanies.get(profileId);
		if (!cached) return;
		warmCompanies.delete(profileId);
		cached.stop();
	};
	const clearWarmCompanies = (): void => {
		for (const cached of warmCompanies.values()) cached.stop();
		warmCompanies.clear();
	};
	const warmCompanyFor = (profileId: string): CompanyController | undefined => {
		const cached = warmCompanies.get(profileId);
		if (!cached) return undefined;
		if (
			disposed ||
			cached.userId !== auth.userId ||
			cached.signal.aborted ||
			cached.store.get().accessLost ||
			!profiles.some((item) => item.profileId === profileId)
		) {
			stopWarmCompany(profileId);
			return undefined;
		}
		return cached;
	};
	let releasesRead: CompanyController | undefined;
	/** The open company's mail as the member reads it, for the Mailbox page (Interfaces step I5c). */
	let mail: CompanyMail | undefined;
	let computerPanels: ComputerPanelsLike | undefined;
	let conversation: ConversationView | undefined;
	/** The chat with another member on screen, and the company it is in. */
	let memberChat: { view: MemberChatView; company: CompanyController } | undefined;
	/** The agent or group chat card opened from the rail, and what an agent card asked for once its chat is on screen. */
	let agentCard: AgentDetails | GroupDetails | undefined;
	let agentPage: { agentId: string; page: AgentPage; until: number } | undefined;
	const cardImages = new WeakMap<CompanyController, ReturnType<typeof folderImageReader>>();
	// WHY: Scope folder listing SWR caches per company and authority so role changes never reuse stale listings.
	const folderListingCaches = new WeakMap<
		CompanyController,
		{ authority: string; cache: Map<string, CachedFolderListing> }
	>();
	const folderListingCacheFor = (
		controller: CompanyController,
		authority: string,
	): Map<string, CachedFolderListing> => {
		const existing = folderListingCaches.get(controller);
		if (existing && existing.authority === authority) return existing.cache;
		existing?.cache.clear();
		const created = new Map<string, CachedFolderListing>();
		folderListingCaches.set(controller, { authority, cache: created });
		return created;
	};
	/** Each company's What's new reads and writes, as the apps drawer, What's new's page and the threads' "a change is
	 * ready" cards make them: numbered as they start, one shared read out at a time for the drawer and the threads, never
	 * across a write from any of them, and the latest-started answer as the company's last read (app/release-reads.ts). */
	const releaseReads = new WeakMap<CompanyController, CompanyReleaseReads>();
	const companyReleases = (controller: CompanyController): CompanyReleaseReads => {
		let reads = releaseReads.get(controller);
		if (!reads) {
			reads = companyReleaseReads(codeReleaseCalls(cloud, controller.profile.profileId), controller.signal);
			releaseReads.set(controller, reads);
		}
		return reads;
	};
	const showReleases = (controller: CompanyController, read: CodeReleases) => {
		const newest = companyReleases(controller).last ?? read;
		const nextWhatsNew = whatsNewEntry(controller, newest);
		if (JSON.stringify(controller.store.get().whatsNew) === JSON.stringify(nextWhatsNew)) return;
		controller.store.set({ whatsNew: nextWhatsNew });
	};
	/** Each company's open questions for its app pages and Concepts viewer, read only while one is on screen. */
	const appQuestions = new WeakMap<CompanyController, OpenQuestions>();
	/** Each company's databases for its app pages: one held watch call for all of them, while the company is open. */
	const appData = new WeakMap<CompanyController, CompanyData>();
	/** Each company's platform numbers for its app pages (`qorpera/*`), while the company is open. */
	const appNumbers = new WeakMap<CompanyController, CompanyNumbers>();
	/** Notes held for the company's apps, by app, while their thread could not take them (app/app-actions.ts
	 * `HeldNote`): kept while the company is open, whichever page the member goes to meanwhile. */
	const heldNotes = new WeakMap<
		CompanyController,
		{ readonly notes: Map<string, HeldNote>; readonly back: Map<string, () => void> }
	>();
	const askAccounts = new WeakMap<CompanyController, TellAccounts>();
	/** Each company's reading of itself for its app pages that read `reading` (the map kit), while the company is open. */
	const appReading = new WeakMap<CompanyController, CompanyReading>();
	let newConversation: NewConversationView | undefined;
	let startingSession: { sessionId: string } | undefined;
	let profiles: HostedProfile[] = [];
	let teamFeedback: TeamFeedback = {};
	let accountState: AccountViewState = {};
	let accountPayments: MyGoodWillView | undefined;
	let unsubscribeCompany: (() => void) | undefined;
	let homeReason: string | undefined;
	/** A Settings tab to open once the company home has resolved: home moves on to the Co-Founder's
	 * conversation, and that route change would close Settings opened before it. */
	let settingsAfterHome: SettingsTab | undefined;

	const render = debounce(() => void draw().catch((error) => console.error("render failed:", error)), 10);

	function observeAccount(): void {
		const currentHub = hub;
		hub.store.subscribe(() => {
			if (hub !== currentHub) return;
			const hubState = currentHub.store.get();
			profiles = hubState.profiles;
			if (hubState.loaded) {
				const valid = new Set(profiles.map((item) => item.profileId));
				for (const profileId of [...warmCompanies.keys()]) {
					if (!valid.has(profileId)) stopWarmCompany(profileId);
				}
			}
			settings?.updateProfiles(profiles);
			render();
		});
	}
	observeAccount();
	auth.store.subscribe(() => {
		const userId = auth.userId;
		if (userId !== accountUserId) {
			const switchingAccount = accountUserId !== undefined;
			// A return from Stripe belongs to the member who paid, not to whoever signs in next;
			// the first sign-in of the page (back from Stripe) keeps it.
			if (switchingAccount) checkoutReturn = undefined;
			// So does a ChatGPT plan sign-in: it is finished only for the member who started it.
			if (switchingAccount && planReturn) {
				planReturn = undefined;
				forgetChatGptPlanSignIn();
			}
			closeSettings(false);
			closeFeedback(false);
			closeFriends(false);
			accountUserId = userId;
			online.mark();
			pictures.reset();
			logos.setAccount(userId, switchingAccount);
			wordmarks.setAccount(userId, switchingAccount);
			accountRevision++;
			routeRevision++;
			teardownCompany(true);
			teardownFounding();
			hub.dispose();
			profiles = [];
			accountState = {};
			accountPayments?.dispose();
			accountPayments = undefined;
			resolvingRoute = undefined;
			routeError = undefined;
			navigationOpen = false;
			navigationFocus = undefined;
			syncNavigation();
			frame.classList.remove("navigation-open");
			topbar.replaceChildren();
			rail.replaceChildren();
			main.replaceChildren();
			hub = new HubController(api, userId);
			observeAccount();
			if (userId) void hub.refresh();
		}
		render();
	});
	window.addEventListener("hashchange", onRouteChange);

	const wordmarkFolder = (profile: HostedProfile, userId: string, signal: AbortSignal) =>
		new WebCompanyFiles(
			cloud,
			profile,
			userId,
			"viewer",
			signal,
			() => {
				if (disposed || auth.userId !== userId) throw new Error(t("Company access changed."));
			},
			false,
		).folder();

	function shellContext(user: User | null, route: Route): ShellContext {
		return {
			profiles,
			user,
			route,
			auth,
			openSettings,
			openFeedback,
			openFriends,
			invites: api,
			invitations: hub.store.get().invitations.length,
			accountAlerts: notices?.count ?? 0,
			prefetchCompanyWordmarks: (list) => {
				const userId = auth.userId;
				if (!userId || disposed) return;
				const currentProfileId = company?.profile.profileId;
				const targets = list
					.filter((profile) => profile.profileId !== currentProfileId)
					.map((profile) => ({
						profileId: profile.profileId,
						createFolder: (signal: AbortSignal) => wordmarkFolder(profile, userId, signal),
					}));
				if (targets.length > 0) void wordmarks.prefetchMany(targets);
			},
			...(route.name === "company" && company && !company.store.get().accessLost
				? {
						navigation: { open: navigationOpen, toggle: () => setNavigationOpen(!navigationOpen) },
						sidebar: {
							hidden: railLayout.hidden,
							toggle: () => {
								railLayout.toggleHidden();
								syncRailReopen();
								render();
							},
						},
					}
				: {}),
		};
	}

	let shownLocale = presentationLocale();
	/** A new language redraws everything with text in it, Settings included:
	 * it reopens on the same tab with the focus back on the language. */
	function onLanguage(): void {
		applyLanguage();
		if (disposed || presentationLocale() === shownLocale) return;
		shownLocale = presentationLocale();
		rail.setAttribute("aria-label", t("Company navigation"));
		backdrop.setAttribute("aria-label", t("Close company navigation"));
		reopenRailBtn.setAttribute("aria-label", t("Show sidebar"));
		reopenRailBtn.title = t("Show sidebar");
		railLayout.relabel();
		const tab = settings?.tab;
		closeSettings(false);
		redrawScreens();
		if (!tab) return;
		openSettings(tab);
		settings?.el.querySelector<HTMLElement>(".preference-picker-button")?.focus();
	}

	/** Rebuild the route's screens from the stores, which keep drafts,
	 * attachments and edits. A new-conversation draft lives only in its screen,
	 * so that stays until it is left. */
	function redrawScreens(): void {
		if (disposed) return;
		// The founding table's page and the new-company box keep their text between refreshes; a new language
		// builds them again.
		relabelNewCompany(hub);
		if (founding) {
			const mod = foundingModule.get();
			if (mod)
				founding = {
					controller: founding.controller,
					view: new mod.FoundingView(founding.controller, founding.view.drafts()),
				};
		}
		const oldNotices = notices;
		notices = undefined;
		shownAccountAlerts = 0;
		oldNotices?.dispose();
		executionNotices.replaceChildren();
		conversation?.dispose();
		conversation = undefined;
		memberChat?.view.dispose();
		memberChat = undefined;
		appPage?.dispose();
		appPage = undefined;
		conceptsView?.dispose();
		conceptsView = undefined;
		siteView?.view.dispose();
		siteView = undefined;
		whatsNewPage?.view.dispose();
		whatsNewPage = undefined;
		newProgramPage?.view.dispose();
		newProgramPage = undefined;
		surfaceView?.view.dispose();
		surfaceView = undefined;
		disposeWarmSurfaces();
		flushPendingSurfaceDisposals();
		if (newConversation && !newConversation.hasInput) {
			newConversation.dispose();
			newConversation = undefined;
		}
		render();
	}

	function disposeCompanyViews(): void {
		interfaceViewModule.get()?.disposeInterface(main);
		const oldNotices = notices;
		notices = undefined;
		shownAccountAlerts = 0;
		oldNotices?.dispose();
		interfacePages?.dispose();
		interfacePages = undefined;
		companyDatabases?.dispose();
		companyDatabases = undefined;
		interfaceFolder?.dispose();
		interfaceFolder = undefined;
		void surfaceFolderHints?.close();
		surfaceFolderHints = undefined;
		companyApps?.dispose();
		companyApps = undefined;
		agentNotes?.dispose();
		agentNotes = undefined;
		sidePanel = undefined;
		appPage?.dispose();
		for (const el of [
			appPage?.el,
			siteView?.el,
			whatsNewPage?.el,
			newProgramPage?.view.el,
			surfaceView?.view.el,
			conceptsView?.el,
			conversation?.el,
			memberChat?.view.el,
			newConversation?.el,
		]) {
			if (el?.parentElement === main) el.remove();
		}
		appPage = undefined;
		appReturn = undefined;
		siteView?.view.dispose();
		siteView = undefined;
		whatsNewPage?.view.dispose();
		whatsNewPage = undefined;
		newProgramPage?.view.dispose();
		newProgramPage = undefined;
		surfaceView?.view.dispose();
		surfaceView = undefined;
		disposeWarmSurfaces();
		flushPendingSurfaceDisposals();
		conceptsView?.dispose();
		conceptsView = undefined;
		mail?.dispose();
		mail = undefined;
		agentCard?.dispose();
		agentCard = undefined;
		conversation?.dispose();
		conversation = undefined;
		memberChat?.view.dispose();
		memberChat = undefined;
		newConversation?.dispose();
		newConversation = undefined;
		computerPanels?.dispose();
		computerPanels = undefined;
	}

	function detachCompany(park: boolean): void {
		const active = company;
		syncAppCardObserver(undefined);
		settingsAfterHome = undefined;
		clearShellCompanyState(active);
		disposeCompanyViews();
		executionNotices.replaceChildren();
		unsubscribeCompany?.();
		unsubscribeCompany = undefined;
		companyActiveAbort?.abort();
		companyActiveAbort = undefined;
		pendingCompany = undefined;
		company = undefined;
		sitesRead = undefined;
		sitesOncePublished = undefined;
		releasesRead = undefined;
		showWaitingInTitle(0);
		agentPage = undefined;
		homeReason = undefined;
		teamFeedback = {};
		if (!active) return;
		const state = active.store.get();
		const cacheable =
			park &&
			!disposed &&
			!active.signal.aborted &&
			!state.accessLost &&
			!state.loading &&
			active.userId === auth.userId &&
			profiles.some((item) => item.profileId === active.profile.profileId);
		if (cacheable) {
			active.suspend();
			surfacesStoreOf(active)?.suspend();
			appQuestions.get(active)?.pause();
			appData.get(active)?.pause();
			appNumbers.get(active)?.pause();
			warmCompanies.delete(active.profile.profileId);
			warmCompanies.set(active.profile.profileId, active);
			while (warmCompanies.size > WARM_COMPANIES_MAX) {
				const oldestKey = warmCompanies.keys().next().value;
				if (!oldestKey) break;
				stopWarmCompany(oldestKey);
			}
			return;
		}
		active.stop();
	}

	function parkCompany(): void {
		detachCompany(true);
	}

	function teardownCompany(clearWarm = false): void {
		detachCompany(false);
		if (clearWarm) clearWarmCompanies();
	}

	function companyRemovedHandler(): (profileId: string) => void {
		const currentHub = hub;
		return (profileId) => {
			if (disposed || hub !== currentHub) return;
			logos.forget(profileId);
			wordmarks.forget(profileId);
			stopWarmCompany(profileId);
			void currentHub.companyRemoved(profileId);
			const route = currentRoute();
			if (route.name === "company" && route.profileId === profileId) {
				closeSettings(false);
				teardownCompany();
				navigate({ name: "hub" });
			}
		};
	}

	function createComputerPanels(
		controller: CompanyController,
		profile: HostedProfile,
		userId: string,
	): ComputerPanelsLike {
		return new LazyComputerPanels(
			(WebComputer) =>
				new WebComputer(cloud, profile, userId, controller.signal, () => {
					if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
						throw new Error(t("Company access is unavailable."));
				}),
			controller.signal,
			{
				hints: (listener) => controller.onInvalidate(listener),
				// The machine's clock and backdrop follow the company's time zone (20260930739000).
				timeZone: () => controller.store.get().team?.timeZone,
				// The company's apps a member may open on a computer (20260930758000): each by its name, its entry page's
				// folder when the page is its index.html (the helper serves the folder), else the page itself.
				apps: () =>
					controller.store
						.get()
						.apps?.filter((app) => app.manifest !== null && app.manifest.kit !== "program")
						.map((app) => ({
							name: app.manifest?.name ?? app.name,
							path:
								app.manifest === null || app.manifest.entry === "index.html"
									? app.path
									: `${app.path}/${app.manifest.entry}`,
						})),
				// Open's "A file…": the company folder's own browser in choose mode, read as the member.
				chooseFile: (signal) => {
					const role = controller.store.get().team?.role;
					if (!role) return Promise.resolve(null);
					return lazyOpsModule.load().then(({ companyFolderChoose: { chooseInCompanyFolder } }) =>
						chooseInCompanyFolder(
							new WebCompanyFiles(cloud, profile, userId, role, controller.signal, () => {
								if (
									disposed ||
									company !== controller ||
									auth.userId !== userId ||
									controller.store.get().accessLost
								)
									throw new Error(t("Company access changed."));
							}),
							signal,
						),
					);
				},
			},
		);
	}

	async function ensureCompany(profileId: string): Promise<CompanyController | undefined> {
		if (company?.profile.profileId === profileId) {
			if (!company.signal.aborted || company.store.get().accessLost) return company;
			teardownCompany();
		}
		const warm = warmCompanyFor(profileId);
		if (warm) {
			warmCompanies.delete(profileId);
			parkCompany();
			if (!warm.signal.aborted && !warm.store.get().accessLost) {
				const latest = profiles.find((item) => item.profileId === profileId);
				if (latest && JSON.stringify(latest) !== JSON.stringify(warm.profile)) {
					warm.store.set({ profile: latest });
				}
				company = warm;
				companyActiveAbort = new AbortController();
				computerPanels = createComputerPanels(warm, warm.profile, warm.userId);
				unsubscribeCompany = warm.store.subscribe(() => render());
				warm.resume();
				surfacesStoreOf(warm)?.resume();
				appQuestions.get(warm)?.resume();
				appData.get(warm)?.resume();
				appNumbers.get(warm)?.resume();
				logos.resumeIdentity(profileId);
				return warm;
			}
			warm.stop();
		}
		if (pendingCompany?.profileId === profileId && pendingCompany.revision === routeRevision) {
			if (!profiles.some((item) => item.profileId === profileId)) return pendingCompany.promise;
			pendingCompany = undefined;
		}
		parkCompany();
		const current = captureRoute();
		const currentHub = hub;
		if (!profiles.find((item) => item.profileId === profileId) && currentHub.store.get().connectionLost)
			return undefined;
		let settled = false;
		let clearOnFinish = true;
		let pending: { profileId: string; revision: number; promise: Promise<CompanyController | undefined> } | undefined;
		const promise = (async () => {
			try {
				let profile = profiles.find((item) => item.profileId === profileId);
				if (!profile) {
					// WHY: Opening a company only needs the profile list; do not block boot on invitations or founding tables.
					await currentHub.ensureProfiles();
					if (!current()) return undefined;
					profile = currentHub.store.get().profiles.find((item) => item.profileId === profileId);
				}
				const userId = auth.userId;
				if (!current() || !profile || !userId) {
					if (current() && userId && !currentHub.store.get().connectionLost) clearOnFinish = false;
					return undefined;
				}
				const controller: CompanyController = new CompanyController(
					api,
					profile,
					userId,
					(sessionId, clientInputId, text, signal, files, executionSponsor, roomTarget) =>
						createWebSessionInputWriter(
							cloud,
							userId,
							controller.signal,
							(target) => {
								const route = currentRoute();
								if (
									disposed ||
									company !== controller ||
									auth.userId !== userId ||
									route.name !== "company" ||
									route.profileId !== profile.profileId ||
									!(
										(route.section === "chat" && route.id === target) ||
										(route.section === "new" && startingSession?.sessionId === target) ||
										// A note the member sent from elsewhere in the company (an app's page, the Mailbox, Generate icon
										// in the apps drawer), on its way: their press, which named the agent, stands for the thread on
										// screen (CompanyController.sendNote).
										controller.noteOnItsWay(target)
									)
								)
									throw new Error(t("Company access is unavailable."));
								controller.assertCanSend(target);
								const observedRoom = controller.roomTargetFor(target);
								if (
									observedRoom?.roomId !== roomTarget?.roomId ||
									observedRoom?.environmentId !== roomTarget?.environmentId
								)
									throw new Error(t("The conversation destination changed. Refresh before sending."));
							},
							profile.profileId,
						)(sessionId, clientInputId, text, signal, files, executionSponsor, roomTarget),
					online,
				);
				company = controller;
				companyActiveAbort = new AbortController();
				const localDev =
					typeof location !== "undefined" &&
					(location.hostname === "127.0.0.1" || location.hostname === "localhost");
				const sandboxParam =
					typeof location !== "undefined" && new URLSearchParams(location.search).get("sandbox") === "1";
				const loadSurfaceCloudFiles = async (
					surface: SurfaceSummary,
					signal: AbortSignal,
				): Promise<SurfaceFolderContents | undefined> => {
					const team = controller.store.get().team;
					if (!team) return undefined;
					const roots = surfaceFolderRoots(surface);
					if (!roots.length) return { files: {}, binaries: {} };
					const readScope = new AbortController();
					const forwardAbort = () => readScope.abort();
					if (controller.signal.aborted || signal.aborted) {
						readScope.abort();
					} else {
						controller.signal.addEventListener("abort", forwardAbort, { once: true });
						signal.addEventListener("abort", forwardAbort, { once: true });
					}
					try {
						const folder = new WebCompanyFiles(
							cloud,
							controller.profile,
							controller.userId,
							team.role,
							readScope.signal,
							() => {
								if (
									disposed ||
									company !== controller ||
									auth.userId !== userId ||
									controller.store.get().accessLost
								)
									throw new Error(t("Company access changed."));
							},
							team.capabilities.write,
						).folder();
						return await readSurfaceFolderFiles(folder, roots, readScope.signal);
					} finally {
						controller.signal.removeEventListener("abort", forwardAbort);
						signal.removeEventListener("abort", forwardAbort);
					}
				};
				const readSurfaceCloudBinary = async (file: StudioBinaryRef, signal: AbortSignal): Promise<Uint8Array> => {
					const team = controller.store.get().team;
					const current = () => {
						if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
							throw new Error(t("Company access changed."));
					};
					current();
					if (!team) throw new Error(t("Company access changed."));
					const readSignal = AbortSignal.any([controller.signal, signal]);
					const folder = new WebCompanyFiles(
						cloud,
						controller.profile,
						controller.userId,
						team.role,
						readSignal,
						current,
						team.capabilities.write,
					).folder();
					const bytes = await folder.readFile(
						{ ...file, executable: (file as { readonly executable?: unknown }).executable === true },
						readSignal,
						file.bytes,
						{ cached: true },
					);
					current();
					return bytes;
				};
				const withLegacyRoutine = async (
					signal: AbortSignal,
					run: (
						routines: ReturnType<typeof createWebRoutines>,
						scopeSignal: AbortSignal,
						current: () => void,
					) => Promise<void>,
				): Promise<void> => {
					await withAbortScopes([controller.signal, signal], async (scopeSignal) => {
						const current = () => {
							scopeSignal.throwIfAborted();
							if (
								disposed ||
								company !== controller ||
								auth.userId !== userId ||
								controller.store.get().accessLost
							)
								throw new Error(t("Company access changed."));
							if (!controller.store.get().team?.capabilities.authorize)
								throw new Error(t("Only founders and admins can change this."));
						};
						current();
						const routines = createWebRoutines(cloud, controller.profile, scopeSignal, current, () => {
							current();
							const role = controller.store.get().team?.role;
							if (!role) throw new Error(t("Company access changed."));
							return new WebCompanyFiles(
								cloud,
								controller.profile,
								controller.userId,
								role,
								scopeSignal,
								current,
							).folder();
						});
						await run(routines, scopeSignal, current);
					});
				};
				const surfaces = new SurfacesStore({
					companyId: profile.profileId,
					companyName: profile.profileName,
					localInteractive: localDev,
					...(sandboxParam ? { sandboxMode: true } : {}),
					client: new CloudSurfacesClient(cloud.supabase),
					synthesize: () => ({
						companyId: profile.profileId,
						sites: controller.store.get().siteList ?? [],
						pages: companyInterfaces(controller).map((entry) => entry.name),
					}),
					migration: () => {
						const state = controller.store.get();
						const cofounderId = controller.cofounderId();
						return {
							companyId: profile.profileId,
							agents: state.staff
								.filter((agent) => agent.employmentStatus === "active" && agent.id !== cofounderId)
								.map((agent) => ({
									id: agent.id,
									handle: agent.displayName,
									name: agent.displayName,
									role: agent.role,
								})),
							boards: (state.apps ?? [])
								.filter((app) => app.manifest?.posted === true && !app.manifest.concept)
								.map((app) => ({
									name: app.name,
									title: app.manifest?.name ?? app.name,
									kit: app.manifest?.kit ?? null,
								})),
						};
					},
					signal: controller.signal,
					unavailableMessage: t("Surfaces aren't enabled for this company yet."),
					onNavigateSurface: (slug) =>
						navigate({ name: "company", profileId: profile.profileId, section: "surface", id: slug }),
					realtimeLive: () => controller.store.get().realtime === "connected",
					memberName: (memberId) => {
						const found = controller.store.get().team?.members.find((member) => member.userId === memberId);
						return found?.displayName || found?.email;
					},
					teammates: () =>
						(controller.store.get().team?.members ?? [])
							.filter((member) => member.userId !== controller.userId)
							.map((member) => ({ userId: member.userId, name: member.displayName || member.email })),
					peopleAtSurface: (slug) => controller.peopleByPlace().get(`surface:${slug.toLowerCase()}`) ?? [],
					userId,
					publishers: () =>
						(controller.store.get().team?.members ?? [])
							.filter((member) => member.role !== "viewer")
							.map((member) => ({ userId: member.userId, name: member.displayName || member.email })),
					loadCloudFiles: loadSurfaceCloudFiles,
					readCloudBinary: readSurfaceCloudBinary,
					renameLegacyRoutine: (routineId, clientRoutineId, title, signal) =>
						withLegacyRoutine(signal, (routines, scopeSignal, current) =>
							routines.rename(routineId, clientRoutineId, title, {
								userId: controller.userId,
								accounts: async () =>
									(
										await createWebNativeSubscription(
											cloud,
											controller.profile.profileId,
											controller.userId,
											scopeSignal,
											current,
										).listConnections()
									).connections,
							}),
						),
					deleteLegacyRoutine: (routineId, clientRoutineId, signal) =>
						withLegacyRoutine(signal, (routines) => routines.delete(routineId, clientRoutineId)),
					uploadImage: async (surfaceId, clientInputId, file, signal) => {
						const current = () => {
							signal.throwIfAborted();
							if (
								disposed ||
								company !== controller ||
								auth.userId !== userId ||
								controller.store.get().accessLost
							)
								throw new Error(t("Company access changed."));
						};
						const bytes = new Uint8Array(await file.arrayBuffer());
						current();
						if (bytes.length !== file.size) throw new Error(t("The selected image changed."));
						const saved = await createWebSessionAttachments(cloud, userId, signal, current).uploadSurface(
							surfaceId,
							clientInputId,
							bytes,
							file.type,
							signal,
						);
						return { sha256: saved.sha256, bytes: saved.bytes, mediaType: saved.mediaType };
					},
					readImage: async (sessionId, clientInputId, image, signal) => {
						const current = () => {
							signal.throwIfAborted();
							if (
								disposed ||
								company !== controller ||
								auth.userId !== userId ||
								controller.store.get().accessLost
							)
								throw new Error(t("Company access changed."));
						};
						const bytes = await createWebSessionAttachments(cloud, userId, signal, current).readSurface(
							sessionId,
							clientInputId,
							{ sha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType },
							signal,
						);
						current();
						return new Blob([new Uint8Array(bytes)], { type: image.mediaType });
					},
				});
				attachSurfaces(controller, surfaces);
				// WHY: Guard store listeners against parked warm companies so background updates never render an inactive company.
				surfaces.store.subscribe(() => {
					if (company === controller) render();
				});
				controller.store.subscribe(() => {
					if (company === controller) surfaces.resynthesize();
				});
				const stopSurfaceHints = controller.onInvalidate((resource) => {
					if (resource === "surfaces" || resource === "company-file") surfaces.onRealtimeHint(resource);
					if (resource === "company-file") {
						folderListingCaches.get(controller)?.cache.clear();
						invalidateShellSearchFiles(profile.profileId);
					}
				});
				controller.signal.addEventListener("abort", stopSurfaceHints, { once: true });
				void surfaces.load();
				void wordmarks.prefetch(
					profile.profileId,
					(signal) => wordmarkFolder(profile, userId, signal),
					controller.signal,
				);
				const syncIdentityFiles = () => {
					if (
						controller.signal.aborted ||
						company !== controller ||
						controller.store.get().accessLost ||
						!controller.store.get().team ||
						surfaces.state.source !== "cloud"
					) {
						return;
					}
					stopIdentitySync();
					surfaces.refreshPendingCloudFiles();
				};
				const stopIdentitySurfaces = surfaces.store.subscribe(syncIdentityFiles);
				const stopIdentityTeam = controller.store.subscribe(syncIdentityFiles);
				const stopIdentitySync = () => {
					stopIdentitySurfaces();
					stopIdentityTeam();
				};
				controller.signal.addEventListener("abort", stopIdentitySync, { once: true });
				const syncCompanyLogo = () => {
					const team = controller.store.get().team;
					if (!team || !team.capabilities.write || controller.store.get().accessLost || controller.signal.aborted)
						return;
					const current = () => {
						if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
							throw new Error(t("Company access changed."));
					};
					void logos
						.sync(
							profile.profileId,
							() => new WebCompanyFiles(cloud, profile, userId, team.role, controller.signal, current).folder(),
							controller.signal,
						)
						.catch(() => undefined);
				};
				logos.bindIdentity(profile.profileId, surfaces, controller.signal, {
					disabled: surfacesDisabledOf(controller),
					onBaseLogoChange: syncCompanyLogo,
				});
				const syncLogo = controller.store.subscribe(() => {
					const team = controller.store.get().team;
					if (!team || controller.store.get().accessLost) return;
					syncLogo();
					syncCompanyLogo();
				});
				controller.signal.addEventListener("abort", syncLogo, { once: true });
				// On a cloud from before each member's own sidebar (20260930727000), the company's sections are
				// QorperaOS/agents/sections.md and the rail's moves are the member's edits of it.
				controller.useSectionsFile((signal) => {
					const current = () => {
						if (disposed || company !== controller || auth.userId !== userId || controller.store.get().accessLost)
							throw new Error(t("Company access changed."));
					};
					current();
					const role = controller.store.get().team?.role;
					if (!role) throw new Error(t("Company access changed."));
					return new WebCompanyFiles(cloud, profile, userId, role, signal, current).folder();
				});
				if (planReturn && planReturn.signIn.companyId === controller.profile.profileId) {
					const outcome = planReturn;
					planReturn = undefined;
					if (outcome.signIn.memberId !== userId) forgetChatGptPlanSignIn();
					else {
						// A ChatGPT plan sign-in for this company. Its confirm belongs to the member, not to a
						// page: it finishes while Settings closes or the route changes, stopping only if the
						// account changes, and AI subscriptions shows the outcome.
						const plan = createWebNativeSubscription(
							cloud,
							profile.profileId,
							userId,
							new AbortController().signal,
							() => {
								if (auth.userId !== userId) throw new Error("The account changed.");
							},
						);
						const loadedSettings = lazySettingsModule.get();
						if (loadedSettings) {
							loadedSettings.settingsConnections.finishPlanSignIn(
								loadedSettings.settingsConnections.memberPlanSignIn(userId, profile.profileId),
								plan,
								outcome,
							);
						} else {
							void lazySettingsModule
								.load()
								.then(({ settingsConnections: { finishPlanSignIn, memberPlanSignIn } }) =>
									finishPlanSignIn(memberPlanSignIn(userId, profile.profileId), plan, outcome),
								);
						}
						queueMicrotask(() => {
							if (disposed || company !== controller) return;
							const route = currentRoute();
							if (route.name === "company" && route.section === "home") settingsAfterHome = "ai-subscriptions";
							else openSettings("ai-subscriptions");
						});
					}
				}
				if (connectorReturn?.connector === "bank") {
					const bankReturn = connectorReturn;
					const loadedOps = lazyOpsModule.get();
					if (loadedOps) loadedOps.bank.noteBankReturn(bankReturn);
					else void lazyOpsModule.load().then(({ bank: { noteBankReturn } }) => noteBankReturn(bankReturn));
				} else if (connectorReturn?.signIn.target === "mailbox") {
					const mailboxReturn = connectorReturn;
					const loadedOps = lazyOpsModule.get();
					if (loadedOps) loadedOps.mailbox.noteGoogleMailReturn(mailboxReturn);
					else
						void lazyOpsModule.load().then(({ mailbox: { noteGoogleMailReturn } }) => {
							noteGoogleMailReturn(mailboxReturn);
							if (!disposed && company === controller) render();
						});
				} else if (connectorReturn) {
					const serviceReturn = connectorReturn;
					const openReturnedSettings = () => {
						if (disposed || company !== controller) return;
						const route = currentRoute();
						if (
							route.name === "company" &&
							route.section === "home" &&
							(resolvingRoute !== undefined || !homeReason)
						)
							settingsAfterHome = "company-connections";
						else openSettings("company-connections");
					};
					const loadedSettings = lazySettingsModule.get();
					if (loadedSettings) {
						loadedSettings.settingsServices.noteConnectorReturn(serviceReturn);
						queueMicrotask(openReturnedSettings);
					} else {
						void lazySettingsModule.load().then((mod) => {
							if (disposed || company !== controller) return;
							mod.settingsServices.noteConnectorReturn(serviceReturn);
							openReturnedSettings();
						});
					}
				}
				connectorReturn = undefined;
				computerPanels = createComputerPanels(controller, profile, userId);
				unsubscribeCompany = controller.store.subscribe(() => render());
				void controller.start();
				return controller;
			} finally {
				settled = true;
				if (clearOnFinish && pending && pendingCompany === pending) pendingCompany = undefined;
			}
		})();
		if (!settled || !clearOnFinish) {
			pending = { profileId, revision: routeRevision, promise };
			pendingCompany = pending;
		}
		return promise;
	}

	async function resolveHome(controller: CompanyController): Promise<void> {
		if (resolvingRoute === routeRevision) return;
		const revision = routeRevision;
		const current = captureRoute();
		resolvingRoute = revision;
		try {
			const result = await controller.openCofounderConversation();
			if (!current() || company !== controller) return;
			const tab = settingsAfterHome;
			settingsAfterHome = undefined;
			if (result.sessionId)
				navigate(
					{ name: "company", profileId: controller.profile.profileId, section: "chat", id: result.sessionId },
					true,
				);
			else {
				homeReason = result.reason;
				render();
			}
			if (tab) openSettings(tab);
		} finally {
			if (resolvingRoute === revision) resolvingRoute = undefined;
		}
	}

	async function resolveStaff(controller: CompanyController, staffId: string): Promise<void> {
		if (resolvingRoute === routeRevision) return;
		const revision = routeRevision;
		const current = captureRoute();
		resolvingRoute = revision;
		try {
			const agent = controller.staffById(staffId);
			if (!agent) throw new Error(t("This agent is not available in the company."));
			const sessionId = await controller.openStaffConversation(agent);
			if (current() && company === controller)
				navigate(
					{ name: "company", profileId: controller.profile.profileId, section: "chat", id: sessionId },
					true,
				);
		} catch (error) {
			if (current() && company === controller) {
				routeError = describeError(error);
				render();
			}
		} finally {
			if (resolvingRoute === revision) resolvingRoute = undefined;
		}
	}

	/** A company or conversation that is still opening shows the thread's placeholder.
	 * A redraw keeps the one already shown and only renames what it is waiting for. */
	function showThreadSkeleton(label: string): void {
		// On a phone the thread brings its own header, with the rail's button, as an open conversation does.
		frame.classList.add("has-thread");
		const shown = main.childElementCount === 1 ? main.firstElementChild : null;
		if (shown?.classList.contains("thread-skeleton")) {
			const name = shown.querySelector(".visually-hidden");
			if (name && name.textContent !== label) name.textContent = label;
			shown.querySelector(".mobile-navigation-toggle")?.setAttribute("aria-expanded", String(navigationOpen));
			return;
		}
		replace(main, threadSkeleton(label, { open: navigationOpen, toggle: () => setNavigationOpen(!navigationOpen) }));
	}

	async function draw(): Promise<void> {
		if (disposed) return;
		settleStartCrown();
		const current = captureRoute();
		const authState = auth.store.get();
		if (!authState.ready || localePending) {
			// A start that failed keeps saying so; a redraw (a route change) never blanks it again. index.html's
			// first screen (ui/boot.ts) stands until the app knows which screen to draw.
			if (startError) replace(root!, startError);
			else if (!root!.querySelector(":scope > .boot")) replace(root!, blankSkeleton(t("Connecting to the cloud")));
			return;
		}
		if (!authState.session || (authState.step.name === "reset" && authState.step.verified)) {
			teardownCompany(true);
			let container = root!.querySelector<HTMLElement>(':scope > .auth:not([data-step="name"])');
			if (!container) {
				container = h("div", { class: "brand-field" });
				replace(root!, container);
			}
			renderSignIn(auth, container);
			return;
		}
		if (!accountName(authState.user)) {
			teardownCompany(true);
			if (root!.querySelector(':scope > .auth[data-step="name"]')) return;
			const container = h("div", { class: "brand-field" });
			replace(root!, container);
			renderNameAsk(auth, container, () => render());
			return;
		}
		if (needsPassword(authState.user)) {
			teardownCompany(true);
			if (root!.querySelector(':scope > .auth[data-step="password"]')) return;
			const container = h("div", { class: "brand-field" });
			replace(root!, container);
			renderPasswordAsk(auth, container, () => render());
			return;
		}
		if (!root!.contains(frame)) replace(root!, frame);
		const route: Route = currentRoute();
		// The account page's good will lives while it shows: its notice goes with it, and a failed
		// read is tried again on the next visit.
		if (route.name !== "account" && accountPayments) {
			accountPayments.dispose();
			accountPayments = undefined;
		}
		frame.classList.toggle(
			"has-thread",
			route.name === "company" &&
				(route.section === "chat" || route.section === "new" || route.section === "member"),
		);
		// The Concepts viewer is full screen: no rail and no top bar, its own side panel instead.
		frame.classList.toggle("has-concepts", route.name === "company" && route.section === "concepts");
		if (route.name !== "company") {
			parkCompany();
			rail.hidden = true;
			syncRailReopen();
			renderTopbar(topbar, shellContext(authState.user, route), undefined);
			if (route.name !== "found") teardownFounding();
			const viewer: Viewer | undefined =
				authState.user && auth.userId ? { userId: auth.userId, name: displayName(authState.user) } : undefined;
			if (route.name === "hub" && hasWebsiteIdea()) {
				// qorpera.com's idea is waiting (a sign-in came back to the app's root): show it in its box.
				navigate({ name: "new" }, true);
			} else if (route.name === "hub") {
				renderHub(hub, main, viewer);
				if (auth.userId && profiles.length > 0) {
					const userId = auth.userId;
					void logos.prefetchManyIdentity(
						profiles.map((profile) => ({
							profileId: profile.profileId,
							createFolder: (signal: AbortSignal) => wordmarkFolder(profile, userId, signal),
						})),
					);
				}
			} else if (route.name === "new") {
				renderNewCompany(hub, main, viewer);
			} else if (route.name === "found") {
				const userId = auth.userId!;
				const loadedFounding = foundingModule.get();
				if (!loadedFounding) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					void foundingModule.load().then(() => {
						if (!disposed) render();
					});
					return;
				}
				if (founding?.controller.profileId !== route.profileId) {
					teardownFounding();
					const profileId = route.profileId;
					const controller = new loadedFounding.FoundingController(api, userId, profileId, {
						currentUserId: () => auth.userId,
						onSeatChanged: () => void hub.refresh(),
						// Still on this table's page: open the company, which opens its Co-Founder's thread. The table's
						// page leaves the history, so Back does not return to a table that is done. A company list read
						// before the company was made may still be out, and opening a company it leaves out would fail:
						// open only after a read that started after this one, and only once it lists the company (else
						// the table's own Open button stays).
						onCompanyReady: () => {
							const page = routeHash({ name: "found", profileId });
							const currentHub = hub;
							// WHY: Enter the ready company as soon as a fresh profile list confirms it instead of blocking navigation on full hub refresh (invitations/founding tables).
							void currentHub.refreshProfilesAfter().then(() => {
								if (disposed || hub !== currentHub || location.hash !== page) return;
								if (currentHub.store.get().profiles.some((item) => item.profileId === profileId)) {
									landStartCrown();
									navigate({ name: "company", profileId, section: "home" }, true);
									void currentHub.refresh();
								}
							});
						},
					});
					founding = { controller, view: new loadedFounding.FoundingView(controller) };
					let companyListed = false;
					controller.store.subscribe(() => {
						if (founding?.controller !== controller) return;
						// A started table's company joins the hub's list once it is ready.
						const start = controller.store.get().table?.start;
						const autoOpening =
							start?.companyReady &&
							!start.firstRunWaitsUntil &&
							(start.firstRun === null ||
								start.firstRun === undefined ||
								start.firstRun === "queued" ||
								start.firstRun === "started");
						if (!companyListed && start?.companyReady && !autoOpening) {
							companyListed = true;
							void hub.refresh();
						}
						render();
					});
				}
				// The table's page is kept and updated in place, never rebuilt (typing, focus and scroll).
				if (!main.contains(founding.view.el)) replace(main, founding.view.el);
				founding.view.update();
			} else if (route.name === "account") {
				const loadedAccount = accountViewModule.get();
				if (!loadedAccount) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Account"))));
					void accountViewModule.load().then(() => {
						if (!disposed) render();
					});
					return;
				}
				const revision = accountRevision;
				loadedAccount.renderAccount(auth, main, accountState, (next) => {
					if (disposed || accountRevision !== revision) return;
					accountState = { ...accountState, ...next };
					render();
				});
				if (checkoutReturn) {
					accountPayments?.dispose();
					accountPayments = undefined;
				}
				accountPayments ??= new loadedAccount.MyGoodWillView(
					() => api.getMyGoodWill(),
					new AbortController().signal,
					checkoutReturn === "card-saved" ? t("Card saved. It pays the company's next invoice.") : undefined,
				);
				checkoutReturn = undefined;
				main.append(accountPayments.el);
			}
			return;
		}
		teardownFounding();
		if (company?.profile.profileId !== route.profileId && !warmCompanyFor(route.profileId)) {
			// Opening a company takes a round trip or two. Meanwhile its rail and page stand
			// as placeholders, never a blank frame or the page it came from.
			topbar.classList.remove("topbar-plain");
			topbar.classList.add("topbar-company");
			replace(topbar);
			rail.hidden = route.section === "concepts";
			syncRailReopen();
			if (!rail.hidden) replace(rail, ...railSkeleton());
			if (
				route.section === "home" ||
				route.section === "chat" ||
				route.section === "staff" ||
				route.section === "new" ||
				route.section === "member"
			)
				showThreadSkeleton(t("Opening company"));
			else replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
		}
		const controller = await ensureCompany(route.profileId);
		if (!current()) return;
		if (!controller) {
			// A drawer opened from the placeholder closes with the company it was opening.
			navigationOpen = false;
			navigationFocus = undefined;
			syncNavigation();
			frame.classList.remove("navigation-open");
			rail.hidden = true;
			syncRailReopen();
			renderTopbar(topbar, shellContext(authState.user, route), undefined);
			const hubState = hub.store.get();
			const transient = hubState.connectionLost || (!hubState.loaded && !hubState.error);
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					notice(
						transient ? "neutral" : "danger",
						transient
							? t("Can't reach Qorpera. Trying again…")
							: (hubState.error ?? t("This company is not available to your account.")),
					),
					hubState.error && !transient
						? button(t("Try again"), () => {
								pendingCompany = undefined;
								void hub.refresh();
							})
						: null,
					h("a", { href: "#/" }, t("Back to companies")),
				),
			);
			return;
		}
		// Agents are company folders (QorperaOS/agents/<handle>/agent.md). Each write re-checks
		// that this member still holds the authority the company showed when it began.
		const agents = () => {
			const team = controller.store.get().team;
			if (!team?.capabilities.authorize) throw new Error(t("Only an owner or admin can change agents."));
			return createWebCompanyAgents(
				new WebCompanyFiles(cloud, controller.profile, controller.userId, team.role, controller.signal, () => {
					const now = controller.store.get();
					if (
						disposed ||
						company !== controller ||
						auth.userId !== controller.userId ||
						now.accessLost ||
						!now.team?.capabilities.authorize
					)
						throw new Error(t("Company access changed."));
				}),
				// A field the member did not touch keeps the file's own value; a figure's own shade is no colour.
				{ saved: savedAgentDraft, native: nativeColorOf },
			);
		};
		const agentActions: WorkspaceActions = {
			createAgent: (_profileId, draft, signal) => agents().create(draft, signal),
			updateAgent: (agent, draft, signal) => agents().update(agent, draft, signal),
			deleteAgent: (agent, signal) => agents().delete(agent, signal),
		};
		// The rail renames and deletes group chats from their menu, with the same rechecks.
		const companyCurrent = () => {
			const now = controller.store.get();
			if (disposed || company !== controller || auth.userId !== controller.userId || now.accessLost)
				throw new Error(t("Company access changed."));
		};
		const groupFolder = (signal: AbortSignal) => {
			companyCurrent();
			const team = controller.store.get().team;
			if (!team?.capabilities.authorize) throw new Error(t("Only an owner or admin can edit group chats."));
			return new WebCompanyFiles(cloud, controller.profile, controller.userId, team.role, signal, () => {
				companyCurrent();
				if (!controller.store.get().team?.capabilities.authorize)
					throw new Error(t("Group chat editing access changed."));
			}).folder();
		};
		// The member's own client for the company's folder under a caller's checks: a routine's file is read and written
		// with the access its routine calls have (P34r).
		const memberFolder = (current: () => void, lost: string) => {
			current();
			const role = controller.store.get().team?.role;
			if (!role) throw new Error(lost);
			return new WebCompanyFiles(
				cloud,
				controller.profile,
				controller.userId,
				role,
				controller.signal,
				current,
			).folder();
		};
		// An agent's app on its page, or a Company File page beside the chat (RUNTIME-INTERFACE-APPS.md §4, §5): read with
		// the member's own folder client, under the company's checks.
		// The agents' open questions about an app, answered on its page and in the Concepts viewer as in the chat
		// (app/open-questions.ts): the member's own model account for the thread, chosen as the thread chooses it.
		const questionsHost = (): QuestionDockHost => {
			let questions = appQuestions.get(controller);
			if (!questions) {
				questions = new OpenQuestions(
					controller,
					createWebNativeSubscription(
						cloud,
						controller.profile.profileId,
						controller.userId,
						controller.signal,
						companyCurrent,
					),
				);
				appQuestions.set(controller, questions);
				controller.signal.addEventListener("abort", questions.watch(), { once: true });
			}
			return {
				questions,
				agent: (agentId) => controller.staffById(agentId),
				memberName: (userId) => controller.memberName(userId),
				image: (path, signal) => (cardImage ? cardImage(path, signal) : Promise.resolve(null)),
				app: (name) => cardApp(name),
				conversation: (sessionId) => controller.conversation(sessionId, false),
			};
		};
		questionsHost();
		// The company's databases, asked and watched as the member through the member gateway; none where the build
		// names no member gateway.
		const dataHost = (): CompanyData | undefined => {
			if (!cloud.config.memberCompanyGatewayUrl) return undefined;
			let data = appData.get(controller);
			if (!data) {
				data = new CompanyData(
					() => {
						const role = controller.store.get().team?.role;
						const client = role
							? new WebCompanyFiles(
									cloud,
									controller.profile,
									controller.userId,
									role,
									controller.signal,
									companyCurrent,
								).data()
							: undefined;
						if (!client) throw new Error(t("Company access changed."));
						return client;
					},
					controller.signal,
					companyCurrent,
				);
				appData.set(controller, data);
			}
			return data;
		};
		// The platform's own numbers of the company (`qorpera/money-now` and the like), asked as the member with a plain
		// call to the cloud, so also where the build names no member gateway.
		const numbersHost = (): CompanyNumbers => {
			let numbers = appNumbers.get(controller);
			if (!numbers) {
				numbers = new CompanyNumbers(
					(asked) => askCompanyNumbers(cloud, controller.profile.environmentId, asked),
					controller.signal,
					companyCurrent,
				);
				appNumbers.set(controller, numbers);
			}
			return numbers;
		};
		// A note an app's page asks the member to send to the agent that owns the app (RUNTIME-INTERFACE-APPS.md §5
		// "tell"), written by the member on the bar: their own message in that agent's thread, or the Co-Founder's, on
		// their own model account for the thread, chosen as the thread chooses it (app/tell-agent.ts).
		const appNotes = (): AppTellSource => {
			let accounts: TellAccounts | undefined;
			const kept = () => {
				let found = heldNotes.get(controller);
				if (!found) {
					found = { notes: new Map(), back: new Map() };
					heldNotes.set(controller, found);
				}
				return found;
			};
			return {
				receiver: (owner) => {
					const found = noteReceiver(controller, owner);
					return "agent" in found ? { agentId: found.agent.id } : found;
				},
				agent: (agentId) => controller.staffById(agentId),
				held: (app) => kept().notes.get(app),
				// A note that was on its way and is held again is back for the app's page on screen, whichever sent it. Any
				// other kept note comes back when the app's page is next shown.
				hold: (app, note, isBack) => {
					const { notes, back } = kept();
					if (note) notes.set(app, note);
					else notes.delete(app);
					if (note && isBack) back.get(app)?.();
				},
				listen: (app, listener) => {
					const { back } = kept();
					back.set(app, listener);
					return () => {
						if (back.get(app) === listener) back.delete(app);
					};
				},
				send: (agentId, note) => {
					accounts ??= createWebNativeSubscription(
						cloud,
						controller.profile.profileId,
						controller.userId,
						controller.signal,
						companyCurrent,
					);
					return tellAgent(controller, accounts, agentId, { text: note.text, quotes: [], header: note.header });
				},
			};
		};
		// The company's reading of itself, its agents and its standing, for a page that reads `reading`
		// (app/company-reading.ts): read as the member, handed over as plain names.
		const readingHost = (): CompanyReading => {
			let reading = appReading.get(controller);
			if (!reading) {
				reading = new CompanyReading(
					{
						folder: () => memberFolder(companyCurrent, t("Company access changed.")),
						people: () => {
							const state = controller.store.get();
							return {
								staff: state.staff,
								working: (agentId) => agentWorks(controller.agentState(agentId)),
								cofounderId: controller.cofounderId(),
								members: state.team?.members ?? [],
								viewer: controller.userId,
							};
						},
						standing: () => readCompanyStanding(cloud, controller.profile.profileId),
					},
					controller.signal,
				);
				appReading.set(controller, reading);
			}
			return reading;
		};
		const cofounderFigure = (className: string) =>
			agentFigure(
				controller.staffById(controller.cofounderId()) ?? {
					id: "",
					displayName: "Co-Founder",
					appearance: { color: "", shape: "" },
					templateId: "co-founder",
				},
				"Co-Founder",
				{ size: 96, className },
			);
		const memberFirstName = (userId: string) => {
			const member = controller.store.get().team?.members.find((each) => each.userId === userId);
			const name = member ? member.displayName || member.email : "";
			return name ? (name.split(/\s+/)[0] ?? name) : null;
		};
		const programAdds = (): ProgramAddHost => ({
			writer: () => memberFolder(companyCurrent, t("Company access changed.")),
			userId: controller.userId,
			canWrite: () => controller.store.get().team?.capabilities.write === true,
			companyName: () => companyInSentence(controller.profile.profileName),
			appNames: () => (companyApps?.apps ?? []).map((app) => app.name),
			opened: (folder) => {
				try {
					companyCurrent();
				} catch {
					return;
				}
				navigate({ name: "company", profileId: controller.profile.profileId, section: "app", id: folder }, true);
			},
			cofounder: () => cofounderFigure("program-say-figure"),
		});
		const panelHost = (): AppPanelHost => ({
			programs: { userId: controller.userId, memberName: memberFirstName, adds: programAdds() },
			folder: () => memberFolder(companyCurrent, t("Company access changed.")),
			agents: () =>
				controller.store
					.get()
					.staff.filter((agent) => agent.employmentStatus === "active")
					.map((agent) => {
						const now = controller.agentState(agent.id);
						return {
							name: agent.displayName,
							role: agent.role,
							working: agentWorks(now),
						};
					}),
			reading: readingHost(),
			readApps: () => companyApps?.read() ?? Promise.resolve([]),
			apps: () => companyApps?.apps ?? [],
			agentName: (agentId) => (agentId ? (controller.staffById(agentId)?.displayName ?? null) : null),
			onFolderChange: (listener) => companyApps?.onChange(listener) ?? (() => {}),
			openInFiles,
			// A link to an app in an app's page, as its card in a message.
			openApp,
			budgetKey: controller.profile.profileId,
			questions: questionsHost(),
			// A change an app asked for and the member allowed is the member's own save, under the company's checks.
			writer: () => memberFolder(companyCurrent, t("Company access changed.")),
			current: companyCurrent,
			data: dataHost(),
			numbers: numbersHost(),
			tell: appNotes(),
		});
		sidePanel = (target) =>
			new AppPanel(panelHost(), target, { kind: "beside", onClose: () => conversation?.closeBeside(true) });
		// The member's erases of single messages under a caller's checks (summary trees M3c).
		const messageErases = (current: () => void) => {
			current();
			const role = controller.store.get().team?.role;
			if (!role) throw new Error(t("Conversation access changed."));
			return new WebCompanyFiles(
				cloud,
				controller.profile,
				controller.userId,
				role,
				controller.signal,
				current,
			).messageErases();
		};
		const groupActions: Pick<WorkspaceActions, "updateGroup" | "deleteGroup"> = {
			updateGroup: createGroupUpdater({ company: controller, current: companyCurrent, folder: groupFolder }),
			deleteGroup: createGroupDeleter({ company: controller, current: companyCurrent, folder: groupFolder }),
		};
		// First run is a moment, not a workspace: the rail stays away until the
		// Co-Founder has a face.
		// The Concepts viewer is full screen: its own side panel leads back.
		rail.hidden = route.section === "concepts" || controller.store.get().accessLost === true;
		syncRailReopen();
		const context = shellContext(authState.user, route);
		renderTopbar(topbar, context, rail.hidden ? undefined : controller);
		// The card's Computer opens in the agent's own chat: here when it is on screen, else once it opens.
		const showAgentPage = (agentId: string, page: AgentPage) => {
			// The member's own click: a sleeping computer wakes (computer.ts OPEN_STARTS).
			if (conversation?.show(agentId, page, true)) return;
			// It waits a little while for the chat; a request the member moved away from does not come back later.
			agentPage = { agentId, page, until: Date.now() + AGENT_PAGE_WAIT_MS };
			navigate({ name: "company", profileId: controller.profile.profileId, section: "staff", id: agentId });
		};
		// Pictures of the folder for previews, one reader per company, so what a card read is not read again per thread.
		let cardImage = cardImages.get(controller);
		if (!cardImage) {
			const reader = folderImageReader(() => memberFolder(companyCurrent, t("Company access changed.")));
			cardImage = reader;
			cardImages.set(controller, reader);
			controller.signal.addEventListener("abort", () => disposeCardPictures(reader), { once: true });
		}
		// The apps that question options' previews name, as the company's apps were last read; a card drawn before they
		// were read is brought up to date by decorateAppCards.
		const cardApp = (name: string) => cardAppOf(controller.store.get().apps, name);
		// What's new's calls and what it reads beside them: its page and the "a change is ready" card in an agent's thread
		// share them (views/release-desk.ts).
		const releaseDesk = (shared = false) => ({
			client: shared ? companyReleases(controller).shared : companyReleases(controller).own,
			// The company's last read, which a thread's card starts from.
			last: () => companyReleases(controller).last,
			options: {
				image: (path: string, signal: AbortSignal) => (cardImage ? cardImage(path, signal) : Promise.resolve(null)),
				// Every read, from What's new's page or a thread's card, is numbered as it starts (its client), so the latest
				// to start is the company's last read: a thread opened next starts from what is true now (a change put live on
				// the page is no card), with no read of its own. The drawer counts from it too.
				listed: (read: CodeReleases) => showReleases(controller, read),
				// The sites Qorpera took down (step 5.1): no link to one. Their names come with the access read, so a
				// project's site that never went live is one too (the review of #1774, F4); the list is read only for an
				// entry that names none.
				takenDown: async (signal: AbortSignal) => {
					const sites = createWebSites(cloud, controller.profile);
					const access = await sites.access(signal);
					const slugs = new Set<string>();
					for (const id of access.takenDown.keys()) {
						const named = access.named.get(id);
						if (named) slugs.add(named.slug);
					}
					if ([...access.takenDown.keys()].every((id) => access.named.has(id))) return slugs;
					for (const site of await sites.list(signal)) if (access.takenDown.has(site.id)) slugs.add(site.slug);
					return slugs;
				},
			},
		});
		// Who may see a site's password and change it: owners and admins (the kernel enforces the same rule).
		const managesSites = () => {
			const role = controller.store.get().team?.role;
			return role === "owner" || role === "admin";
		};
		const openAgentCard: ShellContext["openAgentCard"] = (agent, anchor, card, findAnchor) => {
			agentCard?.dispose();
			const mount = (Loaded: typeof AgentDetails) => {
				if (disposed || company !== controller || controller.signal.aborted) return;
				agentCard?.dispose();
				const opened = new Loaded(
					controller,
					agent,
					{
						...agentActions,
						...workspaceActions,
						routines: createWebRoutines(cloud, controller.profile, controller.signal, companyCurrent, () =>
							memberFolder(companyCurrent, t("Company access changed.")),
						),
						eventHooks: createWebEventHooks(cloud, controller.profile),
						nativeSubscription: createWebNativeSubscription(
							cloud,
							controller.profile.profileId,
							controller.userId,
							controller.signal,
							companyCurrent,
						),
					},
					() => {
						if (agentCard === opened) agentCard = undefined;
					},
					anchor,
					controller.signal,
					{
						computer: () => showAgentPage(agent.id, "computer"),
						...card,
					},
					"beside",
				);
				opened.dialog.findOpener = findAnchor;
				agentCard = opened;
			};
			const cached = agentDetailsModule.get();
			if (cached) mount(cached.AgentDetails);
			else void agentDetailsModule.load().then((mod) => mount(mod.AgentDetails));
		};
		const openGroupCard: ShellContext["openGroupCard"] = (session, anchor, card, findAnchor) => {
			agentCard?.dispose();
			const mount = (Loaded: typeof GroupDetails) => {
				if (disposed || company !== controller || controller.signal.aborted) return;
				agentCard?.dispose();
				const opened = new Loaded(
					controller,
					session.sessionId,
					() => {
						if (agentCard === opened) agentCard = undefined;
					},
					anchor,
					controller.signal,
					{ ...agentActions, ...groupActions, ...workspaceActions },
					card,
					"beside",
				);
				opened.dialog.findOpener = findAnchor;
				agentCard = opened;
			};
			const cached = groupDetailsModule.get();
			if (cached) mount(cached.GroupDetails);
			else void groupDetailsModule.load().then((mod) => mount(mod.GroupDetails));
		};
		// The tab counts the agents that wait on the member here (app/tab-title.ts).
		showWaitingInTitle(
			controller.agentsWaitingOnMe() +
				offersWaitingOn(surfacesOf(controller)?.state.automations ?? [], controller.userId),
		);
		if (!rail.hidden) {
			try {
				renderRail(rail, controller, {
					...context,
					agentActions: { ...agentActions, ...groupActions, ...workspaceActions },
					openAgentCard,
					openGroupCard,
					hideInterfacePage: (page, hidden) =>
						(interfacePages?.hide(page, hidden) ?? Promise.resolve()).then(() => {
							if (controller.ownSidebar()) {
								controller.store.set({ sidebarReset: undefined });
								void controller.refreshSidebar();
							}
						}),
					refreshInterfacePages: () => void interfacePages?.refresh(),
					searchFolder: () => {
						const role = controller.store.get().team?.role;
						const current = () => {
							if (
								disposed ||
								company !== controller ||
								auth.userId !== controller.userId ||
								controller.store.get().accessLost
							)
								throw new Error(t("Company access changed."));
						};
						current();
						if (!role) throw new Error(t("Company access changed."));
						return new WebCompanyFiles(
							cloud,
							controller.profile,
							controller.userId,
							role,
							controller.signal,
							current,
						).folder();
					},
					openInFiles,
					searchBlocked: () => Boolean(settings || feedback || friendsWindow),
				});
			} catch (error) {
				console.error("rail render failed:", error);
			}
		}
		// The drawer may draw an app otherwise now (the member's icon or colour for it, its group's colour): its cards
		// in the messages follow.
		syncAppCardObserver();
		decorateAppCards();
		if (navigationFocus) {
			const target =
				navigationFocus === "rail"
					? rail.querySelector<HTMLElement>(".rail-toolbar .rail-company")
					: (frame.querySelector<HTMLButtonElement>(".main .mobile-navigation-toggle:not([hidden])") ??
						topbar.querySelector<HTMLButtonElement>(".mobile-navigation-toggle"));
			target?.focus();
			navigationFocus = undefined;
		}
		const state = controller.store.get();
		if (state.accessLost) {
			syncAppCardObserver(undefined);
			disposeCompanyViews();
			closeSettings(false);
			navigationOpen = false;
			navigationFocus = undefined;
			syncNavigation();
			frame.classList.remove("navigation-open");
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					notice("danger", t("Your access to this company was revoked.")),
					h("a", { href: "#/" }, t("Back to companies")),
				),
			);
			return;
		}
		if (notices && !state.team?.capabilities.read) {
			notices.dispose();
			notices = undefined;
		}
		if (!notices && state.team?.capabilities.read) {
			const noticeAccess = () => {
				const selected = currentRoute();
				if (
					disposed ||
					company !== controller ||
					auth.userId !== controller.userId ||
					controller.store.get().accessLost ||
					!controller.store.get().team?.capabilities.read ||
					selected.name !== "company" ||
					selected.profileId !== controller.profile.profileId
				)
					throw new Error(t("Company notification access changed."));
			};
			const client = createWebMemberNotifications(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				noticeAccess,
			);
			// A ChatGPT plan's member is asked once to turn on work while away for an agent's routine.
			const native = createWebNativeSubscription(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				noticeAccess,
			);
			const plan =
				native.setWorkWhileAway && native.recordRoutineOffer && native.chatGptPlanAvailable
					? {
							native: {
								listConnections: native.listConnections,
								setWorkWhileAway: native.setWorkWhileAway,
								recordRoutineOffer: native.recordRoutineOffer,
								chatGptPlanAvailable: native.chatGptPlanAvailable,
							},
							// A routine is a file: its resume writes it through the member's own folder client.
							routines: createWebRoutines(cloud, controller.profile, controller.signal, noticeAccess, () =>
								memberFolder(noticeAccess, t("Company notification access changed.")),
							),
							memberId: controller.userId,
							canManage: () => controller.store.get().team?.capabilities.authorize === true,
						}
					: undefined;
			const createdNotices = new ExecutionNotices(
				client,
				controller.signal,
				() => (settings ? settings.focus() : main.focus({ preventScroll: true })),
				plan,
				(staffAgentId) => controller.store.get().staff.find((agent) => agent.id === staffAgentId)?.displayName,
				(userId) => controller.store.get().team?.members.find((member) => member.userId === userId)?.displayName,
				(count) => {
					if (disposed || notices !== createdNotices || count === shownAccountAlerts) return;
					shownAccountAlerts = count;
					render();
				},
			);
			notices = createdNotices;
			executionNotices.append(createdNotices.el);
		}
		// The company's pages are the two the web ships, shown once they are on (Interfaces C6a). What they read comes from
		// its folder, read with the member's own access as the Company File page reads it, and followed while the
		// company is open.
		if (interfaceFolder && !state.team?.capabilities.read) {
			interfacePages?.dispose();
			interfacePages = undefined;
			companyDatabases?.dispose();
			companyDatabases = undefined;
			controller.store.set({ interfacePages: undefined, companyData: undefined });
			interfaceFolder.dispose();
			interfaceFolder = undefined;
			void surfaceFolderHints?.close();
			surfaceFolderHints = undefined;
			companyApps?.dispose();
			companyApps = undefined;
			agentNotes?.dispose();
			agentNotes = undefined;
			controller.store.set({ agentNotes: undefined });
		}
		if (!interfaceFolder && state.team?.capabilities.read) {
			const folderCurrent = () => {
				const now = controller.store.get();
				if (
					disposed ||
					company !== controller ||
					auth.userId !== controller.userId ||
					now.accessLost ||
					!now.team?.capabilities.read
				)
					throw new Error(t("Company access changed."));
			};
			const files = new WebCompanyFiles(
				cloud,
				controller.profile,
				controller.userId,
				state.team.role,
				controller.signal,
				folderCurrent,
			);
			// The pages' reader and the apps' share one hint channel.
			const hints = sharedFolderHints(files);
			surfaceFolderHints = hints(() => {
				surfacesOf(controller)?.onFolderHint();
			});
			const shared = {
				signal: files.signal,
				current: () => files.current(),
				folder: () => files.folder(),
				folderHints: hints,
			};
			const reader = new CompanyInterfaceFolder(shared, (folder) => {
				if (interfaceFolder !== reader) return;
				controller.store.set({ interfaceFolder: folder });
			});
			const databases = cloud.config.memberCompanyGatewayUrl
				? new CompanyDatabases(
						() => {
							const client = files.data();
							if (!client) throw new Error(t("Company access changed."));
							return client;
						},
						(described) => {
							if (companyDatabases === databases) controller.store.set({ companyData: described });
						},
						controller.signal,
					)
				: undefined;
			companyDatabases = databases;
			// The folder is read for the pages that are on: a page switched on is read for at the next sync.
			const pages = new CompanyInterfacePages(
				interfacePageCalls(cloud, controller.profile.environmentId),
				(next) => {
					if (interfacePages !== pages) return;
					controller.store.set({ interfacePages: next });
					reader.read(pagesOn(next));
					if (next?.pages.some((page) => page.page === DATA_PAGE)) databases?.open();
				},
				controller.signal,
			);
			interfacePages = pages;
			interfaceFolder = reader;
			pages.open();
			void reader.open();
			// The agents' apps, for the apps drawer and the apps' own pages (RUNTIME-INTERFACE-APPS.md §4).
			const apps = new CompanyApps(
				shared,
				(next) => {
					if (companyApps !== apps) return;
					controller.store.set({ apps: next });
					syncAppCardObserver();
					decorateAppCards();
					// The apps changed: the icons read for some of them may have too (an agent drew new ones).
					controller.refreshAppIcons();
				},
				(groups) => {
					if (companyApps !== apps) return;
					controller.store.set({ appGroups: groups });
				},
				// WHY: Skip 24 MiB legacy app prefetch on boot while the surface rail hides the legacy apps drawer.
				() => !rail.classList.contains("has-surface-rail"),
			);
			companyApps = apps;
			controller.appIconReader = (app) => apps.icons(app);
			// Generate icon's message takes the thread's own model account, as an answer from an app does.
			controller.appIconAccounts = createWebNativeSubscription(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				companyCurrent,
			);
			// An agent's icons-only save changes no app's manifest: every read of the apps (a hint, the minute's clock, the tab
			// coming back) reads the icons read before (review F5 on #1696).
			apps.onRead(() => controller.refreshAppIcons());
			// The rail's line under each agent's name: its next planned run, read with the member's own access and again on
			// each change hint of the folder (routines are files of it).
			const routines = createWebRoutines(cloud, controller.profile, files.signal, folderCurrent, () =>
				files.folder(),
			);
			const notes = new AgentNotes(
				{
					agents: () =>
						controller.store
							.get()
							.staff.filter((agent) => agent.employmentStatus === "active")
							.map((agent) => agent.id),
					listRoutines: () => routines.list(),
					signal: files.signal,
				},
				(next) => {
					if (agentNotes === notes) controller.store.set({ agentNotes: next });
				},
			);
			agentNotes = notes;
			const notesFocusSignal = companyActiveAbort
				? AbortSignal.any([files.signal, companyActiveAbort.signal])
				: files.signal;
			window.addEventListener("focus", () => notes.changed(), { signal: notesFocusSignal });
			apps.onChange(() => notes.changed());
			apps.open();
			notes.open();
		}
		// The roster arrives after the company opens, and agents are hired and let go: the rail's notes follow it.
		agentNotes?.agentsChanged();
		if (sitesRead !== controller && state.team?.capabilities.read) {
			sitesRead = controller;
			const activeSignal = companyActiveAbort
				? AbortSignal.any([controller.signal, companyActiveAbort.signal])
				: controller.signal;
			const sites = createWebSites(cloud, controller.profile);
			let sitesInFlight = false;
			let sitesPending = false;
			const readSites = () => {
				if (activeSignal.aborted || company !== controller) return;
				if (sitesInFlight) {
					sitesPending = true;
					return;
				}
				sitesInFlight = true;
				void sites
					.list(activeSignal)
					.then(
						async (list) => {
							if (activeSignal.aborted) return;
							const prevList = controller.store.get().siteList;
							if (prevList === undefined || JSON.stringify(prevList) !== JSON.stringify(list))
								controller.store.set(sitesListed(list));
							if (controller.store.get().siteListUnread) controller.store.set({ siteListUnread: false });
							// WHY: ask for taken-down sites only while a live files site exists; keep the last set on failure.
							if (list.some((site) => site.kind === "files" && site.state === "live")) {
								try {
									const access = await sites.access(activeSignal);
									if (activeSignal.aborted) return;
									const nextTaken = new Set(access.takenDown.keys());
									const prevTaken = controller.store.get().sitesTakenDown;
									if (
										!prevTaken ||
										prevTaken.size !== nextTaken.size ||
										[...nextTaken].some((slug) => !prevTaken.has(slug))
									)
										controller.store.set({ sitesTakenDown: nextTaken });
								} catch {}
								const notePublic = startPublicRead(controller.store);
								let hosting: CompanySiteHostingState | undefined;
								try {
									hosting = await createWebSiteHosting(cloud, controller.profile).read(activeSignal);
								} catch {
									hosting = undefined;
								}
								if (!activeSignal.aborted) notePublic(hosting);
							}
						},
						() => {
							if (activeSignal.aborted) return;
							controller.store.set({
								siteListUnread: true,
								...(controller.store.get().siteList === undefined ? { siteList: [] } : {}),
							});
						},
					)
					.finally(() => {
						sitesInFlight = false;
						if (sitesPending && !activeSignal.aborted && company === controller) {
							sitesPending = false;
							readSites();
						}
					});
			};
			readSites();
			window.addEventListener("focus", readSites, { signal: activeSignal });
			sitesOncePublished = readSitesOncePublished(readSites);
		} else if (state.team && !state.team.capabilities.read && state.siteList === undefined)
			// A member the company's sites are never read for: a site's own page says it can't be shown, not waits.
			controller.store.set({ siteList: [], siteListUnread: true });
		if (sitesRead === controller)
			sitesOncePublished?.(controller.store.get(), surfacesOf(controller)?.state.surfaces ?? []);
		// What's new, read the same way for its entry and badge. A cloud without the read (before 20260930729000), or one
		// that refuses this member, shows no entry; a read that did not answer leaves the entry as it was.
		if (releasesRead !== controller && state.team?.capabilities.read) {
			releasesRead = controller;
			const activeSignal = companyActiveAbort
				? AbortSignal.any([controller.signal, companyActiveAbort.signal])
				: controller.signal;
			const releases = companyReleases(controller).shared;
			let releasesInFlight = false;
			let releasesPending = false;
			const readReleases = () => {
				if (activeSignal.aborted || company !== controller) return;
				if (releasesInFlight) {
					releasesPending = true;
					return;
				}
				releasesInFlight = true;
				void releases
					.list(activeSignal)
					.then(
						(read) => {
							if (!activeSignal.aborted) showReleases(controller, read);
						},
						(error: unknown) => {
							if (!activeSignal.aborted && error instanceof CloudRpcError && (error.missing || error.denied)) {
								if (controller.store.get().whatsNew !== undefined)
									controller.store.set({ whatsNew: undefined });
							}
						},
					)
					.finally(() => {
						releasesInFlight = false;
						if (releasesPending && !activeSignal.aborted && company === controller) {
							releasesPending = false;
							readReleases();
						}
					});
			};
			readReleases();
			window.addEventListener("focus", readReleases, { signal: activeSignal });
		}
		// The company's mail, read the same way: whether it is on (the Mailbox's `mail` need) and what waits for a person.
		if (mail && !state.team?.capabilities.read) {
			mail.dispose();
			mail = undefined;
		}
		if (!mail && state.team?.capabilities.read) {
			// A waiting send's answer runs its agent on the member's model account, chosen as the agent's thread chooses it.
			const accounts = createWebNativeSubscription(
				cloud,
				controller.profile.profileId,
				controller.userId,
				controller.signal,
				() => {
					const now = controller.store.get();
					if (
						disposed ||
						company !== controller ||
						auth.userId !== controller.userId ||
						now.accessLost ||
						!now.team?.capabilities.read
					)
						throw new Error(t("Company access changed."));
				},
			);
			// The company's Digital Post letters are files of its folder, read with the member's own access.
			const mailFolder = (signal: AbortSignal) => {
				const current = () => {
					const now = controller.store.get();
					if (disposed || company !== controller || auth.userId !== controller.userId || now.accessLost)
						throw new Error(t("Company access changed."));
				};
				current();
				const role = controller.store.get().team?.role;
				if (!role) throw new Error(t("Company access changed."));
				return new WebCompanyFiles(cloud, controller.profile, controller.userId, role, signal, current).folder();
			};
			const reader = new CompanyMail(
				controller,
				cloud,
				accounts,
				(read) => {
					if (mail === reader) controller.store.set({ mail: read });
				},
				mailFolder,
			);
			mail = reader;
			void reader.open();
		}
		if (route.section !== "chat") {
			conversation?.dispose();
			conversation = undefined;
			controller.setOpenSession(undefined);
		}
		if (route.section !== "member") {
			memberChat?.view.dispose();
			memberChat = undefined;
		}
		// Where this tab is in the rail, for the other members' rails (a conversation says its own: company.ts).
		controller.setOpenPlace(
			route.section === "surface" && route.id
				? `surface:${route.id.toLowerCase()}`
				: route.section === "interface" && route.id
					? `page:${route.id}`
					: route.section === "app" && route.id
						? `app:${route.id}`
						: route.section === "staff" && route.id
							? `agent:${route.id.toLowerCase()}`
							: route.section === "site" && route.id
								? `site:${route.id}`
								: route.section === "concepts" || route.section === "whats-new"
									? route.section
									: COMPANY_PRESENCE_PLACE,
		);
		// A card's request waits only while its agent's chat is on the way.
		if (route.section !== "chat" && route.section !== "staff") agentPage = undefined;
		if (route.section === "chat") appReturn = routeHash(route);
		if (route.section === "app" || route.section === "concepts") companyApps?.warmIfNeeded();
		if (route.section !== "app" || (appPage && !sameTarget(appPage.target, { kind: "app", name: route.id ?? "" }))) {
			appPage?.dispose();
			appPage = undefined;
		}
		if (route.section !== "concepts") {
			conceptsView?.dispose();
			conceptsView = undefined;
		}
		if (route.section !== "site" || siteView?.company !== controller || siteView.slug !== route.id) {
			siteView?.view.dispose();
			siteView = undefined;
		}
		if (route.section !== "whats-new" || whatsNewPage?.company !== controller) {
			whatsNewPage?.view.dispose();
			whatsNewPage = undefined;
		}
		if (route.section !== "new-program" || newProgramPage?.company !== controller) {
			newProgramPage?.view.dispose();
			newProgramPage = undefined;
		}
		if (route.section !== "surface" || surfaceView?.company !== controller || surfaceView.view.slug !== route.id) {
			if (surfaceView) {
				if (surfaceView.company === controller && !state.accessLost && !disposed) {
					// WHY: Keep recently visited surfaces warm so switching back paints instantly without skeleton flash.
					surfaceView.view.park();
					const key = `${controller.profile.profileId}:${surfaceView.view.slug}`;
					warmSurfaces.delete(key);
					warmSurfaces.set(key, surfaceView.view);
					while (warmSurfaces.size > WARM_SURFACES_MAX) {
						const oldestKey = warmSurfaces.keys().next().value;
						if (!oldestKey) break;
						const evicted = warmSurfaces.get(oldestKey);
						warmSurfaces.delete(oldestKey);
						if (evicted) deferSurfaceDisposal(evicted);
					}
				} else {
					deferSurfaceDisposal(surfaceView.view);
				}
			}
			surfaceView = undefined;
		}
		if (route.section !== "new") {
			newConversation?.dispose();
			newConversation = undefined;
		}
		if (route.section !== "interface") interfaceViewModule.get()?.disposeInterface(main);
		const interfaceWrites = (): InterfaceWrites => ({
			mailManage: () => {
				const environment = {
					profileId: controller.profile.profileId,
					environmentId: controller.profile.environmentId,
				};
				const keys = createDigitalPostKeys(cloud, environment);
				const connectors = createWebConnectors(cloud, controller.profile);
				const accounts = createWebNativeSubscription(
					cloud,
					controller.profile.profileId,
					controller.userId,
					controller.signal,
					companyCurrent,
				);
				return {
					hooks: createWebEventHooks(cloud, environment),
					digitalPost: {
						read: () => readDigitalPost(cloud, environment.environmentId),
						save: (apiKey, existingSecretId, abort) => keys.save(apiKey, existingSecretId, abort),
						disconnect: (secretId, abort) => keys.disconnect(secretId, abort),
					},
					// Who answers an address: the agent's routine that starts on its mail, written as the member's own
					// save, on one of the member's own model accounts.
					routines: createWebRoutines(cloud, controller.profile, controller.signal, companyCurrent, () =>
						memberFolder(companyCurrent, t("Company access changed.")),
					),
					accounts: (signal) => accounts.listConnections(signal),
					google: {
						begin: (signal, mailboxId) => connectors.beginMailboxSignIn(signal, mailboxId),
						finish: (outcome, signal) => connectors.finishSignIn(outcome, signal),
						pause: (mailboxId, paused, signal) => pauseGoogleMailbox(cloud, mailboxId, paused, signal),
						existing: async (signal) => reusableGoogleMailAccounts(await connectors.list(signal)),
						connectExisting: (secretId, signal) =>
							connectExistingGoogleMailbox(cloud, environment.environmentId, secretId, signal),
						go: (url) => location.assign(url),
					},
				};
			},
			bankConnection: () => createWebConnectors(cloud, controller.profile),
			data: () => companyDatabases,
			dataAsk: (agentId, note) => {
				let accounts = askAccounts.get(controller);
				if (!accounts) {
					accounts = createWebNativeSubscription(
						cloud,
						controller.profile.profileId,
						controller.userId,
						controller.signal,
						companyCurrent,
					);
					askAccounts.set(controller, accounts);
				}
				return tellAgent(controller, accounts, agentId, note);
			},
		});
		const liveWebsite = (slug: string) =>
			controller.store
				.get()
				.siteList?.find((site) => site.slug === slug && site.kind === "files" && site.state === "live");
		const surfaceMount = (surface: SurfaceSummary, signal: AbortSignal): SurfaceMount | undefined => {
			if (surface.archetype === "live_build" && surface.siteSlug) {
				const slug = surface.siteSlug;
				const website = () => liveWebsite(slug);
				if (!website()) return undefined;
				const loadedSite = siteViewModule.get();
				if (!loadedSite) {
					void siteViewModule.load().then(() => {
						if (!disposed && !signal.aborted) render();
					});
					return undefined;
				}
				const sites = createWebSites(cloud, controller.profile);
				const view = new loadedSite.SiteView(
					{
						site: website,
						pass: (site, passSignal) => sites.memberPass(site, passSignal),
						timeZone: () => controller.store.get().team?.timeZone,
						siteAlone: true,
					},
					slug,
					AbortSignal.any([controller.signal, signal]),
				);
				let wasPublishing = surface.publishStatus === "publishing";
				let lastUnpublished = surface.unpublishedChangeCount;
				return {
					el: h("div", { class: "surface-site is-alone" }, view.el),
					update: () => {
						view.update();
						const latest = surfacesOf(controller)?.state.surfaces.find((item) => item.id === surface.id);
						if (!latest) return;
						const nowPublishing = latest.publishStatus === "publishing";
						const publishFinished =
							(wasPublishing && !nowPublishing && latest.publishStatus !== "failed") ||
							(!wasPublishing && !nowPublishing && lastUnpublished > 0 && latest.unpublishedChangeCount === 0);
						wasPublishing = nowPublishing;
						lastUnpublished = latest.unpublishedChangeCount;
						if (publishFinished) view.reload();
					},
					park: () => view.park(),
					activate: () => view.activate(),
					dispose: () => view.dispose(),
				};
			}
			if (surface.archetype !== "ops") return undefined;
			const page =
				surface.slug === "inbox" || surface.icon === "mail"
					? "mailbox"
					: surface.slug === "money" || surface.icon === "coin" || surface.icon === "bank"
						? "bank"
						: surface.slug === "data" || surface.icon === "database"
							? "data"
							: undefined;
			if (page) {
				const el = h("div", { class: "surface-ops" });
				let closed = false;
				const update = () => {
					if (closed) return;
					const mod = interfaceViewModule.get();
					if (!mod) {
						void interfaceViewModule.load().then(() => {
							if (!closed && !disposed && !signal.aborted) update();
						});
						return;
					}
					mod.renderInterface(el, controller, page, writesUnderSurfaceBar(interfaceWrites()));
				};
				return {
					el,
					update,
					dispose: () => {
						closed = true;
						interfaceViewModule.get()?.disposeInterface(el);
						el.replaceChildren();
					},
				};
			}
			if (!controller.store.get().team) return undefined;
			const el = h("div", { class: "surface-files" });
			let shown: { browser: CompanyFolderBrowser; stop: AbortController; authority: string } | undefined;
			let closedFiles = false;
			const close = () => {
				closedFiles = true;
				if (!shown) return;
				if (filesShown?.browser === shown.browser) filesShown = undefined;
				shown.stop.abort();
				shown.browser.dispose();
				shown = undefined;
			};
			const draw = () => {
				if (closedFiles) return;
				const team = controller.store.get().team;
				const authority =
					team && !controller.store.get().accessLost
						? JSON.stringify([team.role, team.capabilities.read, team.capabilities.write])
						: "";
				if (shown?.authority === authority) {
					if (filesPending?.owner === controller) {
						shown.browser.reveal(filesPending.path);
						filesPending = undefined;
					}
					return;
				}
				if (shown) {
					if (filesShown?.browser === shown.browser) filesShown = undefined;
					shown.stop.abort();
					shown.browser.dispose();
					shown = undefined;
				}
				el.replaceChildren();
				if (!team || !authority) return;
				const folderMod = companyFolderModule.get();
				if (!folderMod) {
					void companyFolderModule.load().then(() => {
						if (!closedFiles && !disposed && !signal.aborted) draw();
					});
					return;
				}
				const stop = new AbortController();
				const browser = new folderMod.CompanyFolderBrowser(
					el,
					new WebCompanyFiles(
						cloud,
						controller.profile,
						controller.userId,
						team.role,
						AbortSignal.any([controller.signal, signal, stop.signal]),
						companyCurrent,
						team.capabilities.write,
					),
					() => ({
						me: controller.userId,
						members: controller.store.get().team?.members ?? [],
						staff: controller.store.get().staff,
					}),
					{
						usage: () => api.getCompanyFile(controller.profile.environmentId),
						listingCache: folderListingCacheFor(controller, authority),
					},
				);
				shown = { browser, stop, authority };
				filesShown = { owner: controller, browser };
				if (filesPending?.owner === controller) browser.reveal(filesPending.path);
				void browser.open().then(
					() => {
						if (filesPending?.owner === controller) filesPending = undefined;
					},
					() => undefined,
				);
			};
			draw();
			return { el, update: draw, activate: () => shown?.browser.refreshUsage(), dispose: close };
		};
		switch (route.section) {
			case "new": {
				if (!newConversation) {
					const current = captureRoute();
					const check = () => {
						if (!current() || company !== controller || controller.store.get().accessLost)
							throw new Error(t("Conversation access changed."));
					};
					const startConversation = createConversationStarter({
						company: controller,
						native: createWebNativeSubscription(
							cloud,
							controller.profile.profileId,
							controller.userId,
							controller.signal,
							check,
						),
						current: check,
						folder: (signal) => {
							check();
							const team = controller.store.get().team;
							if (!team?.capabilities.authorize)
								throw new Error(t("Only an owner or admin can create a group chat."));
							return new WebCompanyFiles(cloud, controller.profile, controller.userId, team.role, signal, () => {
								check();
								if (!controller.store.get().team?.capabilities.authorize)
									throw new Error(t("Group chat creation access changed."));
							}).folder();
						},
						send: async (sessionId, text, signal) => {
							check();
							const attempt = { sessionId };
							startingSession = attempt;
							try {
								return await controller.sendPrompt(sessionId, text, signal);
							} finally {
								// A disposed composer may finish refreshing after a newer send starts.
								if (startingSession === attempt) startingSession = undefined;
							}
						},
					});
					const loadedNewConversation = newConversationModule.get();
					if (!loadedNewConversation) {
						showThreadSkeleton(t("Opening conversation"));
						void newConversationModule.load().then(() => {
							if (!disposed) render();
						});
						return;
					}
					newConversation = new loadedNewConversation.NewConversationView(
						controller,
						{ ...agentActions, startConversation, ...workspaceActions },
						() => navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }),
						() => setNavigationOpen(!navigationOpen),
					);
					replace(main, newConversation.el);
					if (!frame.inert) newConversation.focus();
				}
				newConversation.setNavigationOpen(navigationOpen);
				return;
			}
			case "home": {
				// WHY: Resolve Co-Founder home once org, team, staff, and sessions load instead of waiting on sidebar/groups/activity.
				const homeReady =
					!state.loading ||
					(state.organizationState !== "loading" &&
						state.team !== undefined &&
						state.staffLoaded === true &&
						state.sessionsLoaded === true);
				if (!homeReady) {
					showThreadSkeleton(t("Opening company"));
					return;
				}
				if (!homeReason) {
					showThreadSkeleton(t("Opening the Co-Founder"));
					void resolveHome(controller);
					return;
				}
				const first = state.hierarchy.primary.find((node) => node.kind === "agent");
				// One sentence around the agent's link, so Danish can order it its own way.
				const [before, after] = t("Start with {agent} or pick a conversation in the rail.").split("{agent}");
				replace(
					main,
					h(
						"section",
						{ class: "page" },
						h("h1", null, companyNameText(controller.profile.profileName)),
						notice("neutral", homeReason),
						first
							? h(
									"p",
									null,
									before,
									h(
										"a",
										{ href: `#/c/${controller.profile.profileId}/staff/${first.canonicalId}` },
										first.label,
									),
									after,
								)
							: h("p", { class: "muted" }, t("This company has no staff conversations yet.")),
					),
				);
				return;
			}
			case "chat": {
				if (!conversation || conversation.sessionId !== route.id) {
					conversation?.dispose();
					const checkConversationAccess = (sessionId = route.id) => {
						const selected = currentRoute(),
							state = controller.store.get();
						const session = state.sessions.find((item) => item.sessionId === sessionId);
						if (
							disposed ||
							company !== controller ||
							auth.userId !== controller.userId ||
							state.accessLost ||
							!state.team?.capabilities.read ||
							!session ||
							session.profileId !== controller.profile.profileId ||
							session.environmentId !== controller.profile.environmentId ||
							selected.name !== "company" ||
							selected.profileId !== controller.profile.profileId ||
							selected.section !== "chat" ||
							selected.id !== sessionId
						)
							throw new Error(t("Conversation access changed."));
					};
					conversation = new ConversationView(
						controller,
						route.id ?? "",
						{
							sendMessage: (id, text, signal) => controller.sendPrompt(id, text, signal),
							// One read serves the company's threads for a minute, so it lives with the company,
							// not with this thread; a thread that closes simply stops listening.
							skills: async (agentId) => {
								checkConversationAccess();
								const lists = skillLists.get(controller) ?? new SkillLists();
								skillLists.set(controller, lists);
								const current = () => {
									const state = controller.store.get();
									if (
										disposed ||
										company !== controller ||
										auth.userId !== controller.userId ||
										state.accessLost ||
										!state.team?.capabilities.read
									)
										throw new Error(t("Conversation access changed."));
								};
								return lists.get(agentId, async () => {
									current();
									const role = controller.store.get().team?.role;
									if (!role) throw new Error(t("Conversation access changed."));
									// Read with the member's own access to the company's folder, as the Company File page reads.
									const folder = new WebCompanyFiles(
										cloud,
										controller.profile,
										controller.userId,
										role,
										controller.signal,
										current,
									).folder();
									return loadSkillSuggestions(folder, agentId, controller.signal);
								});
							},
							sessionModel: createWebSessionModel(
								cloud,
								controller.userId,
								controller.signal,
								checkConversationAccess,
							),
							updateGroup: createGroupUpdater({
								company: controller,
								current: checkConversationAccess,
								folder: (signal) => {
									checkConversationAccess();
									const team = controller.store.get().team;
									if (!team?.capabilities.authorize)
										throw new Error(t("Only an owner or admin can edit group chats."));
									return new WebCompanyFiles(
										cloud,
										controller.profile,
										controller.userId,
										team.role,
										signal,
										() => {
											checkConversationAccess();
											if (!controller.store.get().team?.capabilities.authorize)
												throw new Error(t("Group chat editing access changed."));
										},
									).folder();
								},
							}),
							nativeSubscription: createWebNativeSubscription(
								cloud,
								controller.profile.profileId,
								controller.userId,
								controller.signal,
								checkConversationAccess,
							),
							runControl: createWebSessionRunControl(
								cloud,
								controller.userId,
								controller.signal,
								checkConversationAccess,
							),
							previewAttachment: async (messageId, index, viewSignal) =>
								await withAbortScopes([controller.signal, viewSignal], async (signal) => {
									const check = () => {
										signal.throwIfAborted();
										const selected = currentRoute(),
											state = controller.store.get();
										const session = state.sessions.find((item) => item.sessionId === route.id);
										if (
											disposed ||
											company !== controller ||
											auth.userId !== controller.userId ||
											state.accessLost ||
											!state.team?.capabilities.read ||
											!session ||
											session.profileId !== controller.profile.profileId ||
											session.environmentId !== controller.profile.environmentId ||
											selected.name !== "company" ||
											selected.profileId !== controller.profile.profileId ||
											selected.section !== "chat" ||
											selected.id !== route.id
										)
											throw new Error(t("Attachment access changed."));
									};
									check();
									const message = controller
										.conversation(route.id!)
										.get()
										.projection.items.find((item) => item.id === messageId);
									const ref =
										message?.kind === "member" &&
										!message.pending &&
										Number.isSafeInteger(index) &&
										index >= 0
											? message.attachments?.[index]?.reference
											: undefined;
									if (!ref) throw new Error(t("This attachment is not available for preview."));
									const bytes = await createWebSessionAttachments(
										cloud,
										controller.userId,
										signal,
										check,
									).read(route.id!, messageId, ref, signal);
									check();
									return new Blob([new Uint8Array(bytes)], { type: ref.mediaType });
								}),
							// Routines are files (QorperaOS/agents/<handle>/routines/<key>.md): the editor and the switch
							// write them through the member's own folder client, with the same checks as every other routine
							// call.
							routines: createWebRoutines(
								cloud,
								controller.profile,
								controller.signal,
								checkConversationAccess,
								() => memberFolder(() => checkConversationAccess(), t("Conversation access changed.")),
							),
							eventHooks: createWebEventHooks(cloud, controller.profile),
							// No Undo on an agent's interface change: agents don't make pages (Interfaces C6a), and the save
							// check refuses an agent's change under QorperaOS/interfaces/ or to a table's definition (C6c).
							// A message is erased for the whole company through the member's own route; the route checks the
							// role, and the thread offers it to the roles that route takes (M3c).
							folderImage: cardImage,
							folderApp: cardApp,
							decisions: questionsHost(),
							codeReleases: releaseDesk(true),
							companySites: { client: createWebSites(cloud, controller.profile), canManage: managesSites },
							messageErases: {
								request: (sessionId, eventId, signal) =>
									messageErases(() => checkConversationAccess(sessionId)).request(sessionId, eventId, signal),
								status: (erase, signal) =>
									messageErases(() => checkConversationAccess(erase.sessionId)).status(erase, signal),
							},
							...agentActions,
							...workspaceActions,
							computerPanels,
						},
						() => setNavigationOpen(!navigationOpen),
					);
					replace(main, conversation.el);
					syncAppCardObserver(conversation.el);
					decorateAppCards([conversation.el]);
					// Not while Settings covers the frame (a redraw behind it after a language change).
					if (!frame.inert) conversation.focus();
				} else {
					if (!main.contains(conversation.el)) replace(main, conversation.el);
					conversation.update();
					syncAppCardObserver(conversation.el);
				}
				conversation.setNavigationOpen(navigationOpen);
				// Asked for from an agent's card before its chat was open: shown once the chat knows its agent.
				if (
					agentPage &&
					(Date.now() > agentPage.until || conversation.show(agentPage.agentId, agentPage.page, true))
				)
					agentPage = undefined;
				return;
			}
			case "member": {
				// This member's chat with another member of the company. A link to oneself, or to no member's id, leads home.
				const userId = route.id?.toLowerCase() ?? "";
				if (!UUID_PATTERN.test(userId) || userId === controller.userId) {
					navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }, true);
					return;
				}
				if (!state.team) {
					showThreadSkeleton(t("Opening company"));
					return;
				}
				if (memberChat?.view.userId !== userId || memberChat.company !== controller) {
					const loadedMemberChat = memberChatModule.get();
					if (!loadedMemberChat) {
						showThreadSkeleton(t("Opening company"));
						void memberChatModule.load().then(() => {
							if (!disposed) render();
						});
						return;
					}
					memberChat?.view.dispose();
					memberChat = {
						view: new loadedMemberChat.MemberChatView(controller, userId, () =>
							setNavigationOpen(!navigationOpen),
						),
						company: controller,
					};
					replace(main, memberChat.view.el);
					if (!frame.inert) memberChat.view.focus();
				} else {
					if (!main.contains(memberChat.view.el)) replace(main, memberChat.view.el);
					memberChat.view.update();
				}
				memberChat.view.setNavigationOpen(navigationOpen);
				return;
			}
			case "app": {
				// An agent's app as a page of its own, in the frame the app's own folder fills (Jonas, 8 November 2026). It
				// stays as it is through the company's redraws; its page follows the folder itself. A concept of the
				// company's product opens in the Concepts viewer instead, once the apps are read that say it is one.
				if (route.id && isConcept(controller, route.id)) {
					navigate(
						{ name: "company", profileId: controller.profile.profileId, section: "concepts", id: route.id },
						true,
					);
					return;
				}
				if (appPage && main.contains(appPage.el)) return;
				const home = `#/c/${controller.profile.profileId}`;
				// A deep link or a reload: the page waits for the company's first read, so its header names the agent that
				// made it and the app's first `agents()` gets the whole roster (the staff read may land after the folder's).
				if (state.loading) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					return;
				}
				if (!companyApps) {
					replace(
						main,
						h(
							"section",
							{ class: "page" },
							notice("danger", t("This can't be opened right now.")),
							h("a", { href: home }, t("Back to the company")),
						),
					);
					return;
				}
				appPage?.dispose();
				appPage = new AppPanel(
					panelHost(),
					{ kind: "app", name: route.id ?? "" },
					{
						kind: "page",
						back: appReturn
							? { href: appReturn, label: t("Back to the conversation") }
							: { href: home, label: t("Back to the company") },
					},
				);
				replace(main, appPage.el);
				syncAppCardObserver(appPage.el);
				decorateAppCards([appPage.el]);
				if (!frame.inert) appPage.focus();
				return;
			}
			case "concepts": {
				// The company's concepts, full screen with a side panel to pick one (Jonas, 8 November 2026). The viewer
				// stays through the company's redraws and a change of concept: only the stage's frame changes.
				const home = `#/c/${controller.profile.profileId}`;
				if (state.loading) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					return;
				}
				if (!companyApps) {
					replace(
						main,
						h(
							"section",
							{ class: "page" },
							notice("danger", t("This can't be opened right now.")),
							h("a", { href: home }, t("Back to the company")),
						),
					);
					return;
				}
				// An app the route names that is no concept opens as a page of its own.
				const named = route.id ? (state.apps ?? []).find((app) => app.name === route.id) : undefined;
				if (route.id && named?.manifest && !named.manifest.concept) {
					navigate(
						{ name: "company", profileId: controller.profile.profileId, section: "app", id: route.id },
						true,
					);
					return;
				}
				if (conceptsView && main.contains(conceptsView.el)) {
					conceptsView.update(state.apps ?? [], route.id);
					return;
				}
				const loadedConcepts = conceptsModule.get();
				if (!loadedConcepts) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					void conceptsModule.load().then(() => {
						if (!disposed) render();
					});
					return;
				}
				conceptsView?.dispose();
				const reader = cardImage;
				conceptsView = new loadedConcepts.ConceptsView(
					{
						panel: panelHost(),
						profileId: controller.profile.profileId,
						companyName: () => controller.profile.profileName,
						back: () => appReturn ?? home,
						picture: (path, signal) => reader(path, signal),
					},
					state.apps ?? [],
					route.id,
				);
				replace(main, conceptsView.el);
				syncAppCardObserver(conceptsView.el);
				decorateAppCards([conceptsView.el]);
				if (!frame.inert) conceptsView.focus();
				return;
			}
			case "staff": {
				if (state.loading) {
					showThreadSkeleton(t("Opening company"));
					return;
				}
				if (routeError) {
					replace(main, notice("danger", routeError));
					return;
				}
				showThreadSkeleton(t("Opening conversation"));
				void resolveStaff(controller, route.id ?? "");
				return;
			}
			case "file": {
				navigate(
					{
						name: "company",
						profileId: controller.profile.profileId,
						section: "surface",
						id: filesSlug(controller),
					},
					true,
				);
				return;
			}
			case "interface": {
				const loadedInterface = interfaceViewModule.get();
				if (!loadedInterface) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					void interfaceViewModule.load().then(() => {
						if (!disposed) render();
					});
					return;
				}
				loadedInterface.renderInterface(main, controller, route.id ?? "", interfaceWrites());
				return;
			}
			case "site": {
				// One of the company's websites, live, with its numbers (company views step 4): the site in a frame the member
				// is let into without its password, and the numbers watched while it shows.
				const slug = route.id ?? "";
				const website = () =>
					controller.store
						.get()
						.siteList?.find((site) => site.slug === slug && site.kind === "files" && site.state === "live");
				if (!siteView) {
					// A deep link or a reload: the page waits for the company's sites to be read.
					if (state.siteList === undefined) {
						if (!main.querySelector(":scope > .page > .skeleton-page"))
							replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
						return;
					}
					if (!website()) {
						replace(
							main,
							h(
								"section",
								{ class: "page" },
								notice("danger", t("This website can't be shown here right now.")),
								h("a", { href: `#/c/${controller.profile.profileId}` }, t("Back to the company")),
							),
						);
						return;
					}
					const loadedSite = siteViewModule.get();
					if (!loadedSite) {
						if (!main.querySelector(":scope > .page > .skeleton-page"))
							replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
						void siteViewModule.load().then(() => {
							if (!disposed) render();
						});
						return;
					}
					const sites = createWebSites(cloud, controller.profile);
					const view = new loadedSite.SiteView(
						{
							site: website,
							pass: (site, signal) => sites.memberPass(site, signal),
							numbers: numbersHost(),
							timeZone: () => controller.store.get().team?.timeZone,
						},
						slug,
						controller.signal,
					);
					siteView = { company: controller, slug, view, el: h("section", { class: "page site-page" }, view.el) };
				}
				siteView.view.update();
				if (siteView.el.parentElement !== main) replace(main, siteView.el);
				return;
			}
			case "surface": {
				const surfaces = surfacesOf(controller);
				if (!surfaces) {
					if (surfacesDisabledOf(controller)) {
						navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }, true);
					} else if (surfacesStoreOf(controller)?.state.source === "loading") {
						if (!main.querySelector(":scope > .page > .skeleton-page"))
							replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					}
					return;
				}
				if (!surfaceView) {
					const slug = route.id ?? "";
					const warmKey = `${controller.profile.profileId}:${slug}`;
					const cachedView = warmSurfaces.get(warmKey);
					if (cachedView) {
						warmSurfaces.delete(warmKey);
						surfaceView = { company: controller, view: cachedView };
						replace(main, cachedView.el);
						cachedView.activate();
						if (!frame.inert) cachedView.focus();
						return;
					}
				}
				if (!surfaceView) {
					const loadedSurface = surfaceViewModule.get();
					if (!loadedSurface) {
						if (!main.querySelector(":scope > .page > .skeleton-page"))
							replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
						void surfaceViewModule.load().then(() => {
							if (!disposed) render();
						});
						return;
					}
					const loadStudioFiles = async (
						surface: SurfaceSummary,
						signal: AbortSignal,
					): Promise<Readonly<Record<string, string>>> => {
						const roots = surfaceFolderRoots(surface);
						const team = controller.store.get().team;
						if (!roots.length || !team) return {};
						const readSignal = AbortSignal.any([controller.signal, signal]);
						const folder = new WebCompanyFiles(
							cloud,
							controller.profile,
							controller.userId,
							team.role,
							readSignal,
							companyCurrent,
							team.capabilities.write,
						).folder();
						return (await readSurfaceFolderFiles(folder, roots, readSignal)).files;
					};
					const siteHosting = hostingNotingPublic(
						controller.store,
						createWebSiteHosting(cloud, controller.profile),
					);
					const view = new loadedSurface.SurfaceView(
						{
							store: surfaces,
							mount: surfaceMount,
							siteHosting: (surface) => {
								if (isLocalSurfaceId(surface.id) || !surface.siteSlug) return undefined;
								const site = liveWebsite(surface.siteSlug);
								return site ? { siteId: site.id, client: siteHosting } : undefined;
							},
							managesSites,
							canWrite: () => controller.store.get().team?.capabilities.write === true,
							isSiteLive: (surface) => siteServed(controller.store.get(), surface),
							isMountLoading: (surface) => {
								const currentState = controller.store.get();
								if (currentState.accessLost) return false;
								if (surface.archetype === "live_build" && surface.siteSlug)
									return currentState.siteList === undefined;
								if (surface.archetype === "studio" && !isLocalSurfaceId(surface.id)) return !currentState.team;
								if (surface.archetype === "ops") {
									const isBuiltInPage =
										surface.slug === "inbox" ||
										surface.icon === "mail" ||
										surface.slug === "money" ||
										surface.icon === "coin" ||
										surface.icon === "bank" ||
										surface.slug === "data" ||
										surface.icon === "database";
									if (!isBuiltInPage) return !currentState.team;
								}
								return false;
							},
							openMigration: () => {
								void lazyQuickModule
									.load()
									.then(({ surfaceMigrationSheet: { openMigrationSheet } }) => openMigrationSheet(surfaces));
							},
							loadStudioFiles,
							live: { numbers: numbersHost(), data: dataHost() },
						},
						route.id ?? "",
					);
					surfaceView = { company: controller, view };
				}
				if (surfaceView.view.el.parentElement !== main) {
					replace(main, surfaceView.view.el);
					if (!frame.inert) surfaceView.view.focus();
				}
				surfaceView.view.update();
				return;
			}
			case "new-program": {
				if (state.team?.capabilities.write !== true) {
					if (!state.loading && state.team)
						navigate({ name: "company", profileId: controller.profile.profileId, section: "home" }, true);
					else if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
					return;
				}
				if (!newProgramPage) {
					const loadedProgram = newProgramModule.get();
					if (!loadedProgram) {
						if (!main.querySelector(":scope > .page > .skeleton-page"))
							replace(main, h("section", { class: "page" }, pageSkeleton(t("Opening company"))));
						void newProgramModule.load().then(() => {
							if (!disposed) render();
						});
						return;
					}
					const view = new loadedProgram.NewProgramPage(programAdds());
					newProgramPage = { company: controller, view };
				}
				const shown = newProgramPage.view.el.parentElement;
				if (shown?.parentElement !== main)
					replace(main, h("section", { class: "page program-new-page" }, newProgramPage.view.el));
				return;
			}
			case "whats-new": {
				if (!whatsNewPage) {
					const loadedWhatsNew = whatsNewModule.get();
					if (!loadedWhatsNew) {
						if (!main.querySelector(":scope > .page > .skeleton-page"))
							replace(main, h("section", { class: "page" }, pageSkeleton(t("What's new"))));
						void whatsNewModule.load().then(() => {
							if (!disposed) render();
						});
						return;
					}
					const desk = releaseDesk();
					const view = new loadedWhatsNew.WhatsNewView(controller, desk.client, controller.signal, desk.options);
					whatsNewPage = {
						company: controller,
						view,
						el: h(
							"section",
							{ class: "page whats-new-page" },
							h(
								"header",
								{ class: "sites-page-heading" },
								interfaceEmblem("spark", 40),
								h("div", null, h("h1", null, t("What's new"))),
							),
							view.el,
						),
					};
				}
				whatsNewPage.view.update();
				if (whatsNewPage.el.parentElement !== main) replace(main, whatsNewPage.el);
				return;
			}
			case "team": {
				const loadedTeam = teamViewModule.get();
				if (!loadedTeam) {
					if (!main.querySelector(":scope > .page > .skeleton-page"))
						replace(main, h("section", { class: "page" }, pageSkeleton(t("Team"))));
					void teamViewModule.load().then(() => {
						if (!disposed) render();
					});
					return;
				}
				loadedTeam.renderTeam(
					api,
					controller,
					main,
					teamFeedback,
					(next) => {
						if (!current() || company !== controller) return;
						teamFeedback = next;
						render();
					},
					{
						onCompanyRemoved: companyRemovedHandler(),
						addFriend: openFriends,
						openSubscriptions: () => openSettings("ai-subscriptions"),
					},
				);
				return;
			}
		}
	}

	if (options?.localeReady) {
		// WHY: Keep the boot skeleton until the Danish chunk lands while auth.start() and hub.refresh() overlap in parallel.
		void options.localeReady.finally(() => {
			localePending = false;
			if (disposed) return;
			applyLanguage();
			shownLocale = presentationLocale();
			rail.setAttribute("aria-label", t("Company navigation"));
			backdrop.setAttribute("aria-label", t("Close company navigation"));
			reopenRailBtn.setAttribute("aria-label", t("Show sidebar"));
			reopenRailBtn.title = t("Show sidebar");
			railLayout.relabel();
			render();
		});
	}
	if (hasWebsiteIdea()) auth.showStep("create");
	void auth.start().then(
		() => render(),
		(error) => {
			if (disposed) return;
			startError = h(
				"section",
				{ class: "page" },
				notice("danger", t("The cloud could not be reached. {error}", { error: describeError(error) })),
				button(t("Try again"), () => location.reload()),
			);
			render();
		},
	);

	return () => {
		disposed = true;
		appCardObserver.disconnect();
		railLayout.dispose();
		window.removeEventListener("languagechange", onLanguage);
		window.removeEventListener("qorpera-language-change", onLanguage);
		window.removeEventListener("qorpera-time-zone-change", redrawScreens);
		unwatchTheme();
		unwatchBrowserBar();
		closeSettings(false);
		closeFeedback(false);
		closeFriends(false);
		online.stop();
		auth.dispose();
		hub.dispose();
		teardownFounding();
		teardownCompany(true);
		clearShellCompanyState();
		accountPayments?.dispose();
		pictures.reset();
		if (personPictures() === pictures) setPersonPictures(undefined);
		logos.dispose();
		if (companyLogos() === logos) setCompanyLogos(undefined);
		wordmarks.dispose();
		if (companyWordmarks() === wordmarks) setCompanyWordmarks(undefined);
		window.removeEventListener("hashchange", onRouteChange);
		root.removeEventListener("click", onFolderLink);
		window.removeEventListener("keydown", onEscape);
		window.removeEventListener("resize", syncNavigation);
		versionWatch.abort();
	};
}

/** The query keys qorpera.com's box sends (landing/src/site/site.js): the idea, and the kind of company picked.
 * "kind", not "type": the sign-in callback takes a type parameter. */
export const WEBSITE_KEYS = ["ide", "idea", "kind"] as const;
/** How long a card's request for its agent's computer waits for that agent's chat to open. */
const AGENT_PAGE_WAIT_MS = 20_000;

/** qorpera.com's arrow opens `app.qorpera.com/?ide=…&kind=…`; a link may also say `#/new?idea=…`. What it carries
 * is kept for the new-company box (a sign-in may come first), the page goes to that box, and the words leave the
 * address at once, so they never stay in the history or a copied link. */
function holdWebsiteIdea(): void {
	const route = currentRoute();
	const url = new URL(location.href);
	const fromLink = route.name === "new" && location.hash !== routeHash(route);
	const fromQuery = WEBSITE_KEYS.some((key) => url.searchParams.has(key));
	if (!fromLink && !fromQuery) return;
	const idea =
		(route.name === "new" ? route.idea : undefined) || url.searchParams.get("ide") || url.searchParams.get("idea");
	const kind = url.searchParams.get("kind");
	keepWebsiteIdea({ ...(idea ? { idea } : {}), ...(kind ? { kind } : {}) });
	for (const key of WEBSITE_KEYS) url.searchParams.delete(key);
	url.hash = routeHash({ name: "new" });
	history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
