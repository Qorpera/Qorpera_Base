// work/linux-execution/full-entry.ts
var import_node_crypto9 = require("node:crypto");
var import_promises6 = require("node:fs/promises");
var import_node_path10 = require("node:path");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/fixtures/office-physical-policy.ts
var import_node_crypto4 = require("node:crypto");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-image-provenance.ts
var import_node_crypto = require("node:crypto");
function officeRecord(value, keys2) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys2.length || Object.keys(value).sort().join() !== [...keys2].sort().join())
    throw new Error("INVALID_OFFICE_PHYSICAL_RECORD");
  return value;
}
function officeSha(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("INVALID_OFFICE_SHA256");
  return value;
}
function officeCanonical(value) {
  const sorted = (input) => {
    if (Array.isArray(input)) return input.map(sorted);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input).sort().map((key) => [key, sorted(input[key])])
    );
  };
  return JSON.stringify(sorted(value));
}
function officeDigest(value) {
  return (0, import_node_crypto.createHash)("sha256").update(officeCanonical(value)).digest("hex");
}
function officeImagePublicKey(spki) {
  if (typeof spki !== "string" || spki.length > 1024) throw new Error("INVALID_OFFICE_IMAGE_KEY");
  const bytes = Buffer.from(spki, "base64");
  if (bytes.toString("base64") !== spki) throw new Error("INVALID_OFFICE_IMAGE_KEY");
  const key = (0, import_node_crypto.createPublicKey)({ key: bytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" || !key.export({ format: "der", type: "spki" }).equals(bytes))
    throw new Error("INVALID_OFFICE_IMAGE_KEY");
  return key;
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-physical-policy.ts
var import_node_net = require("node:net");
var import_node_path2 = require("node:path");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-guest.ts
var import_node_crypto2 = require("node:crypto");
var import_node_path = require("node:path");
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var SHA = /^[0-9a-f]{64}$/;
var NAME = /^[a-z][a-z0-9-]{0,62}$/;
function parseLxdOfficeGuestBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== [
    "schema",
    "providerId",
    "providerPolicySha256",
    "companyId",
    "environmentId",
    "companyComputerId",
    "logicalComputerId",
    "computerGeneration",
    "allocationId",
    "project",
    "imageFingerprint",
    "bootstrapSha256",
    "storagePool",
    "rootDiskBytes",
    "workbenchSource",
    "network",
    "cpus",
    "memoryBytes"
  ].sort().join())
    throw new Error("INVALID_LXD_OFFICE_BINDING");
  const input = { ...value };
  if (input.schema !== "qorpera.lxd-office-guest/v2" || ![
    input.providerId,
    input.companyId,
    input.environmentId,
    input.companyComputerId,
    input.logicalComputerId,
    input.allocationId
  ].every((id3) => typeof id3 === "string" && UUID.test(id3)) || ![input.imageFingerprint, input.bootstrapSha256, input.providerPolicySha256].every(
    (sha3) => typeof sha3 === "string" && SHA.test(sha3)
  ) || ![input.project, input.storagePool, input.network].every((name) => typeof name === "string" && NAME.test(name)) || ![input.computerGeneration, input.cpus, input.memoryBytes, input.rootDiskBytes].every(
    (number) => Number.isSafeInteger(number) && number >= 1
  ) || input.cpus > 64 || input.memoryBytes > 1024 ** 4 || input.rootDiskBytes > 1024 ** 4 || typeof input.workbenchSource !== "string" || input.workbenchSource === "/" || input.workbenchSource !== (0, import_node_path.resolve)(input.workbenchSource) || input.workbenchSource.length > 4096 || /[\x00-\x20\x7f\\]/.test(input.workbenchSource) || /(?:^|\/)(?:live|company-live|identity|credentials|\.codex|\.claude)(?:\/|$)/.test(input.workbenchSource))
    throw new Error("INVALID_LXD_OFFICE_BINDING");
  return Object.freeze(input);
}
function lxdOfficeGuestPlan(value) {
  const binding = parseLxdOfficeGuestBinding(value);
  const name = `qorpera-office-${binding.allocationId.replaceAll("-", "")}`;
  const instanceSha256 = (0, import_node_crypto2.createHash)("sha256").update(
    JSON.stringify({
      schema: binding.schema,
      providerId: binding.providerId,
      providerPolicySha256: binding.providerPolicySha256,
      companyId: binding.companyId,
      environmentId: binding.environmentId,
      companyComputerId: binding.companyComputerId,
      logicalComputerId: binding.logicalComputerId,
      computerGeneration: binding.computerGeneration,
      allocationId: binding.allocationId,
      project: binding.project,
      name
    })
  ).digest("hex");
  return {
    binding,
    instanceSha256,
    request: {
      name,
      type: "virtual-machine",
      profiles: [],
      source: { type: "image", fingerprint: binding.imageFingerprint },
      config: {
        "boot.mode": "uefi-secureboot",
        "boot.autostart": "false",
        "limits.cpu": String(binding.cpus),
        "limits.memory": String(binding.memoryBytes),
        "user.qorpera.schema": binding.schema,
        "user.qorpera.provider_id": binding.providerId,
        "user.qorpera.provider_policy_sha256": binding.providerPolicySha256,
        "user.qorpera.company_id": binding.companyId,
        "user.qorpera.environment_id": binding.environmentId,
        "user.qorpera.office_id": binding.companyComputerId,
        "user.qorpera.logical_computer_id": binding.logicalComputerId,
        "user.qorpera.computer_generation": String(binding.computerGeneration),
        "user.qorpera.allocation_id": binding.allocationId,
        "user.qorpera.instance_sha256": instanceSha256,
        "user.qorpera.bootstrap_sha256": binding.bootstrapSha256
      },
      devices: {
        root: { type: "disk", path: "/", pool: binding.storagePool, size: String(binding.rootDiskBytes) },
        network: { type: "nic", network: binding.network, name: "eth0" },
        workbench: {
          type: "disk",
          source: binding.workbenchSource,
          path: "/var/lib/qorpera-office",
          required: "true"
        }
      }
    }
  };
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-physical-policy.ts
function officePhysicalPath(value) {
  if (typeof value !== "string" || value === "/" || value.length > 4096 || (0, import_node_path2.resolve)(value) !== value || /[\x00-\x20\x7f\\]/.test(value))
    throw new Error("INVALID_OFFICE_PHYSICAL_PATH");
  return value;
}
var guestKeys = [
  "providerId",
  "companyId",
  "environmentId",
  "companyComputerId",
  "logicalComputerId",
  "computerGeneration",
  "project",
  "imageFingerprint",
  "bootstrapSha256",
  "storagePool",
  "rootDiskBytes",
  "workbenchSource",
  "network",
  "cpus",
  "memoryBytes"
];
function guest(value) {
  const parsed = parseLxdOfficeGuestBinding({
    ...officeRecord(value, guestKeys),
    schema: "qorpera.lxd-office-guest/v2",
    allocationId: "11111111-1111-4111-8111-111111111111",
    providerPolicySha256: "0".repeat(64)
  });
  return Object.fromEntries(
    guestKeys.map((key) => [key, parsed[key]])
  );
}
function id(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** 32 - 2)
    throw new Error("INVALID_OFFICE_HOST_ID");
  return value;
}
function mount(value) {
  if (value.root !== "/" || typeof value.filesystem !== "string" || typeof value.source !== "string" || !value.source || value.source.length > 4096 || /[\x00-\x20\x7f\\]/.test(value.source))
    throw new Error("INVALID_OFFICE_MOUNT_POLICY");
  return {
    mountPoint: officePhysicalPath(value.mountPoint),
    root: "/",
    filesystem: value.filesystem,
    source: value.source
  };
}
function parseLxdOfficePhysicalPolicy(value) {
  const p = officeRecord(value, ["schema", "guest", "host", "image", "infrastructure", "workbench", "journal"]);
  const infrastructure = officeRecord(p.infrastructure, ["projectSha256", "networkSha256", "storagePoolSha256"]);
  const h = officeRecord(p.host, [
    "machineIdSha256",
    "socketPath",
    "socketGid",
    "certificateSha256",
    "serverName",
    "serverVersion",
    "architecture"
  ]);
  const i = officeRecord(p.image, ["bytes", "guestPackageManifestSha256", "statementSha256", "verificationKeySpki"]);
  const w = officeRecord(p.workbench, ["mountPoint", "root", "filesystem", "source", "serverAddress", "uid", "gid"]);
  const j = officeRecord(p.journal, ["mountPoint", "root", "filesystem", "source", "path"]);
  const g = guest(p.guest);
  const workbench = { ...mount(w), serverAddress: w.serverAddress, uid: id(w.uid), gid: id(w.gid) };
  const journal2 = { ...mount(j), path: officePhysicalPath(j.path) };
  if (p.schema !== "qorpera.lxd-office-physical-policy/v2" || h.architecture !== "x86_64" && h.architecture !== "aarch64" || typeof h.serverName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(h.serverName) || typeof h.serverVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+~-]{0,63}$/.test(h.serverVersion) || !Number.isSafeInteger(i.bytes) || i.bytes < 1 || i.bytes > 1024 ** 4 || typeof i.verificationKeySpki !== "string" || workbench.mountPoint !== g.workbenchSource || !["nfs", "nfs4"].includes(workbench.filesystem) || !workbench.source.includes(":/") || typeof w.serverAddress !== "string" || !(0, import_node_net.isIP)(w.serverAddress) || workbench.uid === 0 || !["ext4", "xfs", "btrfs", "zfs"].includes(journal2.filesystem) || !(journal2.path === journal2.mountPoint || journal2.path.startsWith(`${journal2.mountPoint}/`)) || journal2.mountPoint === workbench.mountPoint || journal2.mountPoint.startsWith(`${workbench.mountPoint}/`) || workbench.mountPoint.startsWith(`${journal2.mountPoint}/`))
    throw new Error("INVALID_OFFICE_PHYSICAL_POLICY");
  officeImagePublicKey(i.verificationKeySpki);
  const host = {
    machineIdSha256: officeSha(h.machineIdSha256),
    socketPath: officePhysicalPath(h.socketPath),
    socketGid: id(h.socketGid),
    certificateSha256: officeSha(h.certificateSha256),
    serverName: h.serverName,
    serverVersion: h.serverVersion,
    architecture: h.architecture
  };
  if ([workbench.mountPoint, journal2.path].some(
    (root) => host.socketPath === root || host.socketPath.startsWith(`${root}/`)
  ))
    throw new Error("INVALID_OFFICE_SOCKET_LOCATION");
  return Object.freeze({
    schema: "qorpera.lxd-office-physical-policy/v2",
    infrastructure: Object.freeze({
      projectSha256: officeSha(infrastructure.projectSha256),
      networkSha256: officeSha(infrastructure.networkSha256),
      storagePoolSha256: officeSha(infrastructure.storagePoolSha256)
    }),
    guest: Object.freeze(g),
    host: Object.freeze(host),
    image: Object.freeze({
      bytes: i.bytes,
      guestPackageManifestSha256: officeSha(i.guestPackageManifestSha256),
      statementSha256: officeSha(i.statementSha256),
      verificationKeySpki: i.verificationKeySpki
    }),
    workbench: Object.freeze(workbench),
    journal: Object.freeze(journal2)
  });
}
function lxdOfficePhysicalPolicySha256(value) {
  return officeDigest(parseLxdOfficePhysicalPolicy(value));
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/fixtures/office-image-package.ts
var import_node_crypto3 = require("node:crypto");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-image-installation.ts
var OFFICE_IMAGE_PACKAGE_FILES = [
  "qorpera-company-computer-service.mjs",
  "qorpera-company-computer-preparation.mjs",
  "qorpera-company-computer-preparation-control.mjs",
  "qorpera-company-computer-configuration-control.mjs",
  "qorpera-company-computer-boot-configuration-control.mjs",
  "qorpera-company-computer-boot-service-start-control.mjs",
  "qorpera-company-computer-boot-service-restart-control.mjs",
  "qorpera-company-computer-service-start-control.mjs",
  "qorpera-company-computer-service-stop-control.mjs",
  "qorpera-company-computer-service-restart-control.mjs",
  "office-browser-child.mjs",
  "qorpera-office-image-install.cjs",
  "qorpera-company-computer.service",
  "qorpera-company-computer-preparation.service",
  "qorpera-office-preparation.conf",
  "qorpera-office-runtime.conf",
  "qorpera-office-private.mount.in",
  "qorpera-screen-session",
  "qorpera-screen-xfce",
  "qorpera-browser-policy.json",
  "qorpera-office-browser-bwrap.apparmor",
  "LICENSE"
];
var OFFICE_IMAGE_RESET_PACKAGE_FILES = [
  "qorpera-company-computer-reset-configuration-control.mjs",
  "qorpera-company-computer-reset-service-start-control.mjs",
  "qorpera-company-computer-reset-service-restart-control.mjs"
];

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/fixtures/office-image-package.ts
var officeImagePackageFixture = (reset = true) => ({
  schema: "qorpera.company-computer-package/v1",
  platform: "linux",
  minimumNode: "22.19.0",
  playwright: "1.62.1",
  imagePrerequisites: [
    "cgroup-v2",
    "systemd-credentials",
    "unprivileged-user-namespaces",
    "bubblewrap",
    "tini",
    "xfce",
    "tigervnc",
    "chromium"
  ],
  artifacts: [
    ...OFFICE_IMAGE_PACKAGE_FILES,
    ...reset ? OFFICE_IMAGE_RESET_PACKAGE_FILES : [],
    "node_modules/playwright-core/package.json",
    "node_modules/playwright-core/index.mjs",
    "node_modules/playwright-core/browsers.json",
    "wallpapers/qorpera-screen-pebble.png"
  ].map((file) => {
    const mount2 = Buffer.from("[Mount]\nOptions=uid=@OFFICE_UID@,gid=@OFFICE_GID@\n");
    return file === "qorpera-office-private.mount.in" ? { file, bytes: mount2.length, sha256: (0, import_node_crypto3.createHash)("sha256").update(mount2).digest("hex") } : { file, bytes: 1, sha256: "a".repeat(64) };
  })
});
var officeImagePackageBytes = () => Buffer.from(JSON.stringify(officeImagePackageFixture()));
var officeImagePackageSha256 = () => (0, import_node_crypto3.createHash)("sha256").update(officeImagePackageBytes()).digest("hex");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/fixtures/office-physical-policy.ts
var keys = (0, import_node_crypto4.generateKeyPairSync)("ed25519");
function officePhysicalFixture(architecture = "x86_64") {
  const statement = {
    schema: "qorpera.lxd-office-image-provenance/v1",
    image: {
      fingerprint: "a".repeat(64),
      baseFingerprint: "b".repeat(64),
      architecture,
      bytes: 1024,
      guestPackageManifestSha256: officeImagePackageSha256(),
      bootstrapSha256: "d".repeat(64)
    },
    source: { repository: "https://example.test/office.git", commit: "e".repeat(40), tree: "clean" },
    acceptance: {
      testedAt: "2026-09-08T00:00:00.000Z",
      evidenceSha256: "f".repeat(64),
      virtualization: "kvm",
      bootMode: "uefi-secureboot",
      secureBoot: true,
      credentials: "absent",
      computeIdentity: "absent",
      companyState: "absent",
      services: "fail-closed"
    }
  };
  const envelope = {
    schema: "qorpera.lxd-office-image-provenance-envelope/v1",
    statement,
    signature: {
      algorithm: "ed25519",
      value: (0, import_node_crypto4.sign)(null, Buffer.from(officeCanonical(statement)), keys.privateKey).toString("base64")
    }
  };
  const infrastructure = {
    project: {
      name: "offices",
      config: { "features.images": "true", "features.profiles": "true", "features.networks": "false" },
      replicaMode: ""
    },
    network: {
      name: "office-net",
      project: "default",
      type: "bridge",
      managed: true,
      status: "Created",
      config: { "ipv4.address": "10.44.0.1/24", "ipv4.nat": "true", "ipv6.address": "none" }
    },
    storagePool: { name: "office-pool", driver: "zfs", status: "Created", config: { source: "office-pool" } }
  };
  const policy = {
    schema: "qorpera.lxd-office-physical-policy/v2",
    infrastructure: {
      projectSha256: officeDigest(infrastructure.project),
      networkSha256: officeDigest(infrastructure.network),
      storagePoolSha256: officeDigest(infrastructure.storagePool)
    },
    guest: {
      providerId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      environmentId: "33333333-3333-4333-8333-333333333333",
      companyComputerId: "44444444-4444-4444-8444-444444444444",
      logicalComputerId: "55555555-5555-4555-8555-555555555555",
      computerGeneration: 1,
      project: "offices",
      imageFingerprint: statement.image.fingerprint,
      bootstrapSha256: statement.image.bootstrapSha256,
      storagePool: "office-pool",
      rootDiskBytes: 1024 ** 3,
      workbenchSource: "/mnt/office-workbench",
      network: "office-net",
      cpus: 2,
      memoryBytes: 1024 ** 3
    },
    host: {
      machineIdSha256: "1".repeat(64),
      socketPath: "/run/office-lxd/unix.socket",
      socketGid: 1001,
      certificateSha256: "2".repeat(64),
      serverName: "office-host",
      serverVersion: "6.9",
      architecture
    },
    image: {
      bytes: statement.image.bytes,
      guestPackageManifestSha256: statement.image.guestPackageManifestSha256,
      statementSha256: officeDigest(statement),
      verificationKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64")
    },
    workbench: {
      mountPoint: "/mnt/office-workbench",
      root: "/",
      filesystem: "nfs4",
      source: "192.0.2.1:/offices/test",
      serverAddress: "192.0.2.1",
      uid: 1e3,
      gid: 1e3
    },
    journal: {
      path: "/mnt/office-journal/state",
      mountPoint: "/mnt/office-journal",
      root: "/",
      filesystem: "ext4",
      source: "/dev/vdb"
    }
  };
  const binding = {
    schema: "qorpera.lxd-office-guest/v2",
    ...policy.guest,
    allocationId: "66666666-6666-4666-8666-666666666666",
    providerPolicySha256: lxdOfficePhysicalPolicySha256(policy)
  };
  return { policy, statement, envelope, binding, infrastructure };
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/helpers/office-delete-disposition-fixture.ts
var import_node_crypto6 = require("node:crypto");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-delete-disposition.ts
var import_node_crypto5 = require("node:crypto");
var import_node_util2 = require("node:util");

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-activation.ts
var UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var SHA2 = /^[0-9a-f]{64}$/;
var INVOCATION = /^(?!0{32}$)[0-9a-f]{32}$/;
function record(value, keys2) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== keys2.sort().join())
    throw new Error("record");
  return value;
}
function match(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("identity");
}
function positive(value, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("number");
}
function parseCompanyComputerStartupIdentity(value) {
  try {
    const input = record(value, [
      "scope",
      "computerGeneration",
      "allocationId",
      "instanceSha256",
      "imageSha256",
      "bootstrapSha256",
      "bootId",
      "configurationSha256",
      "serviceInvocationId"
    ]);
    const scope = record(input.scope, ["companyId", "environmentId", "companyComputerId", "logicalComputerId"]);
    for (const id3 of [...Object.values(scope), input.allocationId, input.bootId]) match(id3, UUID2);
    for (const sha3 of [input.instanceSha256, input.imageSha256, input.bootstrapSha256, input.configurationSha256])
      match(sha3, SHA2);
    match(input.serviceInvocationId, INVOCATION);
    positive(input.computerGeneration, Number.MAX_SAFE_INTEGER);
    return Object.freeze({
      ...input,
      scope: Object.freeze({ ...scope })
    });
  } catch {
    throw new Error("INVALID_OFFICE_STARTUP_IDENTITY");
  }
}

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-lifecycle.ts
var UUID3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function record2(value, keys2) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== keys2.sort().join())
    throw new Error("record");
  return value;
}
function uuid(value) {
  if (typeof value !== "string" || !UUID3.test(value)) throw new Error("identity");
}
function parseCompanyComputerLifecycleRequest(value) {
  try {
    const input = record2(value, [
      "schema",
      "transitionId",
      "action",
      "activationId",
      "providerId",
      "providerPolicySha256",
      "startup"
    ]);
    for (const id3 of [input.transitionId, input.activationId, input.providerId]) uuid(id3);
    if (input.schema !== "qorpera.office-lifecycle-request/v1" || !["service_restart", "reboot", "power_off", "replace"].includes(input.action) || typeof input.providerPolicySha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.providerPolicySha256))
      throw new Error("schema");
    return Object.freeze({
      schema: input.schema,
      transitionId: input.transitionId,
      action: input.action,
      activationId: input.activationId,
      providerId: input.providerId,
      providerPolicySha256: input.providerPolicySha256,
      startup: parseCompanyComputerStartupIdentity(input.startup)
    });
  } catch {
    throw new Error("INVALID_OFFICE_LIFECYCLE_REQUEST");
  }
}

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-preparation.ts
var COMPANY_COMPUTER_PREPARATION_MAX_BYTES = 16 * 1024 ** 2;

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-configuration.ts
var COMPANY_COMPUTER_CONFIGURATION_FILES = Object.freeze({
  configuration: "config.json",
  registry: "registry",
  native: "native",
  objects: "objects",
  tlsCert: "tls-cert.pem",
  tlsKey: "tls-key.pem"
});
var COMPANY_COMPUTER_CONFIGURATION_LIMITS = Object.freeze({
  configuration: 16384,
  registry: 8192,
  native: 128,
  objects: 128,
  tlsCert: 65536,
  tlsKey: 32768
});

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-code-package-provision.ts
var COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS = [
  "qorpera-company-computer-boot-configuration-control.mjs",
  "qorpera-company-computer-boot-service-restart-control.mjs",
  "qorpera-company-computer-boot-service-start-control.mjs",
  "qorpera-company-computer-configuration-control.mjs",
  "qorpera-company-computer-preparation-control.mjs",
  "qorpera-company-computer-preparation.mjs",
  "qorpera-company-computer-reset-configuration-control.mjs",
  "qorpera-company-computer-reset-service-restart-control.mjs",
  "qorpera-company-computer-reset-service-start-control.mjs",
  "qorpera-company-computer-service-restart-control.mjs",
  "qorpera-company-computer-service-start-control.mjs",
  "qorpera-company-computer-service-stop-control.mjs",
  "qorpera-company-computer-service.mjs",
  "qorpera-office-image-install.cjs"
];
var COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS = COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS.slice(6, 9);
var COMPANY_COMPUTER_CODE_PACKAGE_MANIFEST_MAX_BYTES = 1024 ** 2;
var COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACT_MAX_BYTES = 32 * 1024 ** 2;
var COMPANY_COMPUTER_CODE_PACKAGE_TOOL_MAX_BYTES = 16 * 1024 ** 2;
var COMPANY_COMPUTER_CODE_PACKAGE_TOTAL_MAX_BYTES = 128 * 1024 ** 2;

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-reset-custody.ts
var COMPANY_COMPUTER_RESET_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;
var COMPANY_COMPUTER_RESET_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
var uuid2 = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var UUID4 = new RegExp(`^${uuid2}$`);
var NAME2 = new RegExp(`^${uuid2}-[0-9]{16}\\.json$`);

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-reset.ts
var COMPANY_COMPUTER_RESET_PHASES = [
  "fenced",
  "stopped",
  "custodied",
  "powered_off",
  "root_deleted",
  "root_created",
  "restored",
  "prepared",
  "active"
];
var COMPANY_COMPUTER_RESET_MAX_BYTES = 65536;
var COMPANY_COMPUTER_RESET_HISTORY_MAX_BYTES = 8 * 1024 ** 2;
var UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var SHA3 = /^[0-9a-f]{64}$/;
function record3(value, keys2) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join() !== keys2)
    throw new Error("record");
  return value;
}
function uuid3(value) {
  if (typeof value !== "string" || !UUID5.test(value)) throw new Error("identity");
  return value;
}
function sha(value) {
  if (typeof value !== "string" || !SHA3.test(value)) throw new Error("digest");
  return value;
}
function bounded(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > COMPANY_COMPUTER_RESET_MAX_BYTES)
    throw new Error("size");
}
function absolutePath(value) {
  if (typeof value !== "string" || value === "/" || !value.startsWith("/") || value.length > 4096 || value.endsWith("/") || /[\x00-\x20\x7f\\]/.test(value) || value.split("/").some((part, index) => index > 0 && !part || part === "." || part === ".."))
    throw new Error("path");
  return value;
}
function distinct(ids) {
  if (new Set(ids).size !== ids.length) throw new Error("identity reuse");
}
function parseCompanyComputerResetPlan(value) {
  try {
    bounded(value);
    const r = record3(
      value,
      "commands,custody,intentId,nodeId,predecessor,predecessorRootIncarnationId,preparationObservationSha256,providerBindingSha256,resetId,rootIncarnationId,schema,successorActivationId"
    );
    if (r.schema !== "qorpera.lxd-office-reset-plan/v1") throw new Error("schema");
    const predecessor = parseCompanyComputerLifecycleRequest(r.predecessor);
    if (predecessor.action !== "replace") throw new Error("action");
    const commands = record3(r.commands, "createCommandId,deleteCommandId,startCommandId,stopCommandId"), custody = record3(r.custody, "archiveRoot");
    const fresh = [
      uuid3(r.resetId),
      uuid3(r.rootIncarnationId),
      uuid3(r.successorActivationId),
      uuid3(commands.stopCommandId),
      uuid3(commands.deleteCommandId),
      uuid3(commands.createCommandId),
      uuid3(commands.startCommandId),
      ...r.predecessorRootIncarnationId === null ? [] : [uuid3(r.predecessorRootIncarnationId)]
    ];
    const retained = [
      uuid3(r.intentId),
      predecessor.transitionId,
      predecessor.activationId,
      predecessor.startup.bootId,
      predecessor.startup.allocationId,
      ...r.nodeId === null ? [] : [uuid3(r.nodeId)]
    ];
    distinct(fresh);
    if (fresh.some((id3) => retained.includes(id3))) throw new Error("identity reuse");
    return Object.freeze({
      schema: "qorpera.lxd-office-reset-plan/v1",
      resetId: r.resetId,
      intentId: r.intentId,
      predecessor,
      preparationObservationSha256: sha(r.preparationObservationSha256),
      providerBindingSha256: sha(r.providerBindingSha256),
      nodeId: r.nodeId,
      predecessorRootIncarnationId: r.predecessorRootIncarnationId,
      rootIncarnationId: r.rootIncarnationId,
      successorActivationId: r.successorActivationId,
      commands: Object.freeze({
        stopCommandId: commands.stopCommandId,
        deleteCommandId: commands.deleteCommandId,
        createCommandId: commands.createCommandId,
        startCommandId: commands.startCommandId
      }),
      custody: Object.freeze({ archiveRoot: absolutePath(custody.archiveRoot) })
    });
  } catch {
    throw new Error("INVALID_OFFICE_RESET_PLAN");
  }
}
function parseCompanyComputerResetPhaseRecord(value, plan) {
  try {
    const r = record3(value, "evidenceSha256,phase,previousSha256,resetId,schema,sequence");
    const index = COMPANY_COMPUTER_RESET_PHASES.indexOf(r.phase);
    if (r.schema !== "qorpera.office-reset-phase/v1" || r.resetId !== parseCompanyComputerResetPlan(plan).resetId || index < 0 || r.sequence !== index + 1 || (index === 0 ? r.previousSha256 !== null : sha(r.previousSha256) !== r.previousSha256))
      throw new Error("phase");
    return Object.freeze({
      schema: "qorpera.office-reset-phase/v1",
      resetId: plan.resetId,
      phase: r.phase,
      sequence: index + 1,
      previousSha256: r.previousSha256,
      evidenceSha256: sha(r.evidenceSha256)
    });
  } catch {
    throw new Error("INVALID_OFFICE_RESET_PHASE_RECORD");
  }
}

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-delete-disposition.ts
var COMPANY_COMPUTER_DELETE_DISPOSITION_MAX_BYTES = 16384;
var UUID6 = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var SHA4 = /^[a-f0-9]{64}$/;
function record4(value, keys2) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("record");
  const names = keys2.split(",");
  if (Reflect.ownKeys(value).length !== names.length) throw new Error("record");
  const result = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("record");
    result[name] = descriptor.value;
  }
  return result;
}
function text(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("value");
  return value;
}
function journal(value) {
  const r = record4(value, "authoritySha256,acceptedHeadSha256,eventCount");
  if (!Number.isSafeInteger(r.eventCount) || r.eventCount < 11 || r.eventCount > 383 || r.eventCount % 3 !== 2)
    throw new Error("prefix");
  return Object.freeze({
    authoritySha256: text(r.authoritySha256, SHA4),
    acceptedHeadSha256: text(r.acceptedHeadSha256, SHA4),
    eventCount: r.eventCount
  });
}
function parseCompanyComputerDeleteAdministrativeDisposition(value, binding) {
  try {
    const r = record4(
      value,
      "schema,auditId,resetId,planSha256,deleteCommandId,operationId,nextCreateCommandId,originalOutcome,targetPostcondition,journal,custodyEvidenceSha256,stopAcknowledgementSha256,poweredOffPhaseSha256,operator,source,executionFence,physicalEvidence,observedAt"
    );
    const b = record4(
      binding,
      "plan,planSha256,operationId,journal,custodyEvidenceSha256,stopAcknowledgementSha256,poweredOffPhaseSha256"
    );
    const plan = parseCompanyComputerResetPlan(b.plan);
    const operator = record4(r.operator, "principalId,reasonCode,reason");
    const source = record4(r.source, "sourceCommit,artifactSha256");
    const fence = record4(r.executionFence, "schema,mechanism,sha256");
    const physical = record4(r.physicalEvidence, "schema,sha256");
    const actualJournal = journal(r.journal), expectedJournal = journal(b.journal);
    if (r.schema !== "qorpera.office-delete-administrative-disposition/v1" || r.originalOutcome !== "unknown" || r.targetPostcondition !== "absent" || r.resetId !== plan.resetId || r.deleteCommandId !== plan.commands.deleteCommandId || r.nextCreateCommandId !== plan.commands.createCommandId || operator.reasonCode !== "accepted_delete_result_unavailable" || fence.schema !== "qorpera.office-delete-execution-fence/v1" || fence.mechanism !== "lxd-ab8fad2-zfs-ordered-delete/v1" || physical.schema !== "qorpera.office-delete-physical-evidence/v1" || actualJournal.authoritySha256 !== expectedJournal.authoritySha256 || actualJournal.acceptedHeadSha256 !== expectedJournal.acceptedHeadSha256 || actualJournal.eventCount !== expectedJournal.eventCount)
      throw new Error("binding");
    const references = [
      "planSha256",
      "custodyEvidenceSha256",
      "stopAcknowledgementSha256",
      "poweredOffPhaseSha256"
    ];
    for (const key of references) if (text(r[key], SHA4) !== text(b[key], SHA4)) throw new Error("reference");
    const operationId = text(r.operationId, UUID6), auditId = text(r.auditId, UUID6);
    if (operationId !== text(b.operationId, UUID6)) throw new Error("operation");
    const retainedIds = [
      plan.resetId,
      plan.intentId,
      plan.rootIncarnationId,
      plan.successorActivationId,
      plan.predecessor.transitionId,
      plan.predecessor.activationId,
      plan.predecessor.startup.allocationId,
      plan.predecessor.startup.bootId,
      ...Object.values(plan.commands),
      plan.nodeId,
      plan.predecessorRootIncarnationId
    ];
    if (auditId === operationId || retainedIds.includes(auditId) || retainedIds.includes(operationId))
      throw new Error("identity reuse");
    if (typeof operator.reason !== "string" || operator.reason.length < 1 || operator.reason.length > 512 || operator.reason.trim() !== operator.reason || /[\x00-\x1f\x7f]/.test(operator.reason))
      throw new Error("reason");
    const observedAt = text(r.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt)
      throw new Error("time");
    const parsed = Object.freeze({
      schema: "qorpera.office-delete-administrative-disposition/v1",
      auditId,
      resetId: plan.resetId,
      planSha256: r.planSha256,
      deleteCommandId: plan.commands.deleteCommandId,
      operationId,
      nextCreateCommandId: plan.commands.createCommandId,
      originalOutcome: "unknown",
      targetPostcondition: "absent",
      journal: actualJournal,
      custodyEvidenceSha256: r.custodyEvidenceSha256,
      stopAcknowledgementSha256: r.stopAcknowledgementSha256,
      poweredOffPhaseSha256: r.poweredOffPhaseSha256,
      operator: Object.freeze({
        principalId: text(operator.principalId, UUID6),
        reasonCode: "accepted_delete_result_unavailable",
        reason: operator.reason
      }),
      source: Object.freeze({
        sourceCommit: text(source.sourceCommit, /^[a-f0-9]{40}$/),
        artifactSha256: text(source.artifactSha256, SHA4)
      }),
      executionFence: Object.freeze({
        schema: "qorpera.office-delete-execution-fence/v1",
        mechanism: "lxd-ab8fad2-zfs-ordered-delete/v1",
        sha256: text(fence.sha256, SHA4)
      }),
      physicalEvidence: Object.freeze({
        schema: "qorpera.office-delete-physical-evidence/v1",
        sha256: text(physical.sha256, SHA4)
      }),
      observedAt
    });
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > COMPANY_COMPUTER_DELETE_DISPOSITION_MAX_BYTES)
      throw new Error("size");
    return parsed;
  } catch {
    throw new Error("INVALID_OFFICE_DELETE_ADMINISTRATIVE_DISPOSITION");
  }
}

// ../../../../work/Qorpera_Base-web-runtime/packages/contracts/src/company-computer-reset-successor.ts
var COMPANY_COMPUTER_RESET_CONFIGURATION_MAX_BYTES = 2 * COMPANY_COMPUTER_PREPARATION_MAX_BYTES + 6 * Object.values(COMPANY_COMPUTER_CONFIGURATION_LIMITS).reduce((sum, limit) => sum + limit, 0) + 65536;

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-physical-host.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path3 = require("node:path");
var import_node_util = require("node:util");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-host-namespace.ts
var OFFICE_HOST_NAMESPACE_RECORD = "/run/qorpera-office-provider/host-mount-namespace.json";
var bootPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var namespacePattern = /^mnt:\[[1-9][0-9]{0,19}\]$/;
function parseLxdOfficeHostNamespace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("OFFICE_HOST_NAMESPACE_UNCONFIRMED");
  const r = value;
  if (Object.keys(r).sort().join(",") !== "bootId,namespace,schema" || r.schema !== "qorpera.lxd-office-host-namespace/v1" || typeof r.bootId !== "string" || !bootPattern.test(r.bootId) || typeof r.namespace !== "string" || !namespacePattern.test(r.namespace))
    throw new Error("OFFICE_HOST_NAMESPACE_UNCONFIRMED");
  return { bootId: r.bootId, namespace: r.namespace };
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-physical-host.ts
async function rootParents(path) {
  let current = (0, import_node_path3.dirname)(path);
  while (true) {
    const info = await (0, import_promises.lstat)(current);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 3090) !== 0)
      throw new Error("OFFICE_HOST_PATH_UNPROTECTED");
    if (current === "/") break;
    current = (0, import_node_path3.dirname)(current);
  }
}
async function readBounded(file, limit) {
  const bytes = Buffer.alloc(limit + 1);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset > limit) throw new Error("OFFICE_HOST_METADATA_TOO_LARGE");
    return bytes.subarray(0, offset);
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}
function identity(info) {
  return { dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode, nlink: info.nlink };
}
async function readLxdOfficeProtectedFile(path, limit) {
  return readProtectedFile(path, limit, false);
}
async function readProtectedFile(path, limit, confidential, ceiling = 65536) {
  officePhysicalPath(path);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ceiling) throw new Error("INVALID_OFFICE_FILE_LIMIT");
  await rootParents(path);
  const file = await (0, import_promises.open)(path, import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW | import_node_fs.constants.O_NONBLOCK);
  let contents;
  let returned = false;
  try {
    if (process.platform !== "linux") throw new Error("OFFICE_HOST_LINUX_REQUIRED");
    const fdInfo = await metadata(`/proc/self/fdinfo/${file.fd}`, 4096);
    const ids = [...fdInfo.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
    const mounts = (await metadata("/proc/self/mountinfo", 1048576)).split("\n").filter((line) => line.split(" ", 1)[0] === ids[0]?.[1]);
    if (ids.length !== 1 || mounts.length !== 1 || !["ext4", "xfs", "btrfs", "zfs", "overlay", "tmpfs"].includes(mounts[0].split(" - ")[1]?.split(" ")[0]))
      throw new Error("OFFICE_HOST_LOCAL_CONFIGURATION_REQUIRED");
    const before = await file.stat();
    if (!before.isFile() || before.uid !== 0 || (before.mode & 3090) !== 0 || confidential && (![256, 288].includes(before.mode & 4095) || (before.mode & 32) !== 0 && before.gid !== process.getegid?.()) || before.nlink !== 1 || before.size < 1 || before.size > limit || await (0, import_promises.realpath)(path) !== path)
      throw new Error("OFFICE_HOST_FILE_UNPROTECTED");
    const bytes = await readBounded(file, limit);
    contents = bytes;
    const after = await file.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.ctimeMs !== after.ctimeMs || before.mtimeMs !== after.mtimeMs || !(0, import_node_util.isDeepStrictEqual)(identity(before), identity(after)) || !(0, import_node_util.isDeepStrictEqual)(identity(after), identity(await (0, import_promises.lstat)(path))))
      throw new Error("OFFICE_HOST_FILE_CHANGED");
    returned = true;
    return bytes;
  } finally {
    if (!returned) contents?.fill(0);
    await file.close();
  }
}
async function metadata(path, limit) {
  const file = await (0, import_promises.open)(path, import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW | import_node_fs.constants.O_NONBLOCK);
  try {
    return new TextDecoder("utf8", { fatal: true }).decode(await readBounded(file, limit));
  } finally {
    await file.close();
  }
}
function assertLxdOfficeHostMount(mountInfo, fdInfo, expected, path, serverAddress) {
  if (Buffer.byteLength(mountInfo) > 1048576 || Buffer.byteLength(fdInfo) > 4096)
    throw new Error("OFFICE_HOST_MOUNT_TOO_LARGE");
  const ids = [...fdInfo.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  if (ids.length !== 1) throw new Error("OFFICE_HOST_MOUNT_UNCONFIRMED");
  const decode = (value) => {
    const decoded = value.replace(
      /\\(040|011|012|134)/g,
      (_, octal) => String.fromCharCode(Number.parseInt(octal, 8))
    );
    if (/[\x00-\x20\x7f\\]/.test(decoded)) throw new Error("OFFICE_HOST_MOUNT_PATH_UNSUPPORTED");
    return decoded;
  };
  const lines = mountInfo.trim().split("\n").map((line) => {
    const [prefix, suffix, extra] = line.split(" - ");
    const before = prefix.split(" ");
    const after = suffix?.split(" ");
    if (extra !== void 0 || before.length < 6 || !after || after.length !== 3)
      throw new Error("OFFICE_HOST_MOUNT_UNCONFIRMED");
    return {
      id: before[0],
      root: decode(before[3]),
      mountPoint: decode(before[4]),
      filesystem: after[0],
      source: decode(after[1]),
      options: before[5].split(","),
      superOptions: after[2].split(",")
    };
  });
  const matches = lines.filter((line) => line.id === ids[0][1]);
  if (matches.length !== 1) throw new Error("OFFICE_HOST_MOUNT_UNCONFIRMED");
  const actual = matches[0];
  if (actual.root !== expected.root || actual.mountPoint !== expected.mountPoint || actual.filesystem !== expected.filesystem || actual.source !== expected.source || !actual.options.includes("rw") || actual.options.includes("ro") || !actual.superOptions.includes("rw") || actual.superOptions.includes("ro") || lines.filter((line) => line.mountPoint === expected.mountPoint).length !== 1 || lines.some((line) => line.mountPoint.startsWith(`${path}/`)))
    throw new Error("OFFICE_HOST_MOUNT_MISMATCH");
  if (serverAddress !== void 0) {
    const options = actual.superOptions;
    const option = (key, allowed) => {
      const values = options.filter((entry) => entry.startsWith(`${key}=`));
      return values.length === 1 && allowed.includes(values[0].slice(key.length + 1));
    };
    if (!actual.options.includes("nosuid") || !actual.options.includes("nodev") || !options.includes("hard") || options.some((entry) => ["soft", "softerr", "softreval"].includes(entry)) || !option("proto", ["tcp"]) || !option("vers", ["4.1", "4.2"]) || !option("addr", [serverAddress]))
      throw new Error("OFFICE_NAS_MOUNT_POLICY_MISMATCH");
  }
}
async function assertLxdOfficeHostNamespace(bootId) {
  const namespace = await (0, import_promises.readlink)("/proc/self/ns/mnt");
  if (!/^mnt:\[[1-9][0-9]{0,19}\]$/.test(namespace)) throw new Error("OFFICE_PROVIDER_HOST_MOUNT_NAMESPACE_REQUIRED");
  let hostNamespace = "";
  try {
    hostNamespace = await (0, import_promises.readlink)("/proc/1/ns/mnt");
  } catch (error) {
    if (!["EACCES", "EPERM"].includes(error.code ?? "")) throw error;
  }
  if (hostNamespace === "") {
    const record5 = parseLxdOfficeHostNamespace(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          await readLxdOfficeProtectedFile(OFFICE_HOST_NAMESPACE_RECORD, 1024)
        )
      )
    );
    if (record5.bootId !== bootId) throw new Error("OFFICE_PROVIDER_BOOT_UNCONFIRMED");
    hostNamespace = record5.namespace;
  }
  if (namespace !== hostNamespace) throw new Error("OFFICE_PROVIDER_HOST_MOUNT_NAMESPACE_REQUIRED");
  return namespace;
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-delete-disposition.ts
var UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var ROOT = "/etc/qorpera/office-provider/delete-dispositions";
var LIMIT = 65536;
var verified = /* @__PURE__ */ new WeakSet();
function lxdOfficeDeleteDispositionPath(allocationId, auditId) {
  if (!UUID7.test(allocationId) || !UUID7.test(auditId)) throw new Error("OFFICE_DELETE_DISPOSITION_ID_INVALID");
  return `${ROOT}/${allocationId}/${auditId}.json`;
}
function lxdOfficeDeleteDocumentSha256(documentText) {
  return (0, import_node_crypto5.createHash)("sha256").update(documentText, "utf8").digest("hex");
}
function lxdOfficeDeletePhaseEvidence(document, dispositionSha256) {
  return {
    schema: "qorpera.office-reset-phase-evidence/v1",
    resetId: document.resetId,
    phase: "root_deleted",
    observation: {
      schema: "qorpera.office-delete-administrative-boundary/v1",
      auditId: document.auditId,
      dispositionSha256: officeSha(dispositionSha256),
      commandId: document.deleteCommandId,
      operationId: document.operationId,
      originalOutcome: "unknown",
      targetPostcondition: "absent",
      nextCreateCommandId: document.nextCreateCommandId
    }
  };
}
function freeze(value) {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
function assertLxdOfficeDeleteDispositionContext(value) {
  if (!value || typeof value !== "object" || !verified.has(value))
    throw new Error("OFFICE_DELETE_DISPOSITION_CONTEXT_UNVERIFIED");
}
async function readLxdOfficeDeleteDisposition(allocationId, auditId, readProtected = readLxdOfficeProtectedFile) {
  try {
    const path = lxdOfficeDeleteDispositionPath(allocationId, auditId);
    const bytes = await readProtected(path, LIMIT);
    if (bytes.length < 1 || bytes.length > LIMIT) throw new Error("receipt size");
    const packet = officeRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), [
      "schema",
      "plan",
      "documentText",
      "sqlReceipt"
    ]);
    if (packet.schema !== "qorpera.lxd-office-delete-disposition-receipt/v1" || typeof packet.documentText !== "string" || Buffer.byteLength(packet.documentText, "utf8") > 16384)
      throw new Error("receipt envelope");
    const plan = parseCompanyComputerResetPlan(packet.plan);
    if (plan.predecessor.startup.allocationId !== allocationId) throw new Error("receipt allocation");
    const raw = JSON.parse(packet.documentText);
    const document = parseCompanyComputerDeleteAdministrativeDisposition(raw, {
      plan,
      planSha256: officeDigest(plan),
      operationId: raw.operationId,
      journal: raw.journal,
      custodyEvidenceSha256: raw.custodyEvidenceSha256,
      stopAcknowledgementSha256: raw.stopAcknowledgementSha256,
      poweredOffPhaseSha256: raw.poweredOffPhaseSha256
    });
    if (document.auditId !== auditId) throw new Error("receipt audit");
    const dispositionSha256 = lxdOfficeDeleteDocumentSha256(packet.documentText);
    const phaseEvidence = lxdOfficeDeletePhaseEvidence(document, dispositionSha256);
    const phaseEvidenceSha256 = officeDigest(phaseEvidence);
    const receipt = officeRecord(packet.sqlReceipt, [
      "schema",
      "auditId",
      "resetId",
      "dispositionSha256",
      "operatorId",
      "recordedAt",
      "originalOutcome",
      "recoveryKind",
      "cleanResetAcceptance",
      "phaseEvidence",
      "phaseEvidenceSha256",
      "resetRevision"
    ]);
    if (typeof receipt.recordedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receipt.recordedAt) || !Number.isFinite(Date.parse(receipt.recordedAt)) || new Date(receipt.recordedAt).toISOString() !== receipt.recordedAt || !Number.isSafeInteger(receipt.resetRevision) || receipt.resetRevision < 1)
      throw new Error("SQL receipt metadata");
    const sqlReceipt = {
      schema: "qorpera.office-delete-administrative-receipt/v1",
      auditId,
      resetId: plan.resetId,
      dispositionSha256,
      operatorId: document.operator.principalId,
      recordedAt: receipt.recordedAt,
      originalOutcome: "unknown",
      recoveryKind: "administrative_delete",
      cleanResetAcceptance: false,
      phaseEvidence,
      phaseEvidenceSha256,
      resetRevision: receipt.resetRevision
    };
    if (!(0, import_node_util2.isDeepStrictEqual)(receipt, sqlReceipt)) throw new Error("SQL receipt differs");
    const context = {
      plan,
      document,
      dispositionSha256,
      sqlReceiptSha256: officeDigest(sqlReceipt),
      phaseEvidenceSha256,
      sqlReceipt
    };
    freeze(context);
    verified.add(context);
    return context;
  } catch {
    throw new Error("OFFICE_DELETE_DISPOSITION_UNCONFIRMED");
  }
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/test/helpers/office-delete-disposition-fixture.ts
var officeDeleteDispositionId = (n) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
var id2 = officeDeleteDispositionId;
var officeDeleteDispositionSha = (n) => n.repeat(64);
var sha2 = officeDeleteDispositionSha;
function fixture() {
  const binding = {
    plan: {
      schema: "qorpera.lxd-office-reset-plan/v1",
      resetId: id2(1),
      intentId: id2(13),
      predecessor: {
        schema: "qorpera.office-lifecycle-request/v1",
        transitionId: id2(2),
        action: "replace",
        activationId: id2(3),
        providerId: id2(12),
        providerPolicySha256: sha2("f"),
        startup: {
          scope: { companyId: id2(6), environmentId: id2(7), companyComputerId: id2(8), logicalComputerId: id2(9) },
          computerGeneration: 1,
          allocationId: id2(10),
          instanceSha256: sha2("a"),
          imageSha256: sha2("b"),
          bootstrapSha256: sha2("c"),
          bootId: id2(11),
          configurationSha256: sha2("d"),
          serviceInvocationId: "e".repeat(32)
        }
      },
      preparationObservationSha256: sha2("1"),
      providerBindingSha256: sha2("2"),
      nodeId: id2(14),
      predecessorRootIncarnationId: null,
      rootIncarnationId: id2(5),
      successorActivationId: id2(4),
      commands: { stopCommandId: id2(20), deleteCommandId: id2(21), createCommandId: id2(22), startCommandId: id2(23) },
      custody: { archiveRoot: "/var/lib/qorpera-office-provider/reset-custody" }
    },
    planSha256: sha2("3"),
    operationId: id2(40),
    journal: { authoritySha256: sha2("4"), acceptedHeadSha256: sha2("5"), eventCount: 11 },
    custodyEvidenceSha256: sha2("6"),
    stopAcknowledgementSha256: sha2("7"),
    poweredOffPhaseSha256: sha2("8")
  };
  const value = {
    schema: "qorpera.office-delete-administrative-disposition/v1",
    auditId: id2(41),
    resetId: binding.plan.resetId,
    planSha256: binding.planSha256,
    deleteCommandId: binding.plan.commands.deleteCommandId,
    operationId: binding.operationId,
    nextCreateCommandId: binding.plan.commands.createCommandId,
    originalOutcome: "unknown",
    targetPostcondition: "absent",
    journal: { ...binding.journal },
    custodyEvidenceSha256: binding.custodyEvidenceSha256,
    stopAcknowledgementSha256: binding.stopAcknowledgementSha256,
    poweredOffPhaseSha256: binding.poweredOffPhaseSha256,
    operator: {
      principalId: id2(42),
      reasonCode: "accepted_delete_result_unavailable",
      reason: "Accepted delete result was not retained."
    },
    source: { sourceCommit: "a".repeat(40), artifactSha256: sha2("9") },
    executionFence: {
      schema: "qorpera.office-delete-execution-fence/v1",
      mechanism: "lxd-ab8fad2-zfs-ordered-delete/v1",
      sha256: sha2("a")
    },
    physicalEvidence: { schema: "qorpera.office-delete-physical-evidence/v1", sha256: sha2("b") },
    observedAt: "2020-01-01T00:00:00.000Z"
  };
  return { binding, value };
}
function officeDeleteDispositionEnvelopeFixture(documentText) {
  const { binding, value } = fixture();
  return officeDeleteDispositionEnvelopeFor(
    binding.plan,
    { ...value, planSha256: officeDigest(binding.plan) },
    documentText
  );
}
function officeDeleteDispositionEnvelopeFor(plan, document, documentText) {
  const text2 = documentText ?? `${JSON.stringify(document, null, 2)}
`, d = JSON.parse(text2);
  const digest = (0, import_node_crypto6.createHash)("sha256").update(text2).digest("hex");
  const phaseEvidence = {
    schema: "qorpera.office-reset-phase-evidence/v1",
    resetId: d.resetId,
    phase: "root_deleted",
    observation: {
      schema: "qorpera.office-delete-administrative-boundary/v1",
      auditId: d.auditId,
      dispositionSha256: digest,
      commandId: d.deleteCommandId,
      operationId: d.operationId,
      originalOutcome: "unknown",
      targetPostcondition: "absent",
      nextCreateCommandId: d.nextCreateCommandId
    }
  };
  return {
    schema: "qorpera.lxd-office-delete-disposition-receipt/v1",
    plan,
    documentText: text2,
    sqlReceipt: {
      schema: "qorpera.office-delete-administrative-receipt/v1",
      auditId: d.auditId,
      resetId: d.resetId,
      dispositionSha256: digest,
      operatorId: d.operator.principalId,
      recordedAt: "2020-01-01T00:01:00.000Z",
      originalOutcome: "unknown",
      recoveryKind: "administrative_delete",
      cleanResetAcceptance: false,
      phaseEvidence,
      phaseEvidenceSha256: officeDigest(phaseEvidence),
      resetRevision: 6
    }
  };
}
function officeDeleteDispositionFixture() {
  const original = fixture();
  const binding = { ...original.binding, planSha256: officeDigest(original.binding.plan) };
  const document = { ...original.value, planSha256: binding.planSha256 };
  return {
    binding,
    plan: binding.plan,
    document,
    envelope: officeDeleteDispositionEnvelopeFixture(`${JSON.stringify(document, null, 2)}
`)
  };
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-operations.ts
var import_node_crypto8 = require("node:crypto");
var import_promises3 = require("node:fs/promises");
var import_node_path5 = require("node:path");
var import_node_util3 = require("node:util");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-journal-files.ts
var import_node_crypto7 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_promises2 = require("node:fs/promises");
var import_node_path4 = require("node:path");
function code(error, expected) {
  return error instanceof Error && "code" in error && error.code === expected;
}
async function checkDirectory(path) {
  const stat = await (0, import_promises2.lstat)(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 4095) !== 448 || await (0, import_promises2.realpath)(path) !== path)
    throw new Error("LXD_OFFICE_JOURNAL_DIRECTORY_UNSAFE");
}
async function syncDirectory(path) {
  const directory = await (0, import_promises2.open)(path, import_node_fs2.constants.O_RDONLY | import_node_fs2.constants.O_DIRECTORY | import_node_fs2.constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function readRecord(path, limit = 16384) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 ** 2 + 4096)
    throw new Error("INVALID_OFFICE_JOURNAL_RECORD_LIMIT");
  const file = await (0, import_promises2.open)(path, import_node_fs2.constants.O_RDONLY | import_node_fs2.constants.O_NOFOLLOW | import_node_fs2.constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 4095) !== 384 || before.nlink !== 1 || before.size < 1 || before.size > limit)
      throw new Error("invalid journal record");
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    const after = await file.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || before.nlink !== after.nlink)
      throw new Error("journal record changed");
    const bytes = buffer.subarray(0, size);
    return { bytes, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) };
  } finally {
    await file.close();
  }
}
async function publish(root, name, bytes) {
  await checkDirectory(root);
  const temporary = (0, import_node_path4.join)(root, `.write-${(0, import_node_crypto7.randomUUID)()}`);
  const file = await (0, import_promises2.open)(
    temporary,
    import_node_fs2.constants.O_WRONLY | import_node_fs2.constants.O_CREAT | import_node_fs2.constants.O_EXCL | import_node_fs2.constants.O_NOFOLLOW,
    384
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  let created = false;
  try {
    await (0, import_promises2.link)(temporary, (0, import_node_path4.join)(root, name));
    created = true;
  } catch (error) {
    if (!code(error, "EEXIST")) throw error;
  } finally {
    await (0, import_promises2.unlink)(temporary);
    await syncDirectory(root);
  }
  return created;
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-operation-completion.ts
function lxdOfficeVmCompletion(event, context, authority) {
  if (event?.kind === "settled" && event.state === "succeeded") return "succeeded";
  if (event?.kind !== "administrative_disposition" || !context || !authority) return void 0;
  assertLxdOfficeDeleteDispositionContext(context);
  const { plan, document } = context;
  if (event.schema !== "qorpera.lxd-office-operation-event/v3" || event.state !== "unknown" || event.action !== "delete" || event.auditId !== document.auditId || event.resetId !== plan.resetId || event.commandId !== plan.commands.deleteCommandId || event.operationId !== document.operationId || event.nextCreateCommandId !== plan.commands.createCommandId || event.dispositionSha256 !== context.dispositionSha256 || event.sqlReceiptSha256 !== context.sqlReceiptSha256 || event.phaseEvidenceSha256 !== context.phaseEvidenceSha256 || event.sequence !== document.journal.eventCount || event.previousSha256 !== document.journal.acceptedHeadSha256 || authority.authoritySha256 !== document.journal.authoritySha256 || plan.intentId !== authority.intentId || plan.providerBindingSha256 !== officeDigest(authority.binding) || plan.predecessor.startup.allocationId !== authority.binding.allocationId)
    throw new Error("OFFICE_DELETE_DISPOSITION_JOURNAL_DIFFERS");
  return "administratively_disposed";
}
async function assertLxdOfficeDeleteDispositionPhases(context, read, requireAdministrativePhase) {
  assertLxdOfficeDeleteDispositionContext(context);
  const { plan, document } = context;
  let previous = null;
  const expected = [
    officeDigest(plan),
    document.stopAcknowledgementSha256,
    document.custodyEvidenceSha256,
    document.poweredOffPhaseSha256,
    context.phaseEvidenceSha256
  ];
  for (let i = 0; i < (requireAdministrativePhase ? 5 : 4); i++) {
    const record5 = parseCompanyComputerResetPhaseRecord(
      await read(`reset-phase-${plan.predecessor.startup.allocationId}-${plan.resetId}-${i + 1}.json`),
      plan
    );
    if (record5.phase !== COMPANY_COMPUTER_RESET_PHASES[i] || record5.previousSha256 !== previous || expected[i] !== void 0 && record5.evidenceSha256 !== expected[i])
      throw new Error("OFFICE_DELETE_DISPOSITION_PHASES_DIFFER");
    previous = officeDigest(record5);
  }
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-vm-lineage.ts
var UUID8 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function assertLxdOfficeVmLineageCommands(commands, running = false) {
  if (commands.length < 2 || commands.length > 128 || new Set(commands.map((item) => item.commandId)).size !== commands.length)
    throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
  let state = "absent";
  for (const [index, command2] of commands.entries()) {
    if (!UUID8.test(command2.commandId) || Object.keys(command2).sort().join() !== "action,commandId")
      throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
    if (command2.action === "create" && state === "absent") state = "stopped";
    else if (command2.action === "start" && state === "stopped") state = "running";
    else if (command2.action === "stop" && state === "running") state = "stopped";
    else if (command2.action === "delete" && state === "stopped" && index > 2 && commands[index - 1].action === "stop")
      state = "absent";
    else throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
  }
  if (running && state !== "running") throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-operations.ts
var UUID9 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var MAX_EVENTS = 384;
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}
function sha256(value) {
  return (0, import_node_crypto8.createHash)("sha256").update(value).digest("hex");
}
function encode(value) {
  return Buffer.from(`${JSON.stringify(value)}
`, "utf8");
}
function lastCommand(events, commandId) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].commandId === commandId) return events[index];
  }
  return void 0;
}
var LxdOfficeOperationJournal = class _LxdOfficeOperationJournal {
  #root;
  #authority;
  #client;
  #now;
  constructor(root, intentId, binding, client, now = () => /* @__PURE__ */ new Date()) {
    this.#root = root;
    this.#authority = {
      schema: "qorpera.lxd-office-operation-journal/v1",
      intentId,
      binding: lxdOfficeGuestPlan(binding).binding
    };
    this.#client = client;
    this.#now = now;
  }
  static async open(stateRoot, intentId, binding, client, existing = false, now = () => /* @__PURE__ */ new Date()) {
    if (typeof intentId !== "string" || !UUID9.test(intentId) || (0, import_node_path5.resolve)(stateRoot) !== stateRoot)
      throw new Error("INVALID_LXD_OFFICE_JOURNAL");
    const plan = lxdOfficeGuestPlan(binding);
    await checkDirectory(stateRoot);
    const root = (0, import_node_path5.join)(stateRoot, plan.binding.allocationId);
    try {
      if (existing) {
        await checkDirectory(root);
      } else {
        await (0, import_promises3.mkdir)(root, { mode: 448 });
        await syncDirectory(stateRoot);
      }
    } catch (error) {
      if (!code(error, "EEXIST")) throw error;
    }
    await checkDirectory(root);
    const journal2 = new _LxdOfficeOperationJournal(root, intentId, plan.binding, client, now);
    if (!existing) await publish(root, "authority.json", encode(journal2.#authority));
    await journal2.#read();
    return journal2;
  }
  /** Local operator read only: validate the original authority and hash chain,
   * without creating files, loading credentials or contacting a provider. */
  static async readHistory(stateRoot, allocationId) {
    return (await _LxdOfficeOperationJournal.#existing(stateRoot, allocationId)).history();
  }
  /** Root operator metadata reconciliation. This entry point has no client
   * capable of VM dispatch or operation inspection. */
  static async recordAdministrativeDisposition(stateRoot, allocationId, context) {
    await (await _LxdOfficeOperationJournal.#existing(stateRoot, allocationId)).#recordAdministrativeDisposition(
      context
    );
  }
  /** Terminal prefix proof shared by reset and successor history readers.
   * Generic readHistory deliberately remains an unauthoritative observation. */
  static async assertCompletedHistory(stateRoot, allocationId, commands) {
    assertLxdOfficeVmLineageCommands(commands);
    const journal2 = await _LxdOfficeOperationJournal.#existing(stateRoot, allocationId);
    const current = await journal2.#read();
    if (current.events.length < commands.length * 3) throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
    const contexts = await journal2.#dispositions(current);
    for (const [index, command2] of commands.entries()) {
      const group = current.events.slice(index * 3, index * 3 + 3);
      if (group.some((event) => event.commandId !== command2.commandId || event.action !== command2.action) || !journal2.#completion(group[2], current.authoritySha256, contexts))
        throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
    }
    return [...contexts.values()].filter(
      (context) => commands.some((command2) => command2.commandId === context.document.deleteCommandId)
    );
  }
  /** Capture only the accepted tail of an existing validated journal. Missing
   * dispatch replies remain unknown; this entry point cannot create or submit. */
  static async observeExisting(stateRoot, allocationId, inspect, signal) {
    signal.throwIfAborted();
    const journal2 = await _LxdOfficeOperationJournal.#existing(stateRoot, allocationId, inspect);
    const tail = (await journal2.#read()).events.at(-1);
    if (tail?.kind === "accepted") await journal2.#observe(tail.commandId, tail.action, signal);
  }
  static async #existing(stateRoot, allocationId, inspect) {
    if ((0, import_node_path5.resolve)(stateRoot) !== stateRoot || !UUID9.test(allocationId)) throw new Error("INVALID_LXD_OFFICE_HISTORY");
    await checkDirectory(stateRoot);
    const root = (0, import_node_path5.join)(stateRoot, allocationId);
    await checkDirectory(root);
    const { value } = await readRecord((0, import_node_path5.join)(root, "authority.json"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("LXD_OFFICE_HISTORY_UNCONFIRMED");
    const authority = value;
    if (Object.keys(authority).sort().join() !== "binding,intentId,schema" || authority.schema !== "qorpera.lxd-office-operation-journal/v1" || typeof authority.intentId !== "string" || !UUID9.test(authority.intentId))
      throw new Error("LXD_OFFICE_HISTORY_UNCONFIRMED");
    const binding = lxdOfficeGuestPlan(authority.binding).binding;
    if (binding.allocationId !== allocationId) throw new Error("LXD_OFFICE_HISTORY_UNCONFIRMED");
    const denied = async () => {
      throw new Error("LXD_OFFICE_HISTORY_READ_ONLY");
    };
    const journal2 = new _LxdOfficeOperationJournal(root, authority.intentId, binding, {
      submitInstanceOperation: denied,
      inspectInstanceOperation: inspect ?? denied
    });
    return journal2;
  }
  async history() {
    const { events, previousSha256 } = await this.#read();
    const { binding, intentId } = this.#authority;
    return {
      schema: "qorpera.lxd-office-operation-history/v1",
      companyId: binding.companyId,
      environmentId: binding.environmentId,
      companyComputerId: binding.companyComputerId,
      logicalComputerId: binding.logicalComputerId,
      computerGeneration: binding.computerGeneration,
      allocationId: binding.allocationId,
      providerId: binding.providerId,
      providerPolicySha256: binding.providerPolicySha256,
      imageFingerprint: binding.imageFingerprint,
      bootstrapSha256: binding.bootstrapSha256,
      intentId,
      journalHeadSha256: previousSha256,
      source: "local_provider_operation_journal",
      runtimeBundleId: null,
      runtimeBundleSource: "not_recorded_in_vm_operation_journal",
      events: events.map((event) => ({
        sequence: event.sequence,
        commandId: event.commandId,
        action: event.action,
        kind: event.kind,
        operationId: event.operationId,
        state: event.state,
        recordedAt: event.schema !== "qorpera.lxd-office-operation-event/v1" ? event.recordedAt : null,
        ...event.kind === "administrative_disposition" ? {
          auditId: event.auditId,
          resetId: event.resetId,
          nextCreateCommandId: event.nextCreateCommandId,
          dispositionSha256: event.dispositionSha256,
          sqlReceiptSha256: event.sqlReceiptSha256,
          phaseEvidenceSha256: event.phaseEvidenceSha256
        } : {},
        timeSource: event.schema === "qorpera.lxd-office-operation-event/v1" ? "not_recorded" : event.recordedAt === null ? "clock_unavailable" : "provider_journal_clock",
        reason: event.kind === "administrative_disposition" ? "ADMINISTRATIVE_DISPOSITION_ORIGINAL_OUTCOME_UNKNOWN" : event.kind === "dispatch" ? "DISPATCH_RECORDED" : event.kind === "accepted" ? "PROVIDER_OPERATION_ACCEPTED" : event.state === "failed" ? "PROVIDER_OPERATION_FAILED" : "PROVIDER_OPERATION_SUCCEEDED",
        physicalTransitionAt: null
      })),
      serviceReadinessInferred: false,
      resourceReleaseInferred: false
    };
  }
  /** Root-verified historical incidents, with the complete administrative
   * phase chain. This conveys provenance, never a current effect grant. */
  async administrativeDispositions() {
    return [...(await this.#dispositions(await this.#read())).values()];
  }
  async #read() {
    try {
      await checkDirectory(this.#root);
      const authority = await readRecord((0, import_node_path5.join)(this.#root, "authority.json"));
      if (!(0, import_node_util3.isDeepStrictEqual)(authority.value, this.#authority)) throw new Error("binding changed");
      const names = (await (0, import_promises3.readdir)(this.#root)).filter((name) => name !== "authority.json" && !/^\.write-[0-9a-f-]{36}$/.test(name)).sort();
      if (names.length > MAX_EVENTS) throw new Error("journal full");
      let previousSha256 = sha256(authority.bytes);
      const events = [];
      const commands = /* @__PURE__ */ new Set();
      const operations = /* @__PURE__ */ new Set();
      for (const [index, name] of names.entries()) {
        if (name !== `${String(index).padStart(6, "0")}.json`) throw new Error("journal sequence missing");
        const { value, bytes } = await readRecord((0, import_node_path5.join)(this.#root, name));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid event");
        const event = value;
        if (event.schema !== "qorpera.lxd-office-operation-event/v1" && event.schema !== "qorpera.lxd-office-operation-event/v2" && event.schema !== "qorpera.lxd-office-operation-event/v3" || Object.keys(event).sort().join() !== (event.schema === "qorpera.lxd-office-operation-event/v1" ? "action,commandId,kind,operationId,previousSha256,schema,sequence,state" : event.schema === "qorpera.lxd-office-operation-event/v2" ? "action,commandId,kind,operationId,previousSha256,recordedAt,schema,sequence,state" : "action,auditId,commandId,dispositionSha256,kind,nextCreateCommandId,operationId,phaseEvidenceSha256,previousSha256,recordedAt,resetId,schema,sequence,sqlReceiptSha256,state") || event.schema === "qorpera.lxd-office-operation-event/v2" && event.recordedAt !== null && !timestamp(event.recordedAt) || event.sequence !== index || event.previousSha256 !== previousSha256 || typeof event.commandId !== "string" || !UUID9.test(event.commandId) || !["create", "start", "stop", "delete"].includes(event.action))
          throw new Error("invalid event identity");
        if (event.kind === "administrative_disposition" !== (event.schema === "qorpera.lxd-office-operation-event/v3"))
          throw new Error("invalid administrative schema");
        if (event.schema === "qorpera.lxd-office-operation-event/v3" && (event.kind !== "administrative_disposition" || event.state !== "unknown" || event.action !== "delete" || index < 11 || index % 3 !== 2 || !timestamp(event.recordedAt) || ![event.auditId, event.resetId, event.nextCreateCommandId].every(
          (id3) => typeof id3 === "string" && UUID9.test(id3)
        ) || ![event.dispositionSha256, event.sqlReceiptSha256, event.phaseEvidenceSha256].every(
          (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
        )))
          throw new Error("invalid administrative marker");
        const previous = events.at(-1);
        if (event.kind === "dispatch") {
          if (previous && previous.kind !== "settled" && !(previous.kind === "administrative_disposition" && event.action === "create" && event.commandId === previous.nextCreateCommandId) || commands.has(event.commandId) || event.operationId !== null || event.state !== null)
            throw new Error("conflicting dispatch");
          commands.add(event.commandId);
        } else {
          if (!previous || event.commandId !== previous.commandId || event.action !== previous.action || typeof event.operationId !== "string" || !UUID9.test(event.operationId))
            throw new Error("unbound operation");
          if (event.kind === "accepted") {
            if (previous.kind !== "dispatch" || operations.has(event.operationId) || event.state !== null)
              throw new Error("conflicting acceptance");
            operations.add(event.operationId);
          } else if (event.kind === "administrative_disposition") {
            if (previous.kind !== "accepted" || previous.operationId !== event.operationId || commands.has(event.nextCreateCommandId) || event.nextCreateCommandId === event.commandId)
              throw new Error("unbound administrative marker");
          } else if (event.kind === "settled") {
            if (previous.kind !== "accepted" || event.operationId !== previous.operationId || event.state !== "succeeded" && event.state !== "failed")
              throw new Error("unconfirmed settlement");
          } else throw new Error("invalid event kind");
        }
        events.push(event);
        previousSha256 = sha256(bytes);
      }
      return { events, previousSha256, authoritySha256: sha256(authority.bytes) };
    } catch {
      throw new Error("LXD_OFFICE_JOURNAL_UNCONFIRMED");
    }
  }
  #completion(event, authoritySha256, contexts) {
    return lxdOfficeVmCompletion(
      event,
      event?.kind === "administrative_disposition" ? contexts.get(event.auditId) : void 0,
      { authoritySha256, ...this.#authority }
    );
  }
  async #dispositions(current) {
    const contexts = /* @__PURE__ */ new Map();
    for (const event of current.events) {
      if (event.kind !== "administrative_disposition") continue;
      const context = await readLxdOfficeDeleteDisposition(this.#authority.binding.allocationId, event.auditId);
      contexts.set(event.auditId, context);
      this.#completion(event, current.authoritySha256, contexts);
      const stopped = current.events[event.sequence - 3];
      if (stopped?.kind !== "settled" || stopped.state !== "succeeded" || stopped.action !== "stop" || stopped.commandId !== context.plan.commands.stopCommandId)
        throw new Error("OFFICE_DELETE_DISPOSITION_STOP_DIFFERS");
      await assertLxdOfficeDeleteDispositionPhases(
        context,
        async (name) => (await readRecord((0, import_node_path5.join)((0, import_node_path5.dirname)(this.#root), name))).value,
        true
      );
    }
    return contexts;
  }
  /** Metadata only: preserve the original accepted tail and append its
   * distinct administrative boundary. The caller holds the operation lock;
   * this method cannot invoke a client operation or advance SQL/reset phases. */
  async #recordAdministrativeDisposition(context) {
    assertLxdOfficeDeleteDispositionContext(context);
    const verified2 = await readLxdOfficeDeleteDisposition(
      this.#authority.binding.allocationId,
      context.document.auditId
    );
    if (!(0, import_node_util3.isDeepStrictEqual)(context, verified2)) throw new Error("OFFICE_DELETE_DISPOSITION_RECEIPT_CHANGED");
    const current = await this.#read();
    const last = current.events.at(-1);
    if (last?.kind === "administrative_disposition") {
      lxdOfficeVmCompletion(last, verified2, { authoritySha256: current.authoritySha256, ...this.#authority });
      await assertLxdOfficeDeleteDispositionPhases(
        verified2,
        async (name) => (await readRecord((0, import_node_path5.join)((0, import_node_path5.dirname)(this.#root), name))).value,
        false
      );
      return;
    }
    if (last?.kind !== "accepted" || last.action !== "delete" || current.events.length !== verified2.document.journal.eventCount || current.events.length > MAX_EVENTS - 7)
      throw new Error("OFFICE_DELETE_DISPOSITION_TAIL_DIFFERS");
    const marker = {
      schema: "qorpera.lxd-office-operation-event/v3",
      sequence: current.events.length,
      previousSha256: current.previousSha256,
      commandId: last.commandId,
      action: "delete",
      kind: "administrative_disposition",
      operationId: last.operationId,
      state: "unknown",
      recordedAt: this.#now().toISOString(),
      auditId: verified2.document.auditId,
      resetId: verified2.plan.resetId,
      nextCreateCommandId: verified2.plan.commands.createCommandId,
      dispositionSha256: verified2.dispositionSha256,
      sqlReceiptSha256: verified2.sqlReceiptSha256,
      phaseEvidenceSha256: verified2.phaseEvidenceSha256
    };
    if (!timestamp(marker.recordedAt)) throw new Error("OFFICE_DELETE_DISPOSITION_CLOCK_UNCONFIRMED");
    lxdOfficeVmCompletion(marker, verified2, { authoritySha256: current.authoritySha256, ...this.#authority });
    const contexts = await this.#dispositions(current);
    const commands = current.events.filter((event) => event.kind === "dispatch").map(({ commandId, action }) => ({ commandId, action }));
    assertLxdOfficeVmLineageCommands(commands);
    for (let i = 2; i < current.events.length - 2; i += 3) {
      if (!this.#completion(current.events[i], current.authoritySha256, contexts))
        throw new Error("OFFICE_DELETE_DISPOSITION_PREFIX_UNCONFIRMED");
    }
    const stopped = current.events[current.events.length - 3];
    if (stopped?.kind !== "settled" || stopped.state !== "succeeded" || stopped.action !== "stop" || stopped.commandId !== verified2.plan.commands.stopCommandId)
      throw new Error("OFFICE_DELETE_DISPOSITION_STOP_DIFFERS");
    await assertLxdOfficeDeleteDispositionPhases(
      verified2,
      async (name) => (await readRecord((0, import_node_path5.join)((0, import_node_path5.dirname)(this.#root), name))).value,
      false
    );
    await publish(this.#root, `${String(marker.sequence).padStart(6, "0")}.json`, encode(marker));
    const retained = (await this.#read()).events.at(-1);
    if (!(0, import_node_util3.isDeepStrictEqual)(retained, marker)) throw new Error("OFFICE_DELETE_DISPOSITION_JOURNAL_RACE");
  }
  async #append(events, previousSha256, entry) {
    if (events.length >= MAX_EVENTS) throw new Error("LXD_OFFICE_JOURNAL_FULL");
    let recordedAt = null;
    try {
      const value = this.#now().toISOString();
      if (timestamp(value)) recordedAt = value;
    } catch {
    }
    return publish(
      this.#root,
      `${String(events.length).padStart(6, "0")}.json`,
      encode({
        schema: "qorpera.lxd-office-operation-event/v2",
        recordedAt,
        sequence: events.length,
        previousSha256,
        ...entry
      })
    );
  }
  /** One bounded reconciliation: submit at most once, then inspect at most
   * once. Call again with the SAME command ID to resume after a process crash.
   * The caller separately checks physical postconditions and admission fences. */
  async reconcile(commandId, action, signal) {
    if (typeof commandId !== "string" || !UUID9.test(commandId) || !["create", "start", "stop", "delete"].includes(action))
      throw new Error("INVALID_LXD_OFFICE_COMMAND");
    signal.throwIfAborted();
    let current = await this.#read();
    let command2 = lastCommand(current.events, commandId);
    if (command2 && command2.action !== action) throw new Error("LXD_OFFICE_COMMAND_CONFLICT");
    if (!command2) {
      await this.#dispositions(current);
      const tail = current.events.at(-1);
      if (tail && tail.kind !== "settled" && !(tail.kind === "administrative_disposition" && action === "create" && commandId === tail.nextCreateCommandId))
        throw new Error("LXD_OFFICE_OPERATION_UNSETTLED");
      if (current.events.length > MAX_EVENTS - 3) throw new Error("LXD_OFFICE_JOURNAL_FULL");
      signal.throwIfAborted();
      const claimed = await this.#append(current.events, current.previousSha256, {
        commandId,
        action,
        kind: "dispatch",
        operationId: null,
        state: null
      });
      if (!claimed) return this.#observe(commandId, action, signal);
      const { binding, request } = lxdOfficeGuestPlan(this.#authority.binding);
      let operationId;
      try {
        signal.throwIfAborted();
        const reference = await this.#client.submitInstanceOperation(
          binding.project,
          action === "create" ? { action, request } : { action, name: request.name },
          signal
        );
        if (reference.project !== binding.project || reference.instanceName !== request.name || !UUID9.test(reference.operationId))
          throw new Error("unbound submission");
        operationId = reference.operationId;
      } catch {
        return { state: "unknown" };
      }
      current = await this.#read();
      command2 = current.events.at(-1);
      if (command2?.kind !== "dispatch" || command2.commandId !== commandId)
        throw new Error("LXD_OFFICE_COMMAND_CONFLICT");
      await this.#append(current.events, current.previousSha256, {
        commandId,
        action,
        kind: "accepted",
        operationId,
        state: null
      });
    }
    return this.#observe(commandId, action, signal);
  }
  /** Inspect an existing command without ever dispatching a missing command.
   * Settlement records may be persisted; no provider mutation is performed. */
  async observe(commandId, action, signal) {
    if (typeof commandId !== "string" || !UUID9.test(commandId) || !["create", "start", "stop", "delete"].includes(action))
      throw new Error("INVALID_LXD_OFFICE_COMMAND");
    signal.throwIfAborted();
    const current = await this.#read();
    const command2 = lastCommand(current.events, commandId);
    if (!command2) return { state: "not_dispatched" };
    return this.#observe(commandId, action, signal);
  }
  /** Initial storage review cannot use a historical create after any start,
   * stop or delete was dispatched, including an operation with unknown outcome.
   * This journal read is evidence only; it does not acquire a lifecycle lock. */
  async assertInitialCreation(commandId, signal) {
    signal.throwIfAborted();
    const { events } = await this.#read();
    const last = events.at(-1);
    if (!last || last.kind !== "settled" || last.state !== "succeeded" || events.some((event) => event.commandId !== commandId || event.action !== "create"))
      throw new Error("OFFICE_INITIAL_CREATION_UNCONFIRMED");
    signal.throwIfAborted();
  }
  /** Restricted first boot may follow only the successful initial create and
   * its one retained start command. A later stop/delete/start, including an
   * unknown dispatch, prevents historical evidence from authorizing a boot. */
  async assertInitialBootSequence(createCommandId, startCommandId, signal) {
    signal.throwIfAborted();
    const { events } = await this.#read();
    if (!UUID9.test(createCommandId) || !UUID9.test(startCommandId) || createCommandId === startCommandId || events.length < 3 || events.length > 6 || events.slice(0, 3).some((event) => event.commandId !== createCommandId || event.action !== "create") || events[2].kind !== "settled" || events[2].state !== "succeeded" || events.slice(3).some((event) => event.commandId !== startCommandId || event.action !== "start"))
      throw new Error("OFFICE_INITIAL_BOOT_SEQUENCE_UNCONFIRMED");
    signal.throwIfAborted();
  }
  /** First VM shutdown follows the completed initial create/boot and exactly
   * one retained stop command. Service restarts do not mutate this journal.
   * A later start/delete/stop or a lost command identity cannot reuse it. */
  async assertPowerOffSequence(createCommandId, startCommandId, stopCommandId, signal) {
    signal.throwIfAborted();
    const { events } = await this.#read();
    const ids = [createCommandId, startCommandId, stopCommandId];
    if (ids.some((id3) => !UUID9.test(id3)) || new Set(ids).size !== 3 || events.length < 6 || events.length > 9 || events.slice(0, 3).some((event) => event.commandId !== createCommandId || event.action !== "create") || events[2].kind !== "settled" || events[2].state !== "succeeded" || events.slice(3, 6).some((event) => event.commandId !== startCommandId || event.action !== "start") || events[5].kind !== "settled" || events[5].state !== "succeeded" || events.slice(6).some((event) => event.commandId !== stopCommandId || event.action !== "stop"))
      throw new Error("OFFICE_POWER_OFF_SEQUENCE_UNCONFIRMED");
    signal.throwIfAborted();
  }
  /** Retained create/start/stop lineage. All predecessors must have succeeded;
   * only the final command may be absent or unresolved. Callers supply exact
   * identities from their protected history, never infer them from VM state. */
  async assertLifecycleSequence(commands, signal) {
    signal.throwIfAborted();
    const { events } = await this.#read();
    if (commands.length < 2 || commands.length > MAX_EVENTS / 3 || new Set(commands.map((command2) => command2.commandId)).size !== commands.length || commands.some(
      (command2, index) => !UUID9.test(command2.commandId) || command2.action !== (index === 0 ? "create" : index % 2 ? "start" : "stop")
    ) || events.length < (commands.length - 1) * 3 || events.length > commands.length * 3)
      throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
    for (const [index, command2] of commands.entries()) {
      if (events.slice(index * 3, index * 3 + 3).some((event) => event.commandId !== command2.commandId || event.action !== command2.action))
        throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
      if (index < commands.length - 1 && (events[index * 3 + 2]?.kind !== "settled" || events[index * 3 + 2]?.state !== "succeeded"))
        throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
    }
    signal.throwIfAborted();
  }
  /** Complete current lineage, with explicit recreated-root groups supplied
   * by immutable reset history. Legacy chains keep their original validator. */
  async assertRetainedLifecycleSequence(commands, signal) {
    assertLxdOfficeVmLineageCommands(commands);
    if (!commands.some((command2) => command2.action === "delete"))
      return this.assertLifecycleSequence(
        commands,
        signal
      );
    signal.throwIfAborted();
    const current = await this.#read(), { events } = current;
    const contexts = await this.#dispositions(current);
    if (events.length < (commands.length - 1) * 3 || events.length > commands.length * 3)
      throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
    for (const [index, command2] of commands.entries()) {
      const group = events.slice(index * 3, index * 3 + 3);
      if (group.some((event) => event.commandId !== command2.commandId || event.action !== command2.action) || index < commands.length - 1 && !this.#completion(group[2], current.authoritySha256, contexts))
        throw new Error("OFFICE_VM_LINEAGE_UNCONFIRMED");
    }
    signal.throwIfAborted();
  }
  /** Governed root reset lineage: the retained create/start/stop chain, then
   * exactly stop -> delete -> create -> start with the planned command IDs.
   * Every predecessor must have succeeded; only the final present command may
   * be unresolved. Original create/boot/power-off validators are unchanged,
   * so historical prefixes cannot be relabelled as a reset. */
  async assertResetLineage(prior, reset, signal) {
    signal.throwIfAborted();
    const current = await this.#read(), { events } = current;
    const contexts = await this.#dispositions(current);
    const suffix = [
      { commandId: reset.stopCommandId, action: "stop" },
      { commandId: reset.deleteCommandId, action: "delete" },
      { commandId: reset.createCommandId, action: "create" },
      { commandId: reset.startCommandId, action: "start" }
    ];
    try {
      assertLxdOfficeVmLineageCommands(prior, true);
    } catch {
      throw new Error("OFFICE_RESET_LINEAGE_UNCONFIRMED");
    }
    const commands = [...prior, ...suffix];
    if (prior.length < 2 || commands.some((command2) => !UUID9.test(command2.commandId)) || new Set(commands.map((command2) => command2.commandId)).size !== commands.length || commands.length > MAX_EVENTS / 3 || events.length < prior.length * 3 || events.length > commands.length * 3)
      throw new Error("OFFICE_RESET_LINEAGE_UNCONFIRMED");
    const groups = Math.ceil(events.length / 3);
    for (let index = 0; index < groups; index++) {
      const command2 = commands[index], group = events.slice(index * 3, index * 3 + 3);
      if (!command2 || group.some((event) => event.commandId !== command2.commandId || event.action !== command2.action))
        throw new Error("OFFICE_RESET_LINEAGE_UNCONFIRMED");
      if (index < groups - 1 && !this.#completion(group[2], current.authoritySha256, contexts))
        throw new Error("OFFICE_RESET_LINEAGE_UNCONFIRMED");
    }
    signal.throwIfAborted();
    const reachedIndex = groups - prior.length, last = events.at(-1);
    return {
      reached: reachedIndex <= 0 ? "none" : suffix[reachedIndex - 1].action,
      settled: reachedIndex > 0 && last?.kind === "settled" && last.state === "succeeded",
      ...reachedIndex > 0 && last?.kind === "administrative_disposition" && this.#completion(last, current.authoritySha256, contexts) === "administratively_disposed" ? { administrativelyDisposed: true } : {}
    };
  }
  async #observe(commandId, action, signal) {
    const current = await this.#read();
    const command2 = lastCommand(current.events, commandId);
    if (!command2 || command2.action !== action) throw new Error("LXD_OFFICE_COMMAND_CONFLICT");
    if (command2.kind === "settled")
      return { state: command2.state, operationId: command2.operationId };
    if (command2.kind === "dispatch") return { state: "unknown" };
    if (command2.kind === "administrative_disposition") return { state: "unknown", operationId: command2.operationId };
    const { binding, request } = lxdOfficeGuestPlan(this.#authority.binding);
    const operationId = command2.operationId;
    let state;
    try {
      signal.throwIfAborted();
      state = await this.#client.inspectInstanceOperation(
        { project: binding.project, instanceName: request.name, operationId },
        signal
      );
      if (!["pending", "succeeded", "failed"].includes(state)) throw new Error("invalid observation");
    } catch {
      return { state: "unknown", operationId };
    }
    if (state === "pending") return { state, operationId };
    const appended = await this.#append(current.events, current.previousSha256, {
      commandId,
      action,
      kind: "settled",
      operationId,
      state
    });
    if (!appended) {
      const latest = await this.#read();
      const settled = lastCommand(latest.events, commandId);
      if (settled?.kind !== "settled" || settled.state !== state || settled.operationId !== operationId)
        throw new Error("LXD_OFFICE_OPERATION_CONFLICT");
    }
    return { state, operationId };
  }
};

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-reset-journal.ts
var import_node_path6 = require("node:path");
var import_node_util4 = require("node:util");
var LIMIT2 = 65536;
var LxdOfficeResetJournal = class _LxdOfficeResetJournal {
  #prefix;
  #records;
  constructor(root, plan, records) {
    this.root = root;
    this.plan = plan;
    this.#prefix = `reset-phase-${plan.predecessor.startup.allocationId}-${plan.resetId}-`;
    this.#records = records;
  }
  static async open(root, value) {
    const plan = parseCompanyComputerResetPlan(value);
    await checkDirectory(root);
    const prefix = `reset-phase-${plan.predecessor.startup.allocationId}-${plan.resetId}-`;
    const records = [];
    let gap = false;
    for (const [index, phase] of COMPANY_COMPUTER_RESET_PHASES.entries()) {
      let value2;
      try {
        value2 = (await readRecord((0, import_node_path6.join)(root, `${prefix}${index + 1}.json`), LIMIT2)).value;
      } catch (error) {
        if (!code(error, "ENOENT")) throw error;
        gap = true;
        continue;
      }
      if (gap) throw new Error("OFFICE_RESET_JOURNAL_GAP");
      const record5 = parseCompanyComputerResetPhaseRecord(value2, plan), previous = records.at(-1);
      if (record5.phase !== phase || record5.previousSha256 !== (previous ? officeDigest(previous) : null) || !(0, import_node_util4.isDeepStrictEqual)(value2, record5))
        throw new Error("OFFICE_RESET_JOURNAL_CHANGED");
      records.push(record5);
    }
    await syncDirectory(root);
    return new _LxdOfficeResetJournal(root, plan, records);
  }
  /** The last locally acknowledged phase, or null before begin was recorded. */
  get phase() {
    return this.#records.at(-1)?.phase ?? null;
  }
  get records() {
    return this.#records.map((record5) => structuredClone(record5));
  }
  evidenceSha256(phase) {
    return this.#records.find((record5) => record5.phase === phase)?.evidenceSha256;
  }
  /** Append the next phase only. A repeated identical advance is idempotent;
   * any skipped, earlier or changed phase is refused. */
  async advance(phase, evidenceSha256) {
    const index = COMPANY_COMPUTER_RESET_PHASES.indexOf(phase);
    if (index < 0) throw new Error("OFFICE_RESET_JOURNAL_PHASE_INVALID");
    const existing = this.#records[index];
    if (existing) {
      if (existing.evidenceSha256 !== officeSha(evidenceSha256) || this.#records.length !== index + 1)
        throw new Error("OFFICE_RESET_JOURNAL_CHANGED");
      return structuredClone(existing);
    }
    if (this.#records.length !== index) throw new Error("OFFICE_RESET_JOURNAL_ORDER");
    const previous = this.#records.at(-1);
    const next = parseCompanyComputerResetPhaseRecord(
      {
        schema: "qorpera.office-reset-phase/v1",
        resetId: this.plan.resetId,
        phase,
        sequence: index + 1,
        previousSha256: previous ? officeDigest(previous) : null,
        evidenceSha256: officeSha(evidenceSha256)
      },
      this.plan
    );
    const name = `${this.#prefix}${index + 1}.json`;
    await publish(this.root, name, Buffer.from(officeCanonical(next)));
    if (!(0, import_node_util4.isDeepStrictEqual)((await readRecord((0, import_node_path6.join)(this.root, name), LIMIT2)).value, next))
      throw new Error("OFFICE_RESET_JOURNAL_RACE");
    this.#records = [...this.#records, next];
    return structuredClone(next);
  }
};

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-delete-metadata-command.ts
var import_node_fs3 = require("node:fs");
var import_promises5 = require("node:fs/promises");
var import_node_path9 = require("node:path");
var import_node_util5 = require("node:util");

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-delete-reconciliation.ts
var import_node_path7 = require("node:path");
async function reconcileLxdOfficeDeleteMetadata(root, context, assertPublicationBoundary) {
  assertLxdOfficeDeleteDispositionContext(context);
  await assertPublicationBoundary();
  const allocationId = context.plan.predecessor.startup.allocationId;
  const before = await LxdOfficeOperationJournal.readHistory(root, allocationId);
  const phases = await LxdOfficeResetJournal.open(root, context.plan);
  if (phases.phase !== "powered_off" && phases.phase !== "root_deleted")
    throw new Error("OFFICE_DELETE_RECONCILIATION_PHASE_DIFFERS");
  await assertLxdOfficeDeleteDispositionPhases(
    context,
    async (name) => (await readRecord((0, import_node_path7.join)(root, name))).value,
    phases.phase === "root_deleted"
  );
  const count = context.document.journal.eventCount;
  const tail = before.events.at(-1);
  if (before.events.length !== count && before.events.length !== count + 1 || tail?.commandId !== context.document.deleteCommandId || tail.operationId !== context.document.operationId || tail.action !== "delete" || before.events.length === count && (tail.kind !== "accepted" || phases.phase !== "powered_off") || before.events.length === count + 1 && tail.kind !== "administrative_disposition")
    throw new Error("OFFICE_DELETE_RECONCILIATION_TAIL_DIFFERS");
  await assertPublicationBoundary();
  await LxdOfficeOperationJournal.recordAdministrativeDisposition(root, allocationId, context);
  await assertPublicationBoundary();
  await phases.advance("root_deleted", context.phaseEvidenceSha256);
  await assertPublicationBoundary();
  await assertLxdOfficeDeleteDispositionPhases(
    context,
    async (name) => (await readRecord((0, import_node_path7.join)(root, name))).value,
    true
  );
  await LxdOfficeOperationJournal.recordAdministrativeDisposition(root, allocationId, context);
  const after = await LxdOfficeOperationJournal.readHistory(root, allocationId);
  if (after.events.length !== count + 1 || after.events.at(-1)?.state !== "unknown")
    throw new Error("OFFICE_DELETE_RECONCILIATION_READBACK_DIFFERS");
  await assertPublicationBoundary();
  return {
    schema: "qorpera.lxd-office-delete-metadata-reconciliation/v1",
    auditId: context.document.auditId,
    resetId: context.plan.resetId,
    allocationId,
    dispositionSha256: context.dispositionSha256,
    sqlReceiptSha256: context.sqlReceiptSha256,
    phaseEvidenceSha256: context.phaseEvidenceSha256,
    journalHeadSha256: after.journalHeadSha256,
    originalOutcome: "unknown",
    cleanResetAcceptance: false,
    vmOperationRequested: false,
    metadataComplete: true
  };
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-code-package-loader.ts
var OFFICE_CODE_PACKAGE_LOADER = String.raw`(function run() {
  const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
  const { spawnSync } = require('node:child_process'), Module = require('node:module');
  try {
    if (process.platform !== 'linux' || process.getuid() !== 0 || process.getgid() !== 0 || process.geteuid() !== 0)
      throw Error('root');
    const [purpose, id, sha, count, ...rest] = process.argv.slice(1);
    if (!['bootstrap','measure'].includes(purpose) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha) || !/^[1-9][0-9]{0,7}$/.test(count)) throw Error('arguments');
    const size = Number(count); if (size > 16*1024*1024) throw Error('size');
    const root='/run/qorpera-office-preparation', stage=root+'/code-package-'+id;
    const tool=stage+'/'+purpose+'.cjs';
    const keys=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
    const same=(a,b)=>keys.every(k=>a[k]===b[k]);
    function local(fd) {
      const ids=[...fs.readFileSync('/proc/self/fdinfo/'+fd,'utf8').matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
      const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(l=>l.split(' ',1)[0]===ids[0]?.[1]);
      if(ids.length!==1 || mounts.length!==1 || !['ext4','xfs','btrfs','zfs','overlay','tmpfs'].includes(mounts[0].split(' - ')[1]?.split(' ')[0])) throw Error('nonlocal');
    }
    function parents(p) {
      for (let q=p;;q=path.dirname(q)) {
        const s=fs.lstatSync(q);
        if (!s.isDirectory() || s.uid!==0 || s.gid!==0 || (s.mode&0o6022)!==0 || fs.realpathSync(q)!==q) throw Error('parent');
        if ((q===root || q===stage) && (s.mode&0o7777)!==0o700) throw Error('private');
        if (q==='/') break;
      }
    }
    parents(stage);
    const fd=fs.openSync(tool,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    let bytes;
    try {
      local(fd);
      const a=fs.fstatSync(fd,{bigint:true});
      if (!a.isFile() || a.uid!==0n || a.gid!==0n || a.nlink!==1n || (a.mode&0o7777n)!==0o400n || a.size!==BigInt(size)) throw Error('tool');
      bytes=Buffer.alloc(size+1); let n=0;
      while(n<bytes.length){const r=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!r)break;n+=r;}
      if(n!==size || !same(a,fs.fstatSync(fd,{bigint:true})) || !same(a,fs.lstatSync(tool,{bigint:true})) || crypto.createHash('sha256').update(bytes.subarray(0,n)).digest('hex')!==sha) throw Error('pin');
      bytes=bytes.subarray(0,n); parents(stage);
    } finally {fs.closeSync(fd);}
    if(rest[0]!=='--locked') {
      const lockPath=root+'/control.lock';
      const lock=fs.openSync(lockPath,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      try {
        local(lock);
        const s=fs.fstatSync(lock,{bigint:true});
        if(!s.isFile() || s.uid!==0n || s.gid!==0n || s.nlink!==1n || s.size!==0n || (s.mode&0o7777n)!==0o600n || !same(s,fs.lstatSync(lockPath,{bigint:true}))) throw Error('lock');
        for(const exe of ['/usr/bin/node','/usr/bin/flock']) {
          parents(path.dirname(exe)); const x=fs.lstatSync(exe);
          if(!x.isFile() || x.uid!==0 || x.gid!==0 || x.nlink!==1 || (x.mode&0o6022)!==0 || fs.realpathSync(exe)!==exe) throw Error('executable');
        }
        const child=spawnSync('/usr/bin/flock',['--exclusive','--nonblock','--no-fork','/proc/self/fd/3','/usr/bin/node','-e','('+run.toString()+')()',purpose,id,sha,count,'--locked',...rest],{cwd:'/',env:{},stdio:['ignore','inherit','inherit',lock],timeout:120000,killSignal:'SIGKILL'});
        if(child.error || child.status!==0) throw Error('child');
      } finally {fs.closeSync(lock);}
    } else {
      local(3);
      const held=fs.fstatSync(3,{bigint:true}), named=fs.lstatSync(root+'/control.lock',{bigint:true});
      if(!held.isFile() || held.uid!==0n || held.gid!==0n || held.nlink!==1n || held.size!==0n || (held.mode&0o7777n)!==0o600n || !same(held,named)) throw Error('inherited lock');
      const major=((held.dev>>8n)&0xfffn)|((held.dev>>32n)&0xfffff000n), minor=(held.dev&0xffn)|((held.dev>>12n)&0xffffff00n);
      const locks=fs.readFileSync('/proc/locks','utf8').split('\n').filter(line=>{
        const m=/^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/.exec(line);
        return m && Number(m[1])===process.pid && BigInt('0x'+m[2])===major && BigInt('0x'+m[3])===minor && BigInt(m[4])===held.ino;
      });
      if(locks.length!==1) throw Error('kernel flock');
      const compiled=new Module(tool); compiled.filename=tool; compiled.paths=[];
      compiled._compile(new TextDecoder('utf8',{fatal:true}).decode(bytes),tool);
      if(typeof compiled.exports.runOfficeCodePackageTool!=='function') throw Error('entry');
      Promise.resolve(compiled.exports.runOfficeCodePackageTool(purpose,id,rest.slice(1))).catch(()=>{process.stderr.write('OFFICE_CODE_PACKAGE_UNCONFIRMED\n');process.exitCode=1;});
    }
  } catch (_) {process.stderr.write('OFFICE_CODE_PACKAGE_LOADER_UNCONFIRMED\n');process.exitCode=1;}
})();`;

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-client.ts
var MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
var MAX_INSTANCE_FILE_BYTES = 256 * 1024;
var RESET_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var OFFICE_RESET_READ_PATHS = Object.freeze([
  { pattern: /^\/var\/lib\/qorpera-office-events$/, maximum: 0, directory: true },
  {
    pattern: new RegExp(`^/var/lib/qorpera-office-events/(?:scope\\.json|${RESET_UUID}-[0-9]{16}\\.json)$`),
    maximum: 73729,
    directory: false
  },
  { pattern: new RegExp(`^/etc/qorpera-office/history/${RESET_UUID}/${RESET_UUID}$`), maximum: 0, directory: true },
  {
    pattern: new RegExp(
      `^/etc/qorpera-office/history/${RESET_UUID}/${RESET_UUID}/(?:manifest|claim|[0-9a-f]{64})\\.json$`
    ),
    maximum: 65536,
    directory: false
  },
  { pattern: /^\/etc\/qorpera-office\/adoption\.json$/, maximum: 65536, directory: false },
  { pattern: /^\/etc\/qorpera-office\/credentials\/config\.json$/, maximum: 16384, directory: false },
  {
    pattern: /^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/(?:adoption|configuration-claim|configuration-completion|reset-configuration-claim|reset-configuration-completion)\.json$/,
    maximum: 65536,
    directory: false
  },
  {
    pattern: /^\/etc\/qorpera-office\/boots\/[0-9a-f]{32}\/credentials\/config\.json$/,
    maximum: 16384,
    directory: false
  }
]);
var OFFICE_RESET_WRITE_PATHS = Object.freeze(
  [
    { pattern: /^\/var\/lib\/qorpera-office-events$/, maximum: 0, directory: true },
    {
      pattern: new RegExp(`^/var/lib/qorpera-office-events/(?:scope\\.json|${RESET_UUID}-[0-9]{16}\\.json)$`),
      maximum: 73729,
      directory: false
    },
    { pattern: /^\/etc\/qorpera-office\/history$/, maximum: 0, directory: true },
    { pattern: new RegExp(`^/etc/qorpera-office/history/${RESET_UUID}$`), maximum: 0, directory: true },
    { pattern: new RegExp(`^/etc/qorpera-office/history/${RESET_UUID}/${RESET_UUID}$`), maximum: 0, directory: true },
    {
      pattern: new RegExp(
        `^/etc/qorpera-office/history/${RESET_UUID}/${RESET_UUID}/(?:manifest|claim|[0-9a-f]{64})\\.json$`
      ),
      maximum: 65536,
      directory: false
    },
    { pattern: /^\/etc\/qorpera-office\/adoption\.json$/, maximum: 65536, directory: false }
  ]
);
var OFFICE_SOFTWARE_STAGING_ROOT = "/run/qorpera-office-preparation";
var OFFICE_SOFTWARE_JOURNAL_ROOT = "/var/lib/qorpera-office-service-software";
var OFFICE_SOFTWARE_INSTALLED_SERVICE = "/opt/qorpera-office/qorpera-company-computer-service.mjs";
var SOFTWARE_SHA = "[0-9a-f]{64}";
var SOFTWARE_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var OFFICE_SOFTWARE_STAGED_FILES = Object.freeze([
  { pattern: /^software-control\.mjs$/, maximum: 16 * 1024 ** 2 },
  { pattern: /^software-measurement-control\.mjs$/, maximum: 16 * 1024 ** 2 },
  { pattern: new RegExp(`^software-incoming-${SOFTWARE_SHA}\\.json$`), maximum: 65536 },
  { pattern: new RegExp(`^software-measurement-incoming-${SOFTWARE_SHA}\\.json$`), maximum: 16384 },
  { pattern: new RegExp(`^software-trust-${SOFTWARE_SHA}\\.json$`), maximum: 4096 },
  { pattern: new RegExp(`^software-(?:previous|next)-manifest-${SOFTWARE_SHA}\\.json$`), maximum: 1024 ** 2 },
  { pattern: new RegExp(`^software-service-${SOFTWARE_SHA}\\.mjs$`), maximum: 32 * 1024 ** 2 },
  { pattern: new RegExp(`^software-capability-${SOFTWARE_UUID}$`), maximum: 64 }
]);
var OFFICE_SOFTWARE_READ_FILES = Object.freeze([
  { pattern: new RegExp(`^${OFFICE_SOFTWARE_INSTALLED_SERVICE.replaceAll(".", "\\.")}$`), maximum: 16 * 1024 ** 2 },
  { pattern: new RegExp(`^${OFFICE_SOFTWARE_JOURNAL_ROOT}/${SOFTWARE_UUID}/installed\\.json$`), maximum: 65536 },
  {
    pattern: new RegExp(`^${OFFICE_SOFTWARE_STAGING_ROOT}/software-measurement-${SOFTWARE_UUID}\\.json$`),
    maximum: 16384
  },
  {
    pattern: new RegExp(`^${OFFICE_SOFTWARE_STAGING_ROOT}/software-measurement-claim-${SOFTWARE_UUID}\\.json$`),
    maximum: 4096
  }
]);

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-storage-inventory.ts
var CHUNK = 256 * 1024;
var maxima = {
  maxEntries: 1e5,
  maxDepth: 64,
  maxFileBytes: 16 * 1024 ** 3,
  maxTotalBytes: 64 * 1024 ** 3,
  maxManifestBytes: 16 * 1024 ** 2
};
function parseOfficeInventoryLimits(value) {
  const record5 = officeRecord(value, Object.keys(maxima));
  for (const key of Object.keys(maxima)) {
    if (!Number.isSafeInteger(record5[key]) || record5[key] < 1 || record5[key] > maxima[key])
      throw new Error("INVALID_OFFICE_INVENTORY_LIMITS");
  }
  if (record5.maxFileBytes > record5.maxTotalBytes)
    throw new Error("INVALID_OFFICE_INVENTORY_LIMITS");
  return Object.freeze({ ...record5 });
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-adoption-files.ts
var CHUNK2 = 256 * 1024;

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-code-package-provision-verification.ts
var resets = new Set(COMPANY_COMPUTER_CODE_PACKAGE_RESET_ARTIFACTS);
var code2 = new Set(COMPANY_COMPUTER_CODE_PACKAGE_ARTIFACTS);

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-provider-registry.ts
var import_node_https = require("node:https");
var METHODS = /* @__PURE__ */ new Set([
  "qorpera_enroll_office_package_provision",
  "qorpera_check_office_package_provision",
  "qorpera_check_office_package_provision_observation",
  "qorpera_ack_office_package_provision",
  "qorpera_office_package_provision_status",
  "qorpera_check_office_package_invocation",
  "qorpera_ack_office_package_invocation",
  "qorpera_reserve_runtime_node_machine",
  "qorpera_runtime_office_provider_status",
  "qorpera_reserve_runtime_office_start",
  "qorpera_check_runtime_office_start",
  "qorpera_check_runtime_office_adoption",
  "qorpera_prepare_runtime_office_activation",
  "qorpera_runtime_office_activation_status",
  "qorpera_activate_runtime_office",
  "qorpera_begin_runtime_office_lifecycle",
  "qorpera_runtime_office_lifecycle_status",
  "qorpera_prepare_runtime_office_stop",
  "qorpera_ack_runtime_office_stop",
  "qorpera_runtime_office_stop_status",
  "qorpera_prepare_runtime_office_successor",
  "qorpera_runtime_office_successor_status",
  "qorpera_check_runtime_office_successor",
  "qorpera_activate_runtime_office_successor",
  "qorpera_prepare_runtime_office_boot_successor",
  "qorpera_runtime_office_boot_successor_status",
  "qorpera_check_runtime_office_boot_successor",
  "qorpera_activate_runtime_office_boot_successor",
  "qorpera_prepare_runtime_office_boot_intent",
  "qorpera_runtime_office_boot_intent_status",
  "qorpera_check_runtime_office_boot_intent",
  // Governed same-allocation root reset: begin/status, bounded per-phase
  // challenges and the reset successor handoff.
  "qorpera_begin_runtime_office_reset",
  "qorpera_runtime_office_reset_status",
  "qorpera_prepare_runtime_office_reset_phase",
  "qorpera_check_runtime_office_reset_phase",
  "qorpera_ack_runtime_office_reset_phase",
  "qorpera_prepare_runtime_office_reset_successor",
  "qorpera_runtime_office_reset_successor_status",
  "qorpera_check_runtime_office_reset_successor",
  "qorpera_activate_runtime_office_reset_successor",
  // Governed service-only software revisions; every call also carries the
  // separate provider capability, which SQL requires and never returns.
  "qorpera_enroll_office_software",
  "qorpera_begin_office_software",
  "qorpera_check_office_software_install",
  "qorpera_ack_office_software_install",
  "qorpera_office_software_status",
  "qorpera_check_office_software_invocation",
  "qorpera_ack_office_software_invocation"
]);
var LIMIT3 = 65536;
function nativeRpc(url, key, body, signal) {
  return new Promise((resolve4, reject) => {
    signal.throwIfAborted();
    const request = (0, import_node_https.request)(
      url,
      {
        method: "POST",
        signal,
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (response) => {
        response.once("error", reject);
        const fail = () => {
          response.destroy();
          request.destroy();
          reject(new Error("unconfirmed"));
        };
        const length = response.headers["content-length"];
        if (response.statusCode !== 200 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers["content-type"] ?? "") || length !== void 0 && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > LIMIT3)) {
          fail();
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > LIMIT3) {
            fail();
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          try {
            signal.throwIfAborted();
            if (!response.complete || length !== void 0 && Number(length) !== size) throw new Error();
            resolve4(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks))));
          } catch {
            fail();
          }
        });
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}
var LxdOfficeProviderHttpRegistry = class {
  #origin;
  #key;
  #fetch;
  #pending = false;
  constructor(registryUrl, serviceKey, fetchImplementation) {
    try {
      const url = new URL(registryUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || registryUrl !== url.origin || typeof serviceKey !== "string" || !/^[A-Za-z0-9_.-]{32,4096}$/.test(serviceKey))
        throw new Error();
      this.#origin = url.origin;
      this.#key = serviceKey;
      this.#fetch = fetchImplementation;
    } catch {
      throw new Error("INVALID_OFFICE_PROVIDER_REGISTRY");
    }
  }
  async call(method, args, caller) {
    caller.throwIfAborted();
    if (!METHODS.has(method)) throw new Error("OFFICE_PROVIDER_RPC_FORBIDDEN");
    if (this.#pending) throw new Error("OFFICE_PROVIDER_RPC_PENDING");
    let body;
    try {
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
      body = JSON.stringify(args);
      if (Buffer.byteLength(body) > LIMIT3) throw new Error();
    } catch {
      throw new Error("INVALID_OFFICE_PROVIDER_RPC");
    }
    const signal = AbortSignal.any([caller, AbortSignal.timeout(5e3)]);
    this.#pending = true;
    let abort = () => {
    };
    const stopped = new Promise((_, reject) => {
      abort = () => reject(new Error("OFFICE_PROVIDER_RPC_UNCONFIRMED"));
      signal.addEventListener("abort", abort, { once: true });
    });
    const operation = (async () => {
      signal.throwIfAborted();
      if (!this.#fetch) return nativeRpc(`${this.#origin}/rest/v1/rpc/${method}`, this.#key, body, signal);
      const response = await this.#fetch(`${this.#origin}/rest/v1/rpc/${method}`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          apikey: this.#key,
          authorization: `Bearer ${this.#key}`,
          "content-type": "application/json",
          accept: "application/json"
        },
        body
      });
      const reader = response.body?.getReader();
      try {
        signal.throwIfAborted();
        const length = response.headers.get("content-length");
        if (response.status !== 200 || response.redirected || !reader || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "") || length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > LIMIT3))
          throw new Error();
        const chunks = [];
        let size = 0;
        for (; ; ) {
          const { value, done } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > LIMIT3) throw new Error();
          chunks.push(value);
        }
        if (length !== null && Number(length) !== size) throw new Error();
        return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
      } finally {
        await reader?.cancel().catch(() => {
        });
        reader?.releaseLock();
      }
    })().catch(() => {
      throw new Error("OFFICE_PROVIDER_RPC_UNCONFIRMED");
    }).finally(() => {
      this.#pending = false;
    });
    try {
      return await Promise.race([operation, stopped]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
};

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-lifecycle-service.ts
function parseLxdOfficeLifecycleServiceConfig(value) {
  const keys2 = [
    "schema",
    "policyPath",
    "provenancePath",
    "planPath",
    "registryUrl",
    "registryCredential",
    "inventoryLimits",
    "pollIntervalMs"
  ];
  const optionalKeys = ["softwareLanePath", "resetImagePackageManifestPath", "codePackageLanePath"].filter(
    (key) => value && typeof value === "object" && Object.hasOwn(value, key)
  );
  const r = officeRecord(value, [...keys2, ...optionalKeys]);
  if (r.schema !== "qorpera.lxd-office-provider-service/v1" || typeof r.registryUrl !== "string")
    throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
  const credential = officeRecord(r.registryCredential, ["path", "bytes", "sha256"]);
  if (!Number.isSafeInteger(credential.bytes) || credential.bytes < 32 || credential.bytes > 4096 || !Number.isSafeInteger(r.pollIntervalMs) || r.pollIntervalMs < 1e3 || r.pollIntervalMs > 6e4)
    throw new Error("INVALID_OFFICE_SERVICE_CONFIG");
  new LxdOfficeProviderHttpRegistry(r.registryUrl, "validation-only-".repeat(3));
  return {
    policyPath: officePhysicalPath(r.policyPath),
    provenancePath: officePhysicalPath(r.provenancePath),
    planPath: officePhysicalPath(r.planPath),
    registryUrl: r.registryUrl,
    registryCredential: {
      path: officePhysicalPath(credential.path),
      bytes: credential.bytes,
      sha256: officeSha(credential.sha256)
    },
    inventoryLimits: parseOfficeInventoryLimits(r.inventoryLimits),
    pollIntervalMs: r.pollIntervalMs,
    resetImagePackageManifestPath: r.resetImagePackageManifestPath === void 0 ? void 0 : officePhysicalPath(r.resetImagePackageManifestPath),
    codePackageLanePath: r.codePackageLanePath === void 0 ? void 0 : officePhysicalPath(r.codePackageLanePath),
    softwareLanePath: r.softwareLanePath === void 0 ? void 0 : officePhysicalPath(r.softwareLanePath)
  };
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-installation.ts
var OFFICE_PROVIDER_USER = "qorpera-office-provider";
var OFFICE_INSTALL_DOCUMENTS = {
  service: { file: "service.json", maxBytes: 16384, mode: 292 },
  policy: { file: "policy.json", maxBytes: 16384, mode: 292 },
  provenance: { file: "provenance.json", maxBytes: 16384, mode: 292 },
  registry: { file: "registry.credential", maxBytes: 4096, mode: 288 },
  registryCa: { file: "registry-ca.pem", maxBytes: 65536, mode: 292 }
};
var documentKeys = Object.keys(OFFICE_INSTALL_DOCUMENTS);

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-installation-host.ts
var import_node_child_process = require("node:child_process");
var import_promises4 = require("node:fs/promises");
var import_node_path8 = require("node:path");
var documentKeys2 = Object.keys(OFFICE_INSTALL_DOCUMENTS);
var environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
var missing = (error) => error.code === "ENOENT";
async function parents(path, create = false) {
  const paths = [];
  if ((0, import_node_path8.join)((0, import_node_path8.dirname)(path), (0, import_node_path8.basename)(path)) !== path || /[\u0000-\u001f\u007f]/.test(path))
    throw new Error("OFFICE_INSTALL_PATH_UNPROTECTED");
  let current = officePhysicalPath((0, import_node_path8.dirname)(path));
  while (true) {
    paths.unshift(current);
    if (current === "/") break;
    current = (0, import_node_path8.dirname)(current);
  }
  for (const part of paths) {
    try {
      await (0, import_promises4.lstat)(part);
    } catch (error) {
      if (!create || !missing(error)) throw error;
      await (0, import_promises4.mkdir)(part, { mode: 493 });
      await (0, import_promises4.chmod)(part, 493);
    }
    const info = await (0, import_promises4.lstat)(part);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 3090) !== 0 || await (0, import_promises4.realpath)(part) !== part)
      throw new Error("OFFICE_INSTALL_PATH_UNPROTECTED");
  }
}
function command(file, args, absent = false) {
  try {
    return (0, import_node_child_process.execFileSync)(file, args, {
      encoding: "utf8",
      env: environment,
      timeout: 1e4,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    if (absent && error.status === 2) return "";
    throw new Error("OFFICE_INSTALL_COMMAND_FAILED");
  }
}
async function lockFd(path, uid) {
  const info = await (0, import_promises4.lstat)(path, { bigint: true });
  if (!info.isFile() || info.uid !== BigInt(uid) || info.nlink !== 1n || info.size !== 0n || (info.mode & 0o7777n) !== 0o600n || await (0, import_promises4.realpath)(path) !== path)
    throw new Error("OFFICE_INSTALL_LOCK_UNPROTECTED");
  const major = info.dev >> 8n & 0xfffn | info.dev >> 32n & 0xfffff000n, minor = info.dev & 0xffn | info.dev >> 12n & 0xffffff00n;
  for (const encoded of await (0, import_promises4.readdir)("/proc/self/fd")) {
    if (!/^\d+$/.test(encoded)) continue;
    const text2 = await (0, import_promises4.readFile)(`/proc/self/fdinfo/${encoded}`, "utf8").catch(() => "");
    const match2 = /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/m.exec(
      text2
    );
    if (match2 && BigInt(`0x${match2[1]}`) === major && BigInt(`0x${match2[2]}`) === minor && BigInt(match2[3]) === info.ino)
      return Number(encoded);
  }
  throw new Error("OFFICE_INSTALL_KERNEL_LOCK_REQUIRED");
}

// ../../../../work/Qorpera_Base-web-runtime/packages/runner-orchestrator/src/lxd-office-delete-metadata-command.ts
var INSTALL_LOCK = "/run/qorpera-office-provider-install/install.lock";
async function runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId) {
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (process.platform !== "linux" || !uid || !gid || uid !== process.geteuid?.() || gid !== process.getegid?.())
    throw new Error("OFFICE_DELETE_METADATA_PROVIDER_UID_REQUIRED");
  const account = command("/usr/bin/getent", ["passwd", OFFICE_PROVIDER_USER]).split(":");
  if (account.length !== 7 || Number(account[2]) !== uid || Number(account[3]) !== gid || account[5] !== "/nonexistent" || account[6] !== "/usr/sbin/nologin")
    throw new Error("OFFICE_DELETE_METADATA_ACCOUNT_DIFFERS");
  const assertProcessIdentity = async () => {
    const status = await (0, import_promises5.readFile)("/proc/self/status", "utf8");
    const field = (name) => {
      const rows = status.split("\n").filter((line) => line.startsWith(`${name}:`));
      if (rows.length !== 1) throw new Error("OFFICE_DELETE_METADATA_PROCESS_PRIVILEGED");
      return rows[0].slice(name.length + 1).trim();
    };
    if (field("Uid").split(/\s+/).join(",") !== [uid, uid, uid, uid].join(",") || field("Gid").split(/\s+/).join(",") !== [gid, gid, gid, gid].join(",") || field("Groups").split(/\s+/).some((value) => value !== "" && value !== String(gid)) || ["CapInh", "CapPrm", "CapEff", "CapAmb"].some((name) => !/^0{16}$/.test(field(name))) || field("NoNewPrivs") !== "1")
      throw new Error("OFFICE_DELETE_METADATA_PROCESS_PRIVILEGED");
  };
  await assertProcessIdentity();
  const readConfig = async () => {
    const encoded = await readLxdOfficeProtectedFile(configPath, 16384);
    const config = parseLxdOfficeLifecycleServiceConfig(
      JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(encoded))
    );
    const policy = parseLxdOfficePhysicalPolicy(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(await readLxdOfficeProtectedFile(config.policyPath, 65536))
      )
    );
    return { encoded, config, policy };
  };
  const loaded = await readConfig();
  const context = await readLxdOfficeDeleteDisposition(allocationId, auditId);
  const binding = parseLxdOfficeGuestBinding({
    ...loaded.policy.guest,
    schema: "qorpera.lxd-office-guest/v2",
    allocationId,
    providerPolicySha256: lxdOfficePhysicalPolicySha256(loaded.policy)
  });
  if (officeDigest(binding) !== context.plan.providerBindingSha256)
    throw new Error("OFFICE_DELETE_METADATA_POLICY_DIFFERS");
  const boot = (await (0, import_promises5.readFile)("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!/^[0-9a-f-]{36}$/.test(boot)) throw new Error("OFFICE_DELETE_METADATA_HOST_NAMESPACE_REQUIRED");
  const namespace = await assertLxdOfficeHostNamespace(boot);
  const root = loaded.policy.journal.path;
  const assertBoundary = async () => {
    await assertProcessIdentity();
    await parents(INSTALL_LOCK);
    await lockFd(INSTALL_LOCK, 0);
    await parents(root);
    await lockFd((0, import_node_path9.join)(root, "adoption.lock"), uid);
    const stat = await (0, import_promises5.lstat)(root);
    if (stat.uid !== uid || stat.gid !== gid || !stat.isDirectory() || (stat.mode & 4095) !== 448)
      throw new Error("OFFICE_DELETE_METADATA_JOURNAL_CUSTODY_DIFFERS");
    const file = await (0, import_promises5.open)(root, import_node_fs3.constants.O_RDONLY | import_node_fs3.constants.O_DIRECTORY | import_node_fs3.constants.O_NOFOLLOW);
    try {
      assertLxdOfficeHostMount(
        await (0, import_promises5.readFile)("/proc/self/mountinfo", "utf8"),
        await (0, import_promises5.readFile)(`/proc/self/fdinfo/${file.fd}`, "utf8"),
        loaded.policy.journal,
        root
      );
    } finally {
      await file.close();
    }
    if (!(0, import_node_util5.isDeepStrictEqual)(await readConfig(), loaded) || !(0, import_node_util5.isDeepStrictEqual)(await readLxdOfficeDeleteDisposition(allocationId, auditId), context) || (await (0, import_promises5.readFile)("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== boot || await assertLxdOfficeHostNamespace(boot) !== namespace)
      throw new Error("OFFICE_DELETE_METADATA_BOUNDARY_CHANGED");
    const state = command("/usr/bin/systemctl", [
      "show",
      "qorpera-office-provider.service",
      "--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,UnitFileState"
    ]);
    const fields = Object.fromEntries(
      state.split("\n").map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      })
    );
    if (fields.LoadState !== "loaded" || fields.ActiveState !== "inactive" || fields.SubState !== "dead" || fields.MainPID !== "0" || fields.ControlPID !== "0" || fields.Job !== "" || fields.UnitFileState !== "disabled")
      throw new Error("OFFICE_DELETE_METADATA_PROVIDER_NOT_STOPPED");
  };
  return reconcileLxdOfficeDeleteMetadata(root, context, assertBoundary);
}

// work/linux-execution/full-entry.ts
var hash = (b) => (0, import_node_crypto9.createHash)("sha256").update(b).digest("hex");
async function main() {
  if (process.platform !== "linux") throw new Error("ISOLATED_LINUX_REQUIRED");
  const [mode, root, mountFile] = process.argv.slice(2);
  if (mode === "prepare") {
    const { policy } = officePhysicalFixture("x86_64");
    const mount2 = JSON.parse(await (0, import_promises6.readFile)(mountFile, "utf8"));
    policy.journal = { ...mount2, path: root };
    const { plan, document } = officeDeleteDispositionFixture();
    const binding = { schema: "qorpera.lxd-office-guest/v2", ...policy.guest, allocationId: plan.predecessor.startup.allocationId, providerPolicySha256: lxdOfficePhysicalPolicySha256(policy) };
    plan.predecessor.providerId = binding.providerId;
    plan.predecessor.providerPolicySha256 = binding.providerPolicySha256;
    plan.predecessor.startup.scope = { companyId: binding.companyId, environmentId: binding.environmentId, companyComputerId: binding.companyComputerId, logicalComputerId: binding.logicalComputerId };
    plan.predecessor.startup.imageSha256 = binding.imageFingerprint;
    plan.predecessor.startup.bootstrapSha256 = binding.bootstrapSha256;
    plan.providerBindingSha256 = officeDigest(binding);
    document.planSha256 = officeDigest(plan);
    const guest2 = lxdOfficeGuestPlan(binding);
    let n = 100;
    let unknown = false;
    const client = { submitInstanceOperation: async (project) => ({ project, instanceName: guest2.request.name, operationId: officeDeleteDispositionId(n++) }), inspectInstanceOperation: async () => {
      if (unknown) throw new Error("synthetic evicted result");
      return "succeeded";
    } };
    const journal2 = await LxdOfficeOperationJournal.open(root, plan.intentId, binding, client);
    for (const [command2, action] of [[officeDeleteDispositionId(90), "create"], [officeDeleteDispositionId(91), "start"], [plan.commands.stopCommandId, "stop"]]) await journal2.reconcile(command2, action, new AbortController().signal);
    unknown = true;
    const result = await journal2.reconcile(plan.commands.deleteCommandId, "delete", new AbortController().signal);
    if (result.state !== "unknown") throw new Error("fixture UNKNOWN expected");
    const dir = (0, import_node_path10.join)(root, binding.allocationId);
    document.operationId = result.operationId;
    const history = await journal2.history();
    document.journal = { authoritySha256: hash(await (0, import_promises6.readFile)((0, import_node_path10.join)(dir, "authority.json"))), acceptedHeadSha256: history.journalHeadSha256, eventCount: history.events.length };
    const phases = await LxdOfficeResetJournal.open(root, plan);
    for (const [phase, digest] of [["fenced", officeDigest(plan)], ["stopped", document.stopAcknowledgementSha256], ["custodied", document.custodyEvidenceSha256], ["powered_off", document.poweredOffPhaseSha256]]) await phases.advance(phase, digest);
    const saved = {};
    for (const name of await (0, import_promises6.readdir)(dir)) saved[(0, import_node_path10.join)(dir, name)] = hash(await (0, import_promises6.readFile)((0, import_node_path10.join)(dir, name)));
    for (const name of await (0, import_promises6.readdir)(root)) if (name.endsWith(".json")) saved[(0, import_node_path10.join)(root, name)] = hash(await (0, import_promises6.readFile)((0, import_node_path10.join)(root, name)));
    const config = { schema: "qorpera.lxd-office-provider-service/v1", policyPath: "/etc/qorpera-fixture/policy.json", provenancePath: "/etc/qorpera-fixture/provenance.json", planPath: "/etc/qorpera-fixture/plan.json", registryUrl: "https://example.invalid", registryCredential: { path: "/etc/qorpera-fixture/unused.credential", bytes: 64, sha256: "a".repeat(64) }, inventoryLimits: { maxEntries: 100, maxDepth: 4, maxFileBytes: 1024, maxTotalBytes: 4096, maxManifestBytes: 65536 }, pollIntervalMs: 2e3 };
    console.log(JSON.stringify({ policy, config, envelope: officeDeleteDispositionEnvelopeFor(plan, document), saved, allocationId: binding.allocationId, auditId: document.auditId }));
  } else if (mode === "metadata") {
    const packet = JSON.parse(await (0, import_promises6.readFile)(mountFile, "utf8"));
    console.log(JSON.stringify(await runLxdOfficeDeleteMetadataCommand("/etc/qorpera-fixture/service.json", packet.allocationId, packet.auditId)));
  } else if (mode === "verify") {
    const packet = JSON.parse(await (0, import_promises6.readFile)(mountFile, "utf8"));
    for (const [path, digest] of Object.entries(packet.saved)) if (hash(await (0, import_promises6.readFile)(path)) !== digest) throw new Error("HISTORICAL_BYTES_CHANGED");
    const history = await LxdOfficeOperationJournal.readHistory(root, packet.allocationId);
    const tail = history.events.at(-1);
    if (history.events.length !== 12 || tail?.kind !== "administrative_disposition" || tail.state !== "unknown") throw new Error("WRONG_FINAL_HISTORY");
    console.log(JSON.stringify({ historicalFilesPreserved: Object.keys(packet.saved).length, events: history.events.length, tail }));
  } else throw new Error("UNKNOWN_MODE");
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
