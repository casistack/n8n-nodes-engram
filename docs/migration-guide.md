# Migration Guide

For the latest release, follow the [current upgrade instructions](../README.md#upgrading-to-v086). This guide preserves earlier upgrade, activation and recovery instructions. Use the sections relevant to your starting version and the features you enable; you do not need to install every intermediate release. Historical installation versions below describe those releases, not a recommendation to downgrade.

Keep all applicable storage compatibility and rollback restrictions when upgrading to a newer release. Never restore an old snapshot over newer conversations.

## Earlier Upgrade Instructions

- [Upgrading to v0.8.5](#upgrading-to-v085)
- [Upgrading to v0.8.4](#upgrading-to-v084)
- [Upgrading to v0.8.3](#upgrading-to-v083)
- [Upgrading to v0.8.2](#upgrading-to-v082)
- [Upgrading to v0.8.1](#upgrading-to-v081)
- [Upgrading to v0.8.0](#upgrading-to-v080)
- [Upgrading to v0.7.2](#upgrading-to-v072)
- [Upgrading to v0.7.1](#upgrading-to-v071)
- [Upgrading to v0.7.0](#upgrading-to-v070)
- [Upgrading to v0.6.0](#upgrading-to-v060)
- [Upgrading from v0.4.x](#upgrading-from-v04x)

---

## Upgrading to v0.8.5

Upgrading from an earlier release or enabling automatic memory for the first time? See the [migration guide](migration-guide.md) for previous upgrade steps, profile setup and storage compatibility restrictions.

This patch adds optional native memory diagnostics. It does not change models, memory acceptance, retrieval policies, namespaces or saved defaults, and does not promise faster replies.

1. Take fresh, consistent workflow and backend-native backups: complete embedded files or a Neo4j database backup. Preserve storage/producer mapping, namespaces, bindings, aliases and existing queue recovery data.
2. Install `n8n-nodes-engram@0.8.5`, restart n8n and refresh the editor. Begin with an inactive workflow copy and a separately restored store whose logical ownership mapping is preserved.
3. On Admin **Capture Human Memory** and Memory v3 using **Autonomous Personal Memory**, optionally enable **Native Memory Diagnostics**. It defaults to **Disabled** and can be enabled independently on the operations you want to inspect. No reset, re-enrollment or re-extraction is required.
4. Inspect `native_diagnostics_v1` in Capture output and Memory load/save diagnostic output. Verify normal and tool-assisted turns, graph recall with the source outside recent history, capture receipts and duplicate handling before expanding the rollout. Diagnostics do not authorize another agent run or message delivery.

The sidecar reports native interpretation request counts, available token usage, client request-to-headers and headers-to-completion envelopes, operation elapsed time and available coarse storage totals. Elapsed time covers the native operation body; earlier setup/initialization and the diagnostic history preview performed after a save are excluded. Missing usage remains unknown (`null`), and request completion does not mean that a graph claim was accepted or persisted. It reports no price or billing estimate. Memory query embeddings and unrelated model/tool calls are not included in native interpretation totals.

Storage observations cover supported callbacks only; unavailable measurements remain `null`. They do not separately measure cold initialization, parsing, indexing, filesystem sync or cache hits. The body envelope includes response reading and local decoding/validation. Nested request/storage totals must not be added to elapsed time or used to infer provider compute time. Observer errors or an unavailable sidecar are not evidence of zero work. The existing `execution_diagnostics` format remains unchanged.

Rollback: disable **Native Memory Diagnostics** while keeping the supported binary and all newly written conversations. This option does not introduce a new memory format; existing downgrade and mixed-version restrictions still apply, including those for context-qualified records and durable queues. Never restore an old snapshot over newer legitimate messages. No model switch, worker activation, automatic historical rewrite or memory purge is part of this upgrade.

---


---

## Upgrading to v0.8.4

This patch reduces repeated validation during ordinary conversation writes to an autonomous-enrolled embedded store. Ordinary queue and file-lock waiting no longer consumes that write's structural validation budget. Native capture and configured execution budgets keep their existing behaviour. This does not guarantee a particular chat response time.

Existing node versions, models, namespaces, bindings, memory policies and saved defaults are preserved. No reset, re-enrollment or bulk re-extraction is required.

1. Take fresh, consistent workflow and backend-native backups: complete embedded files or a Neo4j database backup. Preserve producer/storage mapping, logical store identity, namespaces, bindings, aliases and any existing durable-job recovery data.
2. Install `n8n-nodes-engram@0.8.4`, restart n8n and refresh the editor. Start with an inactive workflow copy and a separately restored store whose logical ownership mapping is preserved.
3. Verify normal and tool-assisted turns, accepted graph-only recall, capture receipts and duplicate-event handling. For a shared store, also verify an Existing / Custom writer in an unbound namespace after autonomous capture. Confirm that prior memory remains intact and final turns are saved once.
4. Optional: on Memory/Admin v3 using Autonomous Personal Memory, deliberately select **Context-Qualified Statements (V1) → Keep Literal When/Whenever Statements (V1)** on both Capture and Memory. The default is **Off (Existing Behaviour)**. This supports eligible first-person statements with one `when` or `whenever` clause; it retains the complete literal condition, qualifiers and ordering as an attributed statement, rather than asserting that the condition is true or current. It does not require a save command. Uncertain, quoted, reported, sensitive or unsupported statements remain subject to the existing safeguards. It does not convert the statement into a structured preference or enable another model or worker.
5. Use a fresh legitimate event for a changed policy. Reusing an existing event with a different policy conflicts rather than rewriting its source. Verify the persisted accepted claim and its qualified graph context with the source absent from recent history, then expand only after the canary passes. Review passive writers separately.

For first-time autonomous activation, follow the [v0.8.0 profile setup](#upgrading-to-v080) and [v0.8.1 configured-budget instructions](#upgrading-to-v081).

Rollback: turn off the optional context policy on the supported new binary while retaining newly written memory. After the optional context policy has written flagged sources or qualified records, the store is forward-only: keep readers and writers on 0.8.4 or a newer compatible version. A 0.8.3 binary fails closed on these descriptors and claims and refuses writes to that store. No data-preserving downgrade to 0.8.3 is supported; an older binary requires a separate compatible store that never received these records. Do not mix unsupported writer versions, reset memory or restore an old snapshot over newer conversations. Capture/provider work can still dominate response time; increasing a deadline is not a speed improvement.

---

## Upgrading to v0.8.3

This patch reduces repeated processing during autonomous personal-memory reads. Existing node versions, saved defaults, namespaces, bindings and memory policies are preserved. No new setting or node-version upgrade is required for this patch.

1. Take fresh, consistent workflow and backend-native backups. Preserve complete embedded files or the Neo4j database, producer workflow mapping, storage paths, logical store identity, namespaces, bindings and aliases. Include queue-aware recovery data where durable jobs already exist.
2. Install `n8n-nodes-engram@0.8.3`, restart n8n and refresh the editor. Begin with an inactive workflow copy and a separately restored store with its logical ownership mapping preserved. Moving an enrolled store to another producer path is not an activation step.
3. Keep the current model, route, temperature, source mappings and stable event IDs. Verify cold startup, recent conversation, accepted graph-only recall, capture receipts, duplicate events and multiple tool calls. Confirm that tool audits remain separate and final turns are saved once.
4. Expand only after the selected workflow passes. Review passive writers separately. When enabling Autonomous Personal Memory for the first time, follow the existing [v0.8.0 profile setup](#upgrading-to-v080) and [v0.8.1 configured-budget instructions](#upgrading-to-v081).

Provider-request latency and capture/write processing remain separate contributors to response time. This patch does not guarantee a particular response time.

No reset, purge, re-enrollment or bulk re-extraction is required. Prefer reverting explicit workflow/policy settings on the supported binary while preserving newly appended memory. Existing downgrade and mixed-version writer/worker restrictions remain in force. Never restore an old snapshot over newer conversations as routine rollback.

---

## Upgrading to v0.8.2

This patch reduces embedded-store processing overhead during automatic capture, memory retrieval and conversation saves. Existing node versions, saved defaults, namespaces and memory policies are preserved. The performance changes require no new setting or node-version upgrade. Installing the package does not enable an automatic-memory profile or start a background worker.

1. Take fresh, consistent workflow and backend-native backups. Preserve complete embedded files or the Neo4j database, producer workflow mapping, storage paths, logical store identity, namespaces, bindings and aliases. Include queue-aware recovery data where durable jobs already exist.
2. Install `n8n-nodes-engram@0.8.2`, restart n8n and refresh the editor. Begin with an inactive workflow copy and a separately restored store with its logical ownership mapping preserved. Moving an enrolled store to another producer path is not an activation step.
3. Keep the current model, route, temperature, source mappings and stable event IDs. Verify cold startup, recent conversation, accepted graph-only recall, capture receipts, duplicate events and a conversation with multiple tool calls. Confirm that tool audits remain separate and final turns are saved once.
4. Expand only after the selected workflow passes. Review passive writers separately. If enabling Autonomous Personal Memory for the first time, the existing [v0.8.0 profile setup](#upgrading-to-v080) and [v0.8.1 configured-budget instructions](#upgrading-to-v081) still apply.

After embedded-store initialization fails, cached-memory reads now report that failure instead of returning empty or stale data. Correct the backing file and retry initialization or restart the workflow; no memory reset is required. A failed initialization must not be treated as successful recall.

Monitor n8n memory use during rollout, particularly with large embedded stores or several active workflows. Faster repeated reads can retain more data in memory between writes. Provider-request latency remains separate from local storage work; this patch does not guarantee a particular response time.

No reset, purge, re-enrollment or bulk re-extraction is required. Prefer reverting explicit workflow/policy settings on the supported binary while preserving newly appended memory. Existing downgrade and mixed-version writer/worker restrictions remain in force. Never restore an old snapshot over newer conversations as routine rollback.

---

## Upgrading to v0.8.1

This patch adds configurable capture budgets and fixes Memory continuation across tool rounds. Existing node versions, saved defaults, namespaces and memory are preserved. Autonomous Personal Memory uses AI Agent **v3.1** with n8n **2.12.3 / Node.js 22** or **2.44.6 / Node.js 24**.

1. Take fresh, consistent workflow and backend-native backups. Preserve complete embedded files or the Neo4j database, producer workflow mapping, storage paths, namespaces, bindings and aliases. Begin with an inactive workflow copy and a separately restored store.
2. Install `n8n-nodes-engram@0.8.1`, restart n8n and refresh the editor. Keep the current model, route, provider temperature setting, source mappings and stable event IDs.
3. On both **Admin v3 > Capture Human Memory** and **Memory v3**, select **Capture Budget Policy > Configured Budgets (V1)**. Match the extraction deadline and all budget settings across the two nodes. Use **Preview Memory Policy** to inspect the selected policy.
4. Start with **Completion Budget > Use Remaining Extraction Deadline**, **Processing Budget > Use Remaining Extraction Deadline**, and **Finalization Reserve > Automatic**. Explicit completion/processing limits are 100–120000 milliseconds. A fixed reserve is 20–5000 milliseconds and must be smaller than the extraction deadline.
5. Verify capture acceptance, graph-only recall, normal and multi-tool conversations, duplicate events and saved provenance before expanding to other writers. Workflow success alone does not prove accepted graph memory.

**Existing Limits** remains the default. Selecting configured budgets removes the legacy five-second completion/processing ceilings for that selected path. Every stage remains within the original extraction deadline and current ownership lease; stage limits never add time. Preparation, each Memory read and the final Memory save have separate operation scopes, so agent/tool time does not consume a later final-save allowance. The extraction deadline is not memory expiry or a whole-workflow timeout. An individual provider-request timeout remains separate.

The configured policy applies to autonomous capture and Memory operations. Neo4j ordinary graph imports now use ordered batches to reduce database round trips while preserving row order, atomicity and existing import limits. Imports remain bounded. Use complete backend-native backups for recovery rather than generic JSON import.

Processing measures cumulative elapsed synchronous work, including parsing, validation, proof reconstruction, hashing, indexing and serialization. Provider/storage waits use the wall-time deadline. Configurable limits do not promise faster responses on larger stores. Configured Admin output adds `execution_diagnostics`: configured/effective allowances, observed elapsed time, cumulative synchronous work, last reached stage and first scope stop. These observations are not a commit receipt; `creationSummary` and `should_process` retain their meanings. An unavailable clock observation is `null`.

A durably acknowledged write followed by a verification timeout remains unconfirmed for continuation; that timeout alone does not quarantine an otherwise healthy embedded store. Persistence/integrity uncertainty retains recovery protection. No timeout authorizes another agent run or external send.

No reset, purge, source rewrite, destructive merge or bulk re-extraction is needed. Historical failed/leased events remain intact; changing settings does not rewrite their ownership or automatically replay them. Prefer policy rollback on the supported binary, preserving newly appended conversations. The existing old-package downgrade and mixed-version restrictions below still apply. Never restore an old snapshot over newer conversations as routine rollback.

---

## Upgrading to v0.8.0

Existing saved workflows, node versions and defaults are preserved. **Automatic Memory Interpretation > Literal Preferences (Existing)** remains the default. Select **Autonomous Personal Memory** explicitly to enable the new interpretation on Admin v3 and Memory v3.

With **Conservative Automatic**, useful personal statements can become accepted, attributed graph memory without a save command or routine manual review. Supported compound preferences preserve language variants, negation, scope and ordering. Eligible statements that cannot be verified as a structured preference may retain their exact wording as dated, attributed evidence. Unsupported or uncertain interpretation is not accepted merely because a model reports high confidence.

### Activate Autonomous Personal Memory

1. Back up workflows and the complete embedded store or Neo4j database consistently. Preserve exact namespaces, producer workflow IDs, storage paths, verified actor bindings and event IDs. A generic JSON export alone cannot restore privileged binding/ownership metadata.
2. Install `n8n-nodes-engram@0.8.0`, restart n8n and refresh the editor. Begin with an inactive workflow copy and a separately restored store. This interpreter supports AI Agent **v3.1** on n8n **2.12.3**.
3. Use Admin v3 **Capture Human Memory** before the agent, with **Capture Lifecycle > Replay Safe**. Connect **Proceed** to the agent and route **Stopped** separately from delivery. Map its `sourceId` into Memory v3's **Captured Human Source ID** and select **Captured Turn Lifecycle > Replay-Safe Captured Turn**.
4. Select **Autonomous Personal Memory** on both nodes and **Memory Behaviour > Conservative Automatic**. Use the same verified issuer/actor binding, stable **Current Turn ID**, backend and namespace. For embedded storage, set Admin's **Memory Workflow ID** to the exact workflow ID owning the Memory store and preserve its storage path. Match the extraction route, model, temperature mode/value, extraction request limit and deadline across Admin and Memory. **Explicit Requests Only** additionally requires trusted save intent; quoted commands do not establish authority.
5. Supply the complete raw human body as **Current Human Query** and **Raw Current Human Content**. If agent input adds application display labels, supply its complete formatted input and exact UTF-16 human-region boundaries. Do not mark quotations, conditions or other human content as display metadata.
6. Set **Extraction Execution > Synchronous** on both Admin capture and Memory. On Memory, keep **Entity Resolution > Bounded**, **Message Write Policy > Final Turns**, **History Filter > Provenance**, **Human Episode Kind > Active Human**, **Retention Policy > Keep Forever** and **Memory Fact Policy > Accepted Facts Only**. Persist human and final assistant messages; disable AI/system/tool extraction. Use **Provider Default** temperature where the model requires omission.

Inspect Admin's `creationSummary`, including `acceptedCoverage`, `sourceCoverage` and per-occurrence outcomes before acknowledging saved knowledge. Source persistence or workflow success alone does not establish accepted graph memory. Redelivery of the same event stops before another agent run; external delivery still needs the application's own idempotency controls.

The selected interpreter replaces general extraction for that writer; it does not run the v2 free-form pipeline in parallel. Keep workflows requiring that pipeline on their existing configuration. **Review First**, passive ingestion, historical/as-of modes for new autonomous claims and durable background execution are outside this interpreter's supported configuration. Existing graph records, interpreters and queue workers retain their behavior; no worker starts automatically.

Process one logical human event per execution. Tool continuations reuse admitted Memory within the same running execution. Unsupported Agent scopes fail before admission. Manual partial execution, cold resume or restart does not recreate that admission from a saved receipt. Credentials remain fixed for the admitted turn; same-credential secret rotation is read on the next turn.

Tool audits preserve the messages the host forwards, separately from conversational context and human extraction. On n8n 2.12.3, sequential tool rounds forward only the latest tool pair at final completion, so these audits are not a complete tool execution trace. Use n8n execution records for that purpose.

### Verify and Roll Back

Verify an ordinary compound preference, negative and uncertain/quoted statements, a temporary question, a normal turn, multiple tool rounds and cross-execution redelivery. Inspect accepted graph evidence and receipt coverage. Test graph-only recall with the original assertion and revealing acknowledgements excluded from recent history. Review active and passive group writers separately before expanding rollout.

Historical artifacts are not automatically relabelled or deleted. Use bounded read-only inspection or dry-run controls for any reviewed record-specific correction; ambiguous JSON remains conversation. No reset, purge, destructive merge or bulk re-extraction is required.

Prefer reverting explicit policy/workflow settings on the supported new binary while preserving newly appended conversations. Old-package downgrade and mixed-version writers/workers are unsupported after new ownership or claim records are written. Never overwrite newer conversations with an old snapshot as routine rollback. The [v0.7.2 recovery boundary](#verify-and-roll-back-1) also applies.

Native Admin capture using the Existing lifecycle now stops an already-owned event from a different or unknown original execution, preventing another agent run on redelivery. Provably same-execution capture and library memory-write replay retain their behavior; conflicting ownership/content still fails safely.

---

## Upgrading to v0.7.2

Existing saved workflows retain their defaults and node versions. Installing this release does not enable automatic acceptance, change namespaces, rewrite historical memory or start a queue worker. New **Memory v3** and **Admin v3** nodes default to **Memory Behaviour > Existing / Custom**.

### Back Up and Activate

1. Take fresh, consistent workflow and backend backups before installing `n8n-nodes-engram@0.7.2`. Preserve exact namespaces, verified alias mappings, storage paths and producer workflow IDs. Restart n8n, refresh the editor and confirm the package version.
2. Start with an inactive copy of one direct-conversation workflow and a separate restored store. Upgrade only the selected Memory/Admin nodes to **v3**. Preserve the current extraction route, model and provider-default temperature setting.
3. In **Admin > Automatic Memory > Create Verified Actor Binding**, select the exact memory namespace and producer workflow ID. Bind a trusted application's stable issuer/actor reference to an **existing, explicitly accepted subject UUID**. Supply the operator and review reason. A name, phone number, session key or model confidence alone does not create this binding. Reassignment and revocation require the current binding revision.
4. Select a profile deliberately. **Conservative Automatic** accepts supported source-grounded preferences; **Explicit Requests Only** additionally requires trusted save intent or an unquoted leading `Remember this:`; **Review First** proposes supported preferences. Use **Preview Memory Policy** to inspect the versioned effective policy, configured limits and identity readiness. Worker readiness is a separate check.
5. On Memory v3, retain **Bounded** resolution, enable knowledge extraction and **Final Turns**, persist human episodes, and disable extraction from AI/system/tool content. Map the verified actor issuer/reference and a stable **Current Turn ID** from trusted application input. Keep tool audits separate. Extraction credentials/model remain required configuration, although this first profile implementation uses deterministic preference parsing rather than model requests.
6. Supply the complete **Raw Current Human Content**. If agent input adds a display label, explicitly attest **Application-Owned Display Wrapper** and provide exact UTF-16 human-region offsets. This attestation is only for application display metadata; never use it to hide quotes, reports, conditions or other human context. No arbitrary label stripping occurs.

### Supported Automatic Memory

Profile version 1 supports complete literal first-person preferences such as `I prefer concise explanations.`, `I like bullet points.`, `I do not like long explanations.` when the value belongs to the supported language, explanation, presentation or format vocabulary. Supported negative preferences retain their polarity. Ambiguous, quoted, hypothetical, sensitive and unsupported statements remain in the episode history without being promoted to accepted facts. Complex preferences, nickname identity merging and dated commitments are outside this profile version. No **Personal Assistant** profile is offered yet.

Exact repeated claims reuse the logical fact; a conflicting supported claim requires review. Rejected/manual decisions remain protected. Claim receipts distinguish accepted, proposed, rejected, deferred, unchanged and not-selected results, with persistence and mutation state. Source-episode acceptance is separate from fact acceptance. New budget diagnostics use a separate versioned `budget` field; the existing error categories remain unchanged.

Current personalization suppresses revoked bindings, unsupported evidence and unresolved opposite claims. Historical modes may return intact source-grounded preference records with an explicit historical qualification: their recorded review state does not establish current identity or validity. As-of retrieval excludes new claims recorded after the requested date. Literal value nodes are never presented independently as personal facts.

For an acknowledgement based on actual saving, put **Admin > Automatic Memory > Capture Human Memory** before the agent. Pass its **sourceId** into Memory v3's **Captured Human Source ID**, using the same backend, exact namespace, actor, turn ID, policy and formatted input. The current source is excluded from history, and the subsequent writer saves the final assistant/audits without saving or extracting the human turn again. Only `facts_accepted` confirms accepted graph knowledge; `review_required`, `not_saved`, `queued` and `unconfirmed` do not. A synchronous retry with a saved source but no recoverable receipt remains unconfirmed. An ordinary agent response generated before memory saving must not promise durable acceptance.

Budget/execution settings are separate from acceptance. The deadline is one extraction work budget, not memory expiry or the whole workflow timeout. Increasing it does not broaden accepted evidence. Durable mode still requires an explicitly deployed matching **Admin v3** worker, route and profile; queued work is not already indexed. Extraction retries never resend an external chat message.

### Verify and Roll Back

Before expanding rollout, verify normal and tool-assisted writes, a supported preference without a save command, a negative/uncertain preference, duplicate turns, and a temporary question. Check accepted graph records and provenance, then verify graph-only recall on the separate restored store with recent conversation excluded. Test historical recall separately. Review active and passive group writers independently.

**Recovery boundary:** once new profiles write bindings, envelopes, claims or role ownership, use consistent backend-native snapshots for recovery: the complete embedded graph file, or a Neo4j database backup. Preserve the original logical store mapping. Generic graph import and queue-aware JSON import deliberately reject restoration of new privileged bindings/ownership into a fresh store; a JSON export alone is not a supported recovery backup for these profiles. Retain queue-aware exports as additional inspection evidence when jobs exist.

For rollback, keep this binary and restore **Existing / Custom** writer settings while its readers continue validating new claims. Old-package downgrade and mixed-version writers/workers are unsupported for new-profile stores. Keep newly appended conversations; never overwrite them with an older snapshot. No reset, purge, bulk re-extraction or automatic legacy repair is part of this upgrade.

---

## Upgrading to v0.7.1

This patch fixes JSON-mode requests in bounded identity matching. It explicitly requests a valid JSON object and checks the trusted instruction before sending bounded extraction requests. Existing legacy extraction behavior and saved workflow defaults remain unchanged. No model, temperature or governance change is needed.

1. Take fresh, consistent backups of your workflows and Engram stores. **Embedded:** preserve the original producer graph file and storage directory. **Neo4j:** use your normal consistent database backup. Keep existing namespace keys and alias mappings.
2. Install `n8n-nodes-engram@0.7.1`, restart n8n, refresh the editor and confirm the installed version. Keep the existing Memory v2 bounded/quality/temperature settings. Node.js 20 or newer remains required. No schema migration, memory reset, purge, bulk re-extraction or queue activation is needed.
3. Start with one conversation workflow. Test normal and tool-assisted turns, a durable preference, a temporary question and historical recall. Confirm explicit extraction success or documented deferral and inspect actual graph facts; overall workflow success alone is insufficient. Expand other namespaces only after this canary passes.

Known JSON-instruction errors retain `kind=invalid_request` with fixed `reason=json_mode_instruction_missing` and `parameter=messages`. Deterministic HTTP 400 or authentication failures stop further equivalent comparisons in the extraction. Conversations remain saved while failed staged graph changes are discarded. No raw provider body is included in these diagnostics.

For rollback, preserve legitimate messages written after the backup and follow the queue-aware backup/downgrade restrictions below when jobs exist. Prefer restoring the previous workflow settings while retaining current memory. Never overwrite newer conversations with an old snapshot as routine rollback. This patch does not repair old extracted facts or reclassify historical episodes. The [v0.7.0 controls and worker setup](#upgrading-to-v070) remain opt-in.

---

## Upgrading to v0.7.0

For bounded-mode installations, use v0.7.1 or newer for the JSON-mode comparison fix.

These Memory v2 controls are optional. Existing workflows keep **Entity Resolution > Legacy**, **Knowledge Selection > Legacy**, **Extraction Execution > Synchronous** and **Graph Context Policy > Legacy**. Installing a newer package does not enable them or rewrite existing knowledge.

### Back Up and Install v0.7.0

1. Back up current workflows and n8n configuration. Preserve exact namespace keys and any existing alias mapping.
2. **Embedded:** pause writers and preserve each producer workflow's graph file, storage directory and workflow-to-file mapping. Use a separate restored store for upgrade trials. Once durable work exists, use **Extraction Queue > Export Queue Backup** for portable queue-aware recovery.
3. **Neo4j:** take a consistent database backup using your normal recovery procedure. Retain the same database and namespace identities. Graph writers coordinate through a shared store lock; validate concurrent write throughput during rollout.
4. Install `n8n-nodes-engram@0.7.0`, restart n8n, refresh the editor and confirm the installed version. Node.js 20 or newer is required. Existing v2 stores load without a bulk migration or re-extraction; earlier provenance/schema upgrades remain separate.
5. Run **Engram Admin > Monitoring > Diagnostics**. Saved Memory v1 nodes remain v1; upgrade selected nodes explicitly to **Memory v2** on an inactive workflow copy before enabling the new controls. Check that the copy points to the intended restored store.

### Activate Bounded Extraction First

Back up current workflows and both the graph and conversation records before changing settings. Preserve the exact namespace, including whitespace, and the existing embedded workflow-to-file mapping or Neo4j database. Begin with one conversation workflow and keep the current model, session identity and conversation window.

Select **Entity Resolution > Bounded** and **Message Write Policy > Final Turns**. Keep eligible human/final-assistant sources stored; system/tool extraction is unsupported in this mode. Exact names and explicitly verified aliases resolve before model comparisons. Defaults limit each extraction to an eight-candidate shortlist, 16 fuzzy comparisons, 32 model/embedding requests and a 30-second shared deadline. Identity ambiguity, pruned candidates and exhausted budgets remain proposed or deferred; they are not permission to merge existing identities. Legacy contradiction expiry and automatic summary updates are not performed by the bounded path.

Select **Knowledge Selection > Durable and Temporal** to keep temporary requests in conversation history without automatically accepting them as durable facts. Automatic acceptance requires accepted human provenance and complete, literal assertion evidence. Paraphrases, quotations, hypothetical or qualified statements and uncertain identities require review. This conservative policy can produce more proposed records. It does not reclassify, re-extract or delete previously stored facts. **Source Timezone** must be an explicit IANA zone such as `Europe/London`; omit it when unknown. Calendar-day resolution supports today/tomorrow/yesterday and a single explicit date. Other relative expressions remain uncertain.

**Graph Context Policy > Governed Current** reconciles search/traversal duplicates by relationship UUID, omits ungrounded entity summaries and excludes unresolved or out-of-interval plans from current context. **Governed Historical** retains historical evidence with source attribution; map historical intent explicitly in the workflow. **Governed As Of** requires an ISO timestamp with `Z` or a numeric offset and tests event-interval relevance, not what the system knew at that time. Separate **Durable Fact Token Allowance** (4096) and **Historical Evidence Token Allowance** (2048) stay within the overall graph context token cap; the recent-message window remains independent. A zero allowance disables that evidence category. Governed search and traversal share a 512-source-reference hydration allowance; candidates whose complete provenance does not fit are deferred, with `source_reference_deferred` and truncation diagnostics. Existing accepted legacy records are not automatically corrected. Genuine human JSON and quoted conversation remain in the episode ledger.

Inspect save diagnostics for per-stage elapsed time, model-call counts, available token usage, candidate/deferral counts and storage timing. Unavailable provider/backend measurements are `null`; overlapping stage/request/storage times must not be added together. Agree latency targets from your own normal and tool-assisted workloads before expanding the rollout.

### Activate a Durable Extraction Worker

Durable Queue removes model extraction from the chat save path by persisting the episode and its extraction job together. Graph facts become available only after a worker completes. It requires persistent storage, bounded resolution, Final Turns and **Retention Policy > Keep Forever**; unsupported combinations fail before the write. Use stable per-turn message/idempotency keys for retries.

1. Create a separate workflow with **Schedule Trigger > Engram Admin v2 > Extraction Queue > Process Jobs**. Start with **Worker Batch Size > 1**; each execution processes at most ten jobs sequentially. No worker runs automatically merely because the package is installed.
2. Configure the same backend and exact **Queue Group ID** as Memory. For embedded storage, set **Memory Workflow ID** to the original producer workflow ID and use the same custom storage directory. The worker's own workflow ID is not the producer's store. The existing producer file must be present. For Neo4j, use the same database and appropriate credentials.
3. Match the producer's extraction credential endpoint, model, temperature mode/value, entity types, thresholds, embedding configuration and all bounded/quality settings. Set the same nonsecret **Extraction Route ID** on producer and worker. API keys are not stored in jobs; credential rotation can retain the binding when these settings are unchanged. Route URLs containing credentials, query strings or fragments are rejected.
4. Activate the scheduled worker, then select **Extraction Execution > Durable Queue** on the producer. Inspect `delivery.status=queued`, job IDs, enqueue timing and `graph_fresh=false`; this is not a successful extraction result. Use **Extraction Queue > Status** for pending/failed counts, oldest pending time and bounded job summaries, then inspect worker outcomes and actual graph facts.
5. Verify an ordinary turn, a real tool-assisted turn, a durable preference, older-fact recall and an explicit historical query. Confirm the final pair is saved once, audits remain outside conversational context, original records retain their identity and the queue drains. Only then activate additional namespaces. Evaluate passive ingestion separately.

Jobs use fenced leases, bounded retry/backoff and atomic graph/completion writes. Restarts can recover work; retries do not resend chat messages. Configuration mismatch leaves work unclaimed. Use **Rebind Job** with an operator and reason only after reviewing corrected settings; this preserves the source/job identity and clears stale staged work. Pause, resume, retry and cancel are explicit reviewed operations. Capacity or durable-storage failures can reject the conversation write; monitor workflow errors rather than assuming every queued save is fail-soft. Snapshot preparation is capped at 100,000 records/100 MiB; source, request, response and staged-plan byte limits can defer oversized work without truncating original messages.

### Backups, Historical Artifacts and Rollback

Use **Extraction Queue > Export Queue Backup** to preserve jobs, ownership and completion markers along with graph/episode records. A generic graph export alone is not the queue recovery procedure. Imports verify checksums, namespace/endpoints and collisions; incomplete legacy source/chain references are retained with warnings. Imported active jobs are paused pending configuration review. Creating a fresh embedded import destination requires explicit review and a custom directory. Never import over newer live conversations.

The historical-artifact inspection and dry-run steps below still apply. This feature does not reinterpret historical records already labelled as genuine conversation, automatically delete extracted facts or provide a record-specific correction migration.

For rollback, first stop producers and workers and take a fresh queue-aware backup. Prefer restoring the previous policy settings on the new package. Before using an older binary, complete or explicitly cancel outstanding jobs and verify no worker remains active. Older binaries do not enforce queue ownership, leases or disk-sync protections; do not run old and new writers concurrently against a queue-bearing store. Keep the queue-aware backup and all new legitimate records. If an older package cannot safely read the retained operational metadata, use a separately reviewed recovery/export procedure; never overwrite live history with an old snapshot as routine rollback. Existing no-queue embedded stores retain their prior disk-sync behavior. Neo4j graph writers coordinate through a shared store lock to protect atomic extraction commits; measure concurrent write throughput before expanding a busy deployment.

---

## Upgrading to v0.6.0

**Installing this release makes the controls available; it does not automatically activate history filtering or final-turn writes.** Existing saved settings retain temperature `0`, History Filter `Off`, Message Write Policy `Legacy`, and Store Tool Audit `Disabled`. Saved Memory v1 nodes remain v1 until explicitly upgraded. The temperature control is available in both v1 and v2; the history/write/query controls require Memory v2.

### Back Up and Install

1. Back up your workflows and n8n instance configuration using your normal recovery procedure. Create current Engram exports and backend backups before changing package or node settings.
2. **Embedded:** preserve each workflow's graph file while writes are paused, or take a consistent Engram export. Keep the original storage directory, workflow-to-file mapping, and session/group keys. A copied workflow can have a different default storage filename; validate against a separately restored test copy rather than accidentally testing a new empty graph.
3. **Neo4j:** take a database backup or consistent export using your normal Neo4j recovery procedure. Keep the same database, credentials, and session/group keys for the existing deployment.
4. Upgrade the existing community-node installation to `n8n-nodes-engram@0.6.0`, restart n8n, refresh the editor, and confirm the installed version. Node.js 20 or newer is required by the package.
5. For stores already running `0.5.1`, this release requires **no storage schema migration** on either backend. Run **Engram Admin > Monitoring > Diagnostics** to confirm storage health. If upgrading from `0.4.x` or earlier, complete the existing provenance/schema migration instructions separately.

### Activate Deliberately, One Memory Workflow at a Time

Start with one backed-up direct-conversation workflow, then validate before updating the remaining Memory nodes. If it still uses Memory v1, use n8n's node upgrade action in an inactive workflow copy to adopt **Memory v2**. Preserve its intended storage and canonical session key; do not replace session keys or use display-name changes as an identity migration.

| Setting                                           | Initial activation                                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction Temperature Mode                       | Select **Provider Default** when the extraction model rejects temperature `0`; this truly omits the request field. Otherwise retain a mode supported by that model.                          |
| History Filter                                    | Select **Provenance** to exclude known tool-output, monitor-summary, and audit episodes from context.                                                                                        |
| Message Write Policy                              | Select **Final Turns** to apply storage/extraction controls to both normal saves and native bulk tool-assisted saves.                                                                        |
| Store Tool Audit                                  | Keep **Disabled** initially. Enable only if audit retention is needed; retained audits stay outside conversation context under Final Turns.                                                  |
| Current Human Query                               | Map to the same current-human-message expression used by the agent prompt. The default accepts string `chatInput`, then string `input`; a different webhook shape needs an explicit mapping. |
| Store Human / AI Episodes                         | Review the intended retention; both default to Enabled in v2.                                                                                                                                |
| Extract from Human / AI / System and Tool Content | Human extraction defaults Enabled; AI and System/Tool extraction default Disabled. Review these when upgrading a v1 node.                                                                    |
| Human Episode Kind                                | Keep **Active Human** for direct conversations; use **Passive Human** for observed/curated human ingestion.                                                                                  |
| Source Message ID / Idempotency Key               | Use a stable **per-message/per-turn** identity for retry deduplication. A static session key or phone number is not a turn identity and can collapse distinct messages.                      |

The context window counts messages/episodes, not user turns or days. With filtering enabled, older eligible messages refill that window within **Maximum History Scan** (default 1000, maximum 10000). Load diagnostics distinguish snapshot overflow from scan-budget truncation. n8n subnode expressions can have different item-resolution behavior from regular nodes; validate mappings for independent conversations rather than assuming a batch resolves each item separately.

### Historical Artifacts: Inspect and Dry-Run First

This release does not delete historical episodes or graph facts. Provenance filtering cannot automatically prove that an unlabelled legacy JSON message is a tool artifact.

1. Use **Engram Explorer > Episode > List/Get** with the exact group, date, and provenance filters to inspect candidate records, their source identities, and `previous_episode_uuid` links. Preserve genuine human JSON, quoted content, and ambiguous messages.
2. For a bounded preview, use **Engram Admin > Lifecycle > Purge Episodes**, keep **Execution Mode > Dry Run**, and set the same exact group/provenance/date scope with a small **Maximum Episodes** limit. **Malformed Content Rule > Empty Assistant Output** can locate empty assistant records; inspect their neighboring episodes separately. **Content Contains** should use a distinctive reviewed marker, not generic JSON keys. Do not select **Delete** or confirm a purge as part of this upgrade. Dry-run results are preview candidates, not automatic approval for deletion or filtering.
3. There is no separate History Filter dry-run switch. Preview filtering in an **inactive workflow copy backed by a separate restored store**, compare its Memory load output before/after, and inspect `history.excluded_legacy`, `legacy_candidates`, `returned`, and `scan_truncated`.
4. If an exact legacy payload is confirmed to be an artifact, calculate its lowercase SHA256 from the **exact UTF-8 episode content**, including whitespace. Select **History Filter > Provenance and Reviewed Legacy** and add that digest to **Reviewed Legacy Content Hashes** (up to 100 comma-separated hashes). A matching hash still requires strict legacy role, adjacency, chain, and source checks. The neighboring empty assistant and reviewed payload are excluded only from context; original records and facts remain intact. Unapproved or ambiguous JSON stays visible.

### Verify Before Expanding the Rollout

- **Extraction:** inspect the Memory save/bulk-write `extraction` outcome and verify expected accepted entities/relationships in Explorer. A green overall chat execution or a valid empty extraction response alone does not prove fact creation.
- **Older recall:** query a known older accepted fact after its episode has fallen outside the recent-message window. Confirm the configured current query and relevant graph context, including any governance filters.
- **Tool-assisted conversation:** exercise a real tool, confirm the real human/final-assistant messages are retained, and verify tool results are not new human sources. Inspect bulk write and extraction diagnostics.
- **Filtered history:** confirm useful messages refill the window, reviewed exclusions match expectations, genuine JSON/quotes remain, and scan truncation is understood. Re-run one explicit turn identity to check retry behavior without reusing that identity for new turns.

After these checks pass, apply the intended controls to the remaining Memory nodes in stages. Extraction and persistence are not a transactional exactly-once pipeline: retrying an already-stored source does not automatically recover extraction interrupted after persistence. Storage-disabled extraction has no durable retry ledger.

### Rollback

Keep the pre-upgrade workflows, exports, and backend backups unchanged until rollout validation finishes. To roll back, pause writes, restore the saved workflow configuration, reinstall `n8n-nodes-engram@0.5.1` through the same installation method, and restart n8n. This returns the prior behavior, including its extraction-model limitations.

No store restore is required merely to undo a non-destructive history filter. However, if **Store Tool Audit** was enabled, `0.5.1` does not implement the new audit-context exclusion and may replay those new records. Review that history before downgrading; keeping `0.6.0` with the intended controls or using a separately restored pre-upgrade store may be preferable. Turning filtering off does not delete audit records.

If a store restore is necessary, use the backed-up embedded file/Engram export or your Neo4j recovery procedure while writes are paused. Reconcile messages created since the backup before replacing live data; restoring an older snapshot can discard newer conversations. Never wipe groups, trim/change session keys, or delete graph facts as an automatic rollback step.

---

## Upgrading from v0.4.x

Version `0.5.0` adds episode provenance and governance fields. Storage migration and n8n node-version upgrades are separate steps.

1. Create a current Engram export or storage/database backup before upgrading the package.
2. Upgrade `n8n-nodes-engram`, restart n8n, and confirm the installed package version.
3. Complete the storage-backend steps below.
4. Run **Engram Admin > Monitoring > Diagnostics** and confirm that no storage migration remains.
5. Upgrade selected Engram Memory nodes to v2 in an inactive workflow copy before changing production workflows.

### Embedded Storage

No migration node is required. On first initialization after the package upgrade, Engram:

- migrates the embedded graph before opening it;
- creates and verifies a backup ending in `.pre-schema-2.0.backup.json`;
- replaces the graph atomically; and
- leaves the original graph unchanged if backup verification or migration fails.

After initialization, use **Engram Admin > Monitoring > Diagnostics** to verify the migration and backup status.

### Neo4j Storage

Neo4j migration is intentionally operator-controlled so Engram does not perform an unbounded database rewrite during startup.

1. Add an **Engram Admin** node configured with the same Neo4j credentials as the production memory workflow.
2. Select **Lifecycle > Migrate Storage Schema** and run **Dry Run**.
3. Review the matched legacy episode count.
4. Select **Migrate**, set **Confirm Migration** to **Confirmed**, and execute a bounded batch.
5. Repeat until `remaining_count` is `0`, then confirm the result with **Monitoring > Diagnostics**.

The Neo4j migration is additive and only fills missing governance fields with conservative defaults.

### Engram Memory v2

Installing `0.5.0` does not silently change saved Engram Memory nodes. Existing v1 nodes retain their previous behavior until explicitly upgraded through n8n's node upgrade action.

- Keep **Human Episode Kind > Active Human** for direct agent conversations.
- Select **Passive Human** for observed or curated human messages stored by passive ingestion workflows.
- Validate the upgraded node in an inactive workflow copy before replacing the production workflow.

---
