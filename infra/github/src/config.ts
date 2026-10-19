import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const githubConfig = new pulumi.Config("github");
const cloudflareConfig = new pulumi.Config("cloudflare");

const visibilities = ["public", "private"] as const;
type Visibility = (typeof visibilities)[number];

// Fail fast if unset. Without it the provider silently targets whichever
// account the token belongs to.
export const owner = githubConfig.require("owner");
export const repositoryName = config.require("repository");
export const description = config.get("description") ?? "";

const visibilityValue = config.get("visibility") ?? "public";
if (!(visibilities as readonly string[]).includes(visibilityValue)) {
  throw new Error(
    `config visibility=${visibilityValue} is not one of: ${visibilities.join(", ")}`,
  );
}
/**
 * Public is what makes this whole program work on GitHub Free: rulesets,
 * environments, and required reviewers on `prod` are all public-only for a
 * personal account (checked 2026-10-12, in flareling). Rather than carry
 * flareling's plan matrix for a repo that will stay public, a private repo is
 * refused outright, since nothing would then gate `deploy: prod`.
 */
if (visibilityValue !== "public") {
  throw new Error(
    "This program assumes a public repo: on GitHub Free a private repo has no rulesets, environments, or required reviewers, so nothing would gate prod.",
  );
}
export const visibility: Visibility = visibilityValue;

/** Status check names required on the default branch. */
export const requiredChecks =
  config.getObject<string[]>("requiredChecks") ?? [];

/**
 * Whether ci.yml runs its Pulumi jobs, `preview` on PRs and `deploy` on main
 * (the PULUMI_CI_ENABLED repo variable). Off until the CI secrets exist.
 */
export const pulumiCiEnabled = config.getBoolean("pulumiCiEnabled") ?? false;

/**
 * GitHub user IDs who approve every job that gets a Pulumi token: the
 * `preview` and `prod` environments. See "Security model" in the README.
 */
export const reviewerIds = config.getObject<number[]>("reviewerIds") ?? [];
if (pulumiCiEnabled && reviewerIds.length === 0) {
  throw new Error(
    "pulumiCiEnabled needs reviewerIds: without a reviewer any PR branch could mint a Pulumi token, and every push to main would apply to prod unattended.",
  );
}

/**
 * The Pulumi Cloud organization ci.yml's jobs log in to through OIDC, and the
 * user whose personal token they get (see src/pulumi-oidc.ts).
 */
export const pulumiOrganization = config.require("pulumiOrganization");
export const pulumiUserLogin = config.require("pulumiUserLogin");

/**
 * Other repos whose CI logs in to `pulumiOrganization` through the same OIDC
 * issuer, as `<owner>/<repo>` to their GitHub environments. Pulumi Cloud
 * allows only one GitHub issuer per organization, so it can't be registered
 * in each repo. This repo's own entry is added in index.ts.
 */
const oidcRepositoriesConfig =
  config.getObject<Record<string, unknown>>("pulumiOidcRepositories") ?? {};
for (const [repository, environments] of Object.entries(
  oidcRepositoriesConfig,
)) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(
      `pulumiOidcRepositories key "${repository}" is not "<owner>/<repo>".`,
    );
  }
  if (
    !Array.isArray(environments) ||
    environments.length === 0 ||
    !environments.every((e) => typeof e === "string" && e !== "")
  ) {
    throw new Error(
      `pulumiOidcRepositories["${repository}"] must be a non-empty list of GitHub environment names.`,
    );
  }
}
export const pulumiOidcRepositories = oidcRepositoriesConfig as Readonly<
  Record<string, readonly string[]>
>;

/** Cloudflare account the CI tokens are minted in. */
export const cloudflareAccountId = config.require("cloudflareAccountId");

/**
 * The spencerwill.com zone. The tokens' zone permissions are scoped to it
 * alone, never to every zone in the account.
 */
export const cloudflareZoneId = config.require("cloudflareZoneId");

/**
 * Whether to mint the Cloudflare CI tokens. Needs a token allowed to create
 * account API tokens, set by hand as `cloudflare:apiToken` (a secret). Until
 * then the GitHub side applies on its own.
 */
export const mintCloudflareTokens =
  cloudflareConfig.get("apiToken") !== undefined;
