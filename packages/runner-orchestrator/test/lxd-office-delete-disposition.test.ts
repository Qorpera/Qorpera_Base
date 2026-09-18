import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertLxdOfficeDeleteDispositionContext,
	lxdOfficeDeleteDispositionPath,
	lxdOfficeDeleteDocumentSha256,
	readLxdOfficeDeleteDisposition,
} from "../src/lxd-office-delete-disposition.ts";
import { officeCanonical, officeDigest } from "../src/lxd-office-image-provenance.ts";
import {
	officeDeleteDispositionId as id,
	officeDeleteDispositionContextFixture,
	officeDeleteDispositionContextFor,
	officeDeleteDispositionFixture,
	officeDeleteDispositionEnvelopeFixture as packet,
	officeDeleteDispositionSha as sha,
} from "./helpers/office-delete-disposition-fixture.ts";

const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const error = "OFFICE_DELETE_DISPOSITION_UNCONFIRMED";
async function read(v: unknown, allocation = id(10), audit = id(41)) {
	return readLxdOfficeDeleteDisposition(allocation, audit, async (path, limit) => {
		expect(path).toBe(`/etc/qorpera/office-provider/delete-dispositions/${allocation}/${audit}.json`);
		expect(limit).toBe(65536);
		return encode(v);
	});
}
describe("protected administrative delete history", () => {
	it("brands a caller-supplied real-prefix fixture through the same protected reader", async () => {
		const { plan, document } = officeDeleteDispositionFixture();
		Object.assign(document.journal, { acceptedHeadSha256: sha("c"), eventCount: 14 });
		const custom = await officeDeleteDispositionContextFor(plan, document);
		assertLxdOfficeDeleteDispositionContext(custom.context);
		expect(custom.context.document.journal).toEqual(document.journal);
		expect(custom.bytes).toEqual(encode(custom.envelope));
	});

	it("pins raw UTF8 text including whitespace and independently reconstructed phase/SQL evidence", async () => {
		const p = packet(),
			c = await read(p);
		expect(c.dispositionSha256).toBe(createHash("sha256").update(p.documentText).digest("hex"));
		expect(c.dispositionSha256).not.toBe(officeDigest(JSON.parse(p.documentText)));
		expect(c.sqlReceipt).toEqual(p.sqlReceipt);
		expect(c.phaseEvidenceSha256).toBe(officeDigest(p.sqlReceipt.phaseEvidence));
		expect(c.sqlReceiptSha256).toBe(officeDigest(p.sqlReceipt));
		const compact = packet(JSON.stringify(JSON.parse(p.documentText)));
		expect((await read(compact)).dispositionSha256).not.toBe(c.dispositionSha256);
		await expect(read({ ...p, documentText: compact.documentText })).rejects.toThrow(error);
	});
	it("keeps old immutable historical evidence without current auth or a physical authority claim", async () => {
		const c = await read(packet());
		expect(c.sqlReceipt.recordedAt).toBe("2020-01-01T00:01:00.000Z");
		expect(c.document.observedAt).toBe("2020-01-01T00:00:00.000Z");
		expect(c.sqlReceipt.cleanResetAcceptance).toBe(false);
		expect(c.document.originalOutcome).toBe("unknown");
		expect(c).not.toHaveProperty("authorized");
	});
	it("brands only the reader-created deeply frozen object", async () => {
		const { context: c } = await officeDeleteDispositionContextFixture();
		expect(() => assertLxdOfficeDeleteDispositionContext(c)).not.toThrow();
		for (const fake of [null, true, {}, { ...c }, structuredClone(c), Object.freeze({ ...c, verified: true })])
			expect(() => assertLxdOfficeDeleteDispositionContext(fake)).toThrow(
				"OFFICE_DELETE_DISPOSITION_CONTEXT_UNVERIFIED",
			);
		const walk = (v: unknown): void => {
			if (v && typeof v === "object") {
				expect(Object.isFrozen(v)).toBe(true);
				Object.values(v).forEach(walk);
			}
		};
		walk(c);
		expect(() => Object.assign(c.sqlReceipt.phaseEvidence.observation, { originalOutcome: "succeeded" })).toThrow();
	});
	it.each(["../escape", "UPPERCASE", "", `${id(10)}/child`, "00000000-0000-0000-0000-000000000000"])(
		"rejects malformed path ID %s before read",
		async (bad) => {
			let calls = 0;
			const port = async () => {
				calls++;
				return encode(packet());
			};
			for (const [allocation, audit] of [
				[bad, id(41)],
				[id(10), bad],
			]) {
				expect(() => lxdOfficeDeleteDispositionPath(allocation, audit)).toThrow(
					"OFFICE_DELETE_DISPOSITION_ID_INVALID",
				);
				await expect(readLxdOfficeDeleteDisposition(allocation, audit, port)).rejects.toThrow(error);
			}
			expect(calls).toBe(0);
		},
	);
	it("rejects foreign allocation/audit and changed plan/command/operation bindings", async () => {
		await expect(read(packet(), id(90))).rejects.toThrow(error);
		await expect(read(packet(), id(10), id(90))).rejects.toThrow(error);
		const mutations = [
			(p: ReturnType<typeof packet>) => {
				Object.assign(p.plan, { resetId: id(90) });
			},
			(p: ReturnType<typeof packet>) => {
				Object.assign(p.plan.predecessor.startup.scope, { companyId: id(90) });
			},
			(p: ReturnType<typeof packet>) => {
				const d = JSON.parse(p.documentText);
				d.nextCreateCommandId = id(90);
				p.documentText = JSON.stringify(d);
			},
			(p: ReturnType<typeof packet>) => {
				p.sqlReceipt.phaseEvidence.observation.operationId = id(90);
				p.sqlReceipt.phaseEvidenceSha256 = officeDigest(p.sqlReceipt.phaseEvidence);
			},
		];
		for (const mutate of mutations) {
			const p = packet();
			mutate(p);
			await expect(read(p)).rejects.toThrow(error);
		}
	});
	it("requires each SQL receipt field and exact phase even with an attacker-recomputed phase digest", async () => {
		const replacements: Record<string, unknown> = {
			schema: "wrong",
			auditId: id(90),
			resetId: id(90),
			dispositionSha256: sha("0"),
			operatorId: id(90),
			originalOutcome: "succeeded",
			recoveryKind: "clean",
			cleanResetAcceptance: true,
			phaseEvidenceSha256: sha("0"),
		};
		for (const [key, value] of Object.entries(replacements)) {
			const p = packet();
			Object.assign(p.sqlReceipt, { [key]: value });
			await expect(read(p)).rejects.toThrow(error);
		}
		for (const key of Object.keys(packet().sqlReceipt)) {
			const p = packet();
			delete (p.sqlReceipt as Record<string, unknown>)[key];
			await expect(read(p)).rejects.toThrow(error);
		}
		const p = packet();
		p.sqlReceipt.phaseEvidence.phase = "active";
		p.sqlReceipt.phaseEvidenceSha256 = officeDigest(p.sqlReceipt.phaseEvidence);
		await expect(read(p)).rejects.toThrow(error);
	});
	it("refuses unknown keys at every receipt level", async () => {
		for (const target of [
			(p: ReturnType<typeof packet>) => p,
			(p: ReturnType<typeof packet>) => p.sqlReceipt,
			(p: ReturnType<typeof packet>) => p.sqlReceipt.phaseEvidence,
			(p: ReturnType<typeof packet>) => p.sqlReceipt.phaseEvidence.observation,
		]) {
			const p = packet();
			Object.assign(target(p), { force: true });
			await expect(read(p)).rejects.toThrow(error);
		}
		const p = packet(),
			d = JSON.parse(p.documentText);
		d.operator.sessionToken = "private-fixture";
		p.documentText = JSON.stringify(d);
		await expect(read(p)).rejects.toThrow(error);
	});
	it.each(["2020-02-30T00:00:00.000Z", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00.000+00:00", "invalid", null])(
		"refuses SQL timestamp %s",
		async (recordedAt) => {
			const p = packet();
			Object.assign(p.sqlReceipt, { recordedAt });
			await expect(read(p)).rejects.toThrow(error);
		},
	);
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "6", null])("refuses SQL revision %s", async (resetRevision) => {
		const p = packet();
		Object.assign(p.sqlReceipt, { resetRevision });
		await expect(read(p)).rejects.toThrow(error);
	});
	it("enforces byte limits and fatal UTF8/JSON even if the protected port misbehaves", async () => {
		for (const bytes of [Buffer.alloc(0), Buffer.alloc(65537, 32), Buffer.from([255]), Buffer.from("{")])
			await expect(readLxdOfficeDeleteDisposition(id(10), id(41), async () => bytes)).rejects.toThrow(error);
		for (const text of [" ".repeat(16385), "é".repeat(8193)]) {
			const p = packet();
			p.documentText = text;
			await expect(read(p)).rejects.toThrow(error);
		}
	});
	it("normalizes read failures without leaking underlying diagnostics or retrying", async () => {
		let calls = 0;
		await expect(
			readLxdOfficeDeleteDisposition(id(10), id(41), async () => {
				calls++;
				throw new Error("credential-private-sentinel /private");
			}),
		).rejects.toThrow(/^OFFICE_DELETE_DISPOSITION_UNCONFIRMED$/);
		expect(calls).toBe(1);
	});
	it("hashes actual nonASCII UTF8 bytes without canonical substitution", () => {
		const text = ' {"reason":"København"}\n';
		expect(lxdOfficeDeleteDocumentSha256(text)).toBe(createHash("sha256").update(Buffer.from(text)).digest("hex"));
		expect(lxdOfficeDeleteDocumentSha256(text)).not.toBe(
			lxdOfficeDeleteDocumentSha256(officeCanonical(JSON.parse(text))),
		);
	});
});
