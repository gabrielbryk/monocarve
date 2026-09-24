# Task 2.1 review follow-ups

- Resolved 2026-09-24 by scope decision: successful reads of the sandbox-private `/proc` and minimal `/dev` are outside the authority boundary (see design.md, "pre-config authority phase"). Revisit only if deterministic-config enforcement becomes a goal.
- Fixed 2026-09-24: the sandbox mounted a tmpfs over `/tmp`, which hid captured inputs for any workspace under `/tmp`. Every valid config there failed with "trace is incomplete". Private scratch now lives at `/.monocarve-config-tmp`, and the incomplete-trace error includes the sandbox's stderr.
- Portability: executable config for assess/replay/batch requires Linux with `bwrap`, `strace`, and unprivileged user namespaces, and fails closed elsewhere. Document this in the README platform section at release.
