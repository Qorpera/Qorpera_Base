import { createHash } from "node:crypto";
import {
	DIGITAL_POST_LETTER_MAX_BYTES,
	DigitalPostLetterInvalid,
	digitalPostLetterText,
	htmlLetterText,
	readDigitalPostLetter,
} from "@qorpera/runtime/digital-post-memo";
import { describe, expect, it } from "vitest";

/* Digital Post letters (digital-post-memo.ts): a MeMo document read strictly, reduced to the letter the platform keeps,
 * with every field kept in `record` and the main document's text taken from its text or HTML version. */

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const PDF = Buffer.from("%PDF-1.7\nfake pdf bytes\n%%EOF\n");

interface Parts {
	prefix?: string;
	uuid?: string;
	header?: string;
	main?: string;
	extra?: string;
	declaration?: string;
}

/** A letter as Digital Post delivers it, made for these tests. */
function memo(parts: Parts = {}): string {
	const p = parts.prefix ?? "memo";
	const q = p ? `${p}:` : "";
	const ns = p ? `xmlns:${p}="https://DigitalPost.dk/MeMo-1"` : `xmlns="https://DigitalPost.dk/MeMo-1"`;
	return `${parts.declaration ?? '<?xml version="1.0" encoding="UTF-8"?>'}
<!-- a test letter -->
<${q}Message ${ns} xmlns:grd="https://data.gov.dk/model/core/" memoVersion="1.2" memoSchVersion="1.2.0">
	<${q}MessageHeader>
		<${q}messageType>DIGITALPOST</${q}messageType>
		<${q}messageUUID>${parts.uuid ?? "6F1D3C2A-9B8E-4D7C-8A6B-5E4F3D2C1B0A"}</${q}messageUUID>
		<${q}messageID>SKAT-2026-118</${q}messageID>
		<${q}label>Årsopgørelse 2025 &amp; rettelser</${q}label>
		<${q}notification>Du har fået post fra Skattestyrelsen</${q}notification>
		<${q}reply>true</${q}reply>
		<${q}replyByDateTime>2026-11-15T23:00:00Z</${q}replyByDateTime>
		<${q}mandatory>false</${q}mandatory>
		<${q}legalNotification>true</${q}legalNotification>
		<${q}postType>VIRKSOMHEDSPOST</${q}postType>
		<${q}Sender>
			<${q}senderID>19552101</${q}senderID>
			<${q}idType>CVR</${q}idType>
			<${q}label>Skattestyrelsen</${q}label>
			<${q}ContactPoint>
				<${q}contactPointID>4b1c3a9e-1c2d-4e5f-8a7b-0c1d2e3f4a5b</${q}contactPointID>
				<${q}label>Selskabsskat</${q}label>
			</${q}ContactPoint>
		</${q}Sender>
		<${q}Recipient>
			<${q}recipientID>12345678</${q}recipientID>
			<${q}idType>CVR</${q}idType>
			<${q}label>Testfirma ApS</${q}label>
		</${q}Recipient>
		<${q}ContentData>
			<grd:CVRdata><grd:cvrNumber>12345678</grd:cvrNumber><grd:companyName>Testfirma ApS</grd:companyName></grd:CVRdata>
			<${q}CaseID><${q}caseID>SAG-778</${q}caseID><${q}caseSystem>Skat</${q}caseSystem></${q}CaseID>
		</${q}ContentData>
		${parts.header ?? ""}
	</${q}MessageHeader>
	<${q}MessageBody>
		<${q}createdDateTime>2026-10-21T23:30:00Z</${q}createdDateTime>
		${
			parts.main ??
			`<${q}MainDocument>
			<${q}mainDocumentID>1</${q}mainDocumentID>
			<${q}label>Årsopgørelse</${q}label>
			<${q}File>
				<${q}encodingFormat>application/PDF</${q}encodingFormat>
				<${q}filename>aarsopgoerelse.pdf</${q}filename>
				<${q}language>da</${q}language>
				<${q}content>${b64(PDF)}</${q}content>
			</${q}File>
			<${q}File>
				<${q}encodingFormat>text/html</${q}encodingFormat>
				<${q}filename>aarsopgoerelse.html</${q}filename>
				<${q}content>${b64("<html><head><title>x</title></head><body><p>Kære Testfirma</p><p>Beløb: 1.200&nbsp;kr</p></body></html>")}</${q}content>
			</${q}File>
			<${q}Action>
				<${q}label>Betal nu</${q}label>
				<${q}actionCode>BETALING</${q}actionCode>
				<${q}endDateTime>2026-11-30T23:00:00Z</${q}endDateTime>
				<${q}EntryPoint><${q}url>https://skat.dk/betal?ref=1&amp;x=2</${q}url></${q}EntryPoint>
			</${q}Action>
		</${q}MainDocument>`
		}
		${parts.extra ?? ""}
	</${q}MessageBody>
</${q}Message>
`;
}

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

function refused(text: string | Uint8Array, message?: RegExp) {
	const run = () => readDigitalPostLetter(typeof text === "string" ? bytes(text) : text);
	expect(run).toThrow(DigitalPostLetterInvalid);
	if (message) expect(run).toThrow(message);
}

describe("readDigitalPostLetter", () => {
	it("reads the header, the parties, the flags, the documents and the links", () => {
		const letter = readDigitalPostLetter(
			bytes(
				memo({
					extra: `<memo:AdditionalDocument>
						<memo:label>Vejledning</memo:label>
						<memo:File><memo:encodingFormat>application/pdf</memo:encodingFormat><memo:filename>vejledning.pdf</memo:filename><memo:content>${b64("guide")}</memo:content></memo:File>
					</memo:AdditionalDocument>
					<memo:TechnicalDocument>
						<memo:File><memo:encodingFormat>text/xml</memo:encodingFormat><memo:filename>data.xml</memo:filename><memo:content><![CDATA[${b64("<a/>")}]]></memo:content></memo:File>
					</memo:TechnicalDocument>`,
				}),
			),
		);
		expect(letter).toMatchObject({
			messageUuid: "6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a",
			memoVersion: "1.2",
			messageId: "SKAT-2026-118",
			title: "Årsopgørelse 2025 & rettelser",
			notification: "Du har fået post fra Skattestyrelsen",
			reply: true,
			replyBy: "2026-11-15T23:00:00Z",
			mandatory: false,
			legalNotification: true,
			postType: "VIRKSOMHEDSPOST",
			sender: { id: "19552101", idType: "CVR", name: "Skattestyrelsen", contactPoint: "Selskabsskat" },
			recipient: { id: "12345678", idType: "CVR", name: "Testfirma ApS" },
			caseId: "SAG-778",
			created: "2026-10-21T23:30:00Z",
		});
		expect(letter.documents.map((document) => [document.role, document.label, document.files.length])).toEqual([
			["main", "Årsopgørelse", 2],
			["additional", "Vejledning", 1],
			["technical", null, 1],
		]);
		const [pdf, html] = letter.documents[0]?.files ?? [];
		expect(pdf?.encodingFormat).toBe("application/pdf");
		expect(Buffer.from(pdf?.bytes ?? [])).toEqual(PDF);
		expect(html?.language).toBeNull();
		expect(Buffer.from(letter.documents[2]?.files[0]?.bytes ?? []).toString()).toBe("<a/>");
		expect(letter.documents[0]?.actions).toEqual([
			{
				label: "Betal nu",
				actionCode: "BETALING",
				startDateTime: null,
				endDateTime: "2026-11-30T23:00:00Z",
				url: "https://skat.dk/betal?ref=1&x=2",
			},
		]);
	});

	it("keeps every field in the record, with each file as its size and digest", () => {
		const letter = readDigitalPostLetter(bytes(memo()));
		const record = letter.record as Record<string, Record<string, Record<string, unknown>>>;
		const message = record.Message as Record<string, unknown>;
		expect(message["@memoVersion"]).toBe("1.2");
		const header = message.MessageHeader as Record<string, unknown>;
		expect(header.messageID).toBe("SKAT-2026-118");
		expect(header.ContentData).toEqual({
			"grd:CVRdata": { "grd:cvrNumber": "12345678", "grd:companyName": "Testfirma ApS" },
			CaseID: { caseID: "SAG-778", caseSystem: "Skat" },
		});
		const main = (message.MessageBody as Record<string, Record<string, unknown>>).MainDocument as Record<
			string,
			unknown
		>;
		const files = main.File as Record<string, unknown>[];
		expect(files).toHaveLength(2);
		expect(files[0]?.content).toEqual({ bytes: String(PDF.byteLength), sha256: sha(PDF) });
		expect(JSON.stringify(letter.record)).not.toContain(b64(PDF));
	});

	it("reads any prefix, a default namespace, a byte order mark, entities and character references", () => {
		const plain = memo({ prefix: "" });
		expect(readDigitalPostLetter(bytes(plain)).title).toBe("Årsopgørelse 2025 & rettelser");
		const other = memo({ prefix: "m" }).replace("rettelser", "&#x72;ettelser &#229;");
		expect(readDigitalPostLetter(bytes(other)).title).toBe("Årsopgørelse 2025 & rettelser å");
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes(memo())]);
		expect(readDigitalPostLetter(bom).messageUuid).toBe("6f1d3c2a-9b8e-4d7c-8a6b-5e4f3d2c1b0a");
		expect(readDigitalPostLetter(bytes(memo({ declaration: "" }))).title).toContain("Årsopgørelse");
	});

	it("refuses a document type, unknown entities and encodings other than UTF-8", () => {
		refused(memo().replace("<!-- a test letter -->", '<!DOCTYPE m [<!ENTITY x "y">]>'), /document type/);
		refused(memo().replace("&amp; rettelser", "&x; rettelser"));
		refused(memo().replace("&amp; rettelser", "& rettelser"));
		refused(memo({ declaration: '<?xml version="1.0" encoding="ISO-8859-1"?>' }), /not UTF-8/);
		refused(new Uint8Array([...bytes(memo()).slice(0, 200), 0xff, 0xfe]), /not UTF-8/);
		refused(memo().replace("Skattestyrelsen</memo:label>", "Skatte\u0001styrelsen</memo:label>"));
		refused(memo().replace("&amp;", "&#0;"));
		refused(`<!-- first -->\n${memo()}`);
	});

	it("refuses malformed XML", () => {
		refused(memo().replace("</memo:messageID>", "</memo:messageId>"));
		refused(`${memo()}<memo:Message xmlns:memo="https://DigitalPost.dk/MeMo-1"/>`, /more than one root/);
		refused(memo().replace('memoVersion="1.2"', 'memoVersion="1.2" memoVersion="1.1"'));
		refused(memo().replace("<memo:label>Skattestyrelsen", "<x:label>Skattestyrelsen"));
		refused(memo().slice(0, -30));
		refused(`${memo()} trailing`);
		refused("");
	});

	it("refuses what is not a letter the platform can keep", () => {
		refused(memo().replace(/https:\/\/DigitalPost\.dk\/MeMo-1/, "urn:other"), /not a MeMo letter/);
		refused(memo({ uuid: "not-a-uuid" }), /not a UUID/);
		refused(memo().replace(/<memo:messageUUID>.*<\/memo:messageUUID>/, ""), /one messageUUID/);
		refused(memo({ main: "" }), /one MainDocument/);
		refused(memo().replace(/<memo:MessageBody>[\s\S]*<\/memo:MessageBody>/, ""), /one MessageHeader and one/);
		refused(memo().replace(b64(PDF), "not base64!"), /not base64/);
		refused(memo().replace("<memo:reply>true</memo:reply>", "<memo:reply>yes</memo:reply>"), /reply/);
		refused(memo().replace(/<memo:Sender>[\s\S]*<\/memo:Sender>/, ""), /no Sender/);
		refused(
			memo()
				.replace(/<memo:File>\s*<memo:encodingFormat>text\/html[\s\S]*?<\/memo:File>/, "")
				.replace(/<memo:File>[\s\S]*?<\/memo:File>/, ""),
			/has no file/,
		);
		refused(new Uint8Array(DIGITAL_POST_LETTER_MAX_BYTES + 1), /too large/);
	});

	it("bounds nesting", () => {
		const deep = `${"<memo:x>".repeat(70)}${"</memo:x>".repeat(70)}`;
		refused(memo({ header: deep }), /too large/);
	});
});

describe("the main document's text", () => {
	it("prefers a plain-text version, then HTML; a PDF alone has no text", () => {
		const html = readDigitalPostLetter(bytes(memo()));
		expect(digitalPostLetterText(html)).toMatchObject({ text: "Kære Testfirma\n\nBeløb: 1.200 kr" });
		expect(digitalPostLetterText(html).source?.filename).toBe("aarsopgoerelse.html");
		const plain = readDigitalPostLetter(
			bytes(
				memo().replace(
					"<memo:Action>",
					`<memo:File><memo:encodingFormat>text/plain</memo:encodingFormat><memo:filename>a.txt</memo:filename><memo:content>${b64("Hej\r\nverden")}</memo:content></memo:File><memo:Action>`,
				),
			),
		);
		expect(digitalPostLetterText(plain).text).toBe("Hej\nverden");
		const pdfOnly = readDigitalPostLetter(
			bytes(memo().replace(/<memo:File>\s*<memo:encodingFormat>text\/html[\s\S]*?<\/memo:File>/, "")),
		);
		expect(digitalPostLetterText(pdfOnly)).toMatchObject({ text: null });
		expect(digitalPostLetterText(pdfOnly).source?.filename).toBe("aarsopgoerelse.pdf");
	});

	it("reads Windows-1252 text that is not UTF-8", () => {
		const latin = Buffer.from([0x42, 0x65, 0x6c, 0xf8, 0x62]); // "Beløb"
		const letter = readDigitalPostLetter(
			bytes(
				memo({
					main: `<memo:MainDocument><memo:File><memo:encodingFormat>text/plain</memo:encodingFormat><memo:filename>a.txt</memo:filename><memo:content>${b64(latin)}</memo:content></memo:File></memo:MainDocument>`,
				}),
			),
		);
		expect(digitalPostLetterText(letter).text).toBe("Beløb");
	});

	it("turns HTML into lines of text", () => {
		expect(
			htmlLetterText(
				"<style>p{}</style><h1>Afgørelse</h1><p>Linje&nbsp;1<br>Linje 2</p><ul><li>a</li><li>b &aelig;&oslash;&aring; &#8364;</li></ul><script>x()</script><table><tr><td>A</td><td>B</td></tr></table>",
			),
		).toBe("Afgørelse\n\nLinje 1\nLinje 2\n\n- a\n\n- b æøå €\n\nA B");
	});
});
