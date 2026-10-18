// P3's company secret broker, for the driver's custody proof (p3-driver.mjs with P3_CUSTODY=1), on the test machine: the
// broker's own service (packages/runtime/src/cloud-secret-broker-http.ts) with its Postgres authority, as
// cloud-secret-broker-service-main.ts composes a company's broker, on a key and a capability made here for this run.
// Its database calls go to the driver, which runs each on the test database as the broker's login
// (qorpera_secret_broker). The executor in the node reaches its coding environment route through the driver's pipe
// ("broker" lines), as it would reach the brokers' shared origin. `seal` makes a version's envelope as a capture would.
import { createHash, randomBytes } from "node:crypto";
import {
	CloudSecretBroker,
	type CloudSecretPostgresClient,
	PostgresCloudSecretBrokerAuthority,
} from "../../../packages/runtime/src/cloud-secret-broker.ts";
import { HttpCloudSecretBrokerService } from "../../../packages/runtime/src/cloud-secret-broker-http.ts";
import { type CloudSecretEnvelopeIdentity, CloudSecretKeyring } from "../../../packages/runtime/src/cloud-secret-crypto.ts";

export interface P3Broker {
	readonly port: number;
	/** The executor's own broker token, for its systemd credential. */
	readonly executorToken: string;
	/** What the company's authority row holds of the broker's capability. */
	readonly capabilitySha256: string;
	seal(identity: CloudSecretEnvelopeIdentity, value: string): Uint8Array;
	close(): Promise<void>;
}

export async function startP3Broker(options: {
	authorityId: string;
	keyId: string;
	database: CloudSecretPostgresClient;
}): Promise<P3Broker> {
	const capability = randomBytes(32).toString("base64url");
	const keyring = new CloudSecretKeyring({ [options.keyId]: randomBytes(32) });
	const authority = new PostgresCloudSecretBrokerAuthority({
		database: options.database,
		brokerAuthorityId: options.authorityId,
		brokerCapability: capability,
	});
	const broker = new CloudSecretBroker({ authority, keyring, adapters: [] });
	const executorToken = randomBytes(32).toString("base64url");
	// No runtime asks it anything: its runtime token is never handed out.
	const service = new HttpCloudSecretBrokerService(broker, randomBytes(32).toString("base64url"), {
		host: "127.0.0.1",
		port: 0,
		codingExecutorToken: executorToken,
	});
	const port = await service.start();
	return {
		port,
		executorToken,
		capabilitySha256: createHash("sha256").update(capability).digest("hex"),
		seal: (identity, value) => keyring.seal({ value }, identity),
		close: () => service.close(),
	};
}
