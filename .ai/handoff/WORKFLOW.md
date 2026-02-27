# Development Workflow

## Standard Feature Pipeline

```
1. Read NEXT_ACTIONS.md -- pick top unblocked task
2. Read CONVENTIONS.md -- confirm constraints
3. Read relevant source files before touching them
4. Implement (contracts -> persistence -> route -> tests)
5. npm test (all must pass)
6. npm run build (must be clean)
7. Commit with conventional message
8. Update AAHP files (STATUS, LOG, NEXT_ACTIONS, DASHBOARD, MANIFEST)
9. Push to GitHub
```

## Order of Implementation for New Features

Always implement in this order to avoid type errors mid-flight:

1. `contracts.ts` -- type changes first
2. `persistence.ts` -- interface + InMemoryControlPlaneStore
3. `persistence/redis-adapter.ts` -- RedisControlPlaneStore
4. `control-plane.ts` -- route(s)
5. `src/<feature>.test.ts` -- tests last (verify full stack)

## Test Patterns

```bash
# Run all tests
npm test

# Run a single test file
npx tsx --test src/cancellation.test.ts

# Build check
npm run build
```

## Git Commit Template

```
feat(scope): short description (<=72 chars)

- Bullet points for key changes
- Reference T-### for tracked tasks

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Environment Variables

| Variable                 | Default                | Purpose                          |
| ------------------------ | ---------------------- | -------------------------------- |
| EDGEMESH_STORE           | (in-memory)            | Set to "redis" to use Redis      |
| EDGEMESH_REDIS_URL       | redis://localhost:6379 | Redis connection URL             |
| EDGEMESH_JWT_SECRET      | (random on start)      | Node JWT signing secret          |
| EDGEMESH_ADMIN_SECRET    | admin-dev              | Admin token for protected routes |
| EDGEMESH_BOOTSTRAP_TOKEN | bootstrap-dev          | Token for node registration      |
| EDGEMESH_HOST            | 0.0.0.0                | Listen host                      |
| EDGEMESH_PORT            | 8787                   | Listen port                      |

## AAHP Update Checklist (after each session)

- [ ] Append entry to LOG.md (newest first, max 10 -- overflow to LOG-ARCHIVE.md)
- [ ] Rewrite STATUS.md build table and gaps section
- [ ] Update NEXT_ACTIONS.md (move done tasks to Recently Completed, add new ones)
- [ ] Update DASHBOARD.md test counts and pipeline state
- [ ] Regenerate MANIFEST.json with new checksums and quick_context
