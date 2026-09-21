# Office host passthrough

Members watch a Company Computer through the web mux, and the node's native
provider hands agents their screens through the same host. Both reach the office
guest through two host ports: one for the viewer, one for the native service.
The guest's TLS terminates in the guest, so the mux keeps verifying the office
certificate; the host only copies bytes.

The guest is a DHCP client of the office bridge. Its address is whatever its
current lease says, and it moves whenever the guest was powered off for longer
than the lease (an idle office stops after five minutes and stays off until
someone opens it). Anything that forwards to a fixed guest address therefore
breaks silently after the first long sleep: the mux answers 504, the web client
shows "Cloud screen unavailable", and nothing in the platform can repair it.

The office provider is the one process that both starts the guest and can ask
LXD where it is, so it carries the two host ports itself and resolves the guest
for every connection. Nothing is pinned: no address in a unit file, no address
on the VM's network device (the provider refuses to start a guest whose devices
differ from its plan, `LXD_OFFICE_GUEST_DRIFTED`), and no operator step after
the guest moves.

## Configuration

Add `passthroughPath` to the root-protected service document
(`qorpera.lxd-office-provider-service/v1`) and place the closed passthrough
document beside it, root-owned and readable by the service user:

```json
{
  "schema": "qorpera.lxd-office-passthrough/v1",
  "listenHost": "100.75.4.70",
  "viewer": { "listenPort": 18543, "guestPort": 18543 },
  "native": { "listenPort": 18544, "guestPort": 18544 },
  "allowedClients": ["100.64.0.0/10"]
}
```

- `listenHost` is the host's tailnet address (an IP literal, never a name).
- `viewer` and `native` name the host port the mux and the native provider
  connect to, and the guest port behind it. The guest ports are the ones in the
  office's service bootstrap (`viewer.port`, `native.port`).
- `allowedClients` lists the IPv4 networks that may connect: the tailnet range
  covers the mux and the native provider on this node. Anything else is closed
  before a byte is copied.

The provider listens as long as it runs, whether or not the office is active. A
connection while the guest is off, stopped or ambiguous is closed at once; the
client's own reconnect is the retry. Per lane at most 64 connections are open;
the guest must accept within 5 seconds. Resolutions are shared for one second so
a burst of reconnects does not become a burst of LXD inventories.

How the guest is found: the provider lists the host inventory and takes the one
running virtual machine in the office project whose `user.qorpera.office_id`
and `user.qorpera.computer_generation` tags match the policy, then reads the
address the guest agent reports on the planned NIC, bound by MAC. Two
candidates, a stopped VM or a NIC without exactly one IPv4 address resolve to
nothing.

## Moving an existing host from operator-managed forwarders

Hosts installed before this change forward with `systemd-socket-proxyd` units
whose `ExecStart` carries the guest address. Replace them once; the provider
owns the ports afterwards.

1. Write the passthrough document and add `passthroughPath` to `service.json`
   (same listen host and ports the units used, so the mux and the native route
   file need no change).
2. Stop and disable the two socket units and their services, for example
   `qorpera-prod-office-a1-viewer.socket`/`.service` and
   `qorpera-prod-office-a1-native.socket`/`.service`. The provider cannot bind a
   port a socket unit still holds.
3. Restart the office provider service. Its journal shows `passthrough` errors
   only when a bind fails; a successful start is silent.
4. Open a computer in the web client. The mux path
   `https://<node>:10000/office/<companyComputerId>/view` answers with a
   WebSocket refusal instead of 504 while the office is active, and a viewer row
   is redeemed in `qorpera_runtime_office_viewers`.

Nothing else moves: the mux configuration, its pinned office certificate, the
native route file and the guest are unchanged.
