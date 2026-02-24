# Troubleshooting

## 1) `npm run build` fails with TS7016 (`*.js` has implicit any)

Cause: importing JS modules without declarations in TS context.

Fix:

- migrate module to `.ts`, or
- add a `.d.ts` declaration file.

Current project fix pattern: typed TS modules for reviewer/agent.

## 2) Node never claims tasks

Check:

1. Node is registered (`GET /v1/nodes`)
2. Node heartbeat is fresh (`freshnessState` is `healthy`)
3. Node not at `maxConcurrentTasks`
4. `requiredTags`/`targetNodeId` match

## 3) Tasks stuck in `claimed`

Likely worker crashed before ack/result.

Check claim TTL behavior in store (`claimTtlMs`).
Expired claims should requeue automatically.

## 4) Security gate blocks orchestrator-run

Expected if mandatory gate fails.

Check executor output:

- `code: security_gate_failed`
- nested `securityGate` output for stderr details

## 5) Pre-commit hook not running

Run:

```bash
npm run prepare
```

Also ensure `.husky/pre-commit` exists and is executable.

## 6) Formatting/lint gate fails

Run:

```bash
npm run format
npm run lint:fix
```

Then re-run checks:

```bash
npm run format:check
npm run lint
npm test
npm run build
```
