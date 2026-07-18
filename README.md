<p align="center">
  <img src="docs/images/logo.png" alt="Engram" width="120" />
</p>

<h1 align="center">n8n-nodes-engram</h1>

<p align="center">
  <strong>Knowledge graph memory for n8n AI agents</strong><br/>
  Persistent memory with entity extraction, temporal fact tracking, community detection, graph traversal, and hybrid search.
</p>

<p align="center">
  <a href="https://github.com/casistack/n8n-nodes-engram/actions/workflows/ci.yml">
    <img src="https://github.com/casistack/n8n-nodes-engram/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://www.npmjs.com/package/n8n-nodes-engram">
    <img src="https://img.shields.io/npm/v/n8n-nodes-engram.svg" alt="npm version" />
  </a>
  <a href="https://github.com/casistack/n8n-nodes-engram/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" />
  </a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.10-brightgreen.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/n8n-community%20node-ff6d5a.svg" alt="n8n community node" />
</p>

<p align="center">
  <a href="#installation">Installation</a> &middot;
  <a href="#upgrading-from-v04x">Upgrade</a> &middot;
  <a href="#node-reference">Nodes</a> &middot;
  <a href="#storage-backends">Storage</a> &middot;
  <a href="#knowledge-extraction">Extraction</a> &middot;
  <a href="#search">Search</a> &middot;
  <a href="#data-storage--security">Security</a> &middot;
  <a href="#development">Development</a>
</p>

---

> **Note:** This is a community node. It is not officially supported by n8n. Use at your own discretion.

---

## Overview

Engram gives your n8n AI agents a **knowledge graph memory**. Instead of losing context between conversations, agents build and query a persistent graph of entities (people, organizations, concepts) and the relationships between them.

Every conversation is stored as an episode. An optional LLM extraction pipeline identifies entities and facts from dialogue, building a growing knowledge graph. When the agent receives a new message, Engram searches the graph for relevant facts and injects them as context&mdash;giving the agent long-term memory that goes beyond simple chat history.

### Highlights

| | Feature | Description |
| --- | --- | --- |
| **4** | n8n Nodes | Memory, Explorer, Admin, Trigger |
| **2** | Storage Backends | Embedded (zero-setup) or Neo4j (production) |
| **5** | Extraction Stages | Entity, dedup, relationships, contradictions, embeddings |
| **3** | Search Modes | Full-text, vector, hybrid RRF fusion |
| **350** | Tests | Unit + integration across 35 test suites |

---

## Architecture

<p align="center">
  <img src="docs/images/architecture.svg" alt="Engram Architecture" width="780" />
</p>

---

## Product Screenshots

Engram provides dedicated n8n nodes for AI memory, graph exploration, administration, diagnostics, and event-driven workflows.

| Installed nodes | AI Memory node |
| --- | --- |
| <img src="docs/images/engram-node-picker.png" alt="Engram nodes in the n8n node picker" /> | <img src="docs/images/engram-memory-node.png" alt="Engram Memory node parameters" /> |

| Explorer actions | Admin operations |
| --- | --- |
| <img src="docs/images/engram-explorer-actions.png" alt="Engram Explorer actions in n8n" /> | <img src="docs/images/engram-admin-actions.png" alt="Engram Admin monitoring and hygiene actions in n8n" /> |

| Admin diagnostics output | Graph event trigger |
| --- | --- |
| <img src="docs/images/engram-admin-diagnostics-output.png" alt="Engram Admin diagnostics output" /> | <img src="docs/images/engram-trigger-node.png" alt="Engram Trigger events in n8n" /> |

---

## Installation

### Via n8n Community Nodes

1. Go to **Settings > Community Nodes** in your n8n instance
2. Enter `n8n-nodes-engram`
3. Click **Install**

### Manual

```bash
cd ~/.n8n
npm install n8n-nodes-engram
```

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

## Quick Start

### Minimal Setup (No LLM Required)

1. Add an **Engram Memory** node to your AI Agent workflow
2. Connect it to the agent's Memory input
3. Set **Storage Backend** to `Embedded (Graphology)`
4. Leave **Knowledge Extraction** as `Disabled`

Your agent now has persistent conversation history stored as episodic memory.

### Full Setup (With Extraction)

1. Create an **Engram Extraction LLM** credential:
   - **Base URL**: OpenAI-compatible endpoint (e.g. `https://api.openai.com/v1`)
   - **API Key**: Your API key
2. Add an **Engram Memory** node, enable **Knowledge Extraction**
3. Select an extraction model (e.g. `gpt-4o-mini`)
4. Optionally enable **Semantic Search (Embeddings)** with an embedding model
5. Optionally enable **Graph Traversal (BFS)** for context enrichment

The extraction pipeline automatically identifies entities and relationships from conversations and builds a queryable knowledge graph.

---

## Node Reference

### Engram Memory

> AI Memory node&mdash;connects to the AI Agent memory input.

On each conversation turn, Engram Memory:

- **Loads** relevant facts from the knowledge graph as system context, plus recent chat history
- **Saves** messages as episodes, optionally running the full extraction pipeline

| Setting | Description | Default |
| --- | --- | --- |
| Storage Backend | Embedded (Graphology) or Neo4j | Embedded |
| Knowledge Extraction | LLM-powered entity extraction | Disabled |
| Store Human Episodes | Persist human messages as episodes (v2) | Enabled |
| Human Episode Kind | Classify human input as active or passive provenance (v2) | Active Human |
| Store AI Episodes | Persist assistant replies as episodes (v2) | Enabled |
| Extract from Human Messages | Allow human content to produce facts (v2) | Enabled |
| Extract from AI Messages | Allow assistant content to produce facts (v2) | Disabled |
| Semantic Search | Vector embeddings for hybrid search | Disabled |
| Graph Traversal | BFS enrichment from matched entities | Disabled |
| Context Window | Recent turns to include | 10 |
| Max Facts per Query | Facts injected as context | 10 |
| Min Relevance Score | Threshold for inclusion (0&ndash;1) | 0.5 |
| Retention Policy | Episode lifecycle management | Forever |

Existing saved Engram Memory nodes retain their original node version and behavior when the package is upgraded. Use n8n's node upgrade action on a workflow copy to adopt v2 controls. Passive ingestion workflows should select **Human Episode Kind > Passive Human**, while direct agent conversations should keep the default **Active Human** classification.

### Engram Explorer

> Regular node&mdash;CRUD operations on the knowledge graph.

| Resource | Operations |
| --- | --- |
| **Entity** | Create, Get, Get by Name, List, Search, Update, Delete |
| **Relationship** | Create, Get, Get Between, Get for Entity, Search, Review, Update, Delete, Get Changelog |
| **Episode** | Get, Get Recent, Get by Date Range, Get Count, List, Update, Delete |
| **Traversal** | BFS from Entity, BFS from Episodes |

### Engram Admin

> Regular node&mdash;administration and analysis.

| Resource | Operations |
| --- | --- |
| **Monitoring** | Stats, List Groups, Group Stats, Embedding Coverage, Diagnostics |
| **Lifecycle** | Apply Retention, Purge Episodes, Migrate Storage Schema, Clear Group, Bulk Clear Groups, Clear All |
| **Hygiene** | Orphaned Entities, Duplicate Entities, Expire Stale Edges, Rebuild Search Index, Backfill Embeddings |
| **Portability** | Export, Import |
| **Analysis** | Detect Communities |

### Engram Trigger

> Polling trigger&mdash;fires when new entities, relationships, or episodes appear in the graph.

### Operational Diagnostics

Engram Admin includes a read-only **Monitoring > Diagnostics** operation for production checks. By default it returns quick storage and graph counts only. Optional deep checks scan the full graph to report embedding coverage, expired/invalidated edges, dangling edges, and duplicate entity-name groups.

For embedded storage, diagnostics also report the most recent mutation's queue wait, file-lock wait, disk refresh, rollback export, graph mutation, snapshot write, rollback restore, total duration, and snapshot size. These timings help distinguish lock contention from large-snapshot persistence costs.

Use **Monitoring > Embedding Coverage** to check whether entities and facts have vectors before enabling hybrid search broadly. Use **Hygiene > Rebuild Search Index** to rebuild the embedded full-text index from stored graph data. Use **Hygiene > Backfill Embeddings** in dry-run mode first, then disable dry-run to fill missing embeddings with the configured embedding model.

Explorer entity and relationship searches can optionally return retrieval diagnostics. The aggregate trace shows active filters, bounded candidate scores and decisions, rejection reasons, and which complete items fit the context preview budget. Diagnostics are disabled by default.

### Import, Export, and Backups

Engram exports use graph format `2.0` and include count metadata and a SHA-256 checksum. Imports support **Dry Run** mode, optional maximum item limits, checksum verification before migration, migration reporting, and reference-integrity warnings before writing data. Existing `1.0` backups remain importable; episodes without provenance are classified as `legacy`, `unverified`, and `proposed` rather than being accepted automatically.

Embedded storage upgrades automatically before the graph is opened. Engram creates and verifies an owner-readable backup beside the storage file, writes the migrated graph with atomic replacement, and stops without changing the source if backup verification or migration fails. The backup name ends with `.pre-schema-2.0.backup.json`, and **Monitoring > Diagnostics** reports its path and verification state.

Neo4j remains available during an upgrade and does not perform an unbounded startup rewrite. Use **Lifecycle > Migrate Storage Schema** in **Dry Run** mode to inspect the remaining legacy episode count, then apply confirmed bounded batches until the remaining count reaches zero. The migration is additive: it only fills missing governance fields with conservative legacy defaults.

For a staged restore, first run the import in **Dry Run** mode and review the source/target versions, default counts, and warnings. Keep the original export unchanged, then perform the write import only after the report matches expectations. Export the restored graph again to create a checksummed `2.0` backup.

To remove historical monitor or tool pollution, use Explorer episode filters to inspect the affected source, kind, trust level, or date range. Admin **Lifecycle > Purge Episodes** can also match empty assistant output or a case-insensitive content fragment. Always run the bounded purge in dry-run mode and review the matched episodes before confirming deletion.

For production Neo4j deployments, see [`docs/production-neo4j.md`](docs/production-neo4j.md). Ready-to-import starter workflows are available in [`docs/workflows/`](docs/workflows/).

---

## Storage Backends

| | Embedded (Graphology) | Neo4j |
| --- | --- | --- |
| **Setup** | Zero configuration | Requires Neo4j instance |
| **Persistence** | JSON file on disk | Neo4j database |
| **Vector search** | Brute-force cosine similarity | Brute-force cosine similarity |
| **Best for** | Development, single-instance | Production, multi-instance |
| **Scaling** | Single n8n instance | Independent of n8n lifecycle |

Both backends implement the same `IGraphStorage` interface. All features work identically on either backend.

---

## Knowledge Extraction

When enabled, the extraction pipeline processes each conversation turn:

```text
User message + AI response
        |
   Entity Extractor ── identifies people, orgs, locations, concepts
        |
   Entity Deduplicator ── merges "Bob Smith" with "Bob"
        |
   Relationship Extractor ── extracts facts ("Alice works at Acme")
        |
   Contradiction Detector ── flags conflicting facts
        |
   Embedding Generator ── (optional) vectors for semantic search
```

**Supported providers**: Any OpenAI-compatible API&mdash;OpenAI, OpenRouter, Ollama, LM Studio, Together AI, and others.

**Configurable entity types**: `person`, `organization`, `location`, `concept`, `event`, or custom types.

Extracted entities and relationships include `attributes.engram_extraction` provenance metadata with source, extraction timestamp, confidence placeholder, review status, and related episode UUIDs where available.

---

## Search

| Mode | Description | Requirements |
| --- | --- | --- |
| **Full-text** | Keyword search on names, summaries, and facts | None |
| **Vector** | Cosine similarity on embedding vectors | Embeddings enabled |
| **Hybrid RRF** | Reciprocal Rank Fusion combining text + vector | Embeddings enabled |

Hybrid search automatically activates when both text and vector search are available.

All search operations support optional **temporal filters** (`valid_after`, `valid_before`, `created_after`, `created_before`) to scope results by time.

---

## Temporal Queries

Engram tracks when facts are valid (`valid_at`, `invalid_at`) and when they were superseded (`expired_at`). You can query the graph by time:

| Operation | Node | Description |
| --- | --- | --- |
| **Get by Date Range** | Explorer > Episode | Retrieve episodes within a time window by `reference_time` |
| **Get Changelog** | Explorer > Relationship | Get recently created, expired, or invalidated relationships since a given date |
| **Search with date filters** | Explorer > Entity/Relationship Search | Filter search results by `valid_after`, `valid_before`, or `created_after` |

Date parameters use ISO 8601 format (e.g. `2026-01-15T00:00:00.000Z`). The LLM agent can convert natural language like "last week" into concrete dates before calling these operations.

---

## Community Detection

Clusters related entities using **label propagation**. Communities are computed on demand via **Engram Admin > Detect Communities** and include member entities, key entities ranked by connectivity, and optional LLM-generated summaries.

---

## Graph Traversal

BFS (breadth-first search) walks the knowledge graph outward from seed entities, collecting connected entities and relationships within a configurable hop limit.

- **BFS from Entity**: Start from specific entity UUIDs
- **BFS from Episodes**: Start from entities referenced in recent episodes
- **Automatic enrichment**: When enabled on the Memory node, a shallow BFS (default: 1 hop) runs after each search to enrich agent context

---

## Data Storage & Security

Engram stores conversation data and extracted knowledge. You should understand where this data lives before deploying to production.

**Embedded backend:**

- Data is stored as a JSON file at `~/.n8n/storage/n8n-nodes-engram/{workflowId}-engram.json` by default
- You can override the default with **Custom Storage Path** when using embedded storage
- The file contains all entities, relationships, episodes, and embeddings in plain text
- A normal human-and-assistant turn is committed as one atomic episode batch, preserving episode order while avoiding duplicate snapshot writes
- Backups: copy the JSON file

**Neo4j backend:**

- Data is stored in your Neo4j database instance
- Engram does not manage Neo4j authentication, encryption, or access control&mdash;configure these in Neo4j directly
- Credentials (URI, username, password) are stored in n8n's encrypted credential store

**LLM API calls:**

- When extraction is enabled, conversation content is sent to the configured LLM provider for entity/relationship extraction
- Embedding generation sends entity names and facts to the configured embedding model
- No data is sent to any external service unless you explicitly enable extraction and configure an API credential

**General:**

- Engram does not phone home, collect telemetry, or make network calls beyond the LLM API you configure
- All data stays on your infrastructure
- Group IDs isolate data between different conversations/users

---

## Credentials

### Engram Extraction LLM

| Field | Description |
| --- | --- |
| Base URL | OpenAI-compatible API base URL |
| API Key | API key for the LLM provider |

Used for entity extraction, community summaries, and embedding generation.

### Engram Neo4j Connection

| Field | Description |
| --- | --- |
| URI | Neo4j connection URI (e.g. `bolt://localhost:7687`) |
| Username | Neo4j username |
| Password | Neo4j password |
| Database | Database name (default: `neo4j`) |

Required only with the Neo4j storage backend.

---

## Development

### Prerequisites

- Node.js >= 18.10
- npm

### Setup

```bash
git clone https://github.com/casistack/n8n-nodes-engram.git
cd n8n-nodes-engram
npm install
```

### Commands

| Command | Description |
| --- | --- |
| `npm run build` | TypeScript compilation + icon build |
| `npm run lint` | ESLint |
| `npm run format` | Prettier (write) |
| `npm run format:check` | Prettier (check) |
| `npm run type-check` | TypeScript type checking |
| `npm test` | Run all tests |
| `npm run test:coverage` | Coverage report |

### Git Hooks (Husky)

| Hook | Checks |
| --- | --- |
| `pre-commit` | ESLint, Prettier, TypeScript type-check |
| `pre-push` | Build, full test suite |

### CI/CD

- **Pull requests**: Lint, type-check, test across Node 18/20/22
- **Releases**: Automated npm publish on GitHub Release

---

## Support

If you find Engram useful, consider supporting the project:

<a href="https://www.buymeacoffee.com/cassistack" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40" />
</a>

---

## License

[AGPL-3.0](LICENSE)
