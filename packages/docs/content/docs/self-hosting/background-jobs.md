---
sidebar_position: 203
---

# Background job storage

:::caution Experimental

The PostgreSQL background job backend is opt-in for evaluation and testing and has not been validated for production. Redis remains the recommended production backend.

:::

Medplum uses BullMQ for background work. Redis remains the default queue backend. You can opt into PostgreSQL queue storage for self-hosted deployments with the `backgroundJobs` setting. Redis is still required for other server features, including caching, rate limiting, and pub/sub.

## Configure PostgreSQL

Add `backgroundJobs` to the JSON server configuration. Store the connection string as a secret and use a PostgreSQL database reachable by every Medplum server instance:

```json
{
  "backgroundJobs": {
    "backend": "postgres",
    "postgres": {
      "connectionString": "postgres://medplum_jobs:secret@db.example.com:5432/medplum_jobs",
      "maxConnections": 32
    }
  }
}
```

`maxConnections` limits the queue pool **per server instance** and defaults to `32`. It must be an integer of at least `2 × enabled workers + 2`: one listener per worker, capacity for worker queries, and a health-check reserve. This minimum is a starting point, not a guarantee of sufficient capacity. Account for total worker concurrency, tune the pool through load testing, and include all instances when sizing PostgreSQL’s connection limit. The queue database can be separate from Medplum’s FHIR database. Use a direct connection or PgBouncer session pooling: transaction pooling does not preserve the sessions needed for notifications. For TLS, configure certificate verification through the PostgreSQL URL, including `sslmode=verify-full` and `sslrootcert` pointing to a trusted CA certificate accessible to the server.

Queue pool connections use the `read committed` transaction isolation level required by the queue backend, overriding any database default or URL startup option for that setting. This does not change the isolation level of the FHIR database pool.

The server runs BullMQ's advisory-lock-protected schema migrations during startup. The configured PostgreSQL role must be allowed to create and update the queue tables and related schema objects. Keep those migration privileges available to the role used at startup.

For environment-based configuration, provide the JSON value as `MEDPLUM_BACKGROUND_JOBS`, for example:

```bash
export MEDPLUM_BACKGROUND_JOBS='{"backend":"postgres","postgres":{"connectionString":"postgres://medplum_jobs:secret@db.example.com:5432/medplum_jobs","maxConnections":32}}'
```

For AWS SSM configuration, `BackgroundJobsPostgresSecrets` may name an AWS Secrets Manager secret containing JSON such as `{"connectionString":"postgres://..."}`. Configure `backgroundJobs.backend` and optionally `backgroundJobs.postgres.maxConnections` as SSM parameters; explicit settings override secret fields. JSON configuration and `MEDPLUM_BACKGROUND_JOBS` also support the setting. See [Setting Medplum Server Configuration](./setting-configuration) for configuration sources and precedence.

## Cutover and operations

Changing the backend does not copy pending, delayed, or recurring jobs. Plan a maintenance window and use this sequence:

1. Block incoming API write traffic and stop external job producers. Keep the existing Redis-backed workers running only to drain work; use deployment-level routing and isolation to prevent new writes. Disable cron or other scheduling as needed, and account for delayed jobs that cannot yet run.
2. Drain or reconcile pending work, including post-deploy migrations and accepted AsyncJob records. If Redis post-deploy migration jobs remain at cutover, the new backend will not see them and associated AsyncJob records may remain accepted. Drain them before switching, or reconcile and re-enqueue the work afterward.
3. Stop all old server instances before changing the backend. Update every instance to the same PostgreSQL queue configuration, then start them while writes and producers remain blocked. Do not run a mixed deployment.
4. Restore cron schedules with an authenticated super-admin `POST /admin/super/reloadcron` request and `Prefer: respond-async`. Poll the URL in the response's `Content-Location` header until the operation completes. This reloads supported legacy Bot and Cron schedules; recreate any other recurring jobs separately.
5. Verify server health and queue processing, then resume API writes and external producers.

Back up the PostgreSQL queue data along with your database recovery plan. Set BullMQ job retention to fit your storage and operational needs, and monitor PostgreSQL connections, queue processing, and the server's `/healthcheck` endpoint, which reports queue storage health. An overall `ok: true` is informational and does not guarantee queue readiness. Medplum does not make resource writes and queue enqueues one atomic transaction, so a database restore or interrupted workflow can leave related work out of sync.

On shutdown, allow the server's normal graceful shutdown to close workers, queues, and the PostgreSQL pool before terminating its process. Apply your usual database access controls and backup retention policies to queue data, which can contain job payloads.

## Run the PostgreSQL backend tests

From `packages/server`, set `MEDPLUM_TEST_QUEUE_DATABASE_URL` to a dedicated test database. These tests run BullMQ migrations and create and remove queues and jobs, so do not point them at a production database. Optionally set `MEDPLUM_TEST_QUEUE_REDIS_URL` to an isolated Redis test database to run the Redis backend smoke test too:

```bash
MEDPLUM_TEST_QUEUE_DATABASE_URL='postgres://medplum:secret@localhost:5432/medplum_queue_test' \
MEDPLUM_TEST_QUEUE_REDIS_URL='redis://:secret@localhost:6379/10' \
bunx vitest run --config vite.postgres.config.ts
```
