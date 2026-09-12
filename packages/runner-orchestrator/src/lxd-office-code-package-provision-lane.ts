import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CompanyComputerResetPlan,
	type CompanyComputerStartupIdentity,
	parseCompanyComputerCodePackageProvisionRequest,
} from "@qorpera/contracts";
import type { LxdOfficeCodePackageClient } from "./lxd-client.ts";
import { LxdOfficeCodePackageControl, type LxdOfficeCodePackageRegistry } from "./lxd-office-code-package-control.ts";
import type { LxdOfficeCodePackageMaterial } from "./lxd-office-code-package-material.ts";
import {
	verifyLxdOfficeCodePackageProvisionReceipt,
	verifyLxdOfficeCodePackageProvisionRequest,
} from "./lxd-office-code-package-provision-verification.ts";
import {
	awaitLxdOfficeCodePackageCommand,
	claimLxdOfficeCodePackageInstall,
	type LxdOfficeCodePackagePacket,
	parseLxdOfficeCodePackageProbe,
	readLxdOfficeCodePackagePublic,
	stageLxdOfficeCodePackage,
} from "./lxd-office-code-package-transport.ts";
import { type LxdOfficeGuestBinding, lxdOfficeGuestPlan } from "./lxd-office-guest.ts";
import { officeCanonical, officeDigest, officeRecord } from "./lxd-office-image-provenance.ts";
import { code, publish, readRecord } from "./lxd-office-journal-files.ts";

const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex"),
	encode = (v: unknown) => Buffer.from(officeCanonical(v));
export interface LxdOfficeCodePackageProvisionContext {
	resetPlan: unknown;
	custody: unknown;
	restore: unknown;
	restoreSha256: string;
	bootId: string;
	originalPreparation: Buffer;
}

export class LxdOfficeCodePackageProvisionLane {
	readonly #root: string;
	readonly #binding: LxdOfficeGuestBinding;
	readonly #material: LxdOfficeCodePackageMaterial;
	readonly #client: LxdOfficeCodePackageClient;
	readonly #control: LxdOfficeCodePackageControl;
	readonly #resetPlan: CompanyComputerResetPlan;
	constructor(options: {
		root: string;
		binding: LxdOfficeGuestBinding;
		material: LxdOfficeCodePackageMaterial;
		client: LxdOfficeCodePackageClient;
		registry: LxdOfficeCodePackageRegistry;
		resetPlan: CompanyComputerResetPlan;
	}) {
		this.#root = options.root;
		this.#binding = options.binding;
		this.#material = options.material;
		this.#client = options.client;
		this.#resetPlan = options.resetPlan;
		this.#control = new LxdOfficeCodePackageControl(
			{
				...options.material.verified,
				resetPlan: options.resetPlan,
				providerCapability: options.material.providerCapability,
			},
			options.registry,
		);
	}
	get provisionId() {
		return this.#material.verified.plan.provisionId;
	}
	async #optional(name: string, limit = 65536) {
		try {
			return (await readRecord(join(this.#root, name), limit)).value;
		} catch (error) {
			if (code(error, "ENOENT")) return undefined;
			throw error;
		}
	}
	async #keep(name: string, value: unknown, limit = 65536) {
		await publish(this.#root, name, encode(value));
		if (!isDeepStrictEqual(await this.#optional(name, limit), value))
			throw new Error("OFFICE_CODE_PACKAGE_HISTORY_CONFLICT");
	}
	async enroll(signal: AbortSignal) {
		return this.#control.enroll(signal);
	}
	async #packet(context: LxdOfficeCodePackageProvisionContext, signal: AbortSignal) {
		const { verified, envelope } = this.#material,
			status = await this.#control.status(signal),
			name = `code-package-request-${this.provisionId}.json`;
		let retained = await this.#optional(name);
		if (retained === undefined) {
			if (status.state !== "enrolled" || status.request !== null)
				throw new Error("OFFICE_CODE_PACKAGE_REQUEST_HISTORY_UNCONFIRMED");
			retained = {
				schema: "qorpera.lxd-office-code-package-request/v1",
				binding: this.#binding,
				request: parseCompanyComputerCodePackageProvisionRequest({
					schema: "qorpera.office-code-package-provision-request/v1",
					plan: verified.plan,
					planSha256: verified.planSha256,
					bootId: context.bootId,
					restoreSha256: context.restoreSha256,
					challengeId: randomUUID(),
					targetRevision: verified.plan.targetRevision,
					capabilityRevision: status.capabilityRevision,
					targetManifestSha256: verified.statement.target.packageManifestSha256,
				}),
			};
			await this.#keep(name, retained);
		}
		const r = officeRecord(retained, ["schema", "binding", "request"]),
			request = verifyLxdOfficeCodePackageProvisionRequest(r.request, verified);
		if (
			r.schema !== "qorpera.lxd-office-code-package-request/v1" ||
			!isDeepStrictEqual(r.binding, this.#binding) ||
			request.bootId !== context.bootId ||
			request.restoreSha256 !== context.restoreSha256 ||
			(status.request !== null && !isDeepStrictEqual(request, status.request))
		)
			throw new Error("OFFICE_CODE_PACKAGE_REQUEST_HISTORY_UNCONFIRMED");
		const packet: LxdOfficeCodePackagePacket = {
			schema: "qorpera.office-code-package-control/v1",
			request,
			resetPlan: context.resetPlan,
			custody: context.custody,
			restore: context.restore,
			originPreparationSha256: hash(context.originalPreparation),
			envelope,
		};
		await this.#keep(`code-package-packet-${this.provisionId}.json`, packet, 4 * 1024 ** 2);
		await this.#keep(`code-package-material-${this.provisionId}.json`, {
			schema: "qorpera.lxd-office-code-package-material/v1",
			binding: this.#binding,
			document: this.#material.document,
			resetPlan: this.#resetPlan,
		});
		await publish(this.#root, `code-package-original-${this.provisionId}.json`, context.originalPreparation);
		if (
			!(
				await readRecord(join(this.#root, `code-package-original-${this.provisionId}.json`), 16 * 1024 ** 2)
			).bytes.equals(context.originalPreparation)
		)
			throw new Error("OFFICE_CODE_PACKAGE_ORIGIN_HISTORY_UNCONFIRMED");
		return { packet, status };
	}
	async #run(
		purpose: "bootstrap" | "measure",
		commandId: string,
		args: readonly string[],
		packetSha256: string,
		signal: AbortSignal,
		authorize: () => Promise<void>,
	) {
		return awaitLxdOfficeCodePackageCommand(
			this.#root,
			this.#binding,
			{
				provisionId: this.provisionId,
				commandId,
				purpose,
				pin: this.#material.verified.statement.tools[purpose],
				args,
				packetSha256,
			},
			this.#client,
			signal,
			authorize,
		);
	}
	async #probe(
		purpose: "install" | "measure",
		challengeId: string,
		bootId: string,
		pins: { packetSha256: string; trustSha256: string },
		signal: AbortSignal,
		authorize: () => Promise<void>,
	) {
		const probeId = purpose === "install" ? randomUUID() : challengeId;
		await this.#run(
			purpose === "install" ? "bootstrap" : "measure",
			randomUUID(),
			purpose === "install"
				? ["preflight", pins.packetSha256, pins.trustSha256, probeId]
				: ["probe", pins.packetSha256, pins.trustSha256, challengeId, bootId],
			pins.packetSha256,
			signal,
			authorize,
		);
		const value = await readLxdOfficeCodePackagePublic(
			this.#client,
			this.#binding,
			this.provisionId,
			`${purpose === "install" ? "preflight" : "probe"}-${probeId}.json`,
			signal,
		);
		return parseLxdOfficeCodePackageProbe(value, {
			purpose,
			provisionId: this.provisionId,
			probeId,
			packetSha256: pins.packetSha256,
			bootId,
			challengeId,
		});
	}
	async #receipt(request: unknown, signal: AbortSignal) {
		const file = await this.#client.readOfficeCodePackageReceipt(
			this.#binding.project,
			lxdOfficeGuestPlan(this.#binding).request.name,
			this.provisionId,
			"installed",
			signal,
		);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o400)
			throw new Error("OFFICE_CODE_PACKAGE_ROOT_CUSTODY_UNCONFIRMED");
		return verifyLxdOfficeCodePackageProvisionReceipt(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)),
			request,
			this.#material.verified,
		);
	}
	async #retainRootEvidence(packet: LxdOfficeCodePackagePacket, receipt: unknown, signal: AbortSignal) {
		const file = await this.#client.readOfficeCodePackageReceipt(
			this.#binding.project,
			lxdOfficeGuestPlan(this.#binding).request.name,
			this.provisionId,
			"claim",
			signal,
		);
		if (file.uid !== 0 || file.gid !== 0 || file.mode !== 0o400)
			throw new Error("OFFICE_CODE_PACKAGE_ROOT_CUSTODY_UNCONFIRMED");
		const claim = officeRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(file.content)), [
			"schema",
			"requestSha256",
			"packetSha256",
			"probe",
		]);
		if (
			claim.schema !== "qorpera.office-code-package-install-claim/v1" ||
			claim.requestSha256 !== officeDigest(packet.request) ||
			claim.packetSha256 !== officeDigest(packet)
		)
			throw new Error("OFFICE_CODE_PACKAGE_ROOT_CLAIM_UNCONFIRMED");
		const probe = officeRecord(claim.probe, [
			"schema",
			"purpose",
			"provisionId",
			"probeId",
			"packetSha256",
			"bootId",
			"challengeId",
			"nonce",
			"monotonicNs",
		]);
		parseLxdOfficeCodePackageProbe(probe, {
			purpose: "install",
			provisionId: this.provisionId,
			probeId: probe.probeId as string,
			packetSha256: officeDigest(packet),
			bootId: packet.request.bootId,
			challengeId: packet.request.challengeId,
		});
		await this.#keep(`code-package-root-claim-${this.provisionId}.json`, claim);
		await this.#keep(`code-package-root-receipt-${this.provisionId}.json`, receipt);
	}
	async ensure(context: LxdOfficeCodePackageProvisionContext, signal: AbortSignal, authorize: () => Promise<void>) {
		const { packet, status } = await this.#packet(context, signal),
			packetSha256 = officeDigest(packet),
			completeName = `code-package-completed-${this.provisionId}.json`,
			complete = await this.#optional(completeName);
		if (complete !== undefined) {
			const r = officeRecord(complete, ["schema", "packetSha256", "receipt", "evidenceSha256"]);
			if (
				r.schema !== "qorpera.lxd-office-code-package-completed/v1" ||
				r.packetSha256 !== packetSha256 ||
				status.state !== "installed" ||
				!isDeepStrictEqual(r.receipt, status.receipt) ||
				r.evidenceSha256 !== status.installationEvidenceSha256 ||
				!isDeepStrictEqual(await this.#receipt(packet.request, signal), r.receipt)
			)
				throw new Error("OFFICE_CODE_PACKAGE_COMPLETION_UNCONFIRMED");
			await this.#retainRootEvidence(packet, status.receipt, signal);
			return { packet, receipt: status.receipt! };
		}
		await authorize();
		const pins = await stageLxdOfficeCodePackage(
			this.#client,
			this.#binding,
			this.#material,
			packet,
			context.originalPreparation,
			signal,
		);
		const intent = await this.#optional(`code-package-install-intent-${this.provisionId}.json`);
		if (intent === undefined) {
			if (status.state !== "enrolled") throw new Error("OFFICE_CODE_PACKAGE_DISPATCH_HISTORY_UNCONFIRMED");
			const probe = await this.#probe(
				"install",
				packet.request.challengeId,
				packet.request.bootId,
				pins,
				signal,
				authorize,
			);
			if (!(await claimLxdOfficeCodePackageInstall(this.#root, packet.request, pins.packetSha256)))
				throw new Error("OFFICE_CODE_PACKAGE_DISPATCH_CONFLICT");
			const challenge = await this.#control.dispatch(packet.request, signal),
				lifetime = Math.floor(challenge.deadline - performance.now());
			await this.#run(
				"bootstrap",
				packet.request.plan.installCommandId,
				["install", pins.packetSha256, pins.trustSha256, probe.probeId, probe.nonce, String(lifetime)],
				pins.packetSha256,
				signal,
				async () => {
					if (performance.now() >= challenge.deadline) throw new Error("OFFICE_CODE_PACKAGE_CHALLENGE_EXPIRED");
				},
			);
		} else if (
			!isDeepStrictEqual(intent, {
				schema: "qorpera.lxd-office-code-package-install-intent/v1",
				request: packet.request,
				packetSha256: pins.packetSha256,
			})
		)
			throw new Error("OFFICE_CODE_PACKAGE_DISPATCH_HISTORY_UNCONFIRMED");
		const observationId = randomUUID(),
			probe = await this.#probe("measure", observationId, packet.request.bootId, pins, signal, authorize),
			challenge = await this.#control.observe(packet.request, observationId, signal);
		await this.#client.pushOfficeCodePackageFile(
			this.#binding.project,
			lxdOfficeGuestPlan(this.#binding).request.name,
			this.provisionId,
			`challenge-${observationId}.json`,
			encode(challenge.wire),
			signal,
		);
		await this.#run(
			"measure",
			randomUUID(),
			[
				"observation",
				pins.packetSha256,
				pins.trustSha256,
				observationId,
				probe.nonce,
				String(challenge.wire.validForMs),
				officeDigest(challenge.wire),
			],
			pins.packetSha256,
			signal,
			async () => {
				if (performance.now() >= challenge.deadline) throw new Error("OFFICE_CODE_PACKAGE_CHALLENGE_EXPIRED");
			},
		);
		const value = officeRecord(
			await readLxdOfficeCodePackagePublic(
				this.#client,
				this.#binding,
				this.provisionId,
				`observation-${observationId}.json`,
				signal,
			),
			[
				"schema",
				"observationId",
				"provisionId",
				"requestSha256",
				"receipt",
				"receiptSha256",
				"inventorySha256",
				"evidenceSha256",
			],
		);
		const receipt = verifyLxdOfficeCodePackageProvisionReceipt(
				value.receipt,
				packet.request,
				this.#material.verified,
			),
			{ evidenceSha256, ...evidence } = value;
		if (
			!isDeepStrictEqual(evidence, {
				schema: "qorpera.office-code-package-observation/v1",
				observationId,
				provisionId: this.provisionId,
				requestSha256: officeDigest(packet.request),
				receipt,
				receiptSha256: officeDigest(receipt),
				inventorySha256: this.#material.verified.inventorySha256,
			}) ||
			evidenceSha256 !== officeDigest(evidence) ||
			performance.now() >= challenge.deadline
		)
			throw new Error("OFFICE_CODE_PACKAGE_OBSERVATION_UNCONFIRMED");
		await this.#retainRootEvidence(packet, receipt, signal);
		await this.#control.acknowledge(receipt, packet.request, observationId, evidenceSha256 as string, signal);
		await this.#keep(completeName, {
			schema: "qorpera.lxd-office-code-package-completed/v1",
			packetSha256,
			receipt,
			evidenceSha256,
		});
		return { packet, receipt };
	}
	async prepareInvocation(packet: LxdOfficeCodePackagePacket, originalPreparation: Buffer, signal: AbortSignal) {
		return stageLxdOfficeCodePackage(
			this.#client,
			this.#binding,
			this.#material,
			packet,
			originalPreparation,
			signal,
		);
	}
	async measureInvocation(
		pins: { packetSha256: string; trustSha256: string },
		activationId: string,
		startup: Readonly<CompanyComputerStartupIdentity>,
		outerDeadline: number,
		signal: AbortSignal,
	) {
		const challengeId = randomUUID();
		const fresh = async () => {
			signal.throwIfAborted();
			if (performance.now() >= outerDeadline) throw new Error("OFFICE_CODE_PACKAGE_INVOCATION_EXPIRED");
		};
		const probe = await this.#probe("measure", challengeId, startup.bootId, pins, signal, fresh),
			challenge = await this.#control.invocation(startup, activationId, challengeId, signal),
			deadline = Math.min(challenge.deadline, outerDeadline);
		await this.#client.pushOfficeCodePackageFile(
			this.#binding.project,
			lxdOfficeGuestPlan(this.#binding).request.name,
			this.provisionId,
			`challenge-${challengeId}.json`,
			encode(challenge.wire),
			signal,
		);
		await this.#run(
			"measure",
			randomUUID(),
			[
				"invocation",
				pins.packetSha256,
				pins.trustSha256,
				challengeId,
				probe.nonce,
				String(challenge.wire.validForMs),
				officeDigest(challenge.wire),
			],
			pins.packetSha256,
			signal,
			async () => {
				await fresh();
				if (performance.now() >= deadline) throw new Error("OFFICE_CODE_PACKAGE_CHALLENGE_EXPIRED");
			},
		);
		const value = officeRecord(
				await readLxdOfficeCodePackagePublic(
					this.#client,
					this.#binding,
					this.provisionId,
					`invocation-${challengeId}.json`,
					signal,
				),
				[
					"schema",
					"challengeId",
					"provisionId",
					"activationId",
					"startup",
					"receiptSha256",
					"inventorySha256",
					"service",
					"runtimeBundle",
					"evidence",
					"evidenceSha256",
				],
			),
			{ evidenceSha256, ...evidence } = value;
		if (
			!isDeepStrictEqual(
				{ ...evidence, evidence: undefined },
				{
					schema: "qorpera.office-code-package-invocation/v1",
					challengeId,
					provisionId: this.provisionId,
					activationId,
					startup,
					receiptSha256: challenge.receiptSha256,
					inventorySha256: this.#material.verified.inventorySha256,
					service: this.#material.verified.statement.target.service,
					runtimeBundle: this.#material.verified.statement.target.runtimeBundle,
					evidence: undefined,
				},
			) ||
			!value.evidence ||
			typeof value.evidence !== "object" ||
			Array.isArray(value.evidence) ||
			evidenceSha256 !== officeDigest(evidence) ||
			performance.now() >= deadline
		)
			throw new Error("OFFICE_CODE_PACKAGE_INVOCATION_UNCONFIRMED");
		await this.#control.acknowledgeInvocation(challenge, evidenceSha256 as string, signal);
	}
}
