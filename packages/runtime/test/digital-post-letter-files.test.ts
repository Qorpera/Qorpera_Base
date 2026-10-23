import { parseCloudCompanyPath } from "@qorpera/cloud-client/company-path-schema";
import { digitalPostSafeName, layOutDigitalPostLetter } from "@qorpera/runtime/digital-post-letter-files";
import type { DigitalPostLetter } from "@qorpera/runtime/digital-post-memo";
import { describe, expect, it } from "vitest";

/* How a Digital Post letter lies in the company folder (digital-post-letter-files.ts): one folder per letter named by
 * day, sender and title, `letter.md` to read, `letter.json` with every field, and the documents under safe names. */

const file = (filename: string, encodingFormat: string, text: string) => ({
	encodingFormat,
	filename,
	language: "da",
	bytes: new Uint8Array(Buffer.from(text)),
});

function letter(overrides: Partial<DigitalPostLetter> = {}): DigitalPostLetter {
	return {
		messageUuid: "6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a",
		memoVersion: "1.2",
		messageId: null,
		messageCode: null,
		title: "Årsopgørelse 2025",
		notification: "Du har fået post",
		reply: true,
		replyBy: "2026-11-15T23:00:00Z",
		mandatory: false,
		legalNotification: true,
		postType: null,
		sender: { id: "19552101", idType: "CVR", name: "Skattestyrelsen", contactPoint: "Selskabsskat" },
		recipient: { id: "12345678", idType: "CVR", name: "Testfirma ApS" },
		caseId: "SAG-778",
		created: "2026-10-21T23:30:00Z",
		documents: [
			{
				role: "main",
				label: "Årsopgørelse",
				files: [
					file("aarsopgoerelse.pdf", "application/pdf", "%PDF"),
					file("aarsopgoerelse.html", "text/html", "<p>Kære Testfirma</p>"),
				],
				actions: [
					{
						label: "Betal nu",
						actionCode: "BETALING",
						startDateTime: null,
						endDateTime: "2026-11-30T23:00:00Z",
						url: "https://skat.dk/betal",
					},
				],
			},
			{ role: "additional", label: "Bilag", files: [file("Bilag.PDF", "application/pdf", "b")], actions: [] },
			{ role: "additional", label: null, files: [file("bilag.pdf", "application/pdf", "c")], actions: [] },
		],
		record: { Message: { MessageHeader: { label: "Årsopgørelse 2025" } } },
		...overrides,
	};
}

const received = new Date("2026-10-22T06:00:00Z");
const text = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString("utf8");

describe("layOutDigitalPostLetter", () => {
	it("names the folder by the sender's day in Danish time, the sender, the title and the id", () => {
		const layout = layOutDigitalPostLetter(letter(), received);
		expect(layout.folder).toBe(
			"digital-post/2026/2026-10-22 Skattestyrelsen - Årsopgørelse 2025 (6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a)",
		);
		expect(layout.files.map((entry) => [entry.name, entry.mediaType])).toEqual([
			["letter.md", "text/markdown"],
			["letter.json", "application/json"],
			["aarsopgoerelse.pdf", "application/pdf"],
			["aarsopgoerelse.html", "text/html"],
			["Bilag.PDF", "application/pdf"],
			["bilag (2).pdf", "application/pdf"],
		]);
		for (const entry of layout.files)
			expect(() => parseCloudCompanyPath(`${layout.folder}/${entry.name}`)).not.toThrow();
	});

	it("writes letter.md with the sender, the flags, the documents, the links and the text", () => {
		const markdown = text(layOutDigitalPostLetter(letter(), received).files[0]?.bytes);
		expect(markdown).toContain("# Årsopgørelse 2025\n");
		expect(markdown).toContain("outside content");
		expect(markdown).toContain("- From: Skattestyrelsen (CVR 19552101)");
		expect(markdown).toContain("- Department: Selskabsskat");
		expect(markdown).toContain("- To: Testfirma ApS (CVR 12345678)");
		expect(markdown).toContain("- Written: 2026-10-22 01:30");
		expect(markdown).toContain("- Received: 2026-10-22 08:00");
		expect(markdown).toContain("- Case: SAG-778");
		expect(markdown).toContain("- Legal effect: yes");
		expect(markdown).not.toContain("Mandatory post");
		expect(markdown).toContain("until 2026-11-16 00:00");
		expect(markdown).toContain("- [bilag (2).pdf](<bilag%20(2).pdf>) (additional)");
		expect(markdown).toContain("- Betal nu (BETALING, until 2026-12-01 00:00): <https://skat.dk/betal>");
		expect(markdown).toContain("From aarsopgoerelse.html:\n\nKære Testfirma");
		expect(markdown.endsWith("\n")).toBe(true);
	});

	it("says where the text is when the main document is only a PDF, and takes text read from it", () => {
		const pdfOnly = letter({
			documents: [{ role: "main", label: null, files: [file("brev.pdf", "application/pdf", "%PDF")], actions: [] }],
			reply: false,
		});
		const without = layOutDigitalPostLetter(pdfOnly, received);
		expect(text(without.files[0]?.bytes)).toContain("The letter's text is in brev.pdf");
		expect(text(without.files[0]?.bytes)).toContain("does not take replies");
		expect(without.summary).toMatchObject({ text: false, snippet: null, replyBy: null, files: 1 });
		const withText = layOutDigitalPostLetter(pdfOnly, received, {
			text: "Read from the PDF",
			from: pdfOnly.documents[0]!.files[0]!,
		});
		expect(text(withText.files[0]?.bytes)).toContain("From brev.pdf:\n\nRead from the PDF");
		expect(withText.summary).toMatchObject({ text: true, snippet: "Read from the PDF" });
	});

	it("gives letters that share a day, sender, title and id prefix their own folders", () => {
		const first = layOutDigitalPostLetter(letter(), received).folder;
		const second = layOutDigitalPostLetter(
			letter({ messageUuid: "6f1d3c2a-0000-4000-8000-000000000001" }),
			received,
		).folder;
		expect(first).not.toBe(second);
		expect(second.endsWith("(6f1d3c2a-0000-4000-8000-000000000001)")).toBe(true);
	});

	it("links documents whose names hold #, brackets or spaces, and keeps links whole", () => {
		const markdown = text(
			layOutDigitalPostLetter(
				letter({
					documents: [
						{
							role: "main",
							label: null,
							files: [file("brev #1 [kopi].pdf", "application/pdf", "%PDF")],
							actions: [
								{
									label: "Se sag",
									actionCode: "INFORMATION",
									startDateTime: null,
									endDateTime: null,
									url: "https://example.dk/sag?a=1 b>c",
								},
							],
						},
					],
				}),
				received,
			).files[0]?.bytes,
		);
		expect(markdown).toContain("- [brev #1 \\[kopi\\].pdf](<brev%20%231%20%5Bkopi%5D.pdf>) (main)");
		expect(markdown).toContain("- Se sag (INFORMATION): <https://example.dk/sag?a=1%20b%3Ec>");
	});

	it("keeps every field in letter.json", () => {
		const json = JSON.parse(text(layOutDigitalPostLetter(letter(), received).files[1]?.bytes));
		expect(json).toEqual({ Message: { MessageHeader: { label: "Årsopgørelse 2025" } } });
	});

	it("summarizes the letter for the index", () => {
		expect(layOutDigitalPostLetter(letter(), received).summary).toEqual({
			messageUuid: "6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a",
			folder:
				"digital-post/2026/2026-10-22 Skattestyrelsen - Årsopgørelse 2025 (6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a)",
			title: "Årsopgørelse 2025",
			sender: "Skattestyrelsen",
			senderId: "19552101",
			created: "2026-10-21T23:30:00Z",
			received: "2026-10-22T06:00:00.000Z",
			mandatory: false,
			legalNotification: true,
			replyBy: "2026-11-15T23:00:00Z",
			caseId: "SAG-778",
			files: 4,
			text: true,
			snippet: "Kære Testfirma",
		});
	});

	it("makes unsafe titles, senders and file names safe and keeps them apart from letter.md", () => {
		const layout = layOutDigitalPostLetter(
			letter({
				title: "Afgørelse: 50% af beløb / rente.",
				sender: { id: "29188505", idType: "CVR", name: "Erhvervs\u0001styrelsen\\Kbh", contactPoint: null },
				created: "not a time",
				documents: [
					{
						role: "main",
						label: null,
						files: [
							file("LETTER.MD", "text/plain", "hej"),
							file("con.txt", "Text/Plain;x", "a"),
							file("../../x.pdf", "application/pdf", "b"),
							file("   ", "application/pdf", "c"),
						],
						actions: [],
					},
				],
			}),
			received,
		);
		expect(layout.folder).toBe(
			"digital-post/2026/2026-10-22 Erhvervs-styrelsen-Kbh - Afgørelse- 50- af beløb - rente (6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a)",
		);
		expect(layout.files.map((entry) => entry.name)).toEqual([
			"letter.md",
			"letter.json",
			"LETTER (2).MD",
			"_con.txt",
			"..-..-x.pdf",
			"document-4",
		]);
		expect(layout.files[3]?.mediaType).toBe("application/octet-stream");
		for (const entry of layout.files)
			expect(() => parseCloudCompanyPath(`${layout.folder}/${entry.name}`)).not.toThrow();
	});
});

describe("digitalPostSafeName", () => {
	it("folds full-width separators before replacing them, and cuts long names", () => {
		expect(digitalPostSafeName("a／b：c", "x", 40)).toBe("a-b-c");
		expect(digitalPostSafeName("x".repeat(50), "x", 40)).toHaveLength(40);
		expect(digitalPostSafeName("...", "fallback", 40)).toBe("fallback");
		expect(digitalPostSafeName("Brev .", "x", 40)).toBe("Brev");
		expect(digitalPostSafeName("LPT1", "x", 40)).toBe("_LPT1");
	});
});
