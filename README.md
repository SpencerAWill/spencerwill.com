# spencerwill.com

Shared infrastructure for the `spencerwill.com` zone and Cloudflare account: the things every app on the zone shares and no single app should own. The apps stay separate Pulumi projects and read what they need from this one through a [StackReference](https://www.pulumi.com/docs/iac/concepts/stacks/#stackreferences):

- [www.spencerwill.com](https://github.com/SpencerAWill/www.spencerwill.com)
- [ucmc.spencerwill.com](https://github.com/SpencerAWill/ucmc.spencerwill.com)
- [flareling](https://github.com/SpencerAWill/flareling)

## Layout

All infrastructure as code lives under `infra/`, as two Pulumi TypeScript projects. They need different credentials and change at different rates, and a mistake in one cannot touch the other.

| Project | Pulumi project / stack | Manages | Applied by |
| --- | --- | --- | --- |
| `infra/cloudflare` | `spencerwill-shared` / `prod` | Zone- and account-wide Cloudflare resources | CI: `pulumi up` on `main`, behind the `prod` environment |
| `infra/github` | `spencerwill-shared-github` / `main` | This repo's settings, ruleset, environments, CI tokens | A repo admin, locally |

## Scope

Each piece lands in its own PR:

| Issue | What |
| --- | --- |
| #2 | Shared Resend sending domain with per-app keys ([Resend](#resend)) |
| #11 | Email Routing, with forwards for the apps' from-addresses |
| #3 | Zero Trust organization and login methods |
| #4 | Zone security settings, with a WAF skip rule for CI smoke tests |
| #5 | Import the zone itself and its DNS |
| #6 | Step DMARC up to `p=reject` |

The `spencerwill.com` zone itself is imported here (#5) and `protect`ed. Anything that already exists in Cloudflare comes in with `pulumi import`, never by being created again, and must preview with no changes after import. Anything whose replacement would take sites down or re-issue keys (the zone, the Resend domain) is `protect: true`.

### Which repo owns what

This repo is the only place for zone-wide resources: zone settings, WAF and bot rules, the zone's own DNS, Email Routing, DMARC, the Zero Trust organization and its login methods. It also owns the Pulumi Cloud OIDC issuer that every repo's CI logs in through (see [GitHub as code](#github-as-code)). Apps manage only their own hostnames, Worker custom domains, data resources, and Access *applications*. If an app's stack creates a DNS record, it stays there. Every other DNS record goes here.

### Adding a DNS record

Every record in the zone has exactly one owner (the list is in `infra/cloudflare/src/zone.ts`):

- **A record that serves one app's hostname,** in a stack that creates that hostname: that app's stack. For example, www's `www` CNAME is in www.spencerwill.com.
- **A record made by a Cloudflare feature** (Worker or R2 custom domains, Email Routing's MX and DKIM): nobody declares it. It's read-only and belongs to whatever created the feature.
- **Everything else** (zone-wide mail records, verification TXT records, anything not tied to one app's stack): here, in `src/zone.ts`, with a PR and its `pulumi preview`.

To bring in a record that was added by hand, declare it with its exact current values (TXT contents with their quotes) and `{ import: "<zone id>/<record id>" }`. The preview must show `= import` and no other change for it. Never create a second record for a name that already has one.

## Stack outputs

Consumers read `SpencerAWill/spencerwill-shared/prod`:

```ts
const shared = new pulumi.StackReference("SpencerAWill/spencerwill-shared/prod");
const zoneId = shared.requireOutput("zoneId");
```

| Output | Value | Read by |
| --- | --- | --- |
| `accountId` | The Cloudflare account ID | Nobody yet (each app has it in its own config) |
| `zoneId` | The `spencerwill.com` zone ID | Nobody yet |
| `zoneName` | `spencerwill.com` | Nobody yet |
| `ucmcResendApiKey` | ucmc's Resend sending key (secret) | ucmc.spencerwill.com prod (`emailStack`, ucmc#302) |
| `ucmcFromEmail` | `ucmc@spencerwill.com` | ucmc.spencerwill.com prod |
| `flarelingResendApiKey` | flareling's Resend sending key (secret) | flareling prod (flareling#13, not yet) |
| `flarelingFromEmail` | `flareling@spencerwill.com` | flareling prod (not yet) |
| `resendDomainId` | The domain's ID in Resend | Nobody (for looking it up in Resend) |

Update this table in the same PR that adds, renames, or starts reading an output.

### Order of applying changes

**This stack before its consumers.** A consumer's `pulumi up` reads this stack's outputs as they are at that moment, so a new or renamed output has to be applied here first. Remove an output only after every consumer has stopped reading it, and apply this stack last in that case.

## Resend

`infra/cloudflare/src/resend.ts` verifies `spencerwill.com` in Resend and issues one sending key per app. The free Resend plan allows one domain per account, so every app's prod sends from this one, each with its own from-address. Resend's records go on `send.spencerwill.com` (MX and SPF, the return path) and `resend._domainkey.spencerwill.com` (DKIM), so the apex's Email Routing MX and SPF are untouched.

- **Keys are scoped to the domain, not to an address.** Either app's key can send as any `@spencerwill.com` address. Resend can't scope a key more narrowly.
- **The domain is `protect`ed.** Deleting it re-issues DKIM and stops every app's mail until the domain verifies again.
- **Keys rotate when the domain is re-created.** Changing `resendManagementApiKey` re-runs the scripts, which re-issues every key. Apply the consumers afterwards, then deploy them.
- **It's driven through `@pulumi/command`** and `infra/cloudflare/scripts/resend.mjs`, ported from ucmc, because Pulumi's dynamic providers don't work with pnpm (pulumi/pulumi#9085).

It uses a full-access Resend key, set once as an encrypted stack config value:

```sh
cd infra/cloudflare
pulumi config set --secret resendManagementApiKey --stack prod   # paste when prompted
```

**First apply:** the cutover in ucmc.spencerwill.com#298 / #302. ucmc first deletes its own domain (`ucmc.spencerwill.com`), which frees the account's one domain slot. Then this stack is applied, and `spencerwill.com` is verified before ucmc's prod switches to `ucmcResendApiKey`. Until that cutover, the Resend PR stays unmerged: merging it would make every deploy from `main` try to create the domain and fail.

To add an app, add it to `sendingKeys` in `infra/cloudflare/index.ts`, export its `<app>ResendApiKey` and `<app>FromEmail`, and add both to the outputs table above.

## CI/CD

`.github/workflows/ci.yml`, on every PR and push to `main`:

- **Checks:** dependency audit, gitleaks over the full history, Biome and `tsc`, and actionlint/zizmor when workflows change. `required` aggregates them and is the one required status check.
- **`check: pulumi preview`** (PRs): `pulumi preview --diff` of `infra/cloudflare`'s prod stack, posted as a PR comment. It runs in the `preview` environment, so **each run waits for a reviewer's approval** (see [Security model](#security-model)). Approve it only once you've read the branch's changes. Its Cloudflare token can only read. On Dependabot's PRs it fails on purpose, because those runs get no secrets. Push any commit to the branch to run it as yourself, and always read the diff for `@pulumi/*` bumps. On a draft, no checks run and `required` fails until the PR is marked ready.
- **`deploy: prod`** (pushes to `main`): `pulumi up`, in the `prod` environment. That environment allows only `main`, needs a reviewer's approval, and holds the write token. Reject the approval for a push that shouldn't apply; the next approved run applies everything merged since.

Both Pulumi jobs run only when the `PULUMI_CI_ENABLED` repo variable is `true`. `infra/github` sets it from `pulumiCiEnabled`.

`lint-pr.yml` checks PR titles against commitlint, since squash merges use the title as the commit message.

## GitHub as code

`infra/github` manages:

- **The repository:** description, visibility, squash-only merges titled from the PR, deleting branches after merge, secret scanning with push protection, and Dependabot alerts. It is `protect`ed and archived rather than deleted if it ever leaves the program.
- **A ruleset on `main`:** no deletion or force pushes, linear history, PRs with resolved threads, and the `required` check. Repository admins can bypass it.
- **Environments:** `preview` (any branch) and `prod` (`main` only). Both require approval from `reviewerIds`, because every job in either one gets a Pulumi token.
- **Cloudflare CI tokens.** It mints a read token and a write token with the same reach and writes each into its environment as `CLOUDFLARE_API_TOKEN`. They are not stack outputs, but they are in this stack's state (see [Security model](#security-model)). Destroying the stack revokes them. To rotate one, run `pnpm apply --replace <token URN>`. The permissions are in `infra/github/src/cloudflare-tokens.ts`. Add a permission there, in both tokens, in the same PR as the resource that needs it.
- **Pulumi Cloud OIDC, for every repo.** It registers GitHub Actions as the `SpencerAWill` Pulumi org's OIDC issuer. Jobs trade their GitHub ID token for a Pulumi token that lasts at most an hour (`pulumi/auth-actions`), so no Pulumi token is stored in GitHub. Pulumi Cloud allows only **one** issuer per GitHub URL per org, so this issuer is shared: every repo that logs in this way gets its allow policies here. Each policy covers one repository and environment, matched on GitHub's immutable subject (`repo:<owner>@<id>/<repo>@<id>:environment:<name>`). This repo's are `preview` and `prod`; other repos are listed in `pulumiOidcRepositories` in `Pulumi.main.yaml`. The issuer is `protect`ed, and a policy added by hand in the Pulumi Cloud UI is removed on the next apply.

It does not manage the workflow files or `dependabot.yml`.

It depends on the repo being public. On GitHub Free, rulesets, environments, and required reviewers are available only on public repos, so the program refuses `visibility: private` instead of leaving `prod` ungated.

### First-time setup

Done on 2026-10-18, and recorded here for rebuilding from scratch. Create both stacks (`pulumi stack init`), adopt the repository (`pnpm adopt` in `infra/github`, which only imports into state), and apply `infra/github` with `pulumiCiEnabled: "false"`. That creates the environments and the ruleset. Then, in order:

1. Give `infra/github` a Cloudflare token that can create account API tokens (permission **Account API Tokens Write**), then apply. This mints the two CI tokens and writes them into the environments:

   ```sh
   cd infra/github
   pulumi config set --secret cloudflare:apiToken   # paste when prompted
   pnpm preview && pnpm apply
   ```

2. Nothing for Pulumi itself: the apply above also registered the OIDC issuer that CI logs in through. (Until 2026-10-19 CI used a stored `PULUMI_ACCESS_TOKEN` repository secret instead. Delete it once OIDC has worked in both a preview and a deploy: `gh secret delete PULUMI_ACCESS_TOKEN`.)

3. Turn the Pulumi jobs on. Set `pulumiCiEnabled: "true"` in `infra/github/Pulumi.main.yaml`, merge that, then run `pnpm apply` in `infra/github`.

### Security model

The tokens that matter most:

- **The Cloudflare write token** can change DNS, settings and WAF for every site on the zone. It is in the `prod` environment's secret, and in `infra/github`'s Pulumi state.
- **The bootstrap token** (`cloudflare:apiToken`) can create Cloudflare API tokens. It is in `infra/github/Pulumi.main.yaml`, encrypted with that stack's key in Pulumi Cloud.

Anyone with a Pulumi token for the `SpencerAWill` account can decrypt both, with `pulumi stack export --show-secrets` and `pulumi config get`. On this Pulumi edition, the only token CI can get through OIDC is a personal token, which has all of its owner's access; tokens scoped to particular stacks need Pulumi Pro. So **any job that gets a Pulumi token can get every secret in every stack.** That includes the jobs in other repos listed in `pulumiOidcRepositories`.

What keeps that safe is that every job that can get a Pulumi token waits for a reviewer:

- Pulumi Cloud gives tokens only to jobs in this repo's `preview` and `prod` environments (and the listed environments of other repos). No Pulumi token is stored in GitHub.
- Both environments require approval from `reviewerIds`. A branch that changed `ci.yml` or the Pulumi program to print secrets still waits for your click. So read a PR's changes before approving its preview, especially changes to `.github/` or anything that runs code.
- Fork PRs get no secrets and are never previewed. Dependabot runs get no secrets either.

Before listing another repo in `pulumiOidcRepositories`, make sure every environment you list there also requires a reviewer. Otherwise that repo's PR branches can read this repo's tokens.

### Moving another repo to Pulumi OIDC

1. Make sure each GitHub environment its Pulumi jobs declare requires a reviewer (see [Security model](#security-model)).
   Also make sure the repo sends GitHub's immutable OIDC subject, which the policies match on (it names the owner and repo by numeric ID, so a re-created repo with the same name doesn't match). `gh api repos/<owner>/<repo>/actions/oidc/customization/sub` should show `"use_immutable_subject": true`. New repos do by default. ucmc.spencerwill.com doesn't yet; switch it with `gh api -X PUT repos/SpencerAWill/ucmc.spencerwill.com/actions/oidc/customization/sub -F use_default=true -F use_immutable_subject=true`.
2. Add the repo and the GitHub environments its Pulumi jobs declare to `pulumiOidcRepositories` in `infra/github/Pulumi.main.yaml`. Merge that, then run `pnpm apply` in `infra/github`.
3. In that repo's workflows, give each Pulumi job `id-token: write` and an `environment:`, and log in with `pulumi/auth-actions` (as in this repo's `ci.yml`: `organization: SpencerAWill`, `requested-token-type: urn:pulumi:token-type:access_token:personal`, `scope: user:SpencerAWill`).
4. Once a run logs in, delete that repo's `PULUMI_ACCESS_TOKEN` secret.

Don't register a GitHub issuer from another repo's stack. Pulumi Cloud rejects it as a duplicate.

## Local development

Node 24 and pnpm (corepack reads the version from `packageManager`), or use the dev container, which also installs the Pulumi CLI, gh, and gitleaks.

```sh
pnpm install
pnpm check          # Biome: lint, format, imports
pnpm typecheck      # tsc over both Pulumi programs

cd infra/cloudflare
pnpm preview        # pulumi preview --diff on prod
pnpm apply          # pulumi up; normally CI does this
```

`infra/cloudflare`'s scripts need a `CLOUDFLARE_API_TOKEN` you export yourself, rather than one read out of `infra/github`'s state. For a local preview, a token with the read permissions in `infra/github/src/cloudflare-tokens.ts` is enough. `infra/github`'s scripts use `gh auth token`.

Commits follow Conventional Commits, enforced by a commit-msg hook. `pnpm commit` gives a prompt. The pre-commit hook runs Biome through lint-staged and gitleaks on the staged diff.

## Upgrading Pulumi

`@pulumi/pulumi`, `@pulumi/cloudflare`, and `@pulumi/github` are pinned **exactly** in `pnpm-workspace.yaml`'s catalog, and Dependabot raises each bump as its own PR. A provider release can change a resource's schema so that an untouched program plans a replacement: ucmc saw `@pulumi/cloudflare` 6.21.0 plan to replace a D1 database, with an empty property diff. Here, a replacement could take out the zone, its DNS, or the Resend domain.

So, for each bump:

- Raise it in its own PR, never in a group bump.
- Read the `pulumi preview` diff before merging. A `replace` or `delete` on anything is a stop. `protect: true` turns it into a failed deploy rather than an outage, but it is still a failed deploy.
- Move `pulumi-version` in `ci.yml` along with `@pulumi/pulumi`. Dependabot doesn't update it.

Everything else follows the 7-day quarantine in `pnpm-workspace.yaml` (`minimumReleaseAge`), and Dependabot's cooldowns match it.
