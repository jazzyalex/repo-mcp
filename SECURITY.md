# Security model

This release candidate is for trusted single-user pilots on macOS. File allowlists,
current hashes, output caps, timeouts and snapshot runners reduce accidental scope
expansion. They do not establish a complete hostile-code execution sandbox.

- Only one server/editor should write a checkout. External writes can race the
  final hash validation and rename. Ordinary filesystem locks cannot constrain
  unrelated writers that do not participate in locking.
- Path containment verifies after acting, because Node has no `openat`: reads prove the
  opened descriptor is the in-tree file, and edits and creations re-check the parent
  directory before and after publishing. This detects swapped path components; it does not
  make races impossible, and undoing a detected violation is best effort. Treat local
  users and processes as trusted.
- Loopback HTTP has no independent authentication. Never expose it directly to a
  public network. The private tunnel provides remote authorization.
- Tests are executable code. Node uses its permission system; the optional Python
  runner applies the limited macOS profile described in SETUP.md. System operations
  outside the documented restrictions remain possible. Keep code trusted.
- Secrets are local files with owner-only permissions. Do not commit or distribute
  .trial, logs, generated profiles, health files or keys. Upstream private logs
  may contain credential diagnostics; only sanitized status is printed.
- Key rotation does not create a new tunnel. It restarts the client to reload the
  key, then checks a recent successful poll. A ChatGPT repo_info call is still the
  final end-to-end check.
- Login services start only after login. Sleeping/offline machines cannot serve
  ChatGPT. Credential revocation or expiry requires user action.

No public vulnerability-reporting address has been established yet. Before public
release, the maintainer must provide a private reporting channel. Do not publish
credentials, private source or exploit details in public issues.
