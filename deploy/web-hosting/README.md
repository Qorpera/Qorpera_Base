# Qorpera Native Web Hosting (`qorpera.site`)

Self-hosted static sites, full-stack/SSR apps, and custom domains (both apex `example.dk` and subdomains `www.example.dk`) running 100% on Qorpera's own servers with zero Cloudflare or Vercel dependencies.

## Components

| Component | Binary / Config | Role |
| :--- | :--- | :--- |
| **Caddy** | `Caddyfile` + `qorpera-web-caddy.service` | Public ports `80`/`443`, HTTP/3 QUIC, On-Demand ACME TLS (Let's Encrypt + ZeroSSL fallback), trusted `X-Qorpera-Client-IP`. |
| **`qorpera-web-router`** | `crates/qorpera-web-router` + `qorpera-web-router.service` | Content-addressed NVMe/NAS static blob store (`512 MiB` / `10,000` files), zero-DB in-memory routing synced via Postgres `LISTEN qorpera_web_route_changes`, Caddy `ask` gate (`/_internal/tls/allow`), L7 rate limits, a "Not live yet" page (401, no form) for a website that is not public and a password gate only for a site whose snapshot row still has a hash (an app link), read-through of a website's database-stored files (`qorpera_web_edge_site_file`, at most `10 MiB` a file and `4` at once, single-flight, SHA-256 checked before a byte is served or kept), instant `<50 ms` takedown, hybrid static fast-path, single-flight scale-to-zero wake-on-request, and bounded bidirectional WebSockets (`2048` global, `128` per deployment, `64` per client IP; `300 s` idle cutoff requiring app-level ping/pong for quiet long-lived sockets). |
| **`qorpera-app-host`** | `crates/qorpera-app-host` + `qorpera-app-host.service` | Dedicated unprivileged LXD `qorpera-web-apps` production app slice, zero-downtime blue/green deploys, health-checked swaps, scale-to-zero idle hibernation, and ring-buffer log capture. |
| **Kernel Shield** | `nftables-edge.nft` | `SYNPROXY` on ports `80`/`443` plus `qorpera_web_apps_egress` blocking customer app containers from RFC1918 LAN, node hosts, LXD sockets, and sibling tenants. |
| **HA Failover** | `keepalived-ha.conf` | VRRP failover between `company41-node-01` (`MASTER`, `192.168.1.27`) and `company41-node-02` (`BACKUP`, `192.168.1.42`) on floating IP `192.168.1.250`. |

## Build & Install on `company41-node-01` / `company41-node-02`

1. Build Linux x86_64 release binaries deterministically inside the pinned Rust container:
   ```bash
   node scripts/build-web-hosting-programs.mjs --out-dir /tmp/qorpera-web-bin
   ```
2. Run the idempotent node installer on both nodes (with shared NAS mounts at `/var/lib/qorpera-web-blobs` and `/var/lib/qorpera-web-certs`):
   ```bash
   sudo bash deploy/web-hosting/install-web-hosting.sh /tmp/qorpera-web-bin
   ```
3. Provision encrypted credentials with `systemd-creds encrypt`:
   - `/etc/credstore.encrypted/qorpera-web-control-token` (shared between `qorpera-web-router`, `qorpera-app-host`, and `coding-worker`'s `webHosting.controlToken`)
   - `/etc/credstore.encrypted/qorpera-web-cookie-secret` (32+ random bytes for visitor/preview/member HMAC cookies)
   - `/etc/credstore.encrypted/qorpera-web-database-url` (Postgres connection string with `service_role` access for `qorpera_web_edge_*` RPCs and `LISTEN qorpera_web_route_changes`; if using a custom/Supabase CA bundle, copy it to `/etc/qorpera-web/db-ca.pem` with mode `0644` and set `QORPERA_WEB_ROUTER_DATABASE_CA_FILE=/etc/qorpera-web/db-ca.pem` in `/etc/qorpera-web/router.env`)
   - Verify `/etc/qorpera-web/edge.env` sets `QORPERA_EDGE_BIND` to the node's LAN IP + floating VIP (`192.168.1.27 192.168.1.250` on `node-01`, `192.168.1.42 192.168.1.250` on `node-02`) so Caddy never collides with `tailscale0:443`.
   - For Keepalived HA, use `interface enp8s0` on `company41-node-01` and `interface enp7s0` (`state BACKUP`, `priority 90`, `unicast_src_ip 192.168.1.42`, peer `192.168.1.27`) on `company41-node-02`.
4. Configure `webHosting` in the `coding-worker` executor config JSON so self-hosted codebase landings publish directly to the native edge:
   ```json
   "webHosting": {
     "routerInternalUrl": "http://127.0.0.1:8094",
     "controlToken": "<shared-control-token>",
     "appHostInternalUrl": "http://127.0.0.1:8096",
     "builderScriptPath": "/usr/local/libexec/qorpera-web-hosting/builder-railpack.sh",
     "registryPrefix": "127.0.0.1:5000/qorpera-apps"
   }
   ```

## Network Cutover Order

### Stage A — Immediate Dev / Beta on Existing Nodes (`93.164.62.162`)
1. Deploy `qorpera-web-router`, `qorpera-app-host`, `caddy`, and `nftables-edge.nft` on `company41-node-01` and `company41-node-02` with shared NAS mounts at `/var/lib/qorpera-web-blobs` and `/var/lib/qorpera-web-certs`.
2. Enable `keepalived` on both nodes (`priority 100` on `node-01`, `priority 90` + `state BACKUP` on `node-02`) for floating LAN IP `192.168.1.250`.
3. Forward TCP `80`, TCP `443`, and UDP `443` on router `192.168.1.1` to `192.168.1.250`.
4. Point `*.qorpera.site` and `sites.qorpera.site` DNS `A` records to `93.164.62.162`.
5. Run the SQL configuration switch:
   ```sql
   update public.qorpera_site_settings
   set hosts_domain = 'qorpera.site',
       hosts_enabled = true,
       public_enabled = true,
       domains_enabled = true,
       edge_ipv4 = '93.164.62.162'::inet,
       edge_cname_target = 'sites.qorpera.site';
   ```
6. Submit `qorpera.site` to the Mozilla Public Suffix List (PSL) before enabling broad public third-party sites.

### Stage B — Danish Colocation Production Cutover (e.g., Adeo Datacenter)
1. Provision two separate public IPv4/IPv6 addresses at colocation:
   - **Platform IP:** `qorpera.com`, `app.qorpera.com`, `api.qorpera.com`, `screens.qorpera.com`.
   - **Customer Sites IP:** `*.qorpera.site`, `sites.qorpera.site`, and all customer custom domains.
2. Update `qorpera_site_settings.edge_ipv4` and `edge_ipv6` to the Customer Sites IP. Zero application code changes required.

### Stage C — Future Rebrand Cutover (e.g., `Medstifter.dk` / `sider.dk`)
1. Add the new sites domain to `qorpera_site_settings_hosts_domain` check constraint via a 1-line migration and add it to `SITE_HOST` in `packages/web/src/cloud/sites.ts`.
2. Update `qorpera_site_settings.hosts_domain` and keep `qorpera.site` in `legacy_hosts_domains` for seamless `308` redirects.
