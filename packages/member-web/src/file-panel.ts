import type {
	CloudMemberCompanyCommand,
	CloudMemberCompanyEdit,
	CloudMemberCompanyFileClient,
	CloudMemberCompanyProposal,
} from "@qorpera/cloud-client/cloud-member-company-editor";
import type { CloudMemberCompanyPresence } from "@qorpera/cloud-client/cloud-member-company-presence";
import type { CompanyPathPresenceView } from "@qorpera/cloud-client/company-path-presence";
import { button, element, input, textPreview, type Work } from "./dom.ts";
import { WebFileDownloads, WebFileUpload } from "./files.ts";

type Review = CloudMemberCompanyCommand | CloudMemberCompanyProposal;
export interface MemberFilePanelSession {
	readonly signal: AbortSignal;
	readonly company: { readonly role: "owner" | "admin" | "contributor" | "viewer"; readonly canWrite?: boolean };
	current(): void;
	files(): Promise<CloudMemberCompanyFileClient>;
	presence(onChange: (view: CompanyPathPresenceView) => void): CloudMemberCompanyPresence;
}
/** Browser-owned selection and rendering around shared live-file authority. */
export async function showFilePanel(options: {
	root: HTMLElement;
	company: MemberFilePanelSession;
	work: Work;
	status(message: string): void;
	current(): void;
	beforeLeave?(check: () => string | null): void;
}): Promise<() => void> {
	const { root, company, work, status, current } = options,
		client = await company.files();
	current();
	const stop = new AbortController(),
		signal = AbortSignal.any([stop.signal, company.signal]);
	const live = () => {
		signal.throwIfAborted();
		company.current();
		current();
	};
	const downloads = new WebFileDownloads({ signal, current: live }),
		upload = new WebFileUpload({ client, signal, current: live });
	let directory = "",
		page: Awaited<ReturnType<CloudMemberCompanyFileClient["list"]>> | null = null,
		selected: Awaited<ReturnType<CloudMemberCompanyFileClient["read"]>> | null = null,
		pendingEdit: CloudMemberCompanyEdit | null = null,
		dirty = false;
	let activityPath: string | null = null,
		activity: CompanyPathPresenceView | undefined,
		uploadDestination: { path: string; expectedVersion: string | null } | null = null;
	const canWrite = company.company.role !== "viewer" && company.company.canWrite !== false,
		files = element("div"),
		reviews = element("div"),
		exports = element("div"),
		details = element("div"),
		presence = element("p");
	presence.className = "hint";
	const path = input("Company path"),
		text = element("textarea"),
		version = element("p"),
		directoryLabel = element("h2", "Company root"),
		listMore = button(
			"More files",
			async () => {
				if (page?.hasMore) await list(directory, true);
			},
			work,
		);
	text.setAttribute("aria-label", "File content");
	text.spellcheck = false;
	text.disabled = true;
	path.input.placeholder = "documents/plan.md";
	listMore.hidden = true;
	const renderPresence = () => {
		const row = activity?.paths.find((row) => row.path === activityPath),
			now = Date.now();
		presence.hidden = activityPath === null;
		if (presence.hidden) return;
		const prefix = `Recent agent activity · ${activityPath || "Company root"}: `;
		if (!activity || !row || activity.state === "unavailable" || now - activity.observedAt > 30000) {
			presence.textContent = `${prefix}unavailable.`;
			return;
		}
		const participants = row.participants.filter((item) => item.expiresAt > now),
			summary = participants
				.slice(0, 8)
				.map(
					(item) =>
						`Agent ${item.staffAgentId.slice(-12)} ${item.activity}${item.overlap === "within_subtree" ? " within this folder" : item.overlap === "ancestor_subtree" ? " on a containing folder" : " here"}`,
				);
		if (participants.length > 8) summary.push(`${participants.length - 8} more observations`);
		presence.textContent =
			prefix +
			(summary.join("; ") || "No recent shared activity observed.") +
			(activity.state === "partial" ? " Some activity could not be checked." : "");
	};
	let observer: CloudMemberCompanyPresence | undefined;
	try {
		observer = company.presence((view) => {
			if (signal.aborted) return;
			activity = view;
			renderPresence();
		});
	} catch {
		/* Optional, lossy activity must not block the File interface. */
	}
	const observe = (value: string | null) => {
		activityPath = value;
		activity = undefined;
		renderPresence();
		observer?.select(value === null ? [] : [value]);
	};
	const timer = setInterval(renderPresence, 1000);
	const leave = () => {
		if (pendingEdit || upload.uncertain)
			throw new Error("The last change is unconfirmed. Retry that exact change before starting another.");
		return !dirty || window.confirm("Discard this unsaved text?");
	};
	options.beforeLeave?.(() =>
		pendingEdit || upload.uncertain
			? "The last change is unconfirmed. Leave this page? Reopen pending changes to check whether it was accepted."
			: dirty
				? "Discard this unsaved text?"
				: upload.selected
					? "Discard this selected upload?"
					: null,
	);
	const save = button("Save to company", async () => mutate(pendingEdit?.operation ?? "write"), work),
		remove = button(
			"Delete…",
			async () => {
				if (selected && window.confirm(`Delete ${selected.path}?`)) await mutate("delete");
			},
			work,
		);
	const controls = () => {
		const opened = selected?.path === path.input.value;
		save.disabled =
			!canWrite || !opened || selected?.executable || new TextEncoder().encode(text.value).length > 32768;
		remove.disabled = !canWrite || !opened || selected?.kind === "absent" || Boolean(pendingEdit);
		text.disabled = !canWrite || !opened || selected?.executable === true || Boolean(pendingEdit);
		path.input.disabled = Boolean(pendingEdit);
		save.textContent = pendingEdit ? "Retry this exact save" : "Save to company";
	};
	text.oninput = () => {
		dirty = true;
		controls();
	};
	path.input.oninput = () => {
		observe(null);
		controls();
	};
	function clearEditor() {
		selected = null;
		dirty = false;
		text.value = "";
		path.input.value = "";
		version.textContent = "";
		details.replaceChildren();
		observe(null);
		controls();
	}
	async function list(value: string, append = false) {
		const next = await client.list(value, signal, append ? page!.nextAfter : null, append ? page!.snapshotId : null);
		live();
		directory = value;
		page = next;
		directoryLabel.textContent = value || "Company root";
		if (!append) files.replaceChildren();
		for (const item of next.items) {
			const openButton = button(
				item.path.split("/").at(-1)!,
				async () => {
					if (!leave()) return;
					if (item.kind === "directory") {
						clearEditor();
						await list(item.path);
						controls();
					} else await open(item.path);
				},
				work,
			);
			const row = element(
				"div",
				undefined,
				openButton,
				element("small", item.kind === "directory" ? "Folder" : `${item.bytes?.toLocaleString()} bytes`),
			);
			row.className = "file-row";
			if (item.kind === "file")
				row.append(
					button(
						"Download…",
						async () => {
							const file = await client.download(
								{ realm: "company_file", path: item.path, version: item.version },
								signal,
							);
							live();
							downloads.offer(item.path, file.bytes);
							status("Download handed to your browser.");
						},
						work,
					),
				);
			files.append(row);
		}
		listMore.hidden = !next.hasMore;
		if (!selected) observe(directory);
	}
	async function open(value: string) {
		observe(null);
		const file = await client.read(value, signal);
		live();
		if (file.kind === "directory") {
			clearEditor();
			await list(value);
			return;
		}
		selected = file;
		pendingEdit = null;
		dirty = false;
		path.input.value = file.path;
		text.value = file.text;
		version.textContent = file.kind === "absent" ? "New file — not yet saved" : "Loaded the current company version.";
		details.replaceChildren();
		observe(file.path);
		controls();
	}
	async function mutate(operation: "write" | "delete" | "mkdir") {
		if (!canWrite || !selected || selected.path !== path.input.value) throw new Error("Open the exact path first");
		if (pendingEdit && pendingEdit.operation !== operation) throw new Error("Retry the exact pending save");
		if (
			!pendingEdit &&
			operation === "write" &&
			(text.value.includes("\0") || new TextEncoder().encode(text.value).length > 32768)
		)
			throw new Error("Enter UTF-8 text of at most 32 KiB without NUL characters");
		pendingEdit ??= {
			operation,
			operationKey: crypto.randomUUID(),
			path: selected.path,
			expectedVersion: selected.version,
			...(operation === "write" ? { text: text.value } : {}),
		} as CloudMemberCompanyEdit;
		controls();
		const result = await client.edit(pendingEdit, signal);
		live();
		pendingEdit = null;
		dirty = false;
		controls();
		if (result.state === "applied") {
			await open(result.plan.path);
			await list(directory);
			status("Saved to the live company.");
		} else if (result.state === "review_required") await preview(result);
		else status(`The change is ${result.state.replaceAll("_", " ")}.`);
		await pending();
	}
	const reviewCursor: { edits: string | null; proposals: string | null } = { edits: null, proposals: null };
	async function pending(append = false) {
		if (!append) reviews.replaceChildren();
		for (const kind of ["edits", "proposals"] as const) {
			if (append && !reviewCursor[kind]) continue;
			const page = await client[kind](signal, append ? reviewCursor[kind] : null);
			live();
			reviewCursor[kind] = page.nextAfter;
			for (const target of page.items)
				reviews.append(
					button(
						`${"commandId" in target ? "Your edit" : "Agent proposal"} · ${target.plan.path}`,
						async () => {
							if (leave()) await preview(target);
						},
						work,
					),
				);
		}
		moreReviews.hidden = !reviewCursor.edits && !reviewCursor.proposals;
	}
	async function preview(target: Review) {
		observe(null);
		let after = "",
			before = "Current content could not be displayed. Check the path before applying this change.";
		if (target.plan.entry?.kind === "file") after = textPreview((await client.pendingFile(target, signal)).bytes);
		try {
			const file = await client.read(target.plan.path, signal);
			before =
				file.kind === "file"
					? file.text
					: file.kind === "absent"
						? "Path does not currently exist."
						: "Current path is a folder.";
		} catch {
			live();
		}
		live();
		const proposed = element("textarea"),
			prior = element("textarea");
		selected = null;
		text.value = "";
		dirty = false;
		path.input.value = target.plan.path;
		controls();
		prior.value = before;
		proposed.value =
			target.plan.entry === null
				? "This path will be deleted."
				: target.plan.entry.kind === "directory"
					? "A folder will be created."
					: after;
		prior.readOnly = true;
		proposed.readOnly = true;
		const approve = button(
			"Apply exact change…",
			async () => {
				if (!window.confirm(`Apply the exact proposed change to ${target.plan.path}?`)) return;
				const result = await client.review(target, "approve", signal);
				live();
				details.replaceChildren();
				await list(directory);
				await pending();
				status(
					result.state === "applied"
						? "Applied the exact approved change."
						: "Approval recorded. Refresh to check the result.",
				);
			},
			work,
		);
		approve.disabled = !canWrite;
		const skip = button(
			"Skip change",
			async () => {
				await client.review(target, "skip", signal);
				live();
				details.replaceChildren();
				await pending();
				status("Change skipped.");
			},
			work,
		);
		skip.disabled = !canWrite;
		details.replaceChildren(
			element("h2", "Review exact change"),
			element("p", target.plan.path),
			element("label", "Current", prior),
			element("label", "Proposed", proposed),
			approve,
			skip,
		);
		if (target.plan.entry?.kind === "file")
			details.append(
				button(
					"Download proposed file…",
					async () => {
						const file = await client.pendingFile(target, signal);
						live();
						downloads.offer(target.plan.path, file.bytes);
						status("Proposed file handed to your browser. Review it before applying.");
					},
					work,
				),
			);
		observe(target.plan.path);
	}
	const moreReviews = button("More pending changes", async () => pending(true), work);
	moreReviews.hidden = true;
	let exportCursor: string | null = null;
	const moreExports = button("More exports", async () => listExports(true), work);
	moreExports.hidden = true;
	async function listExports(append = false) {
		const page = await client.exports.list(signal, append ? exportCursor : null);
		live();
		exportCursor = page.nextAfter;
		if (!append) exports.replaceChildren();
		for (const asset of page.items)
			exports.append(
				button(
					`${asset.source.path} · ${asset.bytes.toLocaleString()} bytes · Download…`,
					async () => {
						const file = await client.exports.download(
							{ realm: "object_storage", assetId: asset.assetId, sha256: asset.sha256 },
							signal,
						);
						live();
						downloads.offer(asset.source.path, file.bytes);
						status("Shared export handed to your browser.");
					},
					work,
				),
			);
		moreExports.hidden = !exportCursor;
	}
	const chooser = element("input");
	chooser.type = "file";
	chooser.setAttribute("aria-label", "Select a file to upload");
	chooser.disabled = !canWrite;
	const uploadLabel = element("p", "Choose a file of at most 8 MiB."),
		destination = input("Upload destination"),
		uploadStatus = element("p"),
		submitUpload = button(
			"Upload to company",
			async () => {
				if (!uploadDestination) throw new Error("Check the destination first");
				try {
					const result = await upload.submit(uploadDestination.path, uploadDestination.expectedVersion);
					live();
					uploadDestination = null;
					submitUpload.disabled = true;
					chooser.value = "";
					uploadLabel.textContent = "Choose a file of at most 8 MiB.";
					destination.input.value = "";
					uploadStatus.textContent = "";
					await list(directory);
					await pending();
					if (result.command.state === "review_required") await preview(result.command);
					else status("Upload submitted to the live company.");
				} finally {
					if (!signal.aborted) {
						chooser.disabled = upload.uncertain || !canWrite;
						destination.input.disabled = upload.uncertain;
						submitUpload.textContent = upload.uncertain ? "Retry this exact upload" : "Upload to company";
					}
				}
			},
			work,
		);
	submitUpload.disabled = true;
	chooser.onchange = () => {
		void work(async () => {
			if (!leave()) return;
			uploadDestination = null;
			submitUpload.disabled = true;
			uploadLabel.textContent = "Reading selected file…";
			const file = chooser.files?.[0];
			if (!file) {
				upload.clearSelection();
				uploadLabel.textContent = "No file selected.";
				return;
			}
			const selected = await upload.select(file);
			live();
			uploadLabel.textContent = `${selected.name} · ${selected.bytes.toLocaleString()} bytes`;
			destination.input.value = directory ? `${directory}/${selected.name}` : selected.name;
			uploadStatus.textContent = "Check the destination before uploading.";
		});
	};
	destination.input.oninput = () => {
		uploadDestination = null;
		submitUpload.disabled = true;
	};
	const checkUpload = button(
		"Check destination",
		async () => {
			if (upload.uncertain) throw new Error("Retry the exact pending upload");
			if (!upload.selected) throw new Error("Choose a file first");
			const target = await client.describe(destination.input.value, signal);
			live();
			if (target.entry?.kind === "directory" || target.entry?.executable)
				throw new Error("Choose a non-executable file destination");
			uploadDestination = { path: target.path, expectedVersion: target.version };
			uploadStatus.textContent = target.entry
				? `Replace ${target.path} at the checked version.`
				: `Create ${target.path}.`;
			submitUpload.disabled = !canWrite;
		},
		work,
	);
	checkUpload.disabled = !canWrite;
	const openButton = button(
		"Open",
		async () => {
			if (leave()) await open(path.input.value);
		},
		work,
	);
	path.input.onkeydown = (event) => {
		if (event.key === "Enter") openButton.click();
	};
	const newFile = button(
		"New file",
		async () => {
			if (!leave()) return;
			clearEditor();
			path.input.value = directory ? `${directory}/` : "";
			observe(null);
			controls();
			path.input.focus();
			status("Enter the path and choose Open to check it before editing.");
		},
		work,
	);
	newFile.disabled = !canWrite;
	const newFolder = button(
		"Create folder…",
		async () => {
			if (!canWrite || !leave()) return;
			await open(path.input.value);
			if (selected?.kind !== "absent") throw new Error("That path already exists");
			await mutate("mkdir");
		},
		work,
	);
	newFolder.disabled = !canWrite;
	const nav = element(
		"aside",
		undefined,
		directoryLabel,
		button(
			"Up",
			async () => {
				if (!leave()) return;
				clearEditor();
				await list(directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "");
				controls();
			},
			work,
		),
		newFile,
		files,
		listMore,
		element("h2", "Pending changes"),
		button("Refresh changes", async () => pending(), work),
		reviews,
		moreReviews,
		element("h2", "Shared exports"),
		button("Browse exports", async () => listExports(), work),
		exports,
		moreExports,
	);
	const editor = element(
		"section",
		undefined,
		path.label,
		openButton,
		newFolder,
		version,
		element("label", "UTF-8 text · up to 32 KiB", text),
		save,
		remove,
		element("p", "Writes use the checked version and current company permissions. Protected changes require review."),
		element("h2", "Upload a file"),
		chooser,
		uploadLabel,
		destination.label,
		checkUpload,
		uploadStatus,
		submitUpload,
		details,
	);
	editor.className = "file-editor";
	const layout = element("div", undefined, nav, editor);
	layout.className = "file-layout";
	root.replaceChildren(presence, layout);
	controls();
	const close = () => {
		stop.abort();
		clearInterval(timer);
		void observer?.close();
		downloads.close();
	};
	try {
		await list("");
		await pending();
		return close;
	} catch (error) {
		close();
		throw error;
	}
}
