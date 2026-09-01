import type { CloudApi } from "../../cloud/api.ts";
import { CloudRpcError, describeError } from "../../cloud/client.ts";
import { ObjectAccessError, ObjectReader } from "../../cloud/objects.ts";
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

	constructor(api: CloudApi, company: CompanyController) {
		this.#api = api;
		this.#company = company;
		this.#reader = new ObjectReader(api, company.profile.profileId);
	}

	async refresh(): Promise<void> {
		const { profileId, environmentId } = this.#company.profile;
		this.store.set({ loading: true, error: undefined });
		try {
			const file = await this.#api.getCompanyFile(environmentId);
			this.store.set({ file, fileState: "ready" });
			const [workspaces, snapshots] = await Promise.all([
				this.#api.listWorkspaces(environmentId),
				this.#api.listSnapshots(file.canonicalWorkspaceId, 50),
			]);
			this.store.set({ workspaces, snapshots });
		} catch (error) {
			if (error instanceof CloudRpcError && error.missing) this.store.set({ fileState: "not-deployed" });
			else this.store.set({ fileState: "error", error: describeError(error) });
		}
		try {
			this.store.set({ usesPathGateway: await this.#api.usesPathGateway(profileId) });
		} catch {
			this.store.set({ usesPathGateway: undefined });
		}
		await this.refreshProposals();
		this.store.set({ loading: false });
	}

	async refreshProposals(): Promise<void> {
		try {
			const page = await this.#api.listProposals(
				this.#company.profile.environmentId,
				this.store.get().proposalStatus,
				50,
			);
			this.store.set({ proposals: page.items });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		}
	}

	setProposalStatus(status: CompanyFileState["proposalStatus"]): void {
		this.store.set({ proposalStatus: status });
		void this.refreshProposals();
	}

	async openSnapshot(snapshotId: string): Promise<void> {
		try {
			const snapshot =
				this.store.get().snapshots.find((item) => item.snapshotId === snapshotId) ??
				(await this.#api.getSnapshot(snapshotId));
			this.store.set({ snapshot: { snapshot, loading: true } });
			const manifest = await this.#reader.readTreeManifest(snapshot);
			this.store.set({ snapshot: { snapshot, entries: manifest.entries, loading: false } });
		} catch (error) {
			const current = this.store.get().snapshot;
			if (current) this.store.set({ snapshot: { ...current, loading: false, error: describeAccess(error) } });
			else this.store.set({ error: describeError(error) });
		}
	}

	async openFile(entry: CloudCompanyTreeEntry): Promise<void> {
		const current = this.store.get().snapshot;
		if (!current || entry.kind !== "file") return;
		this.store.set({ snapshot: { ...current, open: entry.path, content: undefined, contentError: undefined } });
		try {
			const bytes = await this.#reader.readFile(entry.file);
			const text =
				entry.file.bytes <= 2 * 1024 * 1024 ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : undefined;
			this.store.set((state) => ({
				snapshot: state.snapshot
					? { ...state.snapshot, content: text ?? `(binary, ${fmtBytes(bytes.byteLength)})` }
					: undefined,
			}));
		} catch (error) {
			this.store.set((state) => ({
				snapshot: state.snapshot ? { ...state.snapshot, contentError: describeAccess(error) } : undefined,
			}));
		}
	}

	async openProposal(proposalId: string): Promise<void> {
		try {
			const proposal = await this.#api.getProposal(proposalId);
			this.store.set({ proposal: { proposal, comments: [], loading: true } });
			const comments = await this.#api.listProposalComments(proposalId);
			this.store.set({ proposal: { proposal, comments: comments.items, loading: false } });
		} catch (error) {
			this.store.set({ error: describeError(error) });
		}
	}

	async decideProposal(accept: boolean): Promise<void> {
		const current = this.store.get().proposal;
		if (!current) return;
		const confirmed = await confirmDialog(
			accept
				? `Accept “${current.proposal.title}” and publish snapshot ${shortId(current.proposal.proposalSnapshot.snapshotId)} as the new Company File head?`
				: `Reject “${current.proposal.title}”? The proposed snapshot stays retained but never becomes the head.`,
			accept ? "Accept and publish" : "Reject",
			!accept,
		);
		if (!confirmed) return;
		this.store.set({ proposal: { ...current, busy: true, error: undefined } });
		try {
			const proposal = accept
				? await this.#api.acceptProposal(current.proposal.proposalId, current.proposal.proposalSnapshot.snapshotId)
				: await this.#api.rejectProposal(current.proposal.proposalId, current.proposal.proposalSnapshot.snapshotId);
			this.store.set({ proposal: { ...current, proposal, busy: false } });
			await this.refresh();
		} catch (error) {
			this.store.set({ proposal: { ...current, busy: false, error: describeError(error) } });
		}
	}

	async comment(body: string): Promise<void> {
		const current = this.store.get().proposal;
		if (!current || !body.trim()) return;
		try {
			const comment = await this.#api.appendProposalComment(current.proposal.proposalId, crypto.randomUUID(), body);
			this.store.set({ proposal: { ...current, comments: [...current.comments, comment] } });
		} catch (error) {
			this.store.set({ proposal: { ...current, error: describeError(error) } });
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
		if (state.snapshot?.snapshot.snapshotId !== view.snapshotId) void controller.openSnapshot(view.snapshotId);
		children.push(renderSnapshot(state, profileId, controller));
	} else if (view.proposalId) {
		if (state.proposal?.proposal.proposalId !== view.proposalId) void controller.openProposal(view.proposalId);
		children.push(renderProposal(state, profileId, controller, company, canAuthorize));
	} else {
		children.push(
			h("h2", null, "Published snapshots"),
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
	replace(container, h("section", { class: "page company-file" }, ...children));
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
	const commentInput = h("textarea", { rows: 2, placeholder: "Comment…" });
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
							commentInput.value = "";
						},
					},
					commentInput,
					h("button", { type: "submit", class: "btn" }, "Comment"),
				)
			: null,
	);
}
