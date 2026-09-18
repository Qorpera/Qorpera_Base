"use strict";
import "./screen-viewer.js";
import { createMemberDisplayChannel } from "./company-computer-view-channel.js";
const element = id => document.getElementById(id);
let catalog = null, start = null, access = null, busy = false, confirmed = false;
let viewingAvailable = false, viewStatus = null, viewBusy = false, viewer = null;
let browserAvailable = false, profiles = null, privacy = null, browserGrant = null, browserBusy = false, pendingProfile = null;
function status(message, error = false) { element("status").textContent = message; element("status").classList.toggle("error",error); }
async function request(input) { const response = await window.companyComputer.request(input); if (!response?.ok) throw new Error(response?.error || "Company Computer unavailable"); return response.result; }
function buttons() {
	const manage = confirmed && catalog?.canManage;
	element("refresh").disabled = busy;
	element("start").disabled = busy || !manage || start?.officeState !== "provisioning" || Boolean(start?.intent);
	element("cancelStart").hidden = !start?.intent || start.intent.state === "cancelled" || start.officeState === "active";
	element("cancelStart").disabled = busy || !manage;
	for (const id of ["staff","moreStaff"]) element(id).disabled = busy || !confirmed;
	for (const id of ["shell","desktop"]) element(id).disabled = busy || !manage || !access;
	element("grant").disabled = busy || !manage || !access || (!element("shell").checked && !element("desktop").checked);
	element("revoke").disabled = busy || !manage || access?.grant?.state !== "active";
	browserButtons();
}
async function work(action) {
	if (busy) return; busy = true; buttons();
	try { await action(); } catch(error) { confirmed = false; access = null; status(error instanceof Error ? error.message : "Refresh Company Computer status.",true); }
	finally { busy = false; buttons(); }
}
async function grantStatus() {
	access = null;
	if (!catalog?.scope || !catalog.canManage || !element("staff").value) { element("grantState").textContent = "No active agents on this page."; return; }
	access = await request({ method: "access", staffAgentId: element("staff").value });
	element("grantState").textContent = access.grant?.state === "active" ? "This agent has the selected access." : "This agent has no active computer access.";
	element("shell").checked = Boolean(access.grant?.capabilities.includes("shell"));
	element("desktop").checked = Boolean(access.grant?.capabilities.includes("desktop"));
}
async function refresh(after = null) {
	confirmed = false; access = null;
	const next = await request({ method:"catalog",after }); catalog = next.catalog; start = next.start;
	element("staff").replaceChildren();
	for (const staff of catalog.staff) { const option = document.createElement("option"); option.value = staff.staffAgentId; option.textContent = staff.name; element("staff").append(option); }
	element("moreStaff").hidden = !catalog.nextAfter;
	element("accessPanel").hidden = !catalog.scope || !catalog.canManage;
	const labels = { provisioning:"Not yet started",active:"Running",maintenance:"Under maintenance",recovering:"Recovering",retired:"Retired" };
	element("computerState").textContent = !start ? "A shared computer has not been provisioned for this company." : `${labels[start.officeState]}${start.officeState !== "active" && start.intent ? ` · ${start.intent.state === "cancelled" ? "Start cancelled" : "Start requested; waiting for cloud readiness"}` : ""}`;
	element("management").textContent = catalog.canManage ? "You can start this computer and manage agent access." : "A company owner or administrator can start this computer and manage agent access.";
	await grantStatus(); confirmed = true; status("Company Computer status refreshed.");
	if (viewingAvailable && !viewer) await viewWork(refreshScreens);
	if (browserAvailable && !viewer) await browserWork(() => refreshBrowser());
}
element("refresh").onclick = () => work(() => refresh());
element("moreStaff").onclick = () => work(() => refresh(catalog.nextAfter));
element("staff").onchange = () => work(grantStatus);
for (const id of ["shell","desktop"]) element(id).onchange = buttons;
element("start").onclick = () => work(async () => { confirmed = false; await request({ method:"start" }); await refresh(); });
element("cancelStart").onclick = () => work(async () => { const intentId = start.intent.intentId; confirmed = false; await request({ method:"cancelStart",intentId }); await refresh(); });
for (const id of ["grant","revoke"]) element(id).onclick = () => work(async () => {
	const capabilities = id === "revoke" ? access.grant.capabilities : [ ...(element("desktop").checked ? ["desktop"] : []), ...(element("shell").checked ? ["shell"] : []) ];
	const input = { method:"configure",staffAgentId:access.staffAgentId,expectedVersion:access.grant?.version ?? 0,enabled:id === "grant",capabilities };
	access = null; await request(input); await grantStatus(); status(id === "grant" ? "Agent access updated." : "Access revoked. Cloud work is draining where required.");
});
function viewButtons() {
	element("viewPanel").hidden = !viewingAvailable;
	element("refreshScreens").disabled = viewBusy || Boolean(viewer) || !catalog?.scope;
	element("watchScreen").disabled = viewBusy || Boolean(viewer) || viewStatus?.state !== "active" || viewStatus.privacyState !== "shared" || !element("screen").value;
	element("cancelViewer").disabled = viewBusy || Boolean(viewer) || !element("viewerConnection").value;
	browserButtons();
}
async function viewRequest(input) {
	const result = await window.companyComputer.viewRequest(input);
	if (!result?.ok) throw new Error(result?.error || "Refresh screens to check access.");
	return result.result;
}
async function viewWork(action) {
	if (viewBusy) return; viewBusy = true; viewButtons();
	try { await action(); }
	catch (error) { viewStatus = null; element("viewStatus").textContent = error instanceof Error ? error.message : "Screen unavailable."; }
	finally { viewBusy = false; viewButtons(); }
}
async function refreshScreens() {
	viewStatus = null; element("screen").replaceChildren(); element("viewerConnection").replaceChildren();
	if (!catalog?.scope) { element("viewStatus").textContent = "No shared computer has been provisioned."; return; }
	viewStatus = await viewRequest({ method:"status" });
	for (const screen of viewStatus.screens) {
		const option = document.createElement("option"); option.value = screen.binding.screenId;
		const staff = catalog.staff.find(staff => staff.staffAgentId === screen.binding.staffAgentId);
		option.textContent = `Screen ${screen.binding.screenOrdinal}${staff ? ` · ${staff.name}` : ""} · ${screen.driver}`; element("screen").append(option);
	}
	for (const connection of viewStatus.viewers) {
		const option = document.createElement("option"); option.value = connection.viewerSessionId;
		const ordinal = viewStatus.screens.find(screen => screen.binding.screenId === connection.screenId)?.binding.screenOrdinal;
		option.textContent = `Screen ${ordinal ?? "unavailable"} · ${connection.mode} · ${connection.state} · ${connection.viewerSessionId.slice(-8)}`; element("viewerConnection").append(option);
	}
	element("viewStatus").textContent = viewStatus.privacyState === "shared" ? (viewStatus.screens.length ? "Screens refreshed. Select a screen to watch." : "No agent screens are currently available.") : "Private browser sign-in is active or transitioning. Shared viewing is unavailable.";
}
element("refreshScreens").onclick = () => viewWork(refreshScreens);
element("screen").onchange = viewButtons; element("viewerConnection").onchange = viewButtons;
element("cancelViewer").onclick = () => viewWork(async () => { await viewRequest({ method:"cancel",connectionId:element("viewerConnection").value }); await refreshScreens(); });
element("watchScreen").onclick = () => {
	if (viewer || viewBusy || viewStatus?.privacyState !== "shared") return;
	const selected = viewStatus.screens.find(screen => screen.binding.screenId === element("screen").value);
	if (!selected) return;
	openViewer(selected.binding);
};
function openViewer(binding, challenge = null) {
	if (viewer || viewBusy) return;
	viewer = window.qorperaScreenViewer.open({
		binding,title:challenge ? "Your private browser sign-in" : `Company Computer · Screen ${binding.screenOrdinal}`,canControl:catalog.canManage,privateSignIn:Boolean(challenge),
		requestConnection:async ({ binding,mode,signal }) => {
			const attemptId = crypto.randomUUID();
			const abort = () => { void window.companyComputer.viewRequest({ method:"abortConnect",attemptId }).catch(() => undefined); };
			signal.throwIfAborted(); signal.addEventListener("abort",abort,{ once:true });
			try {
				const connection = await viewRequest(challenge ? { method:"connectPrivate",attemptId,challengeId:challenge.challengeId } : { method:"connect",attemptId,binding,mode });
				if (signal.aborted) { await viewRequest({ method:"close",connectionId:connection.connectionId }); signal.throwIfAborted(); }
				return { ...connection,channel:createMemberDisplayChannel(input => window.companyComputer.viewRequest(input),connection.connectionId) };
			} finally { signal.removeEventListener("abort",abort); }
		},
		releaseConnection:({ connectionId }) => viewRequest({ method:"close",connectionId }),
		onClosed:() => { viewer = null; viewButtons(); void viewWork(refreshScreens); if (browserAvailable) void browserWork(() => refreshBrowser()); },
	}); viewButtons();
}
async function browserRequest(input) {
	const response = await window.companyComputer.browserRequest(input);
	if (!response?.ok) throw new Error(response?.error || "Refresh browser status before continuing.");
	return response.result;
}
function selectedProfile() { return profiles?.profiles.find(profile => profile.profileId === element("browserProfile").value); }
function browserButtons() {
	element("browserPanel").hidden = !browserAvailable;
	const waiting = browserBusy || busy || viewBusy || Boolean(viewer), shared = privacy?.state === "shared", profile = selectedProfile();
	for (const id of ["refreshBrowser", "browserProfile", "browserStaff", "profileLabel", "moreProfiles"]) element(id).disabled = waiting || !catalog?.scope;
	element("moreProfiles").hidden = !profiles?.nextAfter;
	const label = element("profileLabel").value;
	element("registerProfile").disabled = waiting || !profiles?.canUse || !shared || Boolean(pendingProfile) || !label || label !== label.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(label);
	element("retryProfile").hidden = !pendingProfile;
	element("retryProfile").disabled = waiting || !profiles?.canUse || !shared;
	element("beginPrivate").disabled = waiting || !viewingAvailable || !profiles?.canUse || !profile || !shared || viewStatus?.privacyState !== "shared" || !element("screen").value;
	element("openPrivate").disabled = waiting || !viewingAvailable || privacy?.state !== "private" || !privacy.challenge;
	element("finishPrivate").disabled = waiting || !privacy?.challenge || !["entering", "private"].includes(privacy.state);
	element("allowBrowser").disabled = waiting || !profiles?.canUse || !shared || !browserGrant?.profile.prepared || browserGrant.grant?.state === "active";
	element("revokeBrowser").disabled = waiting || browserGrant?.grant?.state !== "active";
}
async function browserWork(action) {
	if (browserBusy) return; browserBusy = true; browserButtons();
	try { await action(); }
	catch (error) { profiles = null; privacy = null; browserGrant = null; element("browserStatus").textContent = error instanceof Error ? error.message : "Refresh browser status before continuing."; }
	finally { browserBusy = false; browserButtons(); }
}
async function refreshBrowser(after = null) {
	profiles = null; privacy = null; browserGrant = null;
	if (!catalog?.scope) { element("browserStatus").textContent = "No shared computer has been provisioned."; return; }
	privacy = await browserRequest({method:"privacy"});
	const next = await browserRequest({method:"profiles",after}); profiles = next.catalog; pendingProfile = next.pendingRegistration;
	const previous = element("browserProfile").value;
	element("browserProfile").replaceChildren();
	for (const profile of profiles.profiles) { const option = document.createElement("option"); option.value = profile.profileId; option.textContent = profile.label; element("browserProfile").append(option); }
	if (profiles.profiles.some(profile => profile.profileId === previous)) element("browserProfile").value = previous;
	const state = {shared:"Shared access is enabled.",entering:"Shared work is draining. Refresh to check when your private browser is ready.",private:privacy.challenge ? "Your private browser is ready. Shared access remains paused." : "Another member is signing in privately.",leaving:"Private input is draining. Refresh to check when shared access resumes."};
	element("privacyState").textContent = state[privacy.state];
	element("browserStatus").textContent = pendingProfile ? `Creation of “${pendingProfile.label}” is unconfirmed. Refresh or explicitly retry the same creation.` : profiles.canUse ? "Your browser status is refreshed." : "This profile is available for consent cleanup only.";
	await selectBrowserProfile();
}
async function selectBrowserProfile() {
	browserGrant = null;
	const profile = selectedProfile(); element("browserStaff").replaceChildren();
	element("profileState").textContent = !profile ? "No browser profiles on this page." : profile.prepared ? "Private preparation completed. Check the account inside the browser before allowing agent use." : "This profile needs private preparation before an agent can use it.";
	const agents = [...(catalog?.staff ?? [])];
	if (profile?.activeStaffAgentId && !agents.some(agent => agent.staffAgentId === profile.activeStaffAgentId)) agents.push({staffAgentId:profile.activeStaffAgentId,name:"Previously assigned agent"});
	for (const agent of agents) { const option = document.createElement("option"); option.value = agent.staffAgentId; option.textContent = agent.name; element("browserStaff").append(option); }
	if (profile?.activeStaffAgentId) element("browserStaff").value = profile.activeStaffAgentId;
	await refreshBrowserGrant();
}
async function refreshBrowserGrant() {
	browserGrant = null;
	const profile = selectedProfile(), staffAgentId = element("browserStaff").value;
	if (!profile || !staffAgentId) { element("browserGrantState").textContent = "Select a profile and agent to review consent."; return; }
	browserGrant = await browserRequest({method:"browserGrant",profileId:profile.profileId,staffAgentId});
	element("browserGrantState").textContent = browserGrant.grant?.state !== "active" ? "This agent has no active consent for the profile." : browserGrant.grant.usable ? "Your consent allows this agent to use the profile." : "Consent is recorded but is currently unusable. It may be draining or access may have changed. Revoke it here if no longer wanted.";
}
element("refreshBrowser").onclick = () => browserWork(() => refreshBrowser());
element("moreProfiles").onclick = () => browserWork(() => refreshBrowser(profiles.nextAfter));
element("profileLabel").oninput = browserButtons;
element("browserProfile").onchange = () => browserWork(selectBrowserProfile);
element("browserStaff").onchange = () => browserWork(refreshBrowserGrant);
for (const id of ["registerProfile", "retryProfile"]) element(id).onclick = () => browserWork(async () => {
	await browserRequest(id === "registerProfile" ? {method:id,label:element("profileLabel").value} : {method:id});
	element("profileLabel").value = ""; await refreshBrowser();
});
for (const id of ["allowBrowser", "revokeBrowser"]) element(id).onclick = () => browserWork(async () => {
	const observed = browserGrant; browserGrant = null;
	await browserRequest({method:"configureBrowser",profileId:observed.profile.profileId,profileVersion:observed.profile.version,staffAgentId:observed.staffAgentId,expectedVersion:observed.grant?.version ?? 0,enabled:id === "allowBrowser"});
	await refreshBrowser();
});
element("beginPrivate").onclick = () => browserWork(async () => {
	await browserRequest({method:"beginPrivate",profileId:selectedProfile().profileId,screenId:element("screen").value});
	await refreshBrowser(); if (viewingAvailable) await viewWork(refreshScreens);
});
element("finishPrivate").onclick = () => browserWork(async () => {
	await browserRequest({method:"finishPrivate"}); await refreshBrowser(); if (viewingAvailable) await viewWork(refreshScreens);
});
element("openPrivate").onclick = () => {
	const challenge = privacy?.state === "private" ? privacy.challenge : null;
	if (!challenge || viewer || browserBusy) return;
	openViewer(challenge.drains.find(drain => drain.binding.screenId === challenge.screenId).binding, challenge);
};
void work(async () => { const info = await request({ method:"info" }); viewingAvailable = info.viewingAvailable; browserAvailable = info.browserAvailable; viewButtons(); element("title").textContent = `${info.title} · Company Computer`; await refresh(); });
