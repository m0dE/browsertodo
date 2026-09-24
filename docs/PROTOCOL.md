# Task server protocol

The browsertodo extension fetches work from any HTTP server that implements
the runner endpoints below. The hosted service implements them, and you can
write your own. The zod schemas in `packages/shared/src/task.ts` are the
source of truth for every body shown here.

All requests send `Authorization: Bearer <runner key>` and use JSON unless
stated otherwise. Times are ISO 8601 strings in UTC. Errors return a non-2xx
status with `{ "error": "message" }`.

## Claim the next task

`POST /v1/runner/claim`

```json
{ "runnerId": "3f2c9a4e-..." }
```

`runnerId` is a stable random ID the extension stores for itself.

**204** with an empty body when nothing is due.

**200** when a task was claimed. The server must make sure two runners never
receive the same task, and must hold a lease on it until `leaseExpiresAt`.

```json
{
  "task": {
    "id": "01J9Z...",
    "instructions": "Post this on X: Good morning!",
    "account": "@myhandle",
    "mediaIds": ["01J9Y..."],
    "notBefore": "2026-09-24T09:00:00.000Z",
    "priority": 0,
    "status": "running",
    "attempts": 1,
    "leaseOwner": "3f2c9a4e-...",
    "leaseExpiresAt": "2026-09-24T09:15:00.000Z",
    "retryAfter": null,
    "resultSummary": null,
    "resultUrl": null,
    "resultScreenshotId": null,
    "pauseReason": null,
    "failReason": null,
    "createdAt": "2026-09-23T20:00:00.000Z",
    "updatedAt": "2026-09-24T09:00:00.000Z"
  },
  "media": [
    { "id": "01J9Y...", "filename": "sunrise.jpg", "contentType": "image/jpeg", "size": 183422 }
  ],
  "leaseExpiresAt": "2026-09-24T09:15:00.000Z"
}
```

A task is due when:

- it is `pending` and `notBefore` is empty or in the past, or
- it is `paused` and `retryAfter` is in the past, or
- it is `running` and its lease has expired.

## Keep the lease alive

`POST /v1/runner/tasks/:id/heartbeat`

```json
{ "runnerId": "3f2c9a4e-..." }
```

**200** `{ "leaseExpiresAt": "..." }`. **409** when the task is not running or
the lease belongs to another runner. The extension sends this every 2 minutes
while a task runs.

## Report the result

`POST /v1/runner/tasks/:id/result`

```json
{
  "runnerId": "3f2c9a4e-...",
  "outcome": "done",
  "summary": "Posted the good-morning message on @myhandle.",
  "url": "https://x.com/myhandle/status/1839...",
  "screenshotId": "01J9Z...",
  "retryAfterMinutes": 15
}
```

- `outcome` is `done`, `failed` or `paused`.
- `reason` explains a `failed` or `paused` outcome.
- `retryAfterMinutes` applies to `paused` only. The task becomes due again
  after that many minutes.
- **409** when the task is not running or the lease belongs to another runner.

## Media

`GET /v1/media/:id` returns the file bytes with its `Content-Type`.

`POST /v1/media` takes `multipart/form-data` with one field named `file` and
returns `{ "id", "filename", "contentType", "size" }` with status 201. The
extension uses it to upload the final screenshot of each task.

## Creating tasks

Task creation is not part of the runner protocol, so a compatible server can
fill its queue any way it likes. The hosted service accepts
`POST /v1/tasks` and `POST /v1/tasks/batch` with bodies matching
`CreateTaskInput` and `BatchCreateInput`.
