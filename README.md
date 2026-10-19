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

Empty at bootstrap. Each piece lands in its own PR:

| Issue | What |
| --- | --- |
| #2 | Shared Resend sending domain with per-app keys, Email Routing forwards |
| #3 | Zero Trust organization and login methods |
| #4 | Zone security settings, with a WAF skip rule for CI smoke tests |
| #5 | Import the zone itself and its DNS |
| #6 | Step DMARC up to `p=reject` |

Until #5 lands, **the `spencerwill.com` zone itself is not managed here**, matching ucmc. Anything that already exists in Cloudflare comes in with `pulumi import`, never by being created again, and must preview with no changes after import. Anything whose replacement would take sites down or re-issue keys (the zone, the Resend domain) is `protect: true`.

### Which repo owns what

This repo is the only place for zone-wide resources: zone settings, WAF and bot rules, the zone's own DNS, Email Routing, DMARC, the Zero Trust organization and its login methods. Apps manage only their own hostnames, Worker custom domains, data resources, and Access *applications*. If an app's stack creates a DNS record, it stays there. Every other DNS record goes here.

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

Update this table in the same PR that adds, renames, or starts reading an output.

### Order of applying changes

**This stack before its consumers.** A consumer's `pulumi up` reads this stack's outputs as they are at that moment, so a new or renamed output has to be applied here first. Remove an output only after every consumer has stopped reading it, and apply this stack last in that case.

## CI/CD

`.github/workflows/ci.yml`, on every PR and push to `main`:

- **Checks:** dependency audit, gitleaks over the full history, Biome and `tsc`, and actionlint/zizmor when workflows change. `required` aggregates them and is the one required status check.
- **`check: pulumi preview`** (PRs): `pulumi preview --diff` of `infra/cloudflare`'s prod stack, posted as a PR comment. It runs in the `preview` environment, whose Cloudflare token can only read, because any PR branch can trigger it.
- **`deploy: prod`** (pushes to `main`): `pulumi up`, in the `prod` environment. That environment allows only `main`, needs a reviewer's approval, and holds the write token. Reject the approval for a push that shouldn't apply; the next approved run applies everything merged since.

Both Pulumi jobs run only when the `PULUMI_CI_ENABLED` repo variable is `true`. `infra/github` sets it from `pulumiCiEnabled`.

`lint-pr.yml` checks PR titles against commitlint, since squash merges use the title as the commit message.

## GitHub as code

`infra/github` manages:

- **The repository:** description, visibility, squash-only merges titled from the PR, deleting branches after merge, secret scanning with push protection, and Dependabot alerts. It is `protect`ed and archived rather than deleted if it ever leaves the program.
- **A ruleset on `main`:** no deletion or force pushes, linear history, PRs with resolved threads, and the `required` check. Repository admins can bypass it.
- **Environments:** `preview` (any branch, no reviewer) and `prod` (`main` only, with `prodReviewerIds` as required reviewers).
- **Cloudflare CI tokens.** It mints a read token and a write token with the same reach and writes each into its environment as `CLOUDFLARE_API_TOKEN`. Nobody sees or copies them, and destroying the stack revokes them. To rotate one, run `pnpm apply --replace <token URN>`. The permissions are in `infra/github/src/cloudflare-tokens.ts`. Add a permission there, in both tokens, in the same PR as the resource that needs it.

It does not manage the workflow files, `dependabot.yml`, or `PULUMI_ACCESS_TOKEN`, which is set by hand.

It depends on the repo being public. On GitHub Free, rulesets, environments, and required reviewers are available only on public repos, so the program refuses `visibility: private` instead of leaving `prod` ungated.

### First-time setup

Already done: both stacks exist, the repository is adopted into `infra/github`, and its first apply created the environments, the ruleset, and `PULUMI_CI_ENABLED=false`. `infra/cloudflare`'s prod stack has been applied with its config-only outputs. Remaining, in order:

1. Give `infra/github` a Cloudflare token that can create account API tokens (permission **Account API Tokens Write**), then apply. This mints the two CI tokens and writes them into the environments:

   ```sh
   cd infra/github
   pulumi config set --secret cloudflare:apiToken   # paste when prompted
   pnpm preview && pnpm apply
   ```

2. Add a Pulumi access token as the repository secret `PULUMI_ACCESS_TOKEN`:

   ```sh
   gh secret set PULUMI_ACCESS_TOKEN
   ```

3. Turn the Pulumi jobs on. Set `pulumiCiEnabled: "true"` in `infra/github/Pulumi.main.yaml`, merge that, then run `pnpm apply` in `infra/github`.

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

`infra/cloudflare`'s scripts run through `with-infra-token.sh`, which uses the write token minted by `infra/github` (an exported `CLOUDFLARE_API_TOKEN` wins). `infra/github`'s scripts use `gh auth token`.

Commits follow Conventional Commits, enforced by a commit-msg hook. `pnpm commit` gives a prompt. The pre-commit hook runs Biome through lint-staged and gitleaks on the staged diff.

## Upgrading Pulumi

`@pulumi/pulumi`, `@pulumi/cloudflare`, and `@pulumi/github` are pinned **exactly** in `pnpm-workspace.yaml`'s catalog, and Dependabot raises each bump as its own PR. A provider release can change a resource's schema so that an untouched program plans a replacement: ucmc saw `@pulumi/cloudflare` 6.21.0 plan to replace a D1 database, with an empty property diff. Here, a replacement could take out the zone, its DNS, or the Resend domain.

So, for each bump:

- Raise it in its own PR, never in a group bump.
- Read the `pulumi preview` diff before merging. A `replace` or `delete` on anything is a stop. `protect: true` turns it into a failed deploy rather than an outage, but it is still a failed deploy.
- Move `pulumi-version` in `ci.yml` along with `@pulumi/pulumi`. Dependabot doesn't update it.

Everything else follows the 7-day quarantine in `pnpm-workspace.yaml` (`minimumReleaseAge`), and Dependabot's cooldowns match it.
