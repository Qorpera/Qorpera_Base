// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { CompanyFileController, renderCompanyFile } from "../src/app/views/companyfile.ts";
import { ObjectReader } from "../src/cloud/objects.ts";
import type { CloudCompanyTreeEntry, HostedCompanyProposal } from "../src/cloud/types.ts";
import { deferred, fixture, id, profileA, proposal, settle, snapshot, team, timestamp, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function setup() {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({ team, loading: false });
	const files = new CompanyFileController(f.api, company);
	cleanup.push(() => {
		files.dispose();
		company.stop();
	});
	return { ...f, company, files };
}
const entry = (name: string): CloudCompanyTreeEntry => ({
	kind: "file",
	path: `${name}.txt`,
	executable: false,
	file: { manifestSha256: name.repeat(64), fileSha256: "f".repeat(64), bytes: 9, mediaType: "text/plain" },
});

describe("Company File request ownership", () => {
	it("keeps an active confirmation valid across background refreshes", async () => {
		const { api, files } = setup();
		await files.openProposal(proposal.proposalId);
		const accept = vi.spyOn(api, "acceptProposal").mockResolvedValue({ ...proposal, status: "accepted" });
		const deciding = files.decideProposal(true);
		await files.refresh();
		expect(api.getProposal).toHaveBeenCalledTimes(1);
		[...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
			.find((button) => button.textContent === "Accept and publish")!
			.click();
		await deciding;
		expect(accept).toHaveBeenCalledExactlyOnceWith(proposal.proposalId, snapshot.snapshotId);
	});
	it("refreshes comments on healthy-channel polls without replacing the selected proposal", async () => {
		vi.useFakeTimers();
		const { api, company, files } = setup();
		await company.start();
		files.start();
		await settle();
		await files.openProposal(proposal.proposalId);
		company.store.set({ realtime: "connected" });
		const response = deferred<HostedCompanyProposal>();
		vi.mocked(api.getProposal).mockReturnValue(response.promise);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(api.getCompanyFile).toHaveBeenCalledTimes(2);
		expect(files.store.get().proposal?.proposal.proposalId).toBe(proposal.proposalId);
		response.resolve(proposal);
		await settle();
	});

	it("reuses an ambiguous comment operation on retry and avoids a duplicate receipt", async () => {
		const { api, files } = setup();
		await files.openProposal(proposal.proposalId);
		const append = vi
			.spyOn(api, "appendProposalComment")
			.mockRejectedValueOnce(new Error("Response lost"))
			.mockResolvedValue({
				commentId: id(90),
				proposalId: proposal.proposalId,
				body: "One comment",
				authorName: "A",
				createdAt: timestamp,
			});
		await files.comment("One comment");
		await files.comment("One comment");
		expect(append.mock.calls[0]?.[1]).toBe(append.mock.calls[1]?.[1]);
		expect(files.store.get().proposal?.comments).toHaveLength(1);
		expect(files.commentDraft(proposal.proposalId)).toBe("");
	});
	it("keeps file B's content when file A finishes later", async () => {
		const { files } = setup();
		const a = deferred<Uint8Array>(),
			b = deferred<Uint8Array>();
		vi.spyOn(ObjectReader.prototype, "readFile").mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
		files.store.set({ snapshot: { snapshot, loading: false } });
		const first = files.openFile(entry("a")),
			second = files.openFile(entry("b"));
		b.resolve(new TextEncoder().encode("B content"));
		await second;
		a.resolve(new TextEncoder().encode("A content"));
		await first;
		expect(files.store.get().snapshot).toMatchObject({ open: "b.txt", content: "B content" });
	});

	it("ignores old snapshot and proposal lookups after selection changes", async () => {
		const { api, files } = setup();
		const oldSnapshot = deferred<typeof snapshot>(),
			oldProposal = deferred<HostedCompanyProposal>();
		vi.mocked(api.getSnapshot).mockReturnValue(oldSnapshot.promise);
		vi.mocked(api.getProposal)
			.mockReturnValueOnce(oldProposal.promise)
			.mockResolvedValue({ ...proposal, proposalId: id(99), title: "Newest" });
		const first = files.openSnapshot(snapshot.snapshotId),
			second = files.openProposal(proposal.proposalId);
		await files.openProposal(id(99));
		oldProposal.resolve(proposal);
		oldSnapshot.resolve(snapshot);
		await Promise.all([first, second]);
		expect(files.store.get().proposal?.proposal.title).toBe("Newest");
		expect(files.store.get().snapshot).toBeUndefined();
	});

	it("does not refetch a failed route on every render", async () => {
		const { api, company, files } = setup();
		vi.mocked(api.getProposal).mockRejectedValue(new Error("Proposal missing"));
		const container = document.createElement("main");
		for (let i = 0; i < 5; i++) {
			renderCompanyFile(files, company, container, { proposalId: proposal.proposalId });
			await settle();
		}
		expect(api.getProposal).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Proposal missing");
		container.querySelector("button")!.click();
		await settle();
		expect(api.getProposal).toHaveBeenCalledTimes(2);
	});

	it("ignores stale proposal filters and follows comment and proposal pages", async () => {
		const { api, files } = setup();
		const stale = deferred<Awaited<ReturnType<typeof api.listProposals>>>();
		vi.mocked(api.listProposals)
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce({
				items: [{ ...proposal, status: "accepted" }],
				hasMore: true,
				nextCreatedAt: timestamp,
				nextId: proposal.proposalId,
			})
			.mockResolvedValueOnce({ items: [{ ...proposal, proposalId: id(99), status: "accepted" }], hasMore: false });
		const first = files.refreshProposals();
		files.setProposalStatus("accepted");
		await settle();
		stale.resolve({ items: [proposal], hasMore: false });
		await first;
		expect(files.store.get().proposals.map((p) => p.status)).toEqual(["accepted", "accepted"]);
		expect(api.listProposals).toHaveBeenLastCalledWith(profileA.environmentId, "accepted", 50, {
			time: timestamp,
			id: proposal.proposalId,
		});
		const comment = {
			commentId: id(60),
			proposalId: proposal.proposalId,
			body: "First",
			authorName: "A",
			createdAt: timestamp,
		};
		vi.mocked(api.listProposalComments)
			.mockResolvedValueOnce({
				items: [comment],
				hasMore: true,
				nextCreatedAt: timestamp,
				nextId: comment.commentId,
			})
			.mockResolvedValueOnce({ items: [{ ...comment, commentId: id(61), body: "Second" }], hasMore: false });
		await files.openProposal(proposal.proposalId);
		expect(files.store.get().proposal?.comments).toHaveLength(2);
		expect(api.listProposalComments).toHaveBeenLastCalledWith(proposal.proposalId, 100, {
			time: timestamp,
			id: comment.commentId,
		});
	});

	it("refreshes Company File after realtime invalidation and unsubscribes on dispose", async () => {
		const { api, company, files, hints } = setup();
		await company.start();
		files.start();
		await settle();
		expect(api.getCompanyFile).toHaveBeenCalledTimes(1);
		hints.get("qorpera_company_files")!();
		await settle();
		expect(api.getCompanyFile).toHaveBeenCalledTimes(2);
		files.dispose();
		hints.get("qorpera_company_files")!();
		await settle();
		expect(api.getCompanyFile).toHaveBeenCalledTimes(2);
	});

	it("retains a failed comment draft and does not apply it to a different proposal", async () => {
		const { api, files } = setup();
		await files.openProposal(proposal.proposalId);
		const response = deferred<Awaited<ReturnType<typeof api.appendProposalComment>>>();
		vi.spyOn(api, "appendProposalComment").mockReturnValue(response.promise);
		const posting = files.comment("Keep this draft");
		vi.mocked(api.getProposal).mockResolvedValue({ ...proposal, proposalId: id(99) });
		await files.openProposal(id(99));
		response.reject(new Error("Lost response"));
		await posting;
		expect(files.commentDraft(proposal.proposalId)).toBe("Keep this draft");
		expect(files.store.get().proposal?.comments).toEqual([]);
		expect(files.store.get().proposal?.error).toBeUndefined();
	});
});
