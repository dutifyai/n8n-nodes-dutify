# @dutifyai/n8n-nodes-dutify

n8n community nodes for [Dutify](https://dutify.ai): Project Management, Codexum (wiki),
Roadmarq (feature requests and bugs) and Hub (meeting recordings).

- **Dutify** — an action node with one resource per Dutify object (see the list below).
- **Dutify Trigger** — starts a workflow on Project Management, Codexum (wiki) or Roadmarq
  (feature request) events, or when a Hub meeting finishes processing. Every event is delivered
  by a Dutify webhook that the trigger registers and removes itself.

The package has no runtime dependencies.

## Install

In n8n, open **Settings → Community Nodes → Install**, enter `@dutifyai/n8n-nodes-dutify`, and confirm.
Both nodes then show up in the node panel under "Dutify".

> The package is not published to npm yet. Until it is, the install above will not find it.

## Credential: a personal API key

The nodes authenticate with a Dutify **personal API key** (it starts with `du_live_`).

1. In Dutify Project Management, open **Settings → Personal API keys**
   (`https://cloud.dutify.ai/manage/settings/personal-api-keys`) and create a key. The key is
   shown once, so copy it then.
   - **Access:** choose **All my permissions** (the default). The nodes cover Project
     Management, Codexum, Roadmarq and Hub, so they need every scope of those products. A
     **Read only** key or a key with chosen scopes works only for the operations those scopes
     allow; the rest fail with 403. Meeting webhooks (and the Meeting Processed trigger) need
     `webhooks:read`/`webhooks:write` together with `recordings:read`; Recording → Upload needs
     `recordings:write`. Send to Jira/ClickUp/Airtable also reads `integrations:read` to check the
     integration is connected first, because Dutify accepts a send without one and drops it.
   - The key never grants more than your own membership: it works in the workspaces and
     products you already belong to.
2. In n8n, add a **Dutify API** credential and paste the key. Leave **Base URL** at
   `https://dutify.ai` unless you run another Dutify instance.
3. Save. n8n tests the credential against `GET /mp/api/v1/api-keys/current`.

A personal key works in every workspace you belong to. Each node has a **Workspace** field
(pick from the list, or enter its identifier). The node sends the workspace on every request.

## Resources

| Area           | Resources                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account        | Account (who am I, list/find my workspaces), Workspace (context, dashboard, reference data, feature request boards, wiki spaces)                      |
| Tasks          | Task, Task Comment, Task Relationship, Task Sharing, Time Entry, Saved Filter                                                                         |
| Structure      | Space, Folder, List, Custom Field, Tag, View                                                                                                          |
| Planning       | Sprint (groups, sprints, tasks, burndown), Automation                                                                                                 |
| People         | Team, Member, Invitation, Import Job, User, Notification, Activity Log                                                                                |
| Integration    | PM Webhook (manage webhooks, deliveries, replay)                                                                                                      |
| Codexum (wiki) | Codexum Page (Markdown in and out), Codexum Space (incl. public wiki settings), Codexum Attachment (binary upload)                                    |
| Roadmarq       | Feature Request, Bug                                                                                                                                  |
| Hub            | Call (incl. delete, send action items to Jira/ClickUp/Airtable, custom prompt), Recording (upload, status, signed media URLs, reprocess, summaries), Lens (ask), Meeting Webhook (manage webhooks, test delivery, delivery log), Hub Workspace (members, custom prompt, default workspace), Hub Integration (connected integrations, preferred one), Calendar Event (events, event and series prompts) |

Pickers load names from your workspace (spaces, lists, statuses, members, boards, pages and
more). Name-based fields such as a task status match names, ignoring case. A misspelled name
fails with a 400, and the n8n error lists the valid options.

## Trigger setup

The trigger has four sources:

| Source                          | Starts the workflow when                                                                     | Settings                                                                                                                                                                      | Signature header          |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Project Management**          | a PM event happens (task created, comment added, …)                                          | one or more **Events**; optional scope (space, folder, list or task)                                                                                                          | `X-Webhook-Signature-256` |
| **Codexum (Wiki)**              | a wiki event happens (`wiki.page.published`, `wiki.comment.added`, …)                        | one or more **Events**; optional scope (a wiki space, or a page and the pages below it)                                                                                       | `X-Webhook-Signature-256` |
| **Roadmarq (Feature Requests)** | a feature-request event happens (`feedback.request.created`, `feedback.bug.created`, …)      | one or more **Events**; optional scope (a board, a feature request such as `FR-12`, or a bug report)                                                                          | `X-Webhook-Signature-256` |
| **Meeting Processed**           | a Hub meeting of the workspace finishes processing (an upload, a bot or a desktop recording) | **Sections** of the meeting to send: summary, key points, action items and tasks by default; also transcript, notes, insights, themes, scores, speakers, tags, enhanced notes | `X-Dutify-Signature`      |

The wiki and feature-request events are PM webhooks as well. The trigger loads their list from
Dutify, so new events show up without a node update. Their deliveries share PM's envelope:
`{version, id, type, timestamp, workspaceIdentifier, source, eventId, data}`.

- `source` is `pm`, `codexum` or `roadmarq`.
- `eventId` is the same on a retry or a replay. Use it to drop duplicates.
- `data` is a thin summary of the item: IDs, keys, title, status and the actor. It carries no
  page content, comment text or emails. Fetch the item with the Dutify node if you need more.

Dutify sends an event only while the key's user can still see the item. The key also needs the
product's read scope (wiki or feature requests). Security bug reports are never delivered to the
trigger: only a workspace admin signed in to Dutify can opt a webhook in to them, never an API key.

1. Add **Dutify Trigger**, pick the credential, the **Source**, the workspace and its settings.
2. Click **Listen for test event** or activate the workflow. The trigger registers a webhook for
   n8n's test or production URL, with a fresh random secret.
3. Every delivery is checked against its signature header (`sha256=` + the hex HMAC-SHA256 of
   the raw body with that secret). A delivery that fails the check is answered with 401 and
   does not start the workflow. Dutify signs no timestamp, so the check cannot reject a replayed
   delivery; a meeting delivery carries `X-Dutify-Delivery-Id` (the same on a retry) if your
   workflow needs to drop duplicates.
4. Deactivating the workflow (or ending the test listen) deletes the webhook. A PM webhook that
   Dutify refuses to delete is paused instead (see Known gaps).

A meeting webhook made by the trigger is bound to the chosen workspace: it receives only that
workspace's meetings. To try it without waiting for a meeting, use **Meeting Webhook → Send Test
Delivery** on the trigger's webhook (it is named "n8n"): Hub sends your latest processed meeting
of the workspace, marked `"test": true`. Hub allows 10 meeting webhooks per user and accepts only
public `https://` URLs.

n8n must be reachable from the internet for deliveries to arrive. Dutify refuses a local n8n
URL with 400 `WEBHOOK_URL_NOT_ALLOWED`, so the trigger cannot register one. That covers
`localhost`, a private or link-local IP such as `192.168.x.x`, `10.x.x.x` or `127.0.0.1`, a bare
host name, and `*.svc` / `*.cluster.local` names. To try the trigger on a local n8n, expose it
through a public tunnel (for example ngrok or a Cloudflare tunnel) and set `WEBHOOK_URL` to the
tunnel URL. Self-hosted instances need `WEBHOOK_URL` set to their public URL. If you change `WEBHOOK_URL` later, the trigger registers
a new webhook at the new URL and leaves the old one registered at the old URL, where it keeps
counting against the plan's webhook limit. Remove or pause the old one in Dutify (PM Webhook →
Delete, or Update with Active off).

## Known gaps

- **Webhook lifecycle:** deactivating the trigger deletes its webhook. If PM refuses the
  delete (older Dutify versions answered 409 ENTITY_IN_USE for a webhook that had delivered),
  the trigger pauses the webhook instead. Activating again reuses a webhook already at that n8n
  URL and switches it back on with a new secret, so each n8n URL (test and production) keeps
  one webhook. A webhook Dutify paused itself (for example after a day of failed deliveries
  while n8n was down) is switched back on the same way when you deactivate and activate the
  workflow again. n8n 2.x does not re-check webhook triggers when it restarts, so a restart
  alone does not switch it back on. Paused webhooks still count against the plan's webhook
  limit (3 on FREE); delete them in Dutify if you no longer need them. Meeting webhooks follow
  the same rules (one per n8n URL, reused and switched back on when activated again), except that
  Hub always deletes them.
- **Member administration** (changing a role, removing a member, leaving a workspace,
  transferring ownership) is not in the node. Dutify keeps it for signed-in users in the app and
  refuses it for API keys. Member → Get Many lists the members.
- **Subtasks** must be switched on in the space settings before a task can get a parent.
- **Sprints** must be enabled in the space settings before sprint operations work. The node has
  no operation to enable them.
- **Plan limits apply** as in the app. On FREE, for example: public task sharing and public
  wiki page sharing are refused, there is one extra dashboard, some widgets are PRO only, and
  there is one wiki space.
- **Roadmarq:** a new bug waits in the moderation queue and only appears in board lists after it
  is approved (Bug → Moderate).
- **Hub uploads:** Recording → Upload places the recording in the selected workspace and uses its
  transcription quota. Hub limits uploads to 5000 MiB per file and 10 in progress per user; the
  node refuses a larger file before it starts. The file is streamed from n8n's binary data in
  16 MiB parts, so the node holds only one part in memory at a time (n8n 2.x keeps binary data
  on disk, in S3 or in the database by default). An upload that fails is cancelled in Hub, so it does not keep an upload
  slot. The upload returns at once with the `recordingId`; processing takes a few minutes (poll
  Recording → Get Processing Status, or use the Meeting Processed trigger). For an uploaded audio
  file, Get Media URL and Get Audio URL return signed URLs; an uploaded video answers 400 on
  both (Hub does not give video playback links to API keys), and an audio file has no preview
  image, so Get Preview URL answers 400. A finished upload reports progress 95, not 100; use
  `processed` from Get Processing Status.
- **Lens** spends the workspace's Lens credits; when they run out, Lens Ask fails with Hub's
  "out of Lens credits" message.
- **Hub errors** come as plain text (for example `No such webhook`); the node shows that text as
  the error message.

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
`DUTIFY_API_KEY` from the shell. Every object a test creates is deleted when its file finishes,
except the one test recording, which the Hub suite reuses on every run.

Two optional settings in the same file control the Hub suite:

- `DUTIFY_TEST_AUDIO`: path to an audio file. The suite uploads it (Recording → Upload) only when
  the test workspace has no recording yet, and waits until it is processed. Without a recording
  and without this file, the Hub suite skips.
- `DUTIFY_TEST_PAID_OPS=1`: also runs Regenerate Summary, Reprocess and Lens Ask, which spend AI
  credits. Leave it out for everyday runs.
- `DUTIFY_TEST_VIDEO`: path to a short mp4. With `DUTIFY_TEST_PAID_OPS=1`, the suite uploads it,
  checks its preview thumbnail (Get Preview URL), and deletes the call again.

`test/live/trigger.live.test.ts` delivers real events to the Dutify Trigger. It starts a local
HTTP receiver and an [ngrok](https://ngrok.com) tunnel to it, so ngrok v3 must be installed and
signed in (the path defaults to `D:\Program Files\ngrok-v3-stable-windows-amd64\ngrok.exe`; set
`NGROK_EXE` to change it). It stops only the ngrok process it started.

The test workspace is **"n8n Live Tests"** (identifier `TdoMDsRAm4`, FREE plan). It is owned by
the test user `n8n-live-test@example.com`. Run the live tests only there.
