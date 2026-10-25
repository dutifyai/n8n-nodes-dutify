# n8n-nodes-dutify

n8n community nodes for [Dutify](https://dutify.ai): Project Management, Codexum (wiki),
Roadmarq (feature requests and bugs) and Hub (meeting recordings).

- **Dutify** — an action node with one resource per Dutify object (see the list below).
- **Dutify Trigger** — starts a workflow on Project Management events, delivered by a Dutify
  webhook that the trigger registers and removes itself.

The package has no runtime dependencies.

## Install

In n8n, open **Settings → Community Nodes → Install**, enter `n8n-nodes-dutify`, and confirm.
Both nodes then show up in the node panel under "Dutify".

## Credential: a personal API key

The nodes authenticate with a Dutify **personal API key** (it starts with `du_live_`).

1. Create the key in Dutify under **API access → Personal API keys**. You can also create it
   through the API: `POST https://dutify.ai/mp/api/v1/personal-api-keys` with `{"name": "n8n"}`,
   signed in as yourself. The key is shown once, so copy it then.
2. In n8n, add a **Dutify API** credential and paste the key. Leave **Base URL** at
   `https://dutify.ai` unless you run another Dutify instance.
3. Save. n8n tests the credential against `GET /mp/api/v1/api-keys/current`.

A personal key works in every workspace you belong to. Each node has a **Workspace** field
(pick from the list, or enter its identifier). The node sends the workspace on every request.

## Resources

| Area | Resources |
|---|---|
| Account | Account (who am I, list/find my workspaces), Workspace (context, dashboard, reference data, feature request boards, wiki spaces) |
| Tasks | Task, Task Comment, Task Relationship, Task Sharing, Time Entry, Saved Filter |
| Structure | Space, Folder, List, Custom Field, Tag, View |
| Planning | Sprint (groups, sprints, tasks, burndown), Automation |
| People | Team, Member, Invitation, Import Job, User, Notification, Activity Log |
| Integration | PM Webhook (manage webhooks, deliveries, replay) |
| Codexum (wiki) | Codexum Page (Markdown in and out), Codexum Space (incl. public wiki settings), Codexum Attachment (binary upload) |
| Roadmarq | Feature Request, Bug |
| Hub | Call, Recording (status, signed media URLs, reprocess, summaries), Lens (ask) |

Pickers load names from your workspace (spaces, lists, statuses, members, boards, pages and
more). Name-based fields such as a task status match names, ignoring case. A misspelled name
fails with a 400, and the n8n error lists the valid options.

## Trigger setup

1. Add **Dutify Trigger**, pick the credential, the workspace and one or more **Events** (for
   example *Task Created*). You can narrow the scope to a space, list or task.
2. Click **Listen for test event** or activate the workflow. The trigger registers a webhook for
   n8n's test or production URL, with a fresh random secret.
3. Every delivery is checked against its `X-Webhook-Signature-256` header (`sha256=` HMAC-SHA256 of the raw body with
   that secret). A delivery that fails the check is answered with 401 and does not start the
   workflow.
4. Deactivating the workflow (or ending the test listen) deletes the webhook.

n8n must be reachable from the internet for deliveries to arrive. Self-hosted instances need
`WEBHOOK_URL` set to their public URL.

## Known gaps

- **Trigger sources:** only Project Management events for now. Codexum (wiki) and Roadmarq
  (feature request and bug) events are coming. Hub meeting events are not available to API keys.
- **Webhook removal after deliveries:** Dutify currently refuses to delete a PM webhook that
  has delivered at least once (409 ENTITY_IN_USE). The trigger then logs a warning and leaves
  the webhook in place. On the FREE plan, leftover webhooks count against the 3-webhook limit.
  Deactivate or remove them under PM Webhook if you hit the limit. A backend fix is pending.
- **Not usable with API keys yet** (Dutify refuses them with 403): Import Job list/get (needs
  `imports:read`) and User → Update Current (needs `users:write`).
- **Sprints** must be enabled in the space settings before sprint operations work. The node has
  no operation to enable them.
- **Plan limits apply** as in the app. On FREE, for example: public task sharing and public
  wiki page sharing are refused, there is one extra dashboard, some widgets are PRO only, and
  there is one wiki space.
- **Roadmarq:** a new bug waits in the moderation queue and only appears in board lists after it
  is approved (Bug → Moderate). An unknown short ID currently answers 400 rather than 404.
- **Hub:** API keys cannot upload recordings, so Recording and Lens act on existing calls only.

## Development

```bash
npm install
npm test           # unit tests (test/unit)
npm run lint
npm run build
npm run dev        # n8n with this node, rebuilt on change
npm run test:live  # live tests against a real Dutify workspace (see below)
```

### Live tests

`npm run test:live` runs `test/live/*.live.test.ts` against production Dutify, one file at a
time. The suites skip themselves unless `.dutify-test.env` (gitignored, never committed) exists
in the project root with `DUTIFY_BASE_URL`, `DUTIFY_API_KEY`, `DUTIFY_TEST_WORKSPACE`,
`DUTIFY_TEST_USER_EMAIL` and `DUTIFY_TEST_USER_ID`. They use only that key, never a
`DUTIFY_API_KEY` from the shell. Every object a test creates is deleted when its file finishes.

The test workspace is **"n8n Live Tests"** (identifier `TdoMDsRAm4`, FREE plan). It is owned by
the test user `n8n-live-test@example.com`. Run the live tests only there.
