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
route uses its own 43-character base64url transport token, distinct from object,
secret-broker, Supabase and native-bridge credentials.

A company can run several Company Computers. A route then names every computer
of the company with a placeholder instead of one office ID:
`https://office.example.test/office/{companyComputerId}/native`. The job fills
in the computer its office descriptor places it on. Requirements:

- Every computer of that company accepts the route's token: install the same
  native token in each computer's service bootstrap. A company's computers are
  one trust domain; authority still comes from the run, the descriptor and the
  effect-time grants.
- The front at that origin routes `/office/<id>/native` (and `/view`) to the
  node and host port of that computer, whichever node it was placed on.
- An exact route (one office ID) keeps working and reaches only that computer.
  A run placed on another computer of the company gets no computer tools; it
  does not fail.
- Rolling the provider back to a version without company routes refuses jobs
  whose journal holds a template: drain them first.

The HTTPS endpoint must be reachable from job guests with a valid certificate
and exact office path; this configuration does not create a network route or
weaken TLS verification.

Only the route matching both `work.profileId` and `work.environmentId` enters
the job guest. The URL and token digest are bound into its immutable bootstrap
and provider journal; the token itself is delivered through systemd's
`qorpera-office-native` credential. It is not put in environment variables,
LXD metadata or the journal. Other offices' credentials remain on the provider.
The guest checks the bootstrap URL, digest and credential independence before
starting native execution. Descriptor, run and effect-time resource checks
remain responsible for tool authority; possessing the transport token alone
does not grant browser or Company File access. Since G2-6c, each action also
carries the run's job lease as `x-qorpera-identity`, which the computer proves
with its registry key before anything else, so the route's token without the
run's own lease is refused. Anything between the guest and the computer must
pass that header through (`RUNTIME-NATIVE-HOST-KEY.md`, "G2-6").

Without a matching route, the guest has no office URL and receives an empty
credential source. This keeps the fixed systemd unit startable while granting
no office authority. A missing credential file, nonempty unconfigured token,
changed URL or changed digest blocks startup. Deploy the updated bootstrap and
service unit together in a newly signed guest image.

Route changes are pinned with the rest of the native configuration in retained
job journals. Drain existing jobs before changing the map or rotating tokens;
restarting an old job with changed configuration is rejected. Never rewrite a
journal to bypass that refusal.
