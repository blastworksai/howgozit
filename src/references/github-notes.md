# GitHub notes

The facts about GitHub that the skill relies on.
Each line says how we know it.
**Observed** means seen on live GitHub in October 2026, with the check number (V1 to V8) where there is one.
**Documented only** means we read it in GitHub's documentation and have not seen it ourselves.

## The token

- **Observed (V1, V4, V7):** on an organisation, a fine-grained token works. It needs repository permissions Issues (read and write) and Contents (read and write), and the organisation permission Projects (read and write).
- **Observed (V2, V4, V7):** on a personal account, a classic token with the scopes `repo` and `project` works.
- **Observed:** a fine-grained token must be created with the organisation as its resource owner, and with the one repo selected. A token created with a personal owner, or with no repo, authenticates but gets "not found" on the repo.
- **Observed:** the GraphQL calls that create and delete a Project work with a fine-grained token on an organisation.
- **Documented only:** a fine-grained token cannot reach Projects owned by a personal account. That is why a personal account uses a classic token.
- **Observed:** a link that pre-fills the token form did not fill in the owner or the permissions when tried, so do not promise one. Describe the form in words.
- The running board reads, and writes only when you use one of the four actions: it creates, closes and relabels issues and adds an issue to a Project. That needs Issues and Projects write.
- Contents write is used only by setup and undo.
- With `BOARD_READ_ONLY=1` the board writes nothing.

## Projects

- **Observed (V5):** a Project's items carry only their `Title` unless the request names field ids. Read the Project's fields first, then list items with `fields=<ids>` for `Status` and `Due`.
- **Observed (V5):** `Status` arrives as an object, and its text is at `value.name.raw`. A new item reads `Todo`.
- **Observed (V5):** `Due` arrives as a timestamp such as `2026-10-18T00:00:00+00:00`. The first ten characters are the date.
- **Observed (V5):** the issue behind an item is under `content`, with its number and its repo name.
- **Observed (V5):** the Projects list gives each Project a `state` and a `closed_at`. It has no web address and no `closed` flag. The address is built from the owner: `https://github.com/orgs/<owner>/projects/<n>` or `https://github.com/users/<owner>/projects/<n>`.
- **Observed (V4):** creating a Project, adding a date field called `Due`, setting an item's `Due` and deleting the Project all work through GraphQL with each token type.
- **Observed:** adding an issue to a Project that already holds it is refused with status 422. Setup treats that refusal as "already there".

## Lists run behind writes

- **Observed (V1, V2):** a Project's item list can run behind a write. Often it shows a new item within a few seconds.
- **Observed:** right after several issues were added to brand-new Projects, the lists stayed empty or partial for about two minutes, although every add had been accepted. Setup therefore waits at the end until the lists are complete, and the board keeps showing an issue it has just sorted under its project for ten minutes.
- **Observed:** the issue list also runs behind a create by a moment.
- So do not read a list straight after a write and trust it. Keep the answer of the write itself.

## Milestones

- **Observed (V3, V6):** a milestone created with `due_on` at noon UTC reads back at midnight UTC of the same date. A milestone dated by hand in GitHub's own page also reads back as midnight UTC of the date picked. Either way the UTC calendar date is the one you meant.
- **Documented only:** older reports say GitHub stores the time at midnight Pacific, so a carelessly written time can land on the neighbouring day. Writing noon UTC avoids it.
- **Documented only:** the counters on GitHub's milestone page include pull requests.

## Issues and labels

- **Documented only:** the issue list also returns pull requests. They carry a `pull_request` key. The skill leaves them out.
- **Observed (V7):** with each token type, an issue can be created, closed, reopened, given labels and a milestone. A file in the repo can be created, updated and deleted.
- **Observed:** `labels` in an issue update replaces the whole set. To remove one label, send all the others.
- **Observed:** the issue list filtered by a milestone that no longer exists (`milestone=<number>`) is answered `422`, not `404` and not an empty list. Ask for the milestone itself first; that one answers `404` when it is gone.
- **Observed:** deleting a Project that is already deleted (GraphQL `deleteProjectV2`) is answered with status `200` and an error of type `NOT_FOUND`. The item list of a deleted Project answers `404` at once.
- **Documented only:** without push access, labels and milestone on an update are silently dropped.

## Requests

- **Observed (V8):** GitHub accepts the API version header `X-GitHub-Api-Version: 2026-03-10`.
- **Observed (V8):** the issues, milestones, Project items and contents addresses answer with an `ETag`. A repeat request that sends it back in `If-None-Match` is answered `304` with no body.
- **Documented only:** a `304` does not count against the rate limit.
- **Documented only:** the limit is 5,000 REST requests an hour per token. Follow the `Link` header's `rel="next"` for more pages, and never build page addresses by hand.
