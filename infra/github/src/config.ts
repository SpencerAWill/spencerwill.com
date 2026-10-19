import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const githubConfig = new pulumi.Config("github");
const cloudflareConfig = new pulumi.Config("cloudflare");

const visibilities = ["public", "private"] as const;
type Visibility = (typeof visibilities)[number];

// Fail fast if unset. Without it the provider silently targets whichever
// account the token belongs to.
githubConfig.require("owner");
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

/** GitHub user IDs allowed to approve prod deploys. */
export const prodReviewerIds =
  config.getObject<number[]>("prodReviewerIds") ?? [];
if (pulumiCiEnabled && prodReviewerIds.length === 0) {
  throw new Error(
    "pulumiCiEnabled needs prodReviewerIds: without a reviewer every push to main would apply to prod unattended.",
  );
}

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
