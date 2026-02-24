# Contributing to OpenClaw EdgeMesh

Thanks for contributing 🚀

## Development setup

```bash
npm install
npm run build
npm test
```

## Coding standards

- Use TypeScript for new runtime modules when possible.
- Keep changes small and scoped.
- Add or update tests for behavior changes.
- Run formatting and linting before committing.

## Quality checks

Run locally before opening a PR:

```bash
npm run lint
npm run format:check
npm test
npm run build
```

## Commit guidelines

- Use clear, action-oriented commit messages.
- Prefer Conventional Commit style (`feat:`, `fix:`, `docs:`, `chore:`).

## Pre-commit hooks

This repository uses Husky + lint-staged. On commit, staged files are auto-linted and formatted.

If hooks are not installed yet:

```bash
npm run prepare
```
