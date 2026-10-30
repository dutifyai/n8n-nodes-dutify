# @dutifyai/n8n-nodes-dutify

n8n community nodes for [Dutify](https://dutify.ai): Dutify Cloud (projects and tasks), Codexum
(docs and wiki), Roadmarq (feedback, feature requests and bugs) and Dutify Hub (meetings,
recordings and the AI notetaker).

- **Dutify**: an action node with one resource per Dutify object (see the list below).
- **Dutify Trigger**: starts a workflow on Dutify Cloud, Codexum (wiki) or Roadmarq (feature
  request) events, or when a Hub meeting finishes processing. Every event is delivered by a
  Dutify webhook that the trigger registers and removes itself.

The package has no runtime dependencies.

## Install

In n8n, open **Settings → Community Nodes → Install**, enter `@dutifyai/n8n-nodes-dutify`, and confirm.
Both nodes then show up in the node panel under "Dutify".

> The package is not published to npm yet. Until it is, the install above will not find it.

## Credential: a personal API key

The nodes authenticate with a Dutify **personal API key** (it starts with `du_live_`).

1. In Dutify Cloud, open **Settings → Personal API keys**
   (`https://cloud.dutify.ai/manage/settings/personal-api-keys`) and create a key. The key is
   shown once, so copy it then.
   - **Access:** choose **All my permissions** (the default). The nodes cover Dutify Cloud,
     Codexum, Roadmarq and Dutify Hub, so they need every scope of those products. A
     **Read only** key or a key with chosen scopes works only for the operations those scopes
     allow; the rest fail with 403. Meeting webhooks (and the Meeting Processed trigger) need
     `webhooks:read`/`webhooks:write` together with `recordings:read`; Recording → Upload needs
     `recordings:write`.
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
| Structure      | Space (create, get, update incl. subtasks and sprints, delete), Folder, List, Custom Field, Tag, View                                                 |
| Planning       | Sprint (groups, sprints, tasks, burndown), Automation                                                                                                 |
| People         | Team, Member, Invitation, Import Job, User, Notification, Activity Log                                                                                |
| Integration    | Dutify Cloud Webhook (webhooks for Dutify Cloud, Codexum and Roadmarq events, deliveries, replay)                                                     |
| Codexum (wiki) | Codexum Page (Markdown in and out), Codexum Space (incl. public wiki settings), Codexum Attachment (binary upload)                                    |
| Roadmarq       | Feature Request, Bug, Roadmarq Board (update its settings)                                                                                            |
| Dutify Hub     | Call (incl. delete, custom prompt), Recording (upload, status, signed media URLs, reprocess, summaries), AI Coworker (ask, usage), Meeting Webhook (manage webhooks, test delivery, delivery log), Hub Workspace (members, custom prompt, default workspace), Hub Integration (connected integrations, preferred one), Calendar Event (events, event and series prompts) |

Pickers load names from your workspace (spaces, lists, statuses, members, boards, pages and
more). Name-based fields such as a task status match names, ignoring case. A misspelled name
fails with a 400, and the n8n error lists the valid options.

**Errors** show Dutify's own message as the n8n error message and its error code in the
description (for example `Code: NOT_FOUND`), for every product. With **On Error → Continue**,
the output item carries `error`, `description`, `httpCode` and `errorCode`, so a workflow can
branch on the code.

**Get Many** operations return everything with **Return All**, page by page, and stop at
**Limit** otherwise. That includes the pages of a Codexum space (one level at a time, any
number of pages) and the bugs of a Roadmarq board.

### Dutify Cloud

- **Subtasks** and **Sprints** are off in a new space. Turn them on with Space → Update
  (Subtasks, Sprints); then a task in that space can get a parent, and the sprint operations
  work there.
- **Member administration** (changing a role, removing a member, leaving a workspace,
  transferring ownership) is done by signed-in users in the Dutify app; Dutify refuses it for
  API keys. Member → Get Many lists the members.

### Roadmarq

- A new bug waits for approval when the board's **Bug Approval** setting is All (the default),
  and appears in board lists once it is approved (Bug → Moderate). Set Bug Approval to
  Anonymous Only or None with Roadmarq Board → Update to list bugs from signed-in members at
  once.
- **Roadmarq Board → Update** changes only the fields you set: a setting you leave out keeps its
  value, and a switch you set to off (for example Bug Reports) is turned off. It needs the Manage
  Settings permission on the board.

### Dutify Hub

- **Uploads:** Recording → Upload places the recording in the selected workspace and uses its
  transcription quota. Hub accepts up to 5000 MiB per file and 10 uploads in progress per user;
  the node refuses a larger file before it starts. The file is streamed from n8n's binary data in
  16 MiB parts, so the node holds only one part in memory at a time (n8n 2.x keeps binary data
  on disk, in S3 or in the database by default). An upload that fails is cancelled in Hub, so it
  does not keep an upload slot. The upload returns at once with the `recordingId`; processing
  takes a few minutes (poll Recording → Get Processing Status, or use the Meeting Processed
  trigger).
- **Media URLs:** Get Media URL and Get Audio URL return signed links for uploaded audio and
  video. An uploaded video has no separate audio track, so Get Audio URL signs the video file.
  Only a video has a preview image: for an audio recording Get Preview URL answers 404
  `NO_PREVIEW`. A recording that is still processing answers 409 `RECORDING_STILL_PROCESSING`,
  and a recording you cannot see answers 404 `NOT_FOUND`.
- **Progress:** Get Progress and Get Processing Status report 100 once a recording is processed.
- **Reprocess:** Recording → Reprocess queues a full re-run (transcription, summary, key points
  and action items) and returns at once with `scheduled: true`, so it never waits past n8n's
  HTTP timeout. Follow the run with Get Processing Status or the Meeting Processed trigger.
  Dutify refuses it with 404 `NOT_FOUND`, 402 `TRANSCRIPTION_QUOTA_EXCEEDED`, or 409
  (`WORKFLOW_IN_PROGRESS` while a run is going, `RECORDING_MEDIA_MISSING` when there is nothing
  to run on). For a new summary only, Regenerate Summary is faster and cheaper.
- **AI Coworker:** each AI Coworker → Ask question uses one unit of the workspace's AI Coworker
  usage: its monthly allowance first, then purchased usage. **AI Coworker → Get Usage** reads
  what is left: `allowanceRemaining` of the `monthlyAllowance` (renewed at `cycleResetsAt`),
  `purchasedBalance` and `total`. When `total` is 0, Ask fails with 402
  `AI_COWORKER_USAGE_EXHAUSTED` until the allowance renews or a workspace owner adds more.

## Changelog

### 0.1.5

- Fixed: the Space, List, Status, Member, Task Type and other pickers that list a workspace's
  items stayed empty when they were opened before the Workspace was chosen. They now reload
  whenever the Workspace changes.

### 0.1.4

- Removed: the three Call operations that selected a third-party destination for a call's
  action items (the Select ... Destination operations), with their fields and pickers. Dutify
  Hub no longer supports those destinations. A saved workflow that uses one of them needs a
  different operation. Hub creates the action items of your calls in Dutify Cloud.

## Trigger setup

The trigger has four sources:

| Source                          | Starts the workflow when                                                                        | Settings                                                                                                                                                                      | Signature header          |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Dutify Cloud**                | a Dutify Cloud event happens (task created, comment added, and so on)                           | one or more **Events**; optional scope (space, folder, list or task)                                                                                                          | `X-Webhook-Signature-256` |
| **Codexum (Wiki)**              | a wiki event happens (`wiki.page.published`, `wiki.comment.added`, and so on)                   | one or more **Events**; optional scope (a wiki space, or a page and the pages below it)                                                                                       | `X-Webhook-Signature-256` |
| **Roadmarq (Feature Requests)** | a feature-request event happens (`feedback.request.created`, `feedback.bug.created`, and so on) | one or more **Events**; optional scope (a board, a feature request such as `FR-12`, or a bug report)                                                                          | `X-Webhook-Signature-256` |
| **Meeting Processed**           | a Hub meeting of the workspace finishes processing (an upload, a bot or a desktop recording)    | **Sections** of the meeting to send: summary, key points, action items and tasks by default; also transcript, notes, insights, themes, scores, speakers, tags, enhanced notes | `X-Dutify-Signature`      |

Codexum and Roadmarq events are delivered by Dutify Cloud webhooks as well. The trigger loads
their list from Dutify, so new events show up without a node update. All three sources share one
envelope: `{version, id, type, timestamp, workspaceIdentifier, source, eventId, data}`.

- `source` names the product: `pm` (Dutify Cloud), `codexum` (Codexum) or `roadmarq`
  (Roadmarq). These are the values Dutify sends, so filter on them as written.
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
   workflow needs to drop duplicates. A signed `webhook-ping` (Dutify Cloud checking that a
   webhook it paused can be reached again) is answered with 200 and does not start the workflow.
4. Deactivating the workflow (or ending the test listen) deletes the webhook. If Dutify refuses
   the delete, the trigger pauses the webhook instead.

### Webhook lifecycle

Activating the trigger reuses a webhook already at that n8n URL and switches it back on with a
new secret, so each n8n URL (test and production) keeps one webhook. A webhook Dutify paused
itself (for example after a day of failed deliveries while n8n was down) is switched back on the
same way when you deactivate and activate the workflow again. n8n 2.x does not re-check webhook
triggers when it restarts, so a restart alone does not switch it back on. Paused webhooks still
count against the plan's webhook limit (3 on FREE); delete them in Dutify if you no longer need
them. Meeting webhooks follow the same rules (one per n8n URL, reused and switched back on when
activated again), except that Hub always deletes them.

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
tunnel URL. Self-hosted instances need `WEBHOOK_URL` set to their public URL. If you change
`WEBHOOK_URL` later, the trigger registers a new webhook at the new URL and leaves the old one
registered at the old URL, where it keeps counting against the plan's webhook limit. Remove or
pause the old one in Dutify (Dutify Cloud Webhook → Delete, or Update with Active off).

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
- `DUTIFY_TEST_PAID_OPS=1`: also runs Regenerate Summary, Reprocess and AI Coworker → Ask, which
  use paid AI processing. Leave it out for everyday runs.
- `DUTIFY_TEST_VIDEO`: path to a short mp4. With `DUTIFY_TEST_PAID_OPS=1`, the suite uploads it,
  checks its preview thumbnail (Get Preview URL), and deletes the call again.

`test/live/trigger.live.test.ts` delivers real events to the Dutify Trigger. It starts a local
HTTP receiver and an [ngrok](https://ngrok.com) tunnel to it, so ngrok v3 must be installed and
signed in (the path defaults to `D:\Program Files\ngrok-v3-stable-windows-amd64\ngrok.exe`; set
`NGROK_EXE` to change it). It stops only the ngrok process it started.

The test workspace is **"n8n Live Tests"** (identifier `TdoMDsRAm4`, FREE plan). It is owned by
the test user `n8n-live-test@example.com`. Run the live tests only there.
