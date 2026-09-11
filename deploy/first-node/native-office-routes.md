# Native job connections to the Company Computer

The headless LXD provider can connect each governed native job to its company's
office service. Set `QORPERA_LXD_OFFICE_ROUTES_FILE` in the provider environment
to an absolute physical JSON file. The route file and each token file must be
private (0600), owned by root or the provider service user, and readable by that
service. Symlinked paths, group/world access, unknown fields, malformed scopes
and reused credentials are rejected. Keep these files outside the image and
source repository.

```json
{
  "schema": "qorpera.lxd-native-office-routes/v1",
  "offices": [
    {
      "companyId": "20000000-0000-4000-8000-000000000004",
      "environmentId": "20000000-0000-4000-8000-000000000005",
      "url": "https://office.example.test/office/20000000-0000-4000-8000-000000000099/native",
      "tokenPath": "/etc/qorpera/company-office-native-token"
    }
  ]
}
```

The map accepts 1–128 unique company/environment scopes and office IDs. Each
office uses its own 43-character base64url transport token, distinct from object,
secret-broker, Supabase and native-bridge credentials. The HTTPS endpoint must
be reachable from job guests with a valid certificate and exact office path;
this configuration does not create a network route or weaken TLS verification.

Only the route matching both `work.profileId` and `work.environmentId` enters
the job guest. The URL and token digest are bound into its immutable bootstrap
and provider journal; the token itself is delivered through systemd's
`qorpera-office-native` credential. It is not put in environment variables,
LXD metadata or the journal. Other offices' credentials remain on the provider.
The guest checks the bootstrap URL, digest and credential independence before
starting native execution. Descriptor, run and effect-time resource checks
remain responsible for tool authority; possessing the transport token alone
does not grant browser or Company File access.

Without a matching route, the guest has no office URL and receives an empty
credential source. This keeps the fixed systemd unit startable while granting
no office authority. A missing credential file, nonempty unconfigured token,
changed URL or changed digest blocks startup. Deploy the updated bootstrap and
service unit together in a newly signed guest image.

Route changes are pinned with the rest of the native configuration in retained
job journals. Drain existing jobs before changing the map or rotating tokens;
restarting an old job with changed configuration is rejected. Never rewrite a
journal to bypass that refusal.
