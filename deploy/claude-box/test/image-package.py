#!/usr/bin/env python3
"""C2i proof: a copy of a `--contract-only` guest package that install-image-contract.sh can run outside the real
image build. The real package carries the signed runner image (its OCI archive and Cosign bundle, built by the
ephemeral runner workflow); a contract-only package names them and has neither. This copy drops exactly those two
from its manifest and the installer copy's expected files, and the three installer steps that load and check that
image; every other line runs as it is. The diff is printed. Usage: image-package.py PACKAGE OUT"""
import difflib, hashlib, json, os, shutil, sys

package, out = sys.argv[1:3]
shutil.rmtree(out, ignore_errors=True)
shutil.copytree(package, out)
external = ["runner-image/qorpera-sandbox-probe.cosign-bundle.json", "runner-image/qorpera-sandbox-probe.oci.tar"]
for name in external:
    if os.path.exists(os.path.join(out, name)):
        sys.exit(f"{name} is in the package: this is not a contract-only package")
installer_path = os.path.join(out, "install-image-contract.sh")
original = open(installer_path).read()
text = original
cuts = [
    ('  "runner-image/qorpera-sandbox-probe.cosign-bundle.json",\n  "runner-image/qorpera-sandbox-probe.oci.tar",\n', ""),
    (
        'if ! /usr/bin/cat "${PACKAGE_ROOT}/runner-image/qorpera-sandbox-probe.oci.tar" | (\n'
        "\tcd /var/lib/qorpera-runner\n"
        '\trunuser -u "${RUNNER_USER}" -- env \\\n'
        "\t\tHOME=/var/lib/qorpera-runner \\\n"
        "\t\tXDG_RUNTIME_DIR=/run/qorpera-runner \\\n"
        "\t\t/usr/bin/podman load\n"
        "); then\n"
        '\techo "The signed runner image archive could not be loaded by the runner account." >&2\n'
        "\texit 1\n"
        "fi\n",
        "",
    ),
    (
        "if ! (\n"
        "\tcd /var/lib/qorpera-runner\n"
        '\trunuser -u "${RUNNER_USER}" -- env \\\n'
        "\t\tHOME=/var/lib/qorpera-runner \\\n"
        "\t\tXDG_RUNTIME_DIR=/run/qorpera-runner \\\n"
        '\t\t/usr/bin/podman image exists "${runner_image}"\n'
        "); then\n"
        '\techo "The signed runner image archive did not load under its immutable digest." >&2\n'
        "\texit 1\n"
        "fi\n",
        "",
    ),
    (
        "install -o root -g root -m 0644 \\\n"
        '\t"${PACKAGE_ROOT}/runner-image/qorpera-sandbox-probe.cosign-bundle.json" \\\n'
        "\t/etc/qorpera/ephemeral-runner-image.cosign-bundle.json\n",
        "",
    ),
]
for old, new in cuts:
    if text.count(old) != 1:
        sys.exit(f"installer step not found exactly once:\n{old}")
    text = text.replace(old, new)
open(installer_path, "w").write(text)
manifest_path = os.path.join(out, "manifest.json")
manifest = json.load(open(manifest_path))
before = len(manifest["artifacts"])
manifest["artifacts"] = [a for a in manifest["artifacts"] if a["file"] not in external]
if before - len(manifest["artifacts"]) != 2:
    sys.exit("the manifest did not name the two signed runner image files")
for artifact in manifest["artifacts"]:
    if artifact["file"] == "install-image-contract.sh":
        data = open(installer_path, "rb").read()
        artifact["bytes"], artifact["sha256"] = len(data), hashlib.sha256(data).hexdigest()
open(manifest_path, "w").write(json.dumps(manifest, indent=2) + "\n")
print("=== the installer as the proof runs it (only these lines differ from the package's):")
sys.stdout.writelines(
    difflib.unified_diff(original.splitlines(True), text.splitlines(True), "package", "proof", n=1)
)
print(f"=== manifest: {before} artifacts in the package, {len(manifest['artifacts'])} in the proof copy (without {', '.join(external)})")
