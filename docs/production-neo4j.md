# Production Neo4j Setup

Use Neo4j for production or multi-worker n8n deployments. Embedded storage is useful for local testing and single-instance workflows, but Neo4j keeps Engram state outside the n8n process and avoids shared JSON-file contention.

## Recommended Baseline

- Run Neo4j 5.x with persistent disk storage.
- Create a dedicated database user for Engram.
- Use a dedicated database name when your Neo4j edition supports multiple databases.
- Keep n8n and Neo4j on a private network where possible.
- Enable TLS when connecting across hosts or networks you do not fully control.
- Back up Neo4j independently of n8n workflow exports.

## Credential Fields

In n8n, create an **Engram Neo4j** credential:

- **URI**: `neo4j://host:7687` or `neo4j+s://host:7687`
- **Username**: dedicated Engram user
- **Password**: strong password or secret-managed value
- **Database**: optional database name

## Smoke Check

After configuring the credential:

1. Add an **Engram Admin** node.
2. Set **Backend** to `Neo4j`.
3. Select **Monitoring > Diagnostics**.
4. Run with **Include Deep Checks** set to `Disabled`.

Expected result:

- `status` is `ok`.
- `storage_backend` is `neo4j`.
- `quick_checks` returns graph counts.

## Operational Guidance

- Use **Monitoring > Diagnostics** for fast health checks.
- Use **Monitoring > Embedding Coverage** before enabling hybrid search in production workflows.
- Use **Portability > Export** for logical backups, but rely on Neo4j-native backups for large graphs.
- Use **Portability > Import** with **Import Mode: Dry Run** before restoring into production.
- Keep **Maximum Import Items** and **Maximum Export Items** set when testing backup/restore automation.

## Scaling Notes

Neo4j is the safer backend when:

- n8n has multiple workers.
- workflows can execute concurrently.
- graph data is business-critical.
- graph size is expected to grow beyond small local test datasets.

Embedded storage now uses atomic JSON-file replacement and a short lock during writes, but it is still best treated as a single-instance backend.
