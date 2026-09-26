import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Only hashes leave this oneshot probe. It uses the installed office unit's
// actual LoadCredential directives under the installed office UID.
const names = ["qorpera-office-config", "qorpera-office-registry", "qorpera-office-native", "qorpera-office-objects", "qorpera-office-tls-cert", "qorpera-office-tls-key"];
console.log(JSON.stringify(Object.fromEntries(names.map((name) => [name, createHash("sha256").update(readFileSync(`${process.env.CREDENTIALS_DIRECTORY}/${name}`)).digest("hex")]))));
