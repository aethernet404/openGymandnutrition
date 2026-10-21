# Proposals (nothing here is enabled or applied)

Written 2026-10-21 during the cleanup pass. Each item says what it would change, what it needs, and what could go wrong.
Nothing in this file is active: the workflow in section 1 is not in `.github/workflows/`.

## 1. Delete old versions of the two ghcr.io packages (retention)

**What it does.** Once a week, for `opengym-api-coach-fork` and `opengym-web-fork`, it keeps the **newest 5 versions** plus
every version whose tag or digest is listed in the repository variable `GHCR_KEEP`, and deletes the rest. It starts in
**dry-run**: it only prints what it would delete until you set the variable `GHCR_PRUNE_DRY_RUN` to `false`.

**What you must put in `GHCR_KEEP`:** the tag (or `sha256:` digest) of whatever is **running on the server right now** and
of the build you would roll back to. A deleted image that a pod still needs cannot be pulled again after a restart.

**Permissions (the minimum).** The job gets no permissions by default and one: `packages: write` (list and delete versions of the
packages this repository is linked to). It does not check out the code and does not use any secret of yours: it runs with the
run's own `GITHUB_TOKEN`. **One thing to test first:** GitHub's REST endpoints for deleting a package version are documented for
user tokens; whether the run's `GITHUB_TOKEN` is accepted for packages owned by a *user* account (rather than an organisation)
could not be checked from here. Run it once with dry-run: if the listing works but a real delete answers 403, the
alternative is a classic personal access token with only `read:packages` and `delete:packages`, stored as the repository secret
`GHCR_PRUNE_TOKEN` and used in place of `GITHUB_TOKEN` (a bigger permission, which is why it is the fallback, not the default).
Each package must also list this repository under *Package settings → Manage Actions access* with role **Write** (the same setting the
build workflow already needs).

File: `.github/workflows/prune-ghcr.yml`

```yaml
# Deletes old versions of this fork's two ghcr.io packages. Keeps the newest 5 of each, plus anything named in the
# repository variable GHCR_KEEP (comma-separated tags or sha256 digests). DRY RUN until the variable
# GHCR_PRUNE_DRY_RUN is set to "false": it then only lists what it would delete.
name: Prune old fork images

on:
  schedule:
    - cron: '17 4 * * 0'          # Sundays 04:17 UTC
  workflow_dispatch:

permissions: {}                   # nothing unless a job asks

concurrency:
  group: prune-ghcr
  cancel-in-progress: false

jobs:
  prune:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      packages: write             # list and delete versions of the packages this repository is linked to
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      OWNER: ${{ github.repository_owner }}
      KEEP_NEWEST: '5'
      KEEP: ${{ vars.GHCR_KEEP }}
      DRY_RUN: ${{ vars.GHCR_PRUNE_DRY_RUN != 'false' }}
    steps:
      - name: Prune
        run: |
          set -euo pipefail
          owner="$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')"
          echo "### Prune old images (dry run: $DRY_RUN, keep newest $KEEP_NEWEST, keep list: ${KEEP:-none})" >> "$GITHUB_STEP_SUMMARY"
          for pkg in opengym-api-coach-fork opengym-web-fork; do
            gh api --paginate "/users/${owner}/packages/container/${pkg}/versions?per_page=100" | jq -s 'add // []' > versions.json
            # newest first; skip the newest N; skip anything whose tag or digest is in the keep list
            jq -r --arg keep "$KEEP" --argjson n "$KEEP_NEWEST" '
              ($keep | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $k
              | sort_by(.created_at) | reverse | .[$n:][]
              | select(([.name] + (.metadata.container.tags // [])) | any(. as $x | $k | index($x)) | not)
              | "\(.id)\t\(.name)\t\((.metadata.container.tags // []) | join(","))"' versions.json > delete.tsv
            total="$(jq length versions.json)"; del="$(wc -l < delete.tsv | tr -d ' ')"
            echo "- \`${pkg}\`: ${total} versions, ${del} to delete" >> "$GITHUB_STEP_SUMMARY"
            while IFS=$'\t' read -r id digest tags; do
              [ -n "$id" ] || continue
              echo "  ${pkg} ${digest} [${tags}]"
              if [ "$DRY_RUN" = "false" ]; then
                gh api -X DELETE "/users/${owner}/packages/container/${pkg}/versions/${id}"
              fi
            done < delete.tsv
          done
```

**Risks:** a wrong `GHCR_KEEP` can delete the running image (hence the dry-run default and the weekly cadence); deleting is permanent.
Version `created_at` is when the version was pushed, which is the order we want.

## 2. The 10 upstream tests that fail only because of fixed dates (ask-first)

**What fails.** 10 tests in 5 files whose fixtures contain workouts dated July 2026; the Coach reads a 12-week window, so as
of mid-October 2026 those workouts are outside it. They fail the same way on a pristine upstream checkout.

| File | Tests |
|---|---|
| `api/test/jobs.test.js` | 4 |
| `api/test/coach-limits.test.js` | 2 |
| `api/test/payload-bounds.test.js` | 2 |
| `api/test/payload.test.js` | 1 |
| `api/test/routes.test.js` | 1 |

**Smallest fix, touching none of those five files (recommended).** Pin the clock for just those five files. I have been doing
exactly this to verify them (`node --import <shim>` with the date set to 2026-10-12, the last day the fixtures still fit):
- new `api/test/clock-pin.mjs` (about 10 lines: a `Date` subclass that starts at 2026-10-12 and keeps ticking);
- new `api/scripts/run-tests.mjs` (about 15 lines: runs `node --test` on the five files with `NODE_OPTIONS=--import ./test/clock-pin.mjs`,
  then on every other `test/*.test.js`; needed so it works on any OS and so child servers the tests start inherit the pin);
- `api/package.json`: the `"test"` script becomes `node scripts/run-tests.mjs`.
Upstream files touched: **one line of `api/package.json`**. The two new files are not upstream's.
Downside: those five files stop noticing real date bugs, and the pin is a debt to remove when upstream fixes its fixtures.

**Alternative (more honest, bigger).** Edit the fixtures in the five files to build their dates from `Date.now()`
(for example "10 days ago"). Touches all five upstream test files (plus whatever shared fixture they import) and will
conflict whenever upstream edits them. Best done upstream as a pull request, not in the fork.

## 3. Bringing the work into `main` (ask-first; main is untouched)

**Where things stand.** `origin/main` is exactly upstream's `v1.4.1` release commit (`464355ef`). The work branch
`claude/opengym-nutrition-tracker-7x1675` is **32 commits ahead and 0 behind**, so it is a straight line from `main`.

**Recommended: fast-forward** (`git checkout main && git merge --ff-only claude/opengym-nutrition-tracker-7x1675 && git push`).
- It keeps the exact commit ids. The images are tagged `nutrition-<7-char commit>`, so every image you have deployed still points
  at a commit that exists on `main`. A **squash** would create one new commit with a different id, and the tag on the running
  image would match nothing on `main`. A merge commit also works but adds noise for a linear history.
- Do it only **after** the workflow changes below.

**Before main is touched: disable the workflows that would fire on a push to `main`** (details in `NUTRITION_FORK_IMAGES.md`,
section "Workflows in this fork"). Pushing to `main` would otherwise trigger `docker-publish` (publishes `edge` images under
`ghcr.io/aethernet404/opengym-api` and `opengym-web`: the web image contains the Gym visual media whose licence says "inside openGym
only"), `mirror` (tries to push to upstream's GitLab and fails without its secret), `pages` (tries to deploy the demo) and
`catalogue` / `test` (harmless, but test fails on the 10 date tests until item 2 is done).

**Build trigger.** `build-fork-images.yml` currently runs on pushes to the work branch only. After the fast-forward, change its
`branches:` list to `[main]` (or `[main, claude/opengym-nutrition-tracker-7x1675]` while both exist). One-line change in my own file.

**Name for what is deployed.** Tag the commit that is actually running, once the next feature is deployed, with a tag that does
not start with `v` and is a plain **git tag, not a GitHub Release**: for example `nutrition-2026.10.1` (or `v1.4.1-nutrition.1` if you want the
upstream version visible, but `v*` tags are forwarded by `mirror.yml` and a published Release triggers `docker-publish`; both are disabled by then,
yet the safer name avoids the question). The image tags already say `nutrition-<sha>`, so the tag and the image can be matched by sha.

**Keeping up with upstream openGym.**
1. One time: `git remote add upstream https://github.com/DuarteSantos8/openGym && git fetch upstream --tags`.
2. For each upstream release: `git checkout -b sync/<upstream version> main && git merge upstream/main` (a **merge**, not a rebase,
   so the commit ids behind deployed images never change). Expect conflicts only in the few upstream files this fork touched:
   `api/server.js`, `api/coach/jobs.js`, `api/coach/core/prompts.js`, `api/coach/prompts/common.md`, `frontend/src/App.jsx`,
   `frontend/src/views/Home.jsx`, `frontend/src/views/Settings.jsx` (+ `Settings.reset.test.jsx`), `frontend/package.json` (+ lock), `NOTICE.md`.
3. Run both test suites, push the branch, let Actions build, deploy by digest as usual, then fast-forward `main`.
4. GitHub's "Sync fork" button will not work once `main` diverges; the merge above replaces it.
5. Keep new nutrition work inside `api/nutrition/` and `frontend/src/nutrition/` so step 2 stays small.
