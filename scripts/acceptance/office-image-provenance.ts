import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { officeCanonical, officeDigest, parseLxdOfficeImageStatement, verifyLxdOfficeImageProvenance } from "../../packages/runner-orchestrator/src/lxd-office-image-provenance.ts";

const [statementPath, output] = process.argv.slice(2);
assert(statementPath && output && process.getuid?.() === 0);
const statement = parseLxdOfficeImageStatement(JSON.parse(await readFile(statementPath, "utf8")));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const envelope = { schema: "qorpera.lxd-office-image-provenance-envelope/v1", statement, signature: { algorithm: "ed25519", value: sign(null, Buffer.from(officeCanonical(statement)), privateKey).toString("base64") } };
const verificationKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const statementSha256 = officeDigest(statement);
assert.deepEqual(verifyLxdOfficeImageProvenance(envelope, verificationKeySpki, statementSha256), statement);
assert.throws(() => verifyLxdOfficeImageProvenance({ ...envelope, statement: { ...statement, image: { ...statement.image, fingerprint: "0".repeat(64) } } }, verificationKeySpki, statementSha256));
await writeFile(join(output, "image-provenance.json"), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o644, flag: "wx" });
await writeFile(join(output, "image-verification.json"), `${JSON.stringify({ verificationKeySpki, statementSha256, productionVerifierAccepted: true, alteredImageRejected: true, testOnlySigningKey: true }, null, 2)}\n`, { mode: 0o644, flag: "wx" });

