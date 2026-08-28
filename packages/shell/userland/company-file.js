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
const cursors = { edits: null, proposals: null };

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
	element("save").textContent = draftIntent ? "Retry this exact save" : "Save to company";
	element("refresh").textContent = draftIntent ? "Check current file" : "Refresh";
	element("content").disabled = busy || !selected || !canWrite || selected.executable || Boolean(draftIntent);
	for (const id of ["refresh", "open", "up", "morePaths", "moreReviews", "back"]) element(id).disabled = busy;
	for (const id of ["approve", "skip"]) element(id).disabled = busy || !canWrite || !review;
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
		element("paths").append(button);
	}
	element("morePaths").hidden = !next.hasMore;
}

function clearSelection() {
	selected = null;
	dirty = false;
	element("content").value = "";
	element("version").textContent = "Select a file to read or edit";
}

async function open(path) {
	const file = await request({ method: "read", path });
	if (file.kind === "directory") { clearSelection(); draftIntent = null; await list(path); return; }
	selected = file;
	draftIntent = null;
	dirty = false;
	element("path").value = path;
	element("content").value = file.text;
	element("version").textContent = file.kind === "absent" ? "New file — not yet saved" : file.executable ? "Executable file — read-only in this editor" : "Loaded from the live company";
	element("reviewPanel").hidden = true;
	element("editor").hidden = false;
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
	const key = "commandId" in target ? `edit:${target.commandId}` : `proposal:${target.proposalId}`;
	const details = await request({ method: "preview", key, planSha256: target.planSha256 });
	review = { key, planSha256: target.planSha256 };
	element("reviewTitle").textContent = target.plan.entry === null ? "Review deletion" : "Review exact change";
	element("reviewPath").textContent = target.plan.path;
	element("before").value = details.before;
	element("after").value = target.plan.entry === null ? "This path will be deleted." : target.plan.entry.kind === "directory" ? "A folder will be created." : details.after;
	element("editor").hidden = true;
	element("reviewPanel").hidden = false;
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
element("path").onkeydown = (event) => { if (event.key === "Enter") element("open").click(); };
element("path").oninput = buttons;
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
	element("content").value = "";
	element("editor").hidden = false;
	element("reviewPanel").hidden = true;
	element("path").focus();
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
element("back").onclick = () => { review = null; element("reviewPanel").hidden = true; element("editor").hidden = false; };
window.addEventListener("beforeunload", (event) => { if (dirty || draftIntent) { event.preventDefault(); event.returnValue = ""; } });
void work(async () => {
	const info = await request({ method: "info" });
	element("title").textContent = `${info.title} · Company File`;
	canWrite = info.canWrite;
	await list("");
	await pending();
	status(canWrite ? "Connected to the live company. Select a file to read or edit." : "Connected with read-only company access.");
});
