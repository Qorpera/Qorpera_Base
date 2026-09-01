import { AuthController } from "./app/auth.ts";
import { CompanyController } from "./app/company.ts";
import { currentRoute, navigate, type Route } from "./app/router.ts";
import { debounce } from "./app/state.ts";
import { type AccountViewState, renderAccount } from "./app/views/account.ts";
import { ApprovalsView } from "./app/views/approvals.ts";
import { CloudCheckView } from "./app/views/cloudcheck.ts";
import { CompanyFileController, renderCompanyFile } from "./app/views/companyfile.ts";
import { ConversationView } from "./app/views/conversation.ts";
import { HubController, renderHub } from "./app/views/hub.ts";
import { renderOrganization } from "./app/views/organization.ts";
import { renderRail, renderTopbar } from "./app/views/shell.ts";
import { renderSignIn } from "./app/views/signin.ts";
import { renderTeam } from "./app/views/team.ts";
import { CloudApi } from "./cloud/api.ts";
import { createCloud, describeError } from "./cloud/client.ts";
import { resolveCloudConfig } from "./cloud/config.ts";
import type { HostedProfile } from "./cloud/types.ts";
import { h, notice, replace, spinner } from "./ui/dom.ts";

/* Entry point. One cloud client, one auth controller, one company controller
 * at a time. The route decides the view; every view renders from cloud state
 * and re-renders on store changes. */

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

const cloud = createCloud(resolveCloudConfig());
const api = new CloudApi(cloud);
const auth = new AuthController(cloud);
const hub = new HubController(api);

const topbar = h("header", { class: "topbar" });
const rail = h("aside", { class: "rail", "aria-label": "Company navigation" });
const main = h("main", { class: "main" });
const frame = h("div", { class: "frame" }, topbar, h("div", { class: "body" }, rail, main));

let company: CompanyController | undefined;
let companyFile: CompanyFileController | undefined;
let conversation: ConversationView | undefined;
let approvals: ApprovalsView | undefined;
let cloudCheck: CloudCheckView | undefined;
let profiles: HostedProfile[] = [];
let teamFeedback: { message?: string; error?: string } = {};
let accountState: AccountViewState = {};
let unsubscribeCompany: (() => void) | undefined;
let resolvingHome = false;
let homeReason: string | undefined;

const render = debounce(() => void draw(), 10);

auth.store.subscribe(() => render());
hub.store.subscribe(() => {
	profiles = hub.store.get().profiles;
	render();
});
window.addEventListener("hashchange", () => render());

function teardownCompany(): void {
	unsubscribeCompany?.();
	company?.stop();
	company = undefined;
	companyFile = undefined;
	conversation = undefined;
	approvals = undefined;
	homeReason = undefined;
	teamFeedback = {};
}

async function ensureCompany(profileId: string): Promise<CompanyController | undefined> {
	if (company?.profile.profileId === profileId) return company;
	teardownCompany();
	let profile = profiles.find((item) => item.profileId === profileId);
	if (!profile) {
		await hub.refresh();
		profile = hub.store.get().profiles.find((item) => item.profileId === profileId);
	}
	const userId = auth.userId;
	if (!profile || !userId) return undefined;
	company = new CompanyController(api, profile, userId);
	companyFile = new CompanyFileController(api, company);
	unsubscribeCompany = company.store.subscribe(() => render());
	void company.start();
	return company;
}

async function resolveHome(controller: CompanyController): Promise<void> {
	if (resolvingHome) return;
	resolvingHome = true;
	try {
		const state = controller.store.get();
		if (state.loading && state.organizationState === "loading") return;
		const result = await controller.openCofounderConversation();
		if (result.sessionId) {
			navigate(
				{ name: "company", profileId: controller.profile.profileId, section: "chat", id: result.sessionId },
				true,
			);
			return;
		}
		homeReason = result.reason;
		render();
	} finally {
		resolvingHome = false;
	}
}

async function resolveStaff(controller: CompanyController, staffId: string): Promise<void> {
	const agent = controller.staffById(staffId);
	if (!agent) return;
	try {
		const sessionId = await controller.openStaffConversation(agent);
		navigate({ name: "company", profileId: controller.profile.profileId, section: "chat", id: sessionId }, true);
	} catch (error) {
		replace(
			main,
			h("section", { class: "page" }, h("h1", null, agent.displayName), notice("neutral", describeError(error))),
		);
	}
}

async function draw(): Promise<void> {
	const authState = auth.store.get();
	if (!authState.ready) {
		replace(root!, spinner("Connecting to the cloud"));
		return;
	}
	if (!authState.session) {
		teardownCompany();
		const container = h("div", { class: "centered" });
		replace(root!, container);
		renderSignIn(auth, container);
		return;
	}
	if (!root!.contains(frame)) replace(root!, frame);
	const route: Route = currentRoute();
	if (route.name !== "company") {
		teardownCompany();
		rail.hidden = true;
		renderTopbar(topbar, { profiles, user: authState.user, route }, undefined);
		if (route.name === "hub") {
			if (hub.store.get().loading && !profiles.length) void hub.refresh();
			renderHub(hub, main);
		} else if (route.name === "account") {
			renderAccount(auth, api, main, accountState, (next) => {
				accountState = next;
				render();
			});
		} else if (route.name === "cloud-check") {
			cloudCheck ??= new CloudCheckView(cloud);
			replace(main, cloudCheck.el);
		}
		return;
	}
	const controller = await ensureCompany(route.profileId);
	if (!controller) {
		rail.hidden = true;
		renderTopbar(topbar, { profiles, user: authState.user, route }, undefined);
		replace(
			main,
			h(
				"section",
				{ class: "page" },
				notice("danger", "This company is not available to your account."),
				h("a", { href: "#/" }, "Back to companies"),
			),
		);
		return;
	}
	rail.hidden = false;
	renderTopbar(topbar, { profiles, user: authState.user, route }, controller);
	renderRail(rail, controller, route);
	const state = controller.store.get();
	if (state.accessLost) {
		replace(
			main,
			h(
				"section",
				{ class: "page" },
				notice("danger", "Your access to this company was revoked."),
				h("a", { href: "#/" }, "Back to companies"),
			),
		);
		return;
	}
	if (route.section !== "chat") {
		conversation = undefined;
		controller.setOpenSession(undefined);
	}
	if (route.section !== "approvals") approvals = undefined;
	switch (route.section) {
		case "home": {
			if (state.loading && !state.staff.length) {
				replace(main, spinner("Opening company"));
				return;
			}
			if (!homeReason) {
				replace(main, spinner("Opening the Co-Founder"));
				void resolveHome(controller);
				return;
			}
			const first = state.hierarchy.primary.find((node) => node.kind === "agent");
			replace(
				main,
				h(
					"section",
					{ class: "page" },
					h("h1", null, controller.profile.profileName),
					notice("neutral", homeReason),
					first
						? h(
								"p",
								null,
								"Start with ",
								h("a", { href: `#/c/${controller.profile.profileId}/staff/${first.canonicalId}` }, first.label),
								" or pick a conversation in the rail.",
							)
						: h("p", { class: "muted" }, "This company has no staff conversations yet."),
				),
			);
			return;
		}
		case "chat": {
			if (!conversation || conversation.sessionId !== route.id) {
				conversation = new ConversationView(controller, route.id ?? "");
				replace(main, conversation.el);
				conversation.focus();
			} else conversation.update();
			return;
		}
		case "staff": {
			if (state.loading && !state.staff.length) {
				replace(main, spinner("Opening company"));
				return;
			}
			replace(main, spinner("Opening conversation"));
			void resolveStaff(controller, route.id ?? "");
			return;
		}
		case "approvals": {
			if (!approvals) {
				approvals = new ApprovalsView(controller);
				replace(main, approvals.el);
			} else approvals.update();
			return;
		}
		case "file":
		case "snapshot":
		case "proposal": {
			if (!companyFile) return;
			const fileState = companyFile.store.get();
			if (fileState.loading && !fileState.file && fileState.fileState === "loading") {
				void companyFile.refresh();
				companyFile.store.subscribe(() => render());
			}
			renderCompanyFile(companyFile, controller, main, {
				...(route.section === "snapshot" ? { snapshotId: route.id } : {}),
				...(route.section === "proposal" ? { proposalId: route.id } : {}),
			});
			return;
		}
		case "organization":
			renderOrganization(controller, main);
			return;
		case "team":
			renderTeam(api, controller, main, teamFeedback, (next) => {
				teamFeedback = next;
				render();
			});
			return;
	}
}

void auth.start().then(() => {
	if (auth.store.get().session) void hub.refresh();
	render();
});
