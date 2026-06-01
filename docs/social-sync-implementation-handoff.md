# Social Sync Implementation Handoff

Date: 2026-06-01

## Current Decision

Run this project on Node.js 24.x before installing dependencies, running tests, or committing. Do not treat failures from Node 26 as application failures until the same command has been retried on Node 24 after `pnpm install`.

This is now enforced in code:

- `tools/check-node-version.mjs` reads `.nvmrc` and exits early unless the active Node major is 24.
- `package.json` declares `engines.node: "24.x"`.
- `pnpm-workspace.yaml` enables `engineStrict: true`, so pnpm install rejects unsupported Node majors.
- `pnpm preflight` and `pnpm preflight:fix` run the runtime check before Turbo on supported Node versions; unsupported Node versions are rejected by pnpm before scripts run.
- `pnpm install` is blocked by pnpm engine strictness on unsupported Node versions and also runs the root `preinstall` runtime check on supported versions.
- `start-dev.sh` runs the same check before starting Docker dependencies or app processes.

On Node 26, `pnpm` commands fail with `ERR_PNPM_UNSUPPORTED_ENGINE`. Run `node ./tools/check-node-version.mjs` directly when you want the longer explanation that mentions native SQLite modules.

## What Went Wrong

The previous implementation session ran a commit-gated workflow under Node 26 while the project targets Node 24. Native SQLite packages are Node-ABI sensitive:

- Liteque's nested `better-sqlite3@11` could not load under Node 26.
- Broader tRPC/database tests produced misleading native-module and transaction failures.
- The pre-commit hook ran full preflight after each task, so a known-bad environment looked like fresh feature breakage.

That noise caused agents to change code and commit process around a false signal. The actual prevention is to fail before the test suite starts.

## Future Agent Rules

1. Start every implementation session with:

   ```bash
   node -v
   node ./tools/check-node-version.mjs
   git status --short
   ```

2. If the runtime check fails, stop code work and switch runtimes:

   ```bash
   nvm install 24
   nvm use 24
   pnpm install
   ```

3. Do not use Node 26 failures to justify reverting social-sync code, changing enqueue await semantics, or bypassing tests.

4. Do not use `--no-verify` unless the user explicitly authorizes it for a known external blocker. If it is used, state the blocker and the replacement verification commands in the report.

5. For social-sync work, verify on Node 24 with at least:

   ```bash
   pnpm --filter @karakeep/trpc test
   pnpm --filter @karakeep/plugins test -- queue-liteque
   pnpm --filter @karakeep/workers typecheck
   pnpm preflight
   pnpm run --filter @karakeep/open-api check
   ```

6. UI-only social-sync work still needs browser verification after typecheck/lint/format. Do not substitute TypeScript success for visual confirmation.

## Queue-Specific Notes

The reliable Liteque runner fix is the load-bearing backend change. If you revisit enqueue behavior in `connect` or `syncNow`, do it as a deliberate product/reliability decision on Node 24 with a regression test. Do not infer correctness from Node 26 native-module errors.

The cron path already awaits scheduled enqueue calls and logs scheduling failures. Manual enqueue behavior should be judged by caller semantics and test coverage, not by the broken Node 26 suite.

## Handoff Summary

Root cause: missing early Node runtime enforcement.

Fix applied: runtime guard added to install, preflight, and local dev startup; setup docs and this handoff now document the rule.

Expected future behavior: a contributor or agent on Node 26 gets a short actionable failure before native modules, tests, or hooks create misleading output.
