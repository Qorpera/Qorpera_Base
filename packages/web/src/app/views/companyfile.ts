import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import { ObjectAccessError, ObjectReader } from "../../cloud/objects.ts";
import { collectPages } from "../../cloud/pagination.ts";
import type {
	CloudCompanyTreeEntry,
	HostedCompanyFile,
	HostedCompanyProposal,
	HostedCompanyProposalComment,
	HostedCompanySnapshot,
	HostedCompanyWorkspace,
} from "../../cloud/types.ts";
import {
	badge,
	button,
	confirmDialog,
	fmtBytes,
	fmtDate,
	fmtTime,
	h,
	notice,
	replace,
	shortId,
	spinner,
} from "../../ui/dom.ts";
import { preserveFormDrafts } from "../../ui/forms.ts";
import type { CompanyController } from "../company.ts";
import { Store } from "../state.ts";

/* Company File browsing (COMPANY-FILE.md; contract §6 table): published
 * snapshots, the canonical head, review proposals with comments and
 * accept/reject for authorizers. Object bytes are read through the
 * profile-object authority; live logical paths arrive with Order 0's gateway. */

export interface CompanyFileState {
	loading: boolean;
	file?: HostedCompanyFile;
	fileState: "ready" | "not-deployed" | "error" | "loading";
	workspaces: HostedCompanyWorkspace[];
	snapshots: HostedCompanySnapshot[];
	usesPathGateway?: boolean;
	proposalStatus: "open" | "accepted" | "rejected";
	proposals: HostedCompanyProposal[];
	error?: string;
	selectionError?: string;
	snapshot?: {
		snapshot: HostedCompanySnapshot;
		entries?: CloudCompanyTreeEntry[];
		error?: string;
		loading: boolean;
		open?: string;
		content?: string;
		contentError?: string;
	};
	proposal?: {
		proposal: HostedCompanyProposal;
		comments: HostedCompanyProposalComment[];
		loading: boolean;
		error?: string;
		busy?: boolean;
		draft?: string;
	};
}

export class CompanyFileController {
	readonly store = new Store<CompanyFileState>({
		loading: true,
		fileState: "loading",
		workspaces: [],
		snapshots: [],
		proposalStatus: "open",
		proposals: [],
	});
	readonly #api: CloudApi;
	readonly #company: CompanyController;
	readonly #reader: ObjectReader;
	readonly #unsubscribe: () => void;
	#disposed = false;
	#started = false;
	#refreshing?: Promise<void>;
	#refreshAgain = false;
	#selection = "";
	#selectionVersion = 0;
	#fileVersion = 0;
	#listVersion = 0;
	#confirming = false;
	readonly #drafts = new Map<string, string>();
	readonly #commentRetries = new Map<string, { body: string; id: string }>();

	constructor(api: CloudApi, company: CompanyController) {
		this.#api = api;
		this.#company = company;
		this.#reader = new ObjectReader(api, company.profile.profileId);
		this.#unsubscribe = company.onInvalidate((resource) => {
			if (resource === "company-file" && this.#started) void this.refresh();
		});
	}

	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.refresh();
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		this.#reader.dispose();
		this.#drafts.clear();
		this.#commentRetries.clear();
		this.store.dispose();
	}

	commentDraft(proposalId: string): string {
		return this.#drafts.get(proposalId) ?? "";
	}
	setCommentDraft(proposalId: string, text: string): void {
		if (!this.#disposed) this.#drafts.set(proposalId, text);
	}

	select(view: { snapshotId?: string; proposalId?: string }): void {
		const key = view.snapshotId
			? `snapshot:${view.snapshotId}`
			: view.proposalId
				? `proposal:${view.proposalId}`
				: "";
		if (this.#disposed || key === this.#selection) return;
		if (view.snapshotId) void this.openSnapshot(view.snapshotId);
		else if (view.proposalId) void this.openProposal(view.proposalId);
		else this.#beginSelection("");
	}

	#beginSelection(key: string, preserve = false): () => boolean {
		this.#selection = key;
		const version = ++this.#selectionVersion;
		this.#fileVersion++;
		this.store.set(
			preserve
				? { selectionError: undefined }
				: { snapshot: undefined, proposal: undefined, selectionError: undefined },
		);
		return () => !this.#disposed && version === this.#selectionVersion;
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return this.#refreshing;
		}
		this.#refreshing = this.#refresh().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #refresh(): Promise<void> {
		const { profileId, environmentId } = this.#company.profile;
		do {
			this.#refreshAgain = false;
			this.store.set({ loading: true, error: undefined });
			try {
				const file = await this.#api.getCompanyFile(environmentId);
				if (this.#disposed) return;
				this.store.set({ file, fileState: "ready" });
				const [workspaces, snapshots] = await Promise.all([
					this.#api.listWorkspaces(environmentId),
					this.#api.listSnapshots(file.canonicalWorkspaceId, 50),
				]);
				if (this.#disposed) return;
				this.store.set({ workspaces, snapshots });
			} catch (error) {
				if (this.#disposed) return;
				if (error instanceof CloudRpcError && error.missing) this.store.set({ fileState: "not-deployed" });
				else this.store.set({ fileState: "error", error: describeError(error) });
			}
			try {
				this.store.set({ usesPathGateway: await this.#api.usesPathGateway(profileId) });
			} catch {
				this.store.set({ usesPathGateway: undefined });
			}
			if (this.#disposed) return;
			await this.refreshProposals();
			this.store.set({ loading: false });
			const selected = this.store.get().proposal;
			if (!this.#disposed && selected && !selected.busy && !selected.loading && !this.#confirming)
				await this.openProposal(selected.proposal.proposalId, true);
		} while (this.#refreshAgain && !this.#disposed);
	}

	async refreshProposals(): Promise<void> {
		if (this.#disposed) return;
		const version = ++this.#listVersion;
		const status = this.store.get().proposalStatus;
		try {
			const proposals = await collectPages(async (cursor) => {
				if (this.#disposed || version !== this.#listVersion) throw new Error("Request superseded");
				const page = await this.#api.listProposals(this.#company.profile.environmentId, status, 50, cursor);
				return { ...page, nextTime: page.nextCreatedAt };
			});
			if (!this.#disposed && version === this.#listVersion) this.store.set({ proposals });
		} catch (error) {
			if (!this.#disposed && version === this.#listVersion) this.store.set({ error: describeError(error) });
		}
	}

	setProposalStatus(status: CompanyFileState["proposalStatus"]): void {
		this.store.set({ proposalStatus: status, proposals: [], error: undefined });
		void this.refreshProposals();
	}

	async openSnapshot(snapshotId: string): Promise<void> {
		if (this.#disposed) return;
		const currentRequest = this.#beginSelection(`snapshot:${snapshotId}`);
		try {
			const snapshot =
				this.store.get().snapshots.find((item) => item.snapshotId === snapshotId) ??
				(await this.#api.getSnapshot(snapshotId));
			if (!currentRequest()) return;
			this.store.set({ snapshot: { snapshot, loading: true } });
			const manifest = await this.#reader.readTreeManifest(snapshot);
			if (!currentRequest()) return;
			this.store.set({ snapshot: { snapshot, entries: manifest.entries, loading: false } });
		} catch (error) {
			if (!currentRequest()) return;
			const current = this.store.get().snapshot;
			if (current) this.store.set({ snapshot: { ...current, loading: false, error: describeAccess(error) } });
			else this.store.set({ selectionError: describeError(error) });
		}
	}

	async openFile(entry: CloudCompanyTreeEntry): Promise<void> {
		const current = this.store.get().snapshot;
		if (this.#disposed || !current || entry.kind !== "file") return;
		const version = ++this.#fileVersion;
		this.store.set({ snapshot: { ...current, open: entry.path, content: undefined, contentError: undefined } });
		try {
			const bytes = await this.#reader.readFile(entry.file);
			if (this.#disposed || version !== this.#fileVersion) return;
			const text =
				entry.file.bytes <= 2 * 1024 * 1024 ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : undefined;
			this.store.set((state) => ({
				snapshot: state.snapshot
					? { ...state.snapshot, content: text ?? `(binary, ${fmtBytes(bytes.byteLength)})` }
					: undefined,
			}));
		} catch (error) {
			if (this.#disposed || version !== this.#fileVersion) return;
			this.store.set((state) => ({
				snapshot: state.snapshot ? { ...state.snapshot, contentError: describeAccess(error) } : undefined,
			}));
		}
	}

	async openProposal(proposalId: string, background = false): Promise<void> {
		if (this.#disposed) return;
		const previous = this.store.get().proposal;
		const preserve = background && previous?.proposal.proposalId === proposalId;
		const draft = this.commentDraft(proposalId);
		const currentRequest = this.#beginSelection(`proposal:${proposalId}`, preserve);
		try {
			const proposal = await this.#api.getProposal(proposalId);
			if (!currentRequest()) return;
			this.store.set({ proposal: { proposal, comments: preserve ? previous.comments : [], loading: true, draft } });
			const comments = await collectPages(async (cursor) => {
				if (!currentRequest()) throw new Error("Request superseded");
				const page = await this.#api.listProposalComments(proposalId, 100, cursor);
				return { ...page, nextTime: page.nextCreatedAt };
			});
			if (currentRequest())
				this.store.set({ proposal: { ...this.store.get().proposal!, comments, loading: false } });
		} catch (error) {
			if (!currentRequest()) return;
			const proposal = this.store.get().proposal;
			if (proposal) this.store.set({ proposal: { ...proposal, loading: false, error: describeError(error) } });
			else this.store.set({ selectionError: describeError(error) });
		}
	}

	async decideProposal(accept: boolean): Promise<void> {
		if (this.#confirming) return;
		const current = this.store.get().proposal;
		if (
			this.#disposed ||
			!current ||
			current.busy ||
			current.loading ||
			!this.#company.store.get().team?.capabilities.authorize
		)
			return;
		// A read begun before this decision must not replace its state.
		const version = ++this.#selectionVersion;
		this.#confirming = true;
		const confirmed = await confirmDialog(
			accept
				? `Accept “${current.proposal.title}” and publish snapshot ${shortId(current.proposal.proposalSnapshot.snapshotId)} as the new Company File head?`
				: `Reject “${current.proposal.title}”? The proposed snapshot stays retained but never becomes the head.`,
			accept ? "Accept and publish" : "Reject",
			!accept,
			undefined,
			this.#company.signal,
		);
		this.#confirming = false;
		if (!confirmed || this.#disposed || version !== this.#selectionVersion || this.store.get().proposal?.busy) return;
		this.store.set({ proposal: { ...current, busy: true, error: undefined } });
		try {
			const proposal = accept
				? await this.#api.acceptProposal(current.proposal.proposalId, current.proposal.proposalSnapshot.snapshotId)
				: await this.#api.rejectProposal(current.proposal.proposalId, current.proposal.proposalSnapshot.snapshotId);
			if (this.#disposed) return;
			if (version === this.#selectionVersion)
				this.store.set({ proposal: { ...this.store.get().proposal!, proposal, busy: false } });
			await this.refresh();
		} catch (error) {
			if (!this.#disposed && version === this.#selectionVersion)
				this.store.set({ proposal: { ...this.store.get().proposal!, busy: false, error: describeError(error) } });
		}
	}

	async comment(body: string): Promise<void> {
		const current = this.store.get().proposal;
		if (
			this.#disposed ||
			!current ||
			current.busy ||
			current.loading ||
			!body.trim() ||
			!this.#company.store.get().team?.capabilities.write
		)
			return;
		// Preserve this operation's receipt, draft and busy state over older reads.
		const version = ++this.#selectionVersion;
		this.setCommentDraft(current.proposal.proposalId, body);
		const retry = this.#commentRetries.get(current.proposal.proposalId);
		const operation = retry?.body === body.trim() ? retry : { body: body.trim(), id: crypto.randomUUID() };
		this.#commentRetries.set(current.proposal.proposalId, operation);
		this.store.set({ proposal: { ...current, busy: true, draft: body, error: undefined } });
		try {
			const comment = await this.#api.appendProposalComment(
				current.proposal.proposalId,
				operation.id,
				operation.body,
			);
			if (this.#disposed || version !== this.#selectionVersion) return;
			this.#commentRetries.delete(current.proposal.proposalId);
			const latest = this.store.get().proposal!;
			if (this.commentDraft(current.proposal.proposalId) === body)
				this.setCommentDraft(current.proposal.proposalId, "");
			this.store.set({
				proposal: {
					...latest,
					busy: false,
					draft: latest.draft === body ? "" : latest.draft,
					comments: [...latest.comments.filter((item) => item.commentId !== comment.commentId), comment],
				},
			});
		} catch (error) {
			if (!this.#disposed && version === this.#selectionVersion)
				this.store.set({ proposal: { ...this.store.get().proposal!, busy: false, error: describeError(error) } });
		}
	}
}

function describeAccess(error: unknown): string {
	if (error instanceof ObjectAccessError) return error.message;
	return describeError(error);
}

export function renderCompanyFile(
	controller: CompanyFileController,
	company: CompanyController,
	container: HTMLElement,
	view: { snapshotId?: string; proposalId?: string },
): void {
	const owner = `file:${company.userId}:${view.proposalId ?? ""}`;
	const restoreFocus = preserveFormDrafts(container, owner, false);
	controller.select(view);
	const state = controller.store.get();
	const profileId = company.profile.profileId;
	const canAuthorize = company.store.get().team?.capabilities.authorize === true;
	const children: (HTMLElement | null)[] = [h("h1", null, "Company File")];
	if (state.error) children.push(notice("danger", state.error));
	if (state.fileState === "not-deployed")
		children.push(notice("neutral", "The Company File service is not deployed on this cloud."));
	if (state.file) {
		const file = state.file;
		children.push(
			h(
				"div",
				{ class: "summary-grid" },
				summary("State", file.state === "ready" ? badge("ready", "ok") : badge("provisioning", "warn")),
				summary(
					"Head snapshot",
					file.headSnapshotId
						? h("a", { href: `#/c/${profileId}/snapshot/${file.headSnapshotId}` }, shortId(file.headSnapshotId))
						: "—",
				),
				summary("Logical size", fmtBytes(file.logicalBytes)),
				summary("Storage", `${fmtBytes(file.storageUsedBytes)} of ${fmtBytes(file.storageLimitBytes)}`),
				summary("Backends", file.objectBackends.join(", ") || "—"),
				summary(
					"Live paths",
					state.usesPathGateway === true
						? badge("object gateway", "accent")
						: state.usesPathGateway === false
							? badge("cloud storage", "neutral")
							: badge("unknown", "neutral", "qorpera_company_uses_path_gateway is not deployed here"),
				),
			),
		);
	}
	if (view.snapshotId) {
		children.push(
			state.selectionError ? notice("danger", state.selectionError) : renderSnapshot(state, profileId, controller),
		);
		if (state.selectionError || state.snapshot?.error)
			children.push(button("Retry snapshot", () => void controller.openSnapshot(view.snapshotId!)));
	} else if (view.proposalId) {
		children.push(
			state.selectionError
				? notice("danger", state.selectionError)
				: renderProposal(state, profileId, controller, company, canAuthorize),
		);
		if (state.selectionError || state.proposal?.error)
			children.push(button("Retry proposal", () => void controller.openProposal(view.proposalId!)));
	} else {
		children.push(
			h("h2", null, "Published snapshots"),
			state.snapshots.length === 50
				? h("p", { class: "muted small" }, "Showing the 50 most recent snapshots.")
				: null,
			state.loading && !state.snapshots.length
				? spinner("Loading snapshots")
				: state.snapshots.length
					? h(
							"table",
							{ class: "table" },
							h(
								"thead",
								null,
								h(
									"tr",
									null,
									h("th", null, "Snapshot"),
									h("th", null, "Files"),
									h("th", null, "Size"),
									h("th", null, "Published"),
									h("th", null, "By"),
								),
							),
							h(
								"tbody",
								null,
								...state.snapshots.map((snapshot) =>
									h(
										"tr",
										null,
										h(
											"td",
											null,
											h(
												"a",
												{ href: `#/c/${profileId}/snapshot/${snapshot.snapshotId}` },
												shortId(snapshot.snapshotId),
											),
											snapshot.snapshotId === state.file?.headSnapshotId ? [" ", badge("head", "ok")] : null,
										),
										h("td", null, String(snapshot.tree.fileCount)),
										h("td", null, fmtBytes(snapshot.tree.totalBytes)),
										h("td", null, fmtTime(snapshot.createdAt)),
										h("td", null, company.memberName(snapshot.createdByUserId)),
									),
								),
							),
						)
					: h("div", { class: "empty" }, "No published snapshots yet."),
			h(
				"h2",
				null,
				"Proposals ",
				h(
					"span",
					{ class: "tabs" },
					...(["open", "accepted", "rejected"] as const).map((status) =>
						button(status, () => controller.setProposalStatus(status), {
							small: true,
							primary: state.proposalStatus === status,
						}),
					),
				),
			),
			state.proposals.length
				? h(
						"div",
						{ class: "card-list" },
						...state.proposals.map((proposal) =>
							h(
								"a",
								{ class: "card proposal-row", href: `#/c/${profileId}/proposal/${proposal.proposalId}` },
								h(
									"div",
									{ class: "card-body" },
									h("strong", null, proposal.title),
									h(
										"div",
										{ class: "muted small" },
										`${proposal.reason} · by ${proposal.createdByName} · ${fmtTime(proposal.createdAt)}`,
									),
								),
								badge(
									proposal.status,
									proposal.status === "open" ? "warn" : proposal.status === "accepted" ? "ok" : "neutral",
								),
							),
						),
					)
				: h("div", { class: "empty" }, `No ${state.proposalStatus} proposals.`),
			state.workspaces.length > 1
				? h(
						"details",
						null,
						h("summary", null, `${state.workspaces.length} workspaces`),
						h(
							"ul",
							null,
							...state.workspaces.map((workspace) =>
								h(
									"li",
									null,
									`${workspace.name} · head ${workspace.headSnapshotId ? shortId(workspace.headSnapshotId) : "—"} · ${fmtDate(workspace.updatedAt)}`,
								),
							),
						),
					)
				: null,
		);
	}
	replace(container, h("section", { class: "page company-file", "data-form-owner": owner }, ...children));
	restoreFocus();
}

function summary(label: string, value: HTMLElement | string): HTMLElement {
	return h(
		"div",
		{ class: "summary" },
		h("div", { class: "muted small" }, label),
		h("div", { class: "summary-value" }, value),
	);
}

function renderSnapshot(state: CompanyFileState, profileId: string, controller: CompanyFileController): HTMLElement {
	const current = state.snapshot;
	if (!current) return spinner("Loading snapshot");
	const { snapshot } = current;
	const entries = current.entries ?? [];
	return h(
		"div",
		{ class: "snapshot" },
		h("p", null, h("a", { href: `#/c/${profileId}/file` }, "← All snapshots")),
		h("h2", null, `Snapshot ${shortId(snapshot.snapshotId)}`),
		h(
			"div",
			{ class: "muted small" },
			`${snapshot.tree.fileCount} files · ${fmtBytes(snapshot.tree.totalBytes)} · contract v${snapshot.tree.contractVersion} · ${fmtTime(snapshot.createdAt)}${snapshot.parentSnapshotId ? ` · parent ${shortId(snapshot.parentSnapshotId)}` : ""}`,
		),
		current.error ? notice("warn", current.error) : null,
		current.loading ? spinner("Reading tree manifest") : null,
		entries.length
			? h(
					"div",
					{ class: "tree-layout" },
					h(
						"ul",
						{ class: "tree" },
						...entries.map((entry) =>
							h(
								"li",
								{ class: entry.kind },
								entry.kind === "file"
									? h(
											"a",
											{
												href: "#",
												class: current.open === entry.path ? "active" : "",
												onclick: (event: Event) => {
													event.preventDefault();
													void controller.openFile(entry);
												},
											},
											entry.path,
											h("span", { class: "muted small" }, ` ${fmtBytes(entry.file.bytes)}`),
										)
									: h("span", { class: "muted" }, `${entry.path}/`),
							),
						),
					),
					current.open
						? h(
								"div",
								{ class: "file-view" },
								h("h3", null, current.open),
								current.contentError
									? notice("warn", current.contentError)
									: current.content === undefined
										? spinner("Reading file")
										: h("pre", null, current.content),
							)
						: null,
				)
			: null,
	);
}

function renderProposal(
	state: CompanyFileState,
	profileId: string,
	controller: CompanyFileController,
	company: CompanyController,
	canAuthorize: boolean,
): HTMLElement {
	const current = state.proposal;
	if (!current) return spinner("Loading proposal");
	const { proposal } = current;
	const commentInput = h("textarea", { rows: 2, placeholder: "Comment…", "data-draft": "proposal-comment" });
	commentInput.value = controller.commentDraft(proposal.proposalId);
	commentInput.oninput = () => controller.setCommentDraft(proposal.proposalId, commentInput.value);
	return h(
		"div",
		{ class: "proposal" },
		h("p", null, h("a", { href: `#/c/${profileId}/file` }, "← Company File")),
		h(
			"h2",
			null,
			proposal.title,
			" ",
			badge(
				proposal.status,
				proposal.status === "open" ? "warn" : proposal.status === "accepted" ? "ok" : "neutral",
			),
		),
		h(
			"div",
			{ class: "muted small" },
			`${proposal.reason}${proposal.policyKey ? ` (${proposal.policyKey})` : ""} · proposed by ${proposal.createdByName} · ${fmtTime(proposal.createdAt)} · base ${shortId(proposal.baseSnapshotId)} → `,
			h(
				"a",
				{ href: `#/c/${profileId}/snapshot/${proposal.proposalSnapshot.snapshotId}` },
				shortId(proposal.proposalSnapshot.snapshotId),
			),
		),
		current.error ? notice("danger", current.error) : null,
		proposal.reviews.length
			? h(
					"div",
					null,
					h("h3", null, "Reviews"),
					h(
						"ul",
						null,
						...proposal.reviews.map((review) =>
							h(
								"li",
								null,
								`${review.reviewerName}: `,
								badge(
									review.status,
									review.status === "approved"
										? "ok"
										: review.status === "failed" || review.status === "changes_requested"
											? "warn"
											: "neutral",
								),
								review.failureReason ? ` — ${review.failureReason}` : "",
							),
						),
					),
				)
			: null,
		proposal.status === "open"
			? h(
					"div",
					{ class: "row" },
					canAuthorize
						? [
								button("Reject", () => void controller.decideProposal(false), {
									danger: true,
									disabled: current.busy,
								}),
								button("Accept and publish", () => void controller.decideProposal(true), {
									primary: true,
									disabled: current.busy,
								}),
							]
						: notice("neutral", "Owners and admins decide proposals."),
				)
			: proposal.resolvedAt
				? h(
						"div",
						{ class: "muted small" },
						`Resolved ${fmtTime(proposal.resolvedAt)} by ${company.memberName(proposal.resolvedByUserId)}`,
					)
				: null,
		h("h3", null, `Comments (${current.comments.length})`),
		current.loading ? spinner("Loading comments") : null,
		h(
			"div",
			{ class: "comments" },
			...current.comments.map((comment) =>
				h(
					"div",
					{ class: "comment" },
					h(
						"div",
						{ class: "meta" },
						h("strong", null, comment.authorName),
						" ",
						h("span", { class: "muted small" }, fmtTime(comment.createdAt)),
					),
					h("div", null, comment.body),
				),
			),
		),
		company.store.get().team?.capabilities.write
			? h(
					"form",
					{
						class: "row",
						onsubmit: (event: Event) => {
							event.preventDefault();
							void controller.comment(commentInput.value);
						},
					},
					commentInput,
					h("button", { type: "submit", class: "btn", disabled: current.busy || current.loading }, "Comment"),
				)
			: null,
	);
}
