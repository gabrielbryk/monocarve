# Task 2.1 review follow-ups

- Resolved 2026-09-24 by scope decision: successful reads of the sandbox-private `/proc` and minimal `/dev` are outside the authority boundary (see design.md, "pre-config authority phase"). Revisit only if deterministic-config enforcement becomes a goal.
- Fixed 2026-09-24: the sandbox mounted a tmpfs over `/tmp`, which hid captured inputs for any workspace under `/tmp`. Every valid config there failed with "trace is incomplete". Private scratch now lives at `/.monocarve-config-tmp`, and the incomplete-trace error includes the sandbox's stderr.
- Portability: executable config for assess/replay/batch requires Linux with `bwrap`, `strace`, and unprivileged user namespaces, and fails closed elsewhere. Document this in the README platform section at release.

## Independent review, 2026-09-24

Fixed before merge:

- HIGH: `strace -f` splits a concurrent call into `<unfinished ...>` and `<... resumed>` lines, so an out-of-set read on a worker thread escaped the failed-read check. The trace is now rejoined per PID. Every failed file-class call counts, including `statfs`, `chdir` and `execve`, not a fixed list of syscall names. Regression tests cover both.
- MEDIUM: builtins imported without `node:` (`import "path"`) were treated as files to capture and refused. They are now skipped.

Open (fail closed or out of the approved scope; not merge blockers):

- Directory listings (`readdirSync`) inside the sandbox silently show only captured entries, and `getdents` is not traced. A config that enumerates `packages/*` builds a smaller config without error. Options: make captured directories unlistable, or trace `getdents64` after the marker.
- TOCTOU in `copyInput`: containment is checked separately from the `readFileSync` that follows symlinks. A concurrent writer could swap in a symlink to a host file. Fix with an `O_NOFOLLOW` open, then `fstat` compared against the capture.
- pnpm-installed config dependencies probably fail closed. Resolution returns the real `.pnpm/` path, but `node_modules/<pkg>` is absent from the image.
- LOW: `prepareSandboxImage` runs outside the `try`, so a throw leaks the snapshot directory. The standalone binary falls back to the first `bun` on `PATH`.
