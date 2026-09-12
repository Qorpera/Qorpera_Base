import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { build } from "esbuild";

/** Prepare one governed service-only software revision for an existing office
 * VM: the next inventory is the installed image's package manifest with only
 * the service entry replaced, the statement is signed with the operator's
 * ed25519 key, and plan/trust are derived so that the provider's verifier
 * accepts the set before anything is staged. No live access; nothing here
 * enrolls, begins or installs. The private key is read once and never printed. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLAGS = {
	"--previous-manifest": "previousManifest",
	"--next-service": "nextService",
	"--source-commit": "sourceCommit",
	"--previous-source-commit": "previousSourceCommit",
	"--base-source-commit": "baseSourceCommit",
	"--base-manifest-sha256": "baseManifestSha256",
	"--repository": "repository",
	"--evidence-sha256": "evidenceSha256",
	"--predecessor": "predecessor",
	"--stop-acknowledgement": "stopAcknowledgement",
	"--signing-key": "signingKey",
	"--signing-key-passphrase-stdin": "signingKeyPassphraseStdin",
	"--out": "out",
	"--acceptance-tested-at": "acceptanceTestedAt",
	"--successor-activation-id": "successorActivationId",
};
const REQUIRED = [
	"previousManifest",
	"nextService",
	"sourceCommit",
	"previousSourceCommit",
	"repository",
	"evidenceSha256",
	"predecessor",
	"stopAcknowledgement",
	"signingKey",
	"out",
];
const USAGE = `Usage: node scripts/prepare-office-service-software-revision.mjs \\
  --previous-manifest <installed image package manifest.json> \\
  --next-service <new qorpera-company-computer-service.mjs> \\
  --source-commit <40 hex of the new service's clean source tree> \\
  --previous-source-commit <40 hex of the installed image/revision source> \\
  --repository <https URL> --evidence-sha256 <64 hex> \\
  --predecessor <retained service_restart lifecycle request JSON, or the retained recovery-request / service-stop-request record> \\
  --stop-acknowledgement <retained SQL stop acknowledgement JSON, or the retained service-stop-completed record> \\
  --signing-key <ed25519 private key PEM, read only> [--signing-key-passphrase-stdin true] --out <new directory> \\
  [--acceptance-tested-at <ISO time, default now>] [--successor-activation-id <uuid retained by the provider>] \\
  [--base-source-commit <40 hex> --base-manifest-sha256 <64 hex>   (only for a revision after the first; default: previous)]
`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
	throw new Error(code);
};
function parseArguments(argv) {
	const options = {};
	if (argv.length === 1 && argv[0] === "--help") return undefined;
	for (let index = 0; index < argv.length; index += 2) {
		const key = FLAGS[argv[index]];
		const value = argv[index + 1];
		if (!key || typeof value !== "string" || !value || value.startsWith("--") || key in options) fail("OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID");
		options[key] = value;
	}
	for (const key of REQUIRED) if (!(key in options)) fail("OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID");
	if (("baseSourceCommit" in options) !== ("baseManifestSha256" in options)) fail("OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID");
	if ("signingKeyPassphraseStdin" in options && options.signingKeyPassphraseStdin !== "true") fail("OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID");
	for (const key of ["previousManifest", "nextService", "predecessor", "stopAcknowledgement", "signingKey", "out"]) options[key] = resolve(options[key]);
	return options;
}
/** Bundle the repository's own verifier and parsers once per run; the script
 * must accept exactly what the provider will accept. */
async function loadVerifier() {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-software-revision-"));
	const outfile = join(temporary, "verifier.mjs");
	await build({
		absWorkingDir: root,
		stdin: {
			contents: [
				'export { verifyLxdOfficeServiceSoftware } from "./packages/runner-orchestrator/src/lxd-office-service-software.ts";',
				'export { officeCanonical, officeDigest } from "./packages/runner-orchestrator/src/lxd-office-image-provenance.ts";',
				'export { parseOfficeImagePackage } from "./packages/runner-orchestrator/src/lxd-office-image-installation.ts";',
				'export { COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, parseCompanyComputerLifecycleRequest, parseCompanyComputerServiceSoftwareStatement, parseCompanyComputerServiceSoftwarePlan } from "./packages/contracts/src/index.ts";',
			].join("\n"),
			resolveDir: root,
			loader: "ts",
		},
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22.19",
		legalComments: "none",
		logLevel: "silent",
	});
	return { module: await import(pathToFileURL(outfile).href), dispose: () => rm(temporary, { recursive: true, force: true }) };
}
const readJson = async (path) => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(await readFile(path)));
/** The predecessor is the stopped service_restart lifecycle request. Accept it
 * raw or inside the provider's retained recovery-request / stop-request record. */
function extractPredecessor(value, parse) {
	if (value && typeof value === "object" && value.schema === "qorpera.lxd-office-recovery-request/v1") return parse(value.request);
	if (value && typeof value === "object" && value.schema === "qorpera.lxd-office-stop-request/v1") return parse(value.request?.revocation?.request);
	return parse(value);
}
function extractAcknowledgement(value, predecessor) {
	const acknowledgement = value && typeof value === "object" && value.schema === "qorpera.lxd-office-stop-completion/v1" ? value.receipt : value;
	if (
		!acknowledgement ||
		typeof acknowledgement !== "object" ||
		acknowledgement.schema !== "qorpera.office-service-stop-acknowledgement/v1" ||
		acknowledgement.state !== "stopped" ||
		!isDeepStrictEqual(structuredClone(acknowledgement.request), structuredClone(predecessor))
	)
		fail("OFFICE_SOFTWARE_REVISION_INPUT_INVALID");
	return acknowledgement;
}
function timestamp(value) {
	const time = value === undefined ? new Date() : new Date(value);
	if (!Number.isFinite(time.getTime())) fail("OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID");
	return time.toISOString();
}
async function loadSigningKey(path, passphraseStdin) {
	const pem = await readFile(path);
	// An encrypted PEM takes its passphrase from stdin only (never argv/env),
	// matching the image provenance signer's custody convention.
	const passphrase = passphraseStdin ? readFileSync(0, "utf8").replace(/[\r\n]+$/, "") : undefined;
	if (passphraseStdin && !passphrase) fail("OFFICE_SOFTWARE_REVISION_KEY_INVALID");
	try {
		const privateKey = createPrivateKey(passphrase === undefined ? { key: pem, format: "pem" } : { key: pem, format: "pem", passphrase });
		if (privateKey.asymmetricKeyType !== "ed25519") fail("OFFICE_SOFTWARE_REVISION_KEY_INVALID");
		const verificationKeySpki = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
		return { privateKey, verificationKeySpki };
	} catch {
		fail("OFFICE_SOFTWARE_REVISION_KEY_INVALID");
	} finally {
		pem.fill(0);
	}
}
async function main(argv) {
	const options = parseArguments(argv);
	if (!options) {
		process.stdout.write(USAGE);
		return;
	}
	const { module: v, dispose } = await loadVerifier();
	try {
		let previousBytes, serviceBytes, predecessorValue, acknowledgementValue;
		try {
			previousBytes = await readFile(options.previousManifest);
			serviceBytes = await readFile(options.nextService);
			predecessorValue = await readJson(options.predecessor);
			acknowledgementValue = await readJson(options.stopAcknowledgement);
		} catch {
			fail("OFFICE_SOFTWARE_REVISION_INPUT_INVALID");
		}
		let previous, nextManifest, statement, plan;
		try {
			const parsed = v.parseOfficeImagePackage(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(previousBytes)));
			previous = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(previousBytes));
			const index = previous.artifacts.findIndex((artifact) => artifact.file === "qorpera-company-computer-service.mjs");
			const entry = parsed.artifacts.find((artifact) => artifact.file === "qorpera-company-computer-service.mjs");
			if (index < 0 || !entry || !isDeepStrictEqual(Object.keys(previous.artifacts[index]).sort(), ["bytes", "file", "sha256"]))
				fail("OFFICE_SOFTWARE_REVISION_INPUT_INVALID");
			// The next inventory is the previous manifest with only the service entry
			// replaced; helper bundles, units and browser files stay the image's own.
			nextManifest = structuredClone(previous);
			nextManifest.artifacts[index] = { ...previous.artifacts[index], bytes: serviceBytes.length, sha256: hash(serviceBytes) };
			const predecessor = extractPredecessor(predecessorValue, v.parseCompanyComputerLifecycleRequest);
			const acknowledgement = extractAcknowledgement(acknowledgementValue, predecessor);
			const nextBytes = Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`);
			statement = v.parseCompanyComputerServiceSoftwareStatement({
				schema: "qorpera.office-service-software-statement/v1",
				base: {
					imageSha256: predecessor.startup.imageSha256,
					bootstrapSha256: predecessor.startup.bootstrapSha256,
					packageManifestSha256: options.baseManifestSha256 ?? hash(previousBytes),
					sourceCommit: options.baseSourceCommit ?? options.previousSourceCommit,
				},
				previous: {
					packageManifestSha256: hash(previousBytes),
					sourceCommit: options.previousSourceCommit,
					service: { path: v.COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, bytes: entry.bytes, sha256: entry.sha256 },
				},
				next: {
					packageManifestSha256: hash(nextBytes),
					service: { path: v.COMPANY_COMPUTER_SERVICE_SOFTWARE_PATH, bytes: serviceBytes.length, sha256: hash(serviceBytes) },
				},
				source: { repository: options.repository, commit: options.sourceCommit, tree: "clean" },
				acceptance: { testedAt: timestamp(options.acceptanceTestedAt), evidenceSha256: options.evidenceSha256, change: "service-only" },
			});
			const ids = new Set([predecessor.activationId, predecessor.transitionId]);
			const fresh = () => {
				let id = randomUUID();
				while (ids.has(id)) id = randomUUID();
				ids.add(id);
				return id;
			};
			// A provider that already retained its successor request has fixed the
			// successor identity; the plan must adopt it instead of minting one.
			const pinned = (value) => {
				if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) || ids.has(value)) fail("OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID");
				ids.add(value);
				return value;
			};
			const successorActivationId = options.successorActivationId === undefined ? fresh() : pinned(options.successorActivationId);
			plan = v.parseCompanyComputerServiceSoftwarePlan({
				schema: "qorpera.office-service-software-plan/v1",
				updateId: fresh(),
				predecessor,
				stopAcknowledgementSha256: v.officeDigest(acknowledgement),
				successorActivationId,
				statementSha256: v.officeDigest(statement),
			});
			nextManifest = nextBytes;
		} catch (error) {
			fail(error instanceof Error && error.message.startsWith("OFFICE_SOFTWARE_REVISION_") ? error.message : "OFFICE_SOFTWARE_REVISION_INPUT_INVALID");
		}
		const { privateKey, verificationKeySpki } = await loadSigningKey(options.signingKey, options.signingKeyPassphraseStdin === "true");
		const envelope = {
			schema: "qorpera.office-service-software-envelope/v1",
			statement,
			signature: { algorithm: "ed25519", value: sign(null, Buffer.from(v.officeCanonical(statement)), privateKey).toString("base64") },
		};
		const trust = { verificationKeySpki, statementSha256: v.officeDigest(statement), planSha256: v.officeDigest(plan) };
		const manifests = { previous: previousBytes, next: nextManifest };
		try {
			v.verifyLxdOfficeServiceSoftware(envelope, plan, trust, manifests);
		} catch {
			fail("OFFICE_SOFTWARE_REVISION_UNCONFIRMED");
		}
		try {
			await mkdir(options.out, { mode: 0o700 });
		} catch {
			fail("OFFICE_SOFTWARE_REVISION_OUTPUT_EXISTS");
		}
		const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
		const files = [
			["previous-manifest.json", previousBytes],
			["next-manifest.json", nextManifest],
			["qorpera-company-computer-service.mjs", serviceBytes],
			["statement.json", json(statement)],
			["envelope.json", json(envelope)],
			["plan.json", json(plan)],
			["trust.json", json(trust)],
		];
		const artifacts = [];
		for (const [file, bytes] of files) {
			await writeFile(join(options.out, file), bytes, { mode: 0o400, flag: "wx" });
			artifacts.push({ file, bytes: bytes.length, sha256: hash(bytes) });
		}
		// Re-read what was written: the deployment set must verify on its own.
		const written = Object.fromEntries(await Promise.all(files.map(async ([file]) => [file, await readFile(join(options.out, file))])));
		try {
			v.verifyLxdOfficeServiceSoftware(JSON.parse(written["envelope.json"].toString()), JSON.parse(written["plan.json"].toString()), JSON.parse(written["trust.json"].toString()), {
				previous: written["previous-manifest.json"],
				next: written["next-manifest.json"],
			});
			if (hash(written["qorpera-company-computer-service.mjs"]) !== statement.next.service.sha256) throw new Error("service");
		} catch {
			fail("OFFICE_SOFTWARE_REVISION_UNCONFIRMED");
		}
		const trustSha256 = hash(Buffer.from(v.officeCanonical(trust)));
		const summary = {
			schema: "qorpera.office-service-software-revision/v1",
			updateId: plan.updateId,
			successorActivationId: plan.successorActivationId,
			predecessor: { allocationId: plan.predecessor.startup.allocationId, transitionId: plan.predecessor.transitionId, activationId: plan.predecessor.activationId },
			statementSha256: trust.statementSha256,
			planSha256: trust.planSha256,
			trustSha256,
			stopAcknowledgementSha256: plan.stopAcknowledgementSha256,
			verificationKeySpki,
			previous: statement.previous,
			next: statement.next,
			source: statement.source,
			acceptance: statement.acceptance,
			artifacts,
		};
		await writeFile(join(options.out, "manifest.json"), json(summary), { mode: 0o400, flag: "wx" });
		await writeFile(
			join(options.out, "README.md"),
			[
				"# Governed service-only software revision",
				"",
				`Update \`${plan.updateId}\` for allocation \`${plan.predecessor.startup.allocationId}\` (stopped predecessor transition \`${plan.predecessor.transitionId}\`, successor activation \`${plan.successorActivationId}\`).`,
				"",
				"The next inventory is the installed image's package manifest with only the service entry replaced. Helper bundles, units and browser files remain the image's own builds. The signed statement, plan and trust verify with `verifyLxdOfficeServiceSoftware` against `previous-manifest.json` and `next-manifest.json`.",
				"",
				"| File | Bytes | SHA-256 |",
				"|---|---|---|",
				...artifacts.map((a) => `| \`${a.file}\` | ${a.bytes} | \`${a.sha256}\` |`),
				"",
				`- statementSha256: \`${trust.statementSha256}\``,
				`- planSha256: \`${trust.planSha256}\``,
				`- trustSha256 (staged trust file name): \`${trustSha256}\``,
				`- stopAcknowledgementSha256: \`${plan.stopAcknowledgementSha256}\``,
				`- verificationKeySpki: \`${verificationKeySpki}\``,
				`- previous service: ${statement.previous.service.bytes} bytes \`${statement.previous.service.sha256}\` (source ${statement.previous.sourceCommit})`,
				`- next service: ${statement.next.service.bytes} bytes \`${statement.next.service.sha256}\` (source ${statement.source.commit})`,
				`- acceptance: ${statement.acceptance.testedAt}, evidence \`${statement.acceptance.evidenceSha256}\``,
				"",
				"Stage this directory as root-owned protected files on the node and name them in the provider's `qorpera.lxd-office-software-update/v1` document for `qorpera-office-software-update.cjs`. The signing key is not part of this set.",
				"",
			].join("\n"),
			{ mode: 0o400, flag: "wx" },
		);
		process.stdout.write(`${JSON.stringify({ out: options.out, updateId: plan.updateId, successorActivationId: plan.successorActivationId, statementSha256: trust.statementSha256, planSha256: trust.planSha256, trustSha256 })}\n`);
	} finally {
		await dispose();
	}
}
try {
	await main(process.argv.slice(2));
} catch (error) {
	const code = error instanceof Error && /^OFFICE_SOFTWARE_REVISION_[A-Z_]+$/.test(error.message) ? error.message : "OFFICE_SOFTWARE_REVISION_UNCONFIRMED";
	process.stderr.write(`${code}\n`);
	process.exitCode = code === "OFFICE_SOFTWARE_REVISION_ARGUMENTS_INVALID" ? 2 : 1;
}
