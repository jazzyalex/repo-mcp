# Milestone 2b design: path policy, discovery and scoped creation

Status: **approved with changes (rev 2).** Rev 2 resolves the review findings: Git argument handling (section 7), deletions in diffs (section 7), `mayDescend` (section 7), v1 narrowing (section 5), `secret_exceptions` (D3), cursor expiry (D8), Unicode spelling (D10) and rollback wording (D9). Implementation starts with failing boundary tests (section 12). `dist/` and the running pilot stay untouched until 2b passes review.

Inputs: [WORKFLOW-SPEC.md](WORKFLOW-SPEC.md) ("Policy and capture cost", "MCP interface requirements"), [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) section 2b, and the 2a code (`policy.ts`, `repo.ts`, `capture.ts`).

## 1. Goals and non-goals

Goals
- Enforce the policy v2 fields that `policy.ts` already parses but `runtimePolicy` rejects today: read/write include and exclude globs, `create.directories` and `create.extensions`, `dotfiles`.
- Let a policy expose a real project (thousands of files, nested creation, `.github/` files) without listing every path.
- Keep `.git` internals and secrets unreadable, unwritable and undiscoverable under every policy.
- Keep today's containment, no-overwrite, hash-precondition and atomic-edit properties across the larger path surface.

Non-goals (deferred, stated so nobody assumes them)
- Resumable discovery jobs, execution-input scopes, named checks, rename/delete: milestone 3 and later.
- A hostile-local-user threat model. The local user and processes stay trusted (SECURITY.md); section 8 reduces and detects races, it does not claim to remove them.

Contract preservation
- No change to existing tool names, arguments or response fields. New: `list_files` tool, `capabilities.path_policy`, `capabilities.discovery`.
- All 93 current tests keep passing, with one intended exception: `policy.test.ts` "pattern semantics are rejected until policy matching lands" pins the behaviour 2b replaces. It is rewritten to assert the new grammar and the still-rejected syntax. Exact-mode `git_diff` and `repo_info` output stays byte-identical for existing cases.
- **Intentional narrowing** (not hidden compatibility): the new built-in denials and path-syntax rules can reject policies that older versions accepted. See section 5.
- Adding `list_files` changes the tool list: after deployment refresh the cached tool list in ChatGPT settings and verify discovery in a new conversation. Policy edits alone do not.

## 2. Policy model

The v2 schema is unchanged, so there is no version bump and the policy digest algorithm is unchanged.

| Field | Meaning in 2b |
|---|---|
| `read.include` / `read.exclude` | Files the model may read, search and diff. |
| `write.include` / `write.exclude` | Files `edit` may change. A writable path must also be readable. `read.exclude` also denies writes. |
| `create.paths` | Exact new-file paths (today's v1 `creatable`). |
| `create.directories` | Existing directories under which new files, and new subdirectories, may be created. |
| `create.extensions` | Extensions allowed for files created under `create.directories` (required when `directories` is non-empty). `create.paths` entries are exempt: the operator named them. |
| `dotfiles` | The only way a path with a dot-leading segment becomes eligible (section 4). |
| `checks[].path` | Exact paths, unchanged. Must be readable. |
| `secret_exceptions` | **New, optional.** Exact paths of conventional example files (basename ending `.example`, `.sample`, `.template`, `.tmpl` or `.dist`) that a reviewed policy lifts from the secret-*file* rules. Absent means none. Omitted from the canonical policy when empty, so existing task policy digests do not change. |
| `limits` | Unchanged keys. `inventory_paths` gains its enforcement (section 7). |

Created files must also match `read.include` and `write.include`, so they can be read back and edited. This keeps today's invariant `creatable ⊆ editable ⊆ files` (creation of a file the server cannot read back was a 2a defect).

## 3. Path syntax and glob semantics

Path syntax, checked before any matching (traversal is rejected, never normalised away):
- Repository-relative, `/`-separated, 1 to 256 bytes of UTF-8.
- No empty, `.` or `..` segment; no leading `/`; no `\`; no control character (C0, DEL, C1), no U+FFFD (how Node shows an undecodable disk name) and no unpaired surrogate; no segment over 255 bytes.
- Any other Unicode is accepted **in the spelling stored on disk**. The server never rewrites or rejects a name merely for being decomposed (NFD), which macOS stores for some project files.
- Tool arguments and policy patterns share these rules. A path that fails them is not exposed; it is not an error that distinguishes it from a missing path.

Glob grammar, deliberately small:
- `*` matches zero or more characters within one segment; `?` matches one character within one segment.
- `**` is valid only as a whole segment and matches zero or more whole directory segments.
- A pattern without wildcards is an exact path.
- `[ ] { } !` and `\` are rejected when the policy loads ("unsupported pattern syntax"), as today. No negation, alternation or escapes: exclude rules express negation. Rejecting beats guessing at escape rules.
- Patterns match **files**, with one deliberate asymmetry: an exclude pattern also matches every path beneath a directory it matches (it is prefix-closed). Include patterns are not. So `exclude: ["vendor"]` removes the whole `vendor/` tree, while `include: ["src"]` matches nothing.
- Wildcards match dot-leading segments. Eligibility of dot paths is decided by the dotfile gate (section 4), not by the glob, so a `**` include can never expose `.env`.

Spelling, normalisation and collisions (D10), defined separately from matching:
- **Preserved spelling.** Inventory entries, responses, cursors and audit records carry the disk spelling. Nothing is rewritten.
- **Deny comparisons fold**: NFC, then Unicode lower-casing, applied to both pattern and path. `.GIT/config` and an NFD spelling of a denied name are denied.
- **Allow comparisons are NFC-insensitive and case-sensitive**: patterns and paths are NFC-normalised for comparison only, so `café/*` in a policy matches a directory stored as decomposed `café`; a case variant never gains access.
- **Tool path resolution**: an exact inventory spelling wins; otherwise a tool path resolves to the inventory entry that has the same NFC form if exactly one exists (so a model's NFC `café.js` finds the decomposed file); otherwise the path is not exposed. Responses report the resolved disk spelling.
- **Creation collisions**: a new file or directory name is refused when it equals an existing sibling after NFC and case folding, even on a case-sensitive volume. The refusal names no hidden file.
- Two entries that are NFC-equal on a normalisation-sensitive volume both stay in the inventory under their own spellings; resolution of an ambiguous NFC-only path fails, exact spellings still work.

## 4. Deny precedence and the dotfile gate

`decide(path, op)` for `op` in `read | write | create`, evaluated in this order; the first denying step wins and a later step can never undo it.

1. **Syntax** (section 3).
2. **Built-in denials**, not configurable and not liftable by `dotfiles` or includes:
   - any segment equal (folded) to `.git`, `.hg` or `.svn`;
   - secret names, matched on the folded basename, and also on the basename with every trailing conventional example suffix (`.example`, `.sample`, `.template`, `.tmpl`, `.dist`) removed, so `config.pem.sample`, `server.key.example`, `credentials.json.template` and `.npmrc.template` are denied like `config.pem`, `server.key`, `credentials.json` and `.npmrc`: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`, `credentials`, `credentials.json`; and directories `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`;
   - server-owned paths that fall inside the root: the policy file, audit log, state and capture directories (passed in as protected paths), and the repository-root `.trial` directory, which is a built-in rule (first segment equal, folded, to `.trial`): it is denied for read, write and create, discovery never descends into it, and neither `dotfiles` (even `**`) nor `secret_exceptions` can lift it. A `.trial` below the root is an ordinary dot path;
   - server temp files, `.mcp-*.tmp`.
3. **Operator excludes**: `read.exclude` for read; `write.exclude` plus `read.exclude` for write and create.
4. **Dotfile gate**: if any segment starts with `.`, the path must match a `dotfiles` pattern, else deny. (v1 policies have `dotfiles: []`, so they keep rejecting every dot path.)
5. **Includes**: read needs `read.include`; write needs `read.include` and `write.include`; create needs the rule in section 6 and both includes.

Consequences: `**` plus `dotfiles: [".github/**"]` exposes `.github/workflows/ci.yml` but never `.env`, `.git/config` or `.ssh/id_rsa`. A `dotfiles` pattern that overlaps a built-in denial is ignored, and policy load reports it as a warning-level error naming the pattern.

**Reviewed exceptions (D3).** `.env.example`, `config.pem.sample` and similar conventional templates are denied by default because the secret-name rules match them. A policy may list exact paths in `secret_exceptions`. An exception applies only if (a) the entry is an exact path, not a pattern, (b) the basename ends in `.example`, `.sample`, `.template`, `.tmpl` or `.dist`, and (c) the denial it lifts is a secret *file-name* rule. It never lifts `.git`/VCS names, secret directories, server-owned paths or temp files. Entries that violate (a) to (c), or lift nothing, fail policy load. Because the policy is operator-owned and part of the policy digest, adding an exception is a reviewed change; real secret names (`.env`, `.env.local`, `id_rsa`, `*.pem`) stay denied.

No existence oracle for **file operations**: reading, editing or creating a denied path, an unlisted path and a missing path return the same error text ("Path is not exposed by this repository policy."), and search never reports skipped secrets. Git status is the exception: it is the unfiltered output of `git status` (the existing contract, kept byte-identical), so it can list the *names* of untracked paths the policy does not expose, never their contents (decision D13).

## 5. Exact policies, v1 migration and compatibility

- `migrateV1` is unchanged: exact lists become exact `include` entries, `dotfiles: []`, `create.directories: []`.
- A policy whose `read.include` entries are all literal and whose `create.directories` is empty is **exact mode**. Exact mode skips the walk: the inventory is the literal list filtered by `decide`, existing files validated at startup exactly as today (`read()` of each, tracked-in-HEAD check of each literal write path, protected-test hashes). Existing error messages and behaviours are preserved, including startup failure when a listed file is missing, too large or not UTF-8.
- `runtimePolicy(v2)` keeps returning today's `RepoPolicy` for exact-mode policies, so `deepEqual(runtimePolicy(migrateV1(v1)), v1)` still holds. Glob policies compile to a `PathPolicy` (`src/path-policy.ts`) that `RepoWorkspace` consumes through the same interface; `RepoWorkspace.create(root, RepoPolicy)` wraps a `RepoPolicy` into an exact `PathPolicy`, so all existing callers and tests work unchanged.
- Differential test (section 12): random exact policies behave identically through both paths.
- **Intentional narrowing.** 2b is not permission-identical for every policy that v1 accepted, and it does not pretend to be. Two classes of previously accepted policy are now rejected **at startup** with an actionable migration error; paths are never silently filtered out while claiming identical permissions:
  1. Literal paths hitting a built-in denial, for example `credentials.json`, `example.pem`, `secrets/id_rsa`, `.env`. Error: `Policy path "credentials.json" is denied by built-in secret rule <name>. Remove it from the policy. (If it is a conventional example file, list it in secret_exceptions.)`
  2. Literal paths that violate the new syntax (control characters, U+FFFD, backslash, over-long segments). Error names the path and the rule.
  Patterns are never rejected for *possibly* matching a denied path; they simply never match it. SETUP.md carries a migration note with both errors and the fix.
- Glob-mode startup cannot read every file. It validates structure only: patterns parse, checks resolve to readable literal paths, dotfile and create rules are coherent, literal write paths are tracked. Per-file validation (size, UTF-8, tracked) happens when a file is discovered (size) or used (UTF-8, tracked), as `edit` already does.

## 6. Scoped creation

A path `P` may be created when all of these hold:
1. `decide(P, create)` allows it (`read.include`, `write.include`, not denied).
2. `P` is in `create.paths`, **or** `P` lies under an entry `D` of `create.directories`, its extension (last `.ext`, folded) is in `create.extensions`, and its depth below `D` is at most 8.
3. `D` itself exists and is a real directory (the server never creates a scope root).
4. No existing entry in the target directory collides with the final name after case and NFC folding.

Missing intermediate directories under `D` are created one level at a time with mode 0o755: lstat the parent (real directory, not a symlink), `mkdir` (which fails rather than follow an existing final symlink), then verify the new directory (section 8). Creation never overwrites: the file still publishes with temp file plus `link()`, as now. If the final `link` fails, directories this call created that are still empty are removed best-effort (section 8). Outcome records and `request_id` reconciliation keep working because they key on the file path and content hash; leftover empty directories are harmless and noted in the response (`created_directories`).

Edits of a created file: it is untracked, so the "editable files must be tracked in HEAD" rule is relaxed for any path that satisfies rule 2, exactly as `create.paths` are exempted today. `git_diff` shows such files as approved new files.

## 7. Discovery, inventories and limits

### Inventory
Glob mode builds an **inventory**: a sorted (byte order) array of entries `{path, size, mode, mtimeNs, ctimeNs, ino}` plus a list of walked directories `{path, mtimeNs, ctimeNs, ino}` and a `digest = sha256(policy_digest, entries, directories)`.

The walk, from the root, depth-first in sorted order:
- `readdir` with file types, names read as bytes. A name that is not valid UTF-8, contains a control character or `\`, or yields a path over 256 bytes is skipped and counted.
- Symlinks, FIFOs, sockets and devices are never followed or listed; counted.
- Directories on another device are not entered; counted.
- A directory is entered only if `mayDescend(directory)` holds (below). File eligibility and directory descent are **different questions** with different rules.
- Regular files with `nlink > 1` or `size > edit_file_bytes` are skipped and counted (`linked`, `too_large`).
- Each directory is lstat-ed before and after listing; if its identity moved, that directory is re-listed once, then the build fails with an explicit "changed during discovery" error.

`mayDescend(D)` is true only if **all** hold; otherwise the directory is pruned:
1. No unconditional denial: not a VCS or secret directory, and no operator exclude *covers* `D`. An exclude covers `D` when it matches `D` itself (excludes are prefix-closed) or has the form `Q/**` with `Q` matching `D`. Patterns like `vendor/*/x` do not prune; their files are filtered individually.
2. **Dotfile gate, directory form**: if `D` has a dot-leading segment, some `dotfiles` pattern could match a path beneath `D`. With `dotfiles: [".github/**"]`, `.github` and `.github/workflows` are entered; `.git` and `.secret/` are not.
3. **Include reachability**: some `read.include` pattern could match a path beneath `D`. Includes restricted to specific descendants (`src/a/b.js`) keep `src` and `src/a` descendable and prune `test`.

"Could match beneath" is computed on segments after normalising a trailing `**` to `**/*` (so `src/**` means one or more segments below `src`): consume `D`'s segments through the pattern (a `**` may stay or advance) and require a state with pattern segments still to match. This is a necessary condition only; every file is still checked by `decide(path, read)`. Pruning never hides a permitted file because every condition is a necessary condition for some descendant to be permitted.

Content is not read during discovery, so UTF-8 or binary status is unknown until use. `read` of a non-text file fails explicitly as today; `search` skips non-text files and reports `skipped_files` instead of failing the page (exact-mode policies still fail at startup as today).

### Limits (all explicit, never a partial inventory presented as complete)
- `inventory_paths` (default 100,000) caps listed files.
- Visited directory entries are capped at 4 x `inventory_paths`, depth at 32, so excluded junk cannot make the walk unbounded.
- The walk runs under one `Deadline` (`operationBudgetMs`, 10 s) shared with all its stages. Exceeding any cap or the deadline returns `DISCOVERY_LIMIT` or a timeout naming the cap and suggesting excludes. **Resumable discovery jobs are deferred to milestone 3** (decision D4); a 100,000-file walk should take 1 to 3 seconds, and the tests measure it.
- Responses report `inventory: {paths, directories, skipped: {...}, digest}`.

### Freshness, validity and invalidation (D5)
Two freshness levels, both checked on every call that uses the inventory:
1. **Membership** (files added, removed, renamed): every walked directory's `(mtimeNs, ctimeNs, ino)` is compared; one lstat per directory. Any difference triggers a full re-walk. Server mutations also update the in-memory inventory.
2. **File metadata** (in-place edits that leave their directory untouched): directory metadata cannot see these. Each call re-lstats every entry (O(files); batched, about 1 second for 100,000 files, under the call's deadline) and updates entries whose `(mode, size, mtimeNs, ctimeNs, ino)` changed. So cached entries never serve stale metadata to a new call, and `list_files` sizes are current as of that call.

The inventory `digest` covers both levels, so any membership or metadata change produces a new digest.

What binds to what:

| Consumer | Binds to | On change |
|---|---|---|
| `list_files`, `files_cursor`, search cursors | The cursor's inventory digest, repository binding, policy digest, argument digest (query and prefix) and creation time | Explicit stale-cursor error. A call without a cursor starts a new generation. |
| Per-file use (`read`, `edit`, search scan) | The entry fingerprint re-checked against the open descriptor's `fstat` | Search: stale-cursor error. `read` and `edit`: unchanged stale-hash rules. |
| `git_diff` and status captures (2a) | Digest of the entries and directory fingerprints that can lie under the capture's prefix, and a digest of the Git index entries it depends on (mode, object and stage from `ls-files -s`, plus the intent-to-add, skip-worktree and assume-unchanged flags from `ls-files --debug` with its stat lines dropped; whole index for status, permitted paths under the prefix for diff), both taken before and after Git runs and on every continuation | Stale-cursor error, including a file appearing or disappearing in a scanned directory and a change that touches only the index. Stat-only index refreshes do not change the digest. |
| Task policy change | Existing `verifyPolicy` | Unchanged. |

Fingerprints are change metadata, not content identity: a writer that keeps size and restores mtime and ctime is undetected here. Review and commit boundaries must verify content hashes, as 2a already states. Test: an in-place edit (same directory, no membership change) is visible to the next search, and invalidates a search or diff cursor mid-paging.

### Cursors (D8)
List, file-list and search cursors need no server memory, so they survive a restart, but they are not open-ended. A cursor is JSON with a kind and: repository binding (digest of root, git-dir and common-dir), policy digest, inventory digest, argument digest, creation time `t`, and positions. Validation, in order: kind matches; every field has the expected type; positions are non-negative safe integers; `t` is not in the future (5 minutes of skew allowed) and `now - t` is within `cursor_ttl_hours` (using the injectable clock); repository, policy and arguments match the current call; the current inventory digest matches; positions lie within the inventory (and a search line position within the file's actual line count). Anything else is an explicit invalid or expired cursor error. Cursors are unsigned hints: every field is revalidated against current state, so forging `t` can only extend the window in which a cursor with a matching digest still works, never widen access. Diff and status cursors keep the 2a capture binding and expiry.

### Git integration for large path sets
Installed Git (2.50.1) rejects `--pathspec-from-file` for `git diff` and `git ls-files` (only commands such as `add` and `restore` accept it), so the earlier design is withdrawn. Rules instead:
- **Never one unbounded command line.** Literal paths go in bounded batches of at most 200 paths and 48 KiB of path bytes, after `--` with the existing `--literal-pathspecs`. All batches of one capture share one `Deadline`; each Git run gets the remaining time; the deadline is checked between batches.
- **Rename handling is explicit.** Every capture command passes `--no-renames`. A rename therefore appears as one deletion and one addition, each judged by policy on its own path. A rename from a permitted path to a denied one shows only the permitted side's deletion; denied to permitted shows only the permitted addition (its content is readable anyway). Without `--no-renames` a rename's pairing would depend on which batch each path landed in.
- **Changed paths are listed first, patches second.** Porcelain `git diff --no-ext-diff --no-textconv --no-renames -z --name-only HEAD` lists every path whose content differs from HEAD (working tree, deletions and staged additions), and the same with `--cached` lists index differences; their union is filtered through `decide(path, read)` and the prefix. Porcelain `diff` is used rather than `diff-index` because it refreshes the index and compares content: `diff-index` also reports stat-dirty paths whose content is unchanged, which would hide a staged-only difference from the marker logic below. Output is small because it names only changes. Patches are then produced with `git diff --no-ext-diff --no-textconv --no-color --no-renames HEAD -- <batch>`, appended to one capture file in path order. One batch produces output byte-identical to the 2a command.
- **Name listings may be lossy; patches may not.** Path lists are decoded leniently (a tracked name with invalid UTF-8 elsewhere in the repository must not break an unrelated diff); a name containing U+FFFD fails the syntax rule and is dropped. Patch content stays strictly validated.

### Deleted and staged changes in diffs
Filesystem discovery cannot see a deleted tracked file, so the diff scope is **not** the inventory. It is the union of (a) permitted paths that Git reports as changed from HEAD or the index, including deletions, which come from Git's own listing, and (b) permitted working-tree files from the inventory that are approved new files (untracked and satisfying the creation rule), checked against the index in batches with `git ls-files --cached -z -- <batch>`. A permitted change is never dropped because its file is absent. If Git lists a permitted path as changed but its patch is empty (for example a staged-only difference), the capture appends an explicit line `# no working-tree patch for <path> (index differs from HEAD)` instead of omitting it. Deleted paths are tested for staleness by their directory's fingerprint: a deleted file reappearing, or another file vanishing from a scanned directory, makes the capture stale.

**Eligibility of existing diff inputs (review fix).** Git opens an existing working file itself, so path spelling and read policy are not enough. Before patches run, every listed path that exists is judged by the read/inventory rules: no symlink in any component, every component on the root's device, a regular file with one hard link, within `edit_file_bytes`. A missing file or parent is a genuine deletion and is reported as before. An ineligible path is not given to Git; the capture appends `# no patch for <path> (<reason>; ...)` instead, so the omission is explicit. After Git has run the same check is repeated against the lstat fingerprints taken first; any difference discards the capture and retries under the existing attempt limit. This is the established detect-after design (section 8): a swap between check and Git's open is detected afterwards, never prevented, and nothing here claims protection from a hostile filesystem writer. Not covered: exact-mode `list_files` still lists a hard-linked file that appears after startup (`read` refuses it).

**Dot paths in exact v2 policies (final review fix).** The v1 rule "no dot-leading segment" belongs to direct v1 policies (`RepoWorkspace.create(root, RepoPolicy)`, `validateLegacy`), which keep it unchanged. A compiled v2 policy that has an exact form is checked by path syntax (`pathProblem`), list membership and the `PathPolicy` decisions only, so a literal path such as `.github/a.yml` with `dotfiles: [".github/**"]` starts on the exact fast path, and can be listed, read, searched, edited (if write-listed) and created (if a literal create path). The dotfiles gate, built-in denials (`.git`, secrets, `.trial`) and server-owned paths still fail policy load for literal entries, and a migrated v1 policy (which has no dotfiles entries) still cannot name a dot path. An approved dot directory does not expose unlisted files in it.

**Exact policies use the compiled decisions (final review fix).** The exact (v1-shaped) lists of an exact policy are derived from the compiled `PathPolicy`'s own `decide` results, with the same server-owned `protectedPaths`, instead of a second set-membership implementation. Consequences:
- `read.exclude` and `write.exclude` apply folded (case and Unicode normalisation) and prefix-closed (an excluded directory covers everything beneath it), for read, write, create and checks. A listed path that a rule denies is dropped from its list; a path that only lacks an include stays, so the v1 membership error is unchanged.
- A configured check that the policy denies is a policy error (`Check path "..." is not readable under this policy`), never a silently shorter suite list, matching what glob policies already do at startup.
- A literal policy path (`read.include`, `write.include`, `create.paths`, `checks`) or creation directory that is or lies under a server-owned path (policy file, audit log, state directory inside the repository) fails policy load with a "server-owned path" error, in exact and glob mode, v1 migrations included. Nothing is silently filtered there, as for the built-in denials. Policies that do not name server-owned paths keep the exact fast path and are unchanged.
- `RepoWorkspace.create` refuses a compiled policy whose exact lists contain a path its own path policy denies, and exact-mode `exposed()` re-checks `decide(path, 'read')`, so a hand-built or stale pair cannot widen access.

**create_file crash recovery (final review fix).**
- *Window.* `create_file` hard-links a complete `.mcp-<uuid>.tmp` to the target and unlinks the temporary. A crash between the two leaves the target at two links; discovery and `read` refuse links (section 8), so a retry saw "absent" and replayed into `EEXIST`, recording a failure for content that was published.
- *Evidence.* After the temporary is written, synced and closed, and before the link, the outcome record gains an optional `publication` object `{ target, temp, dev, ino }` (`temp` a path in the target's directory, `dev` and `ino` decimal strings from a bigint `lstat`). Schema change: one optional field on the `outcome` record; the record version is unchanged. Records without it (older versions, or a crash before it was written) are read as before and never trigger cleanup.
- *Recovery* (`recoverPublication`) runs at startup for the task's outcomes that have evidence and did not fail (before exact-mode validation, holding the checkout lock, only when the task has recorded outcomes) and in `prior()` before a retry's hash is read. It acts only if the evidence is well formed (temp name pattern, same directory as the target, no path problems), no symlink is on either path, and: the temporary is the recorded inode with exactly the expected link count (1 before the link, 2 after, with the target the same inode and also at 2), and its content hash equals the recorded `after_sha256`. Then, and only then, it unlinks that one temporary after a second identity check. A replaced temporary, an extra link, a different file at the target, or a symlink throws an uncertain-outcome error with nothing removed or written; at startup that error is deferred to the retry (exact mode still fails closed on the hard link).
- *Absent versus refused.* `currentHash` returns `null` only when the path is truly absent. A path that exists but is not an exposed readable file (link, symlink, special file, oversized, ambiguous alias) is an uncertain-outcome error, never "absent", so refusal can never make a replay look safe. Files the policy denies are not examined.
- *Limits.* A crash after the temporary is created and before its evidence is recorded leaves an orphan `.mcp-*.tmp` that is not exposed and is not removed by name; the retry creates the file once. Cleanup is best effort against races (a pathname check followed by `unlink`), like every other containment step. Created-but-empty directories from an interrupted create are not removed. A hash-only match (someone else created identical content) is still accepted as `already_applied`, as before.
- *Test seam.* The `pathHook` stage `create:after-temp` (new) joins `create:before-link` and `create:after-link`. `test/review-create-recovery.test.ts` kills a child process (SIGKILL) at each stage in glob and exact task modes, and crafts persisted states for the malicious, replaced, unrecorded and old-outcome cases.

**Oracle review fixes.**
- **Request IDs and Unicode spelling.** Reconciliation (`once`) hashes the file by the same resolution `read` and `edit` use: exact inventory spelling, else the single NFC-equal entry (exact mode: the listed path). An ambiguous or unexposed path hashes as absent, never as another file, and a creation target that does not exist yet still hashes as `null`. The intent record stores the resolved disk spelling. Replay after a retry, a restart and a crash between write and completion record is covered for an NFC tool path over an NFD disk name.
- **Git name versus disk name.** Git may store a different Unicode form than the disk spelling (macOS precomposition). Tracking checks and the new-file check in `git_diff` ask Git for each path's NFC and NFD spellings as well, and accept a Git name that differs from the disk spelling only if both spellings are the same file (same device and inode). On a normalisation-sensitive volume the two entries are distinct files, so they are never merged. Listings keep the disk spelling.
- **Bounded tracking argv.** `ls-tree` and `ls-files` for the tracking invariants run in the existing batches (200 paths, 48 KiB) of literal pathspecs under one operation `Deadline` shared by every batch and every stage (HEAD, then index) of one validation. The deadline is checked before and after each Git call and each call gets only the time left, in a capture and outside it, so a positive `operationBudgetMs` is never exceeded by a second stage. One compatibility case: while the repo is being created, `operationBudgetMs: 0` (a test setting that makes runtime operations time out at once) gives startup validation its own 10 second allowance, because startup would otherwise be impossible; a positive startup budget applies as is, and runtime edit, diff, capture and search keep the zero budget. Results are merged before the invariants are checked. Exact policies with thousands of long paths no longer fail with `E2BIG`. To keep that startup inside the budget, `PathPolicy.decide` looks literal `read.include` and `write.include` entries up in a set instead of matching each one in turn.
- **Permission bits.** An edit writes a temporary file and renames it. `open(..., mode)` is filtered by the process umask, so the replacement is `fchmod`-ed to the original ordinary permission bits (including the executable bits). Setuid, setgid and sticky bits, ACLs and extended attributes are not preserved.
- **AGENTS.md continuation.** `repo_info` has no input for `instructions_next_cursor`; the server instructions and the `repo_info` description tell the model to call `read(path: "AGENTS.md", cursor: <instructions_next_cursor>)` and continue with `read`'s `next_cursor` until `complete`.

**Index binding (review fix).** A capture records a digest of the index entries it depends on, compared before and after Git and on continuation (see the table in section 7). The digest is computed from `git ls-files --stage --debug -z`, never from the index file, so refreshes that only rewrite stat data (or the index version) do not invalidate cursors; `git write-tree` is avoided because it writes objects. `--stage -v` alone is not enough: an intent-to-add entry lists exactly like a staged empty file (empty blob, mode 100644, stage 0) yet `git status` reports ` A` instead of `A `, and `-v` does not show the flag. The entry flags are read from the `--debug` block and masked to `CE_VALID` (assume-unchanged), `CE_INTENT_TO_ADD` and `CE_SKIP_WORKTREE`; the stat lines are discarded. Output that does not parse fails closed with an inspection error. The listing is buffered in memory (not streamed) up to 128 MiB (roughly 400,000 paths); beyond that the capture fails explicitly. This is the one exception to the 16 MiB cap on other buffered Git calls. Records without the field never match.

**Response budget (review fix).** `list_files` and `search` count the whole serialized response against `page_bytes`: metadata (the last page without a cursor, other pages with a worst-case cursor) plus entries. When metadata plus one entry or match does not fit, the call fails with an explicit `page_bytes` error rather than returning an oversized response or a cursor that cannot advance. The documented `run_tests` output exception remains until milestone 3.

### repo_info and list_files
- `repo_info` keeps its six file lists, now drawn from the inventory and paged by `files_cursor` as in 2a, plus `inventory` counts. For glob policies it also reports a compact `policy_summary` (patterns, dotfiles, create scopes) so the model can reason about scope without listing everything.
- New `list_files {prefix?, cursor?}`: paged `{path, bytes, editable}` entries in byte order within the page budget, with `complete`, `next_cursor` and the `inventory` block. Read-only; annotations as `search`.
- `capabilities` gains `path_policy: "exact" | "glob"` and `discovery: {inventory_paths, tools: ["list_files"]}`.

### Test snapshot
`run_tests` copies readable files into a temp snapshot. With globs that could be the whole tree. Until milestone 3 execution scopes exist, the snapshot copies the readable inventory but fails explicitly above 5,000 files or 64 MiB (constants, not policy limits, because the `limits` block is a strict object listing every key). Exact-mode behaviour is unchanged (decision D6).

## 8. Containment and symlink-race resistance

Node has no `openat`, `renameat` or directory-relative operations, and `/proc/self/fd` tricks are not portable to macOS. The design therefore **verifies identity after acting**, so a swapped path component is detected rather than silently followed, and undoes what it created on a best-effort basis. Undo is **not atomic and not race-free**: a pathname check followed by an unlink can itself be raced, so removal runs only if a fresh lstat still matches the identity we created and any failure is reported rather than hidden. Residual risk is a writer that swaps components and swaps back between a check and the act it guards; the trusted-local-user model (SECURITY.md) applies, and the audit log records any detected violation.

Reads (`read`, search scan, snapshot copy), in `safe-fs.ts`:
1. lstat each component of the inventory path; reject symlinks.
2. `open` the final component with `O_NOFOLLOW | O_NONBLOCK`, then `fstat` the descriptor.
3. Require: regular file, `nlink === 1`, and `(dev, ino)` equal to an lstat of the same path taken **after** the open, and `realpath(path)` equal to `root/path`.
4. Read through the descriptor only.

If an intermediate component was swapped to a symlink before the open, the descriptor refers to an inode outside the tree. Both checks in step 3 are needed: `lstat` of a path with a symlinked *intermediate* component follows it, so identity equality alone would pass, but `realpath(path) === root/path` fails. A swap that is restored before the check passes the `realpath` test, but then the in-tree file has a different `(dev, ino)` from the descriptor, so the identity test fails. Reading from the descriptor means later swaps cannot redirect the data.

Edits: as today (temp file in the target directory, hash recheck, atomic `rename`) plus: record the parent directory identity before creating the temp; before `rename` re-verify the parent's `realpath` and `(dev, ino)`; after `rename` verify `realpath(target)` is still `root/path` and its identity equals the temp's. A post-rename violation cannot be undone safely, so it is reported as an uncertain outcome (`containment_violation`, naming the path) with the request still recorded, never as success.

Creation: parent chain lstat-checked per component; temp file; recheck parent identity; `link(temp, target)`; verify `realpath(target)`, `(dev, ino)` equal to the temp's and `nlink === 2`; then unlink the temp. If verification fails, the new link is removed best-effort: lstat the target, and only if its `(dev, ino)` still equals the temp file's, unlink it. If the removal succeeds the call returns `NotAppliedError`; if the identity changed or the unlink fails the outcome is uncertain and reported as `containment_violation` for the operator to inspect. New directories (section 6) verify the same way and are removed with `rmdir`, which refuses non-empty directories, also best-effort.

Discovery walk: directories are lstat-ed before and after listing (section 7) and never entered through symlinks.

Git: paths reach Git only as `--literal-pathspecs` arguments in bounded batches, after validation. Git may read validated metadata internally; no tool returns `.git` contents.

Other protections that carry over unchanged: hard-link rejection (`nlink === 1`), O_NONBLOCK to avoid FIFO hangs, `wx` temp creation, no overwrite on create.

The test seam: a `pathHook(stage, ctx)` option on `RepoWorkspace` (like 2a's `captureHook`) lets tests swap a component for a symlink at an exact stage (`after-check`, `before-rename`, `before-link`, `before-open`) so every race above is exercised deterministically, not by timing.

## 9. Interaction with 2a captures and `request_id`

- Capture scope is the digest of inventory entries and directory fingerprints under the capture's prefix (section 7); the 2a drift check around Git, the shared deadline and the retry limit are unchanged. The inventory refresh and every Git batch run inside the capture's `Deadline`.
- `request_id` outcomes are unchanged. `created_directories` is returned in the result but is not part of idempotency (replay returns the recorded result with `already_applied`).

## 10. Errors

New distinguishable errors, none of which leaks denied-path existence: `invalid path`, `unsupported pattern syntax` (policy load), `policy overlaps a built-in denial` (policy load), `DISCOVERY_LIMIT`, `changed during discovery`, `containment_violation`, `creation scope: extension not allowed`, `creation scope: depth exceeded`, `snapshot too large`. Existing messages for existing cases are unchanged.

## 11. Files

New: `src/glob.ts` (compile and match), `src/path-policy.ts` (`decide`, built-ins, dotfile gate, creation rule), `src/inventory.ts` (walk, fingerprints, digest, validity), `src/safe-fs.ts` (verified open, replace, link, mkdir with seams). Changed: `policy.ts` (`compilePathPolicy`, `runtimePolicy` for exact mode, load-time checks), `repo.ts` (inventory-backed `availableFiles`, search, info, diff scope, creation, edit), `server.ts` (`list_files`, capabilities, instructions), `capture.ts` (unchanged API; scope digest comes from the inventory), `exec.ts` (append mode for batched output), docs and SETUP.

## 12. Test-first plan

Boundary tests are written and seen to fail before each piece is implemented. Groups:

1. **Glob matcher** (table-driven): `*`, `?`, `**` at start, middle and end, zero-segment `**`, dot segments, prefix-closed excludes versus file-only includes, rejected syntax (`[ ] { } ! \`), NFC and case folding on deny but not on allow.
2. **Decision order**: include/exclude precedence for read, write, create; `read.exclude` blocks write; built-ins beat `dotfiles` and `**`; `.GIT/config`, NFD `.git` spellings, `.env`, `.env.local`, `.env.example`, `id_rsa`, `.ssh/config`, `.aws/credentials`, `.mcp-x.tmp`; allowed `.github/workflows/ci.yml` and `.gitignore` with `dotfiles`, denied without; identical error text for denied, missing and unlisted paths.
3. **Policy file protection**: policy file, audit log and state directory inside the root are excluded from read, search, list, write and create; a chat tool cannot overwrite the policy file even when a `**` write include covers it.
4. **v1 equivalence**: all existing tests; a differential test running random exact policies through the legacy path and the exact-mode path with identical results and error messages.
5. **Traversal and syntax**: `../`, absolute, `//`, `a/./b`, backslash, NUL, over-long, NFD input.
6. **Symlinks and hard links**: symlinked file, symlinked directory in the tree (not entered, counted), symlink swapped at each hook stage for read, edit, create and mkdir, hard-linked file excluded from inventory and refused at read; swap-and-restore detection through identity checks.
7. **Scoped creation**: nested creation under a directory scope; disallowed extension; depth 9; scope root missing; case or NFC collision with an existing name; no overwrite; rollback of created directories when `link` fails; created file readable, editable, shown in `git_diff`; `create.paths` exempt from extensions.
8. **Discovery limits**: more files than `inventory_paths` fails explicitly with no partial listing; visited-entry cap; deadline expiry; exclude pruning keeps a `node_modules`-style tree out of the cap; skipped counters (`too_large`, `linked`, `special`, `unsafe_name`, `other_device` where testable).
9. **Invalidation**: new, deleted and renamed files change the inventory digest; `files_cursor`, `list_files` and search cursors go stale; a diff capture goes stale when a file appears in a scanned directory; unrelated directories do not invalidate; search cursors survive a restart when nothing changed.
10. **Scale**: 20,000-file tree builds and pages within budget; continuation validation cost measured.
11. **Snapshot cap** and unchanged exact-mode `run_tests` behaviour.
12. **Git integration with large path sets** (real Git, no mocks): thousands of changed and unchanged permitted paths produce the same patch as one Git command over all paths; batch boundaries never split output; an unbounded pathspec is never used; the shared deadline stops a long batch loop.
13. **Deletions, renames, staged changes**: a deleted tracked permitted file appears in `git_diff`; rename inside scope shows deletion and addition; rename to a denied path shows only the permitted side; staged addition, staged deletion and staged-only differences are never silently dropped; deletion of an unchanged tracked file after capture makes the cursor stale.
14. **Descent rules**: `.github/**` with `dotfiles` enters `.github` and nested allowed dotfiles; a `.github/workflows/ci.yml`-only include enters exactly its ancestors; includes limited to `src/a/b.js` prune `test`; `.git`, `.ssh` never entered; `vendor/**` pruned; `vendor/*/x` not pruned but filtered.
15. **Migration narrowing**: v1 exact policies naming `credentials.json`, `example.pem`, `.env` fail at startup with the migration error; `.env.example` fails without and loads with `secret_exceptions`; exceptions that are patterns, non-example names or non-secret lift nothing fail load.
16. **Unicode**: a decomposed (NFD) disk name is listed in its disk spelling, readable by exact spelling and by its unique NFC spelling, matched by an NFC policy pattern, denied by folded deny patterns, and creation collisions with NFC or case variants are refused.
17. **Cursor validation**: expired, future-dated, wrong-repository, wrong-policy, wrong-arguments, malformed or out-of-range positions are explicit errors; cursors survive a restart while valid.
18. **MCP level**: `list_files` schema, `capabilities.path_policy`, glob-policy end-to-end read, edit, create, diff, plus the rewritten policy test.

## 13. Decisions (rev 2)

| # | Decision | Status |
|---|---|---|
| D1 | Glob grammar limited to `*`, `?`, `**`; reject `[ ] { } !` and escapes | Accepted |
| D2 | Dot paths gated only by `dotfiles`; wildcards still match dot segments; directory descent uses its own `mayDescend` rule | Accepted, revised |
| D3 | Secret names denied by default; reviewed `secret_exceptions` for conventional example files only | Revised per review |
| D4 | Discovery is synchronous under a 10 s deadline and fails explicitly; resumable jobs wait for milestone 3 | Accepted |
| D5 | Inventory identity is fingerprints; membership via directory fingerprints, in-place edits via per-call entry refresh; content hashes remain mandatory at review/commit | Revised per review |
| D6 | `run_tests` snapshot capped at 5,000 files or 64 MiB for glob policies | Accepted |
| D7 | New `list_files` tool; one tool-list refresh in ChatGPT | Accepted |
| D8 | Search/list cursors restart-safe, bound to repository, policy, inventory, arguments and expiry, with defined position validation | Revised per review |
| D9 | Race handling is verify-after-act with best-effort, non-atomic undo; stated plainly | Revised per review |
| D10 | Deny comparisons fold case and NFC; allow comparisons NFC-insensitive, case-sensitive; disk spelling preserved; collisions defined separately | Revised per review |
| D11 | Creation depth limit 8, directory mode 0o755 | Accepted by default |
| D12 | Only the `policy.test.ts` "pattern semantics are rejected" test changes | Accepted |
| D13 | Git status stays unfiltered (existing contract) and can list names of non-exposed untracked paths; filtering is a later change | Open: default unchanged |
| D14 | Large path sets use bounded literal batches and `--no-renames`; `--pathspec-from-file` withdrawn | New, per review |
| D15 | v1 policies naming built-in-denied or syntactically invalid literal paths fail at startup with a migration error | New, per review |
