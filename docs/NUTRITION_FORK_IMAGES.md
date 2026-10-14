# Fork images from GitHub Actions (nothing is built on the server)

`.github/workflows/build-fork-images.yml` builds this fork's two images on GitHub's runners and pushes them to
the GitHub Container Registry. The home server then only **pulls** them.

| image | built from | name |
|---|---|---|
| api | `api/Dockerfile`, `--target coach` | `ghcr.io/aethernet404/opengym-api-coach-fork:nutrition-<7-char commit>` |
| web | `web/Dockerfile`, context = repo root | `ghcr.io/aethernet404/opengym-web-fork:nutrition-<7-char commit>` |

linux/amd64 only. There is **no** `latest` tag: a tag names one commit, and the run summary lists each image's
exact digest (`sha256:…`) so a deploy can pin to it.

The workflow runs on every push to `claude/opengym-nutrition-tracker-7x1675` that touches `api/`, `frontend/`,
`web/`, `catalogue/`, `scripts/` or the workflow itself, and by hand (Actions → *Build fork images* → *Run
workflow*, once the file is on the default branch). Each image is built once, started and checked, and only
then pushed. The check on the api image: the nutrition module and the Coach SDK are present, it boots on an
empty volume, `/api/health` and `/api/config` answer, and the nutrition routes (including
`/api/nutrition/health/hae`) answer 401, not 404. On the web image: this commit's frontend is in the bundle
(the Apple Health history and Health Auto Export paths), and nginx serves the app and a deep link.

## Steps on GitHub (once)

1. **Open your fork** in a browser: `github.com/aethernet404/opengymandnutrition`, signed in as `aethernet404`.
2. **Turn Actions on.** Click the **Actions** tab. If you see a green button **"I understand my workflows, go
   ahead and enable them"**, click it. (Forks start with Actions off.) If instead the tab shows workflows
   already, it is on. Also check **Settings → Actions → General → Actions permissions** is **Allow all actions
   and reusable workflows** (the workflow only uses actions pinned by commit).
3. **Check workflow permissions:** Settings → Actions → General → **Workflow permissions**. Either choice
   works (the workflow asks for exactly what it needs), but it must not be blocked by an organisation policy.
4. **Start the first run.** The workflow starts by itself when a commit that touches the app is pushed to the
   branch. If you enabled Actions *after* the last push, nothing has run yet: tell Claude "run the build" and it
   pushes a one-line commit that triggers it. (The *Run workflow* button only shows once the workflow file is on
   your default branch, `main`; you do not need that.)
5. **Watch it.** Actions tab → click the run named **Build fork images** (newest at the top). Three boxes:
   `api`, `web`, `summary`. Click a box to see its steps; click a step to read its log. Green tick = done.
   It takes roughly 5–12 minutes.
6. **Find the image names and digests.** Open the finished run → the **Summary** page (top-left of the run
   page, above the job boxes). The bottom of it has the table "Images pushed for `<commit>`" with both names
   and `sha256:` digests. Copy it into your message to Cascade.
7. **See the packages.** Your profile (`github.com/aethernet404`) → **Packages** tab → `opengym-api-coach-fork`
   and `opengym-web-fork`. Each page lists the tags.

## Public or private? Recommendation: private (both), with one pull secret

* The **web image contains the Gym visual exercise stills and animations**, licensed for use *inside openGym
  only* (`catalogue/media/NOTICE.md`). A public package lets anyone download them. Upstream publishes its
  image publicly, but this is your fork and the licence is not yours to relax: keep the web package private.
* The api image has no such files and could be public, but one pull secret covers both, so make both private
  and the rules are simple.

Private means the server needs a read-only credential **once**:

1. GitHub → your avatar → **Settings** → **Developer settings** (bottom of the left menu) → **Personal access
   tokens** → **Tokens (classic)** → **Generate new token (classic)**.
2. Name it `home-server-ghcr-pull`, expiration 90 days (or longer), tick **only `read:packages`**. Generate.
   Copy the token (`ghp_…`) once; give it to Cascade, never to a chat that logs it or a file in the repo.
3. Cascade creates a Kubernetes pull secret from it (see below). Nothing else on your server needs a login.

If you prefer public anyway (api only, say): package page → **Package settings** (right side) → **Danger
Zone → Change visibility → Public → type the package name → confirm**. Public cannot be made private again
without GitHub support if it has been pulled a lot. Do not do this for the web package.

If a package page says it is not linked to the repository, that is fine for pulling; the workflow labels the
images with the repo so later runs can push to the same package. If a later run fails with `denied` or
`permission_denied: write_package`: package page → **Package settings → Manage Actions access → Add
Repository → opengymandnutrition → Role: Write**.

## What Cascade does (paste this)

See the end of this file's source message in the project chat; in short: snapshot the other namespaces' pods,
create the pull secret in `fitness-test`, `kubectl set image` the two containers of `opengym-test` to the
digest-pinned names, wait for the rollout, verify, snapshot the other pods again and compare. No `docker
build`, no `ctr images import`, no test suite, replicas 1 and `Recreate` untouched.
