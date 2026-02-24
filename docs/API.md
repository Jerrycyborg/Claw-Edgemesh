# API Reference (Practical)

Base URL: `http://localhost:8787`
Schema version: `1.0`

## Nodes

### `POST /v1/nodes/register`

Register or upsert a node.

Payload:

```json
{
  "schemaVersion": "1.0",
  "nodeId": "node-a",
  "region": "local",
  "capabilities": { "tags": ["linux"], "maxConcurrentTasks": 1 }
}
```

### `POST /v1/nodes/:nodeId/heartbeat`

Updates liveness and load.

### `GET /v1/nodes`

Returns nodes with computed `freshnessState` (`healthy|degraded|offline`).

## Tasks

### `POST /v1/tasks`

Enqueue a task.

Payload (minimum):

```json
{
  "taskId": "task-1",
  "kind": "echo",
  "payload": { "msg": "hello" }
}
```

Optional routing:

- `targetNodeId`
- `requiredTags`

### `POST /v1/nodes/:nodeId/tasks/claim`

Node claims next eligible task.

Eligibility checks:

- node freshness must be `healthy`
- `maxConcurrentTasks` must not be exceeded
- `targetNodeId` and `requiredTags` must match

### `POST /v1/tasks/:taskId/ack`

Marks claimed task as running.

### `POST /v1/tasks/:taskId/result`

Stores success/failure result and finishes task.

### `GET /v1/tasks/:taskId`

Returns task + stored result.

### `GET /v1/tasks/queue`

List queued tasks.

### `GET /v1/tasks/running`

List claimed/running tasks.

## Plugins

### `GET /v1/plugins/telemetry`

Returns telemetry counters/events from the built-in plugin.

## Common errors

- `404 unknown_node`
- `404 task_not_found`

## Curl quickstart

```bash
curl -sS -X POST http://localhost:8787/v1/nodes/register \
  -H 'content-type: application/json' \
  -d '{"schemaVersion":"1.0","nodeId":"node-a","capabilities":{"tags":["linux"],"maxConcurrentTasks":1}}'
```
