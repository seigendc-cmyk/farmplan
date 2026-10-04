# The Brain: activity log + conversational search

Decided 2026-10-03. Goal: the app keeps a readable record of everything that happens (actions, notes, voice, photos) and people can chat with it — with an admin deciding who can see and do what.

## Principles
1. **One append-only event stream.** Everything the brain knows is an *activity event*: who, when, on which device, what happened, as a plain sentence, plus links to the record it is about. The chat never reads anything the event stream and the existing tables don't already hold.
2. **Access is decided before retrieval, never after.** Every event has a domain (`ops`, `finance`, `admin`). A person sees an event if they hold that domain's level, or (at the lowest level) if they made it. The same filter runs for the timeline, search and the chat's tools, so the chat cannot leak what the person could not open themselves.
3. **Offline first.** Capture, storage and keyword search work with no signal. Only the *chat model call* needs the internet.
4. **The model gets the least it needs.** The owner chooses what leaves the device (names only / redacted snippets / full snippets). Default: redacted.
5. **Answer before act.** The chat answers first. Doing things (recording rain, paying) arrives last, as propose → confirm, through the same service functions and permission checks the screens use.

## Layers (each ships and is useful on its own)
| Layer | What | Status |
|---|---|---|
| **L1 Ledger & access** | `activity_log` (synced, append-only), automatic capture from every save, notes, access levels (admin assigns per role), Activity timeline with search and filters | built |
| L2 Media | Photos and voice notes captured on the phone, stored as files on the device, metadata synced; voice → text on-device where the platform allows, photo → description by Claude vision (opt-in). Their text becomes events, so L3/L4 treat them like any note | next |
| L3 Index | SQLite full-text search over events and notes, with the same access filter; optional embeddings later | |
| L4 Chat | Conversation with tool use: *query numbers* (the existing validated read-only SQL), *search the log*, *open a record*. Answers in words with citations. Runs through a small Supabase Edge Function that holds the API key (staff never see it), with per-user limits; owner-only direct-key mode stays | |
| L5 Actions | Propose → confirm → execute, permission `brain.chat.act`, every action logged as an event | |
| L6 Shared brain | The same event schema exported so other apps (farmPLAN Livestock, POS, …) feed one stream per tenant | |

## Access levels (L1)
Admin picks a level per role in Users & access → Roles (or ticks individual permissions):

| Level | Can see | Can write |
|---|---|---|
| None | nothing | – |
| Own activity | events they made | notes |
| Operations | all field, curing, stock, machine and labour activity | notes |
| Management | + finance: sales, payments, buyers, contracts, budgets | notes |
| Full | + administration: users, roles, devices, pairing | notes |

Permissions: `brain.note.record`, `brain.log.view_own`, `brain.log.view_ops`, `brain.log.view_finance`, `brain.log.view_admin`.
Defaults: Owner everything; Farm Manager Management; Field Recorder Own activity.

## What is captured
Every insert, update and delete of a synced record becomes an event with a human sentence ("Tendai recorded harvest batch H-LA-00007: 120 kg from F-04"). Derived rows that would only repeat their parent (cost entries, sale lines, operation inputs…) are not logged separately. Admin actions (users, roles, devices) are mirrored from the audit log. Existing records are back-filled once on upgrade as `system` events dated by when they were created. Sentences deliberately leave out pay rates and prices; those live in the records and need finance access to query.

## Known limits (L1)
* "Own activity" is enforced on the device; in the cloud the database enforces the three domain levels (it cannot know a local user's id).
* Events are tamper-evident, not tamper-proof: the cloud forbids updates and deletes, and stamps the signed-in account that uploaded each event, but a member could still upload a fabricated event under another person's name (the stamp shows the truth).
* Over the Wi-Fi hub, phones can write events but cannot read other people's.
* No retention policy yet; the log only grows.

## Chat design (as built)
Router, not author: an engine picks one catalogue item and its parameters; fixed queries produce the numbers; a sentence is worded by code or by the local model and rejected if it contains any number not in the table. The catalogue filters itself by the caller's permissions, so the model is only ever offered what the person could open. See `src/brain/`.

## Speed and quality evidence (what is and is not measured)
* **Measured here:** lookups run in ≤3 ms on a seeded farm (1,200 labour, 800 cost, 1,800 activity rows); keyword routing is instant. Keyword floor: 100% on the 82-question main set (tuned after seeing its misses; 24 questions added in October 2026 for six new lookups: contract delivery vs target, stock on hand, seedbeds, storage ready to open, service due, overdue obligations), 17/18 on the 18-question unseen set (`HOLDOUT_SET`, never tuned against and unchanged by the new lookups; the miss is an off-topic question matched to grade prices, harmless because the catalogue is read-only). The router prompt is ~405 tokens (was ~330), which a CPU-only local model reads on every question.
* **Not measured here:** any real model. The build sandbox cannot download model files, so latency and accuracy of qwen2.5:3b-instruct (or any other model) on an 8 GB CPU-only PC are unknown until `tools/brain-bench` is run there. Rough expectation only: a few seconds per routed question once the prompt is cached, and roughly double that if model wording is on, which is why wording is off by default.
