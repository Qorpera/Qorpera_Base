# Company41 private custody endpoint

This deployment serves the retained broker and recovery authority at Company41's
private tailnet address, `100.65.132.47:8443`. The broker and recovery packages
continue to listen on loopback. The TLS service accepts only the existing capture,
operation and recovery routes. Each backend still authenticates and authorizes
every request; the proxy grants no operation authority.

Install `custody-proxy.conf` as `/etc/qorpera-secret-broker/custody-proxy.conf` and
the unit under `/etc/systemd/system/`, with root ownership and explicit mode
`0644`. Set the mode explicitly after creation under a restrictive umask so the
proxy service account can read its public configuration. Provision the certificate and private key
as systemd encrypted credentials named `qorpera-cloud-custody-tls-cert` and
`qorpera-cloud-custody-tls-key`. Generate and encrypt private material on the
broker; return only the public CA for the native provider's existing trust bundle.
Retain the installed certificate across boots. Plaintext key material belongs
only in root-owned tmpfs during issuance and in systemd's credential directory
while the service runs.

Verify the configuration, exact package hashes, production authority bindings,
private listener, trusted TLS requests and authentication denials before enabling
the unit and its backend services at boot. Restart the VM and verify the same
certificate, encrypted credential files and private route survive. Keep the
separate recovery journal mount as a startup dependency; availability of the NAS
replica is checked separately and cannot be inferred from a running endpoint.
The private tailnet address can appear after `tailscaled.service` becomes active;
the proxy's bounded restart policy retries the bind without opening a wildcard
listener. Record any startup retry and verify that the service then remains stable.

This persistent service replaces the historical temporary TLS proof unit. Its
absence after a VM restart exposed the need for persistent encrypted credentials
and a boot-enabled service. The historical unit and CA are not a recovery path.
