"use strict";

const element = (id) => document.getElementById(id);
let directory = "";
let page = null;
let selected = null;
let draftIntent = null;
let review = null;
let dirty = false;
let busy = false;
let canWrite = false;
let uploadSelection = null;
let uploadDestination = null;
let uploadIntent = null;
let exportCursor = null;
const cursors = { edits: null, proposals: null };
let presenceAvailable = false;
let presencePath = null;
let presenceView = null;
let stopPresence = null;

function renderPresence() {
	const node = element("presence"), now = Date.now();
	node.hidden = !presenceAvailable || presencePath === null;
	if (node.hidden) return;
	const prefix = `Recent agent activity · ${presencePath || "Company root"}: `;
	const row = presenceView?.paths?.find(item => item.path === presencePath);
	if (!row || presenceView.state === "unavailable" || now - presenceView.observedAt > 30000) { node.textContent = `${prefix}unavailable.`; return; }
	const participants = row.participants.filter(item => item.expiresAt > now);
	const details = participants.slice(0,8).map(item => `${presenceView.names?.[item.staffAgentId] || `Agent ${item.staffAgentId.slice(-12)}`} ${item.activity}${item.overlap === "within_subtree" ? " within this folder" : item.overlap === "ancestor_subtree" ? " on a containing folder" : " here"}`);
	if(participants.length>8)details.push(`${participants.length-8} more activity observations`);
	node.textContent = prefix + (details.length ? details.join("; ") : "No recent shared activity observed.") + (presenceView.state === "partial" ? " Some activity could not be checked." : "");
}

function observePresence(path) {
	if (!presenceAvailable || path === presencePath) return;
	presencePath = path;
	presenceView = null;
	renderPresence();
	void window.companyFile.selectPresence(path === null ? [] : [path]).catch(() => undefined);
}

function editorPresence() { observePresence(selected ? (selected.path === element("path").value ? selected.path : null) : directory); }

const presenceTimer = setInterval(renderPresence, 1000);
window.addEventListener("unload", () => { clearInterval(presenceTimer); stopPresence?.(); });

function status(message, error = false) {
	element("status").textContent = message;
	element("status").classList.toggle("error", error);
}

async function request(input) {
	const response = await window.companyFile.request(input);
	if (!response?.ok) throw new Error(response?.error || "Company File request failed");
	return response.cancelled ? null : response.result;
}

function buttons() {
	const bytes = new TextEncoder().encode(element("content").value).length;
	const selectedPath = selected && selected.path === element("path").value;
	element("size").textContent = `${bytes.toLocaleString()} / 32,768 bytes`;
	element("save").disabled = busy || !canWrite || !selectedPath || selected.executable || bytes > 32768;
	element("delete").disabled = busy || !canWrite || !selectedPath || selected.kind === "absent" || Boolean(draftIntent);
	element("newFile").disabled = busy || !canWrite;
	element("newFolder").disabled = busy || !canWrite;
	element("chooseUpload").disabled = busy || !canWrite || Boolean(uploadIntent) || Boolean(draftIntent);
	element("checkUpload").disabled = busy || !canWrite || Boolean(uploadIntent);
	element("uploadPath").disabled = busy || Boolean(uploadIntent);
	element("submitUpload").disabled = busy || !canWrite || !uploadSelection || !uploadDestination;
	element("submitUpload").textContent = uploadIntent ? "Retry this exact upload" : "Upload to company";
	element("cancelUpload").disabled = busy || Boolean(uploadIntent);
	element("save").textContent = draftIntent ? "Retry this exact save" : "Save to company";
	element("refresh").textContent = draftIntent ? "Check current file" : "Refresh";
	element("content").disabled = busy || !selected || !canWrite || selected.executable || Boolean(draftIntent);
	for (const id of ["refresh", "open", "up", "morePaths", "moreReviews", "back", "recovery", "computer"]) element(id).disabled = busy;
	for (const id of ["approve", "skip"]) element(id).disabled = busy || !canWrite || !review;
	element("downloadReview").disabled = busy || !review;
	for (const id of ["listExports", "moreExports"]) element(id).disabled = busy;
	for (const button of document.querySelectorAll(".download")) button.disabled = busy;
}

async function work(action) {
	if (busy) return;
	busy = true;
	buttons();
	try { await action(); }
	catch (error) { status(error instanceof Error ? error.message : "Company File request failed", true); }
	finally { busy = false; buttons(); }
}

function canLeave() {
	if (uploadIntent) { status("The last upload is uncertain. Retry that exact upload, or reopen the Company File to check its state.", true); return false; }
	if (draftIntent) { status("The last save is uncertain. Retry that exact save before starting another edit, or reopen the Company File to check its state.", true); return false; }
	return !dirty || window.confirm("Discard this unsaved text?");
}

async function list(path, append = false) {
	const next = await request({ method: "list", path, after: append ? page.nextAfter : null, snapshotId: append ? page.snapshotId : null });
	directory = path;
	page = next;
	element("directory").textContent = path || "Company root";
	if (!append) element("paths").replaceChildren();
	for (const item of next.items) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "path";
		button.textContent = item.path.split("/").at(-1);
		const detail = document.createElement("small");
		detail.textContent = item.kind === "directory" ? "Folder" : `${item.bytes.toLocaleString()} bytes`;
		button.append(detail);
		button.onclick = () => work(async () => {
			if (!canLeave()) return;
			if (item.kind === "directory") { clearSelection(); await list(item.path); }
			else await open(item.path);
		});
		const row = document.createElement("div");
		row.className = "file-row";
		row.append(button);
		if (item.kind === "file") {
			const download = document.createElement("button");
			download.type = "button";
			download.className = "download";
			download.textContent = "Download…";
			download.setAttribute("aria-label", `Download ${item.path}`);
			download.disabled = busy;
			download.onclick = () => work(async () => {
				status("Choose where to save this file.");
				const result = await request({ method: "download", selection: { realm: "company_file", path: item.path, version: item.version } });
				status(result?.saved ? `Downloaded ${item.path.split("/").at(-1)} (${result.bytes.toLocaleString()} bytes).` : "Download cancelled.");
			});
			row.append(download);
		}
		element("paths").append(row);
	}
	element("morePaths").hidden = !next.hasMore;
	if (!selected && element("reviewPanel").hidden && element("uploadPanel").hidden) observePresence(directory);
}

function clearSelection() {
	observePresence(null);
	selected = null;
	dirty = false;
	element("content").value = "";
	element("version").textContent = "Select a file to read or edit";
}

async function sharedExports(append = false) {
	const page = await request({ method: "exports", after: append ? exportCursor : null });
	exportCursor = page.nextAfter;
	if (!append) element("exports").replaceChildren();
	for (const asset of page.items) {
		const row = document.createElement("div"), label = document.createElement("span"), button = document.createElement("button");
		row.className = "file-row";
		label.textContent = `${asset.source.path} · ${asset.bytes.toLocaleString()} bytes`;
		button.type = "button"; button.className = "download"; button.textContent = "Download…";
		button.setAttribute("aria-label", `Download export ${asset.source.path}`);
		button.onclick = () => work(async () => {
			const result = await request({ method: "downloadExport", selection: { realm: "object_storage", assetId: asset.assetId, sha256: asset.sha256 } });
			status(result?.saved ? `Downloaded shared export (${result.bytes.toLocaleString()} bytes).` : "Download cancelled.");
		});
		row.append(label, button); element("exports").append(row);
	}
	element("moreExports").hidden = !exportCursor;
	status(element("exports").children.length ? "Shared exports are ready to download." : "No downloadable exports on this page.");
}

async function open(path) {
	observePresence(null);
	const file = await request({ method: "read", path });
	if (file.kind === "directory") { clearSelection(); draftIntent = null; await list(path); return; }
	selected = file;
	draftIntent = null;
	dirty = false;
	element("path").value = path;
	element("content").value = file.text;
	element("version").textContent = file.kind === "absent" ? "New file — not yet saved" : file.executable ? "Executable file — read-only in this editor" : "Loaded from the live company";
	element("reviewPanel").hidden = true;
	element("uploadPanel").hidden = true;
	element("editor").hidden = false;
	observePresence(path);
	status(file.kind === "absent" ? "This path does not exist yet. Enter text and save to create it." : "Loaded the current authorized version.");
}

function addReview(target) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "pending";
	button.textContent = target.plan.path;
	const detail = document.createElement("small");
	detail.textContent = `${"commandId" in target ? "Your edit" : "Agent proposal"} · ${target.plan.entry === null ? "Delete" : target.plan.entry.kind === "directory" ? "Create folder" : "Write file"}`;
	button.append(detail);
	button.onclick = () => work(async () => { if (canLeave()) await preview(target); });
	element("reviews").append(button);
}

async function pending(append = false) {
	if (!append) element("reviews").replaceChildren();
	for (const kind of ["edits", "proposals"]) {
		if (append && !cursors[kind]) continue;
		const next = await request({ method: "reviews", kind, after: append ? cursors[kind] : null });
		cursors[kind] = next.nextAfter;
		for (const target of next.items) addReview(target);
	}
	element("moreReviews").hidden = !cursors.edits && !cursors.proposals;
	if (!element("reviews").children.length) element("reviews").textContent = "No pending changes.";
}

async function preview(target) {
	observePresence(null);
	const key = "commandId" in target ? `edit:${target.commandId}` : `proposal:${target.proposalId}`;
	const details = await request({ method: "preview", key, planSha256: target.planSha256 });
	review = { key, planSha256: target.planSha256 };
	element("downloadReview").hidden = target.plan.entry?.kind !== "file";
	element("reviewTitle").textContent = target.plan.entry === null ? "Review deletion" : "Review exact change";
	element("reviewPath").textContent = target.plan.path;
	element("before").value = details.before;
	element("after").value = target.plan.entry === null ? "This path will be deleted." : target.plan.entry.kind === "directory" ? "A folder will be created." : details.after;
	element("editor").hidden = true;
	element("uploadPanel").hidden = true;
	element("reviewPanel").hidden = false;
	observePresence(target.plan.path);
	status("Review the path and content. No change is applied until you approve it.");
}

async function save(operation) {
	if (!selected || selected.path !== element("path").value) throw new Error("Open the selected path first");
	if (!draftIntent) draftIntent = { operation, operationKey: crypto.randomUUID(), path: selected.path, expectedVersion: selected.version, ...(operation === "write" ? { text: element("content").value } : {}) };
	status("Saving through cloud permissions…");
	const result = await request({ method: "edit", intent: draftIntent });
	draftIntent = null;
	dirty = false;
	if (result.state === "applied") {
		await open(result.plan.path);
		await list(directory);
		status("Saved to the live company.");
	} else if (result.state === "review_required") await preview(result);
	else status(`The edit is ${result.state.replaceAll("_", " ")}. It has not been applied.`);
	await pending();
}

element("open").onclick = () => work(async () => { if (canLeave()) await open(element("path").value); });
element("listExports").onclick = () => work(() => sharedExports());
element("moreExports").onclick = () => work(() => sharedExports(true));
element("chooseUpload").onclick = () => work(async () => {
	if (!canLeave()) return;
	const choice = await request({ method: "chooseUpload" });
	if (!choice) { status("Upload selection cancelled."); return; }
	uploadSelection = choice;
	uploadDestination = null;
	uploadIntent = null;
	element("uploadSource").textContent = `${choice.name} · ${choice.bytes.toLocaleString()} bytes · SHA-256 ${choice.sha256}`;
	element("uploadPath").value = directory ? `${directory}/${choice.name}` : choice.name;
	element("uploadDestination").textContent = "Check the destination before uploading.";
	element("editor").hidden = true;
	element("reviewPanel").hidden = true;
	element("uploadPanel").hidden = false;
	observePresence(null);
	status("Selected file is ready. Check its company destination.");
});
element("uploadPath").oninput = () => { uploadDestination = null; observePresence(null); element("uploadDestination").textContent = "Check the destination before uploading."; buttons(); };
element("checkUpload").onclick = () => work(async () => {
	uploadDestination = null;
	const target = await request({ method: "describe", path: element("uploadPath").value });
	if (target.entry?.kind === "directory") throw new Error("Choose a file destination, not a folder.");
	if (target.entry?.executable) throw new Error("Executable files cannot be replaced from this uploader.");
	uploadDestination = { path: target.path, expectedVersion: target.version };
	observePresence(target.path);
	element("uploadDestination").textContent = target.entry ? `Replace ${target.path} (${target.entry.file.bytes.toLocaleString()} bytes) at its current version.` : `Create ${target.path}.`;
	status("Destination checked. Choose Upload to company to submit this file.");
});
element("submitUpload").onclick = () => work(async () => {
	if (!uploadSelection || !uploadDestination) return;
	uploadIntent ??= { id: uploadSelection.id, ...uploadDestination };
	status("Uploading the selected file through company permissions…");
	const result = await request({ method: "upload", intent: uploadIntent });
	uploadIntent = null;
	uploadSelection = null;
	uploadDestination = null;
	clearSelection();
	element("uploadPanel").hidden = true;
	element("editor").hidden = false;
	await list(directory);
	await pending();
	if (result.command.state === "review_required") await preview(result.command);
	else status(result.command.state === "applied" ? "Uploaded to the live company." : `The upload is ${result.command.state.replaceAll("_", " ")}.`);
});
element("cancelUpload").onclick = () => { if (!uploadIntent) { element("uploadPanel").hidden = true; element("editor").hidden = false; editorPresence(); } };
element("downloadReview").onclick = () => work(async () => {
	if (!review) return;
	const result = await request({ method: "downloadReview", ...review });
	status(result?.saved ? "Downloaded the exact proposed file. Review it before applying the change." : "Download cancelled.");
});
element("recovery").onclick = () => work(() => request({ method: "recovery" }));
element("path").onkeydown = (event) => { if (event.key === "Enter") element("open").click(); };
element("path").oninput = () => { editorPresence(); buttons(); };
element("content").oninput = () => { dirty = true; buttons(); };
element("save").onclick = () => work(() => save("write"));
element("delete").onclick = () => work(async () => { if (canLeave()) await save("delete"); });
element("refresh").onclick = () => work(async () => {
	if (draftIntent) {
		if (!window.confirm("The submitted save may already have completed. Discard the draft and load the current cloud version without retrying the save?")) return;
	} else if (!canLeave()) return;
	if (selected) await open(selected.path);
	await list(directory);
	await pending();
});
element("up").onclick = () => work(async () => { if (canLeave()) { clearSelection(); await list(directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : ""); } });
element("morePaths").onclick = () => work(() => list(directory, true));
element("moreReviews").onclick = () => work(() => pending(true));
element("newFile").onclick = () => work(async () => {
	if (!canLeave()) return;
	element("path").value = directory ? `${directory}/` : "";
	selected = null;
	dirty = false;
	observePresence(null);
	element("content").value = "";
	element("editor").hidden = false;
	element("reviewPanel").hidden = true;
	element("path").focus();
	element("uploadPanel").hidden = true;
	status("Enter the new path, then choose Open to check it before editing.");
});
element("newFolder").onclick = () => work(async () => {
	if (!canLeave()) return;
	const path = element("path").value;
	if (!path) throw new Error("Enter the new folder path above first");
	const target = await request({ method: "read", path });
	if (target.kind !== "absent") throw new Error("That path already exists");
	selected = target;
	await save("mkdir");
});
for (const [id, decision] of [["approve", "approve"], ["skip", "skip"]]) {
	element(id).onclick = () => work(async () => {
		if (!review) return;
		const result = await request({ method: "review", ...review, decision });
		if (!result) return;
		review = null;
		element("reviewPanel").hidden = true;
		element("editor").hidden = false;
		if (selected) await open(selected.path);
		await list(directory);
		await pending();
		status(result.state === "applied" ? "Applied the exact approved change to the company." : "Skipped. No change was applied.");
	});
}
element("back").onclick = () => { review = null; element("reviewPanel").hidden = true; element("editor").hidden = false; editorPresence(); };
element("computer").onclick = () => work(async () => { await request({ method:"computer" }); });
window.addEventListener("beforeunload", (event) => { if (dirty || draftIntent || uploadIntent) { event.preventDefault(); event.returnValue = ""; } });
void work(async () => {
	const info = await request({ method: "info" });
	element("title").textContent = `${info.title} · Company File`;
	canWrite = info.canWrite;
	presenceAvailable = info.presenceAvailable === true && typeof window.companyFile.onPresence === "function" && typeof window.companyFile.selectPresence === "function";
	if (presenceAvailable) stopPresence = window.companyFile.onPresence(view => { presenceView = view; renderPresence(); });
	element("computer").hidden = info.computerAvailable !== true;
	await list("");
	await pending();
	status(canWrite ? "Connected to the live company. Select a file to read or edit." : "Connected with read-only company access.");
});
