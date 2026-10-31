# n8n-nodes-vantaris

This is an n8n community node package. It lets you use [VantarIS](https://vantaris.app), a governance, risk and
compliance (GRC) platform, in your n8n workflows: create and update tickets and tasks, keep assets in sync, read
risks, processes, documents and controls, and start workflows when something changes in VantarIS or a deadline is
reached.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation
platform.

[Installation](#installation) · [Nodes and operations](#nodes-and-operations) · [Credentials](#credentials) ·
[Triggers](#triggers) · [Compatibility](#compatibility) · [Usage](#usage) · [Development](#development) ·
[Guidelines followed](#guidelines-followed) · [Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community
nodes documentation. The package name is `n8n-nodes-vantaris`.

## Nodes and operations

The package contains three nodes:

| Node | Purpose |
|---|---|
| **VantarIS** | Actions on VantarIS objects, plus **API Call** for any other route of the API |
| **VantarIS Trigger** | Starts a workflow instantly: VantarIS sends each event as a signed webhook |
| **VantarIS Polling Trigger** | Starts a workflow by reading the event feed at an interval (no inbound connection to n8n needed) |

Operations of the **VantarIS** node:

| Resource | Operations |
|---|---|
| Incident (ticket) | Create, Get, Get Many, Update, Set Status, Add Comment |
| Task | Create, Get, Get Many, Update, Set Status, Add Comment |
| Asset | Create, Get, Get Many, Update |
| Risk Scenario | Get, Get Many, Update |
| Process | Get, Get Many, Update |
| Document | Get, Get Many, Upload |
| Control | Get, Get Many |
| API Call | Make a Request (method, path below `/api/v1`, query, JSON body) |

- Dropdowns for status, category, owner (employees and roles) and tags are loaded from your instance, with the rights
  of the access key.
- **Get Many** offers *Return All* (follows the API's cursor pages) or a *Limit*.
- **Create** operations accept an *Idempotency Key*; **Update** and **Set Status** accept an *If-Match (ETag)* for
  safe concurrent changes.
- Errors of the API (RFC 9457 problem answers) are shown with status, code, reason and the affected fields, e.g.
  `VantarIS answered 422 Unprocessable Content (validation_failed)` / `Field 'name': required`.

The resources and operations are generated from the integration profile of the VantarIS API
(`profile/profile.json`, see [Development](#development)); new building blocks appear when the profile grows.

## Credentials

Create an access key in VantarIS under **Company → API keys**. Each key belongs to one role and has the flags
`data:read`, `data:write` and `data:delete`; give the key only what the workflow needs.

| Field | Value |
|---|---|
| Instance Address | `https://vantaris.app` (default), the whitelabel address of your company (e.g. `https://grc.example.com`) or the address of an on-premise installation. With or without a trailing `/api/v1`. |
| Access Key | The key, starting with `vtk_`. Stored encrypted by n8n, sent as `Authorization: Bearer …`. |

The credential test calls `GET {Instance Address}/api/v1/ping`.

Notes:

- VantarIS accepts keys only over HTTPS. An on-premise instance behind a TLS proxy works with its HTTPS address.
- If your self-hosted n8n runs with `N8N_SSRF_PROTECTION_ENABLED=true`, add the address of an internal VantarIS
  instance to `N8N_SSRF_ALLOWED_HOSTNAMES` (or `N8N_SSRF_ALLOWED_IP_RANGES`).

## Triggers

Both triggers emit the same thin event object; it never contains the content of the object, only what changed:

```json
{
  "id": "evt_a1234567",
  "type": "task.updated",
  "occurred_at": "2026-10-31T10:00:00Z",
  "object": { "type": "task", "id": 123, "href": "/api/v1/tasks/123", "name": "Review firewall rules" },
  "changes": ["status", "owner"],
  "actor": { "kind": "api", "via": "api", "key": "vtk_ab12" },
  "data": {}
}
```

- **Events**: choose event types (92 types: changes of tickets, tasks, assets, risks, processes, documents, controls and
  further objects, plus business events such as reporting deadlines or due dates) or groups (*All Task Events*,
  *All Events*).
- **Ignore Own Changes** (on by default): skips events caused by the access key of these credentials, so a workflow
  that writes back to VantarIS does not trigger itself.
- **Include Object**: loads the current object of each event (with the rights of the key) into `object_data`.

**VantarIS Trigger (webhook)**: on activation the node subscribes the workflow's production URL
(`POST /api/v1/webhooks`); on deactivation it removes the subscription. Every delivery is verified with the
[Standard Webhooks](https://www.standardwebhooks.com) signature (`webhook-id`, `webhook-timestamp`,
`webhook-signature`, HMAC-SHA256, 5 minutes tolerance); a wrong signature is answered with 401 and starts nothing.
The production URL of n8n must be reachable over HTTPS from the VantarIS instance.

**VantarIS Polling Trigger**: reads `GET /api/v1/events` after the stored cursor. On activation it only remembers the
current position (no replay of the past). Duplicates are dropped by event id; an expired cursor restarts at the time
of the newest seen event. Use it when n8n is not reachable from VantarIS (e.g. n8n inside your own network).

## Compatibility

Built with `@n8n/node-cli` 0.54 and tested against n8n 2.45.7 (`n8n-workflow` 2.45.4). No runtime dependencies.

## Usage

Examples in [`examples/`](examples/):

- `ticket-from-form.json`: an n8n form creates a VantarIS incident (ticket).
- `deadline-follow-up.json`: when a reporting deadline of a ticket reaches a stage, load the ticket and add a comment.

Typical uses: mirror tasks to Jira and back (keep *Ignore Own Changes* on), post reporting deadlines to Microsoft Teams
or Slack, create assets from device management, or create tickets from forms and mailboxes.

## Development

```bash
npm ci
npm run generate   # regenerate nodes/*/generated from profile/profile.json
npm run lint
npm run build
npm test           # builds, then runs the tests in test/ with node:test
```

- `profile/profile.json` is the integration profile, produced from the OpenAPI description of VantarIS by the
  VantarIS connector tooling. `scripts/generate.mjs` turns it into `nodes/Vantaris/generated/*.ts` and
  `nodes/shared/generated/events.ts`. Do not edit generated files by hand.
- The tests run the built nodes inside n8n-core's execution engine (`n8n-core` is a dev dependency) against a local
  mock server: every generated operation against three kinds of instance address, credential test, cursor
  pagination, problem answers, dropdown lookups, webhook subscription and signature (with the known-answer vectors of
  the Standard Webhooks repository), polling cursor, deduplication and echo suppression. No request leaves the
  machine.

## Guidelines followed

- [Verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/):
  scaffolded with `npm create @n8n/node` (`@n8n/node-cli`), TypeScript, MIT licence, no runtime dependencies, no
  environment variables or file access in node code, English interface texts, `npm run lint` clean (the scanner
  `npx @n8n/scan-community-package n8n-nodes-vantaris` checks the published package and runs after the first
  release), trigger nodes in programmatic style next to a declarative action node.
- [Submit community nodes](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/): package name
  `n8n-nodes-…`, keyword `n8n-community-node-package`, nodes and credentials listed in `package.json` → `n8n`, publishing
  only through GitHub Actions with npm provenance (`.github/workflows/publish.yml`, required since 1 May 2026).
- [Declarative style](https://docs.n8n.io/integrations/creating-nodes/build/declarative-style-node/) for the
  VantarIS node (`requestDefaults`, `routing` per operation and parameter, `postReceive`/`preSend` and a pagination
  function), [programmatic style](https://docs.n8n.io/integrations/creating-nodes/build/programmatic-style-node/) for the
  triggers (`webhookMethods` with `checkExists`/`create`/`delete`, `poll`).
- [UX guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/): resource/operation
  pattern, *Get Many* with *Return All*/*Limit*, password field for the key, Title Case names and sentence case actions,
  errors that say what happened and how to fix it.

The polling mode is a separate node (*VantarIS Polling Trigger*) instead of a mode switch inside *VantarIS Trigger*:
n8n decides between webhook and polling behaviour per node type, and mixing both in one node would register an unused
webhook in polling mode and show the poll interval in webhook mode.

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
