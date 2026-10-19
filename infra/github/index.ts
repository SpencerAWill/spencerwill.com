import * as github from "@pulumi/github";
import { createCiTokens } from "./src/cloudflare-tokens.ts";
import {
  cloudflareAccountId,
  cloudflareZoneId,
  mintCloudflareTokens,
  owner,
  pulumiCiEnabled,
  pulumiOidcRepositories,
  pulumiOrganization,
  pulumiUserLogin,
  repositoryName,
  reviewerIds,
} from "./src/config.ts";
import { createPulumiOidcIssuer } from "./src/pulumi-oidc.ts";
import { repository } from "./src/repository.ts";

/**
 * GitHub settings and CI secrets for this repo. See "GitHub as code" in the
 * README for what is managed here and why.
 *
 * Run locally by a repo admin, never in CI: the Actions GITHUB_TOKEN cannot
 * change repo settings or write secrets, and CI should not hold a credential
 * that can loosen its own rules.
 */

// PR previews. No branch policy, because every PR branch needs it. Its
// Cloudflare token can only read, but the Pulumi token a job here mints can
// read every stack's secrets (infra/github's state holds the Cloudflare write
// token), so every run waits for a reviewer. See "Security model" in the
// README.
const preview = new github.RepositoryEnvironment("preview", {
  repository: repository.name,
  environment: "preview",
  canAdminsBypass: true,
  preventSelfReview: false,
  reviewers: [{ users: reviewerIds }],
});

// `pulumi up`. Main only, behind a reviewer.
const prod = new github.RepositoryEnvironment("prod", {
  repository: repository.name,
  environment: "prod",
  canAdminsBypass: true,
  preventSelfReview: false,
  reviewers: [{ users: reviewerIds }],
  deploymentBranchPolicy: {
    protectedBranches: false,
    customBranchPolicies: true,
  },
});

new github.RepositoryEnvironmentDeploymentPolicy("prod-main-only", {
  repository: repository.name,
  environment: prod.environment,
  branchPattern: "main",
});

// The Pulumi login ci.yml's pulumi/auth-actions steps ask for. Variables
// rather than literals in ci.yml, so the OIDC policies above and the
// workflow can't drift apart.
new github.ActionsVariable("pulumi-organization", {
  repository: repository.name,
  variableName: "PULUMI_ORGANIZATION",
  value: pulumiOrganization,
});
new github.ActionsVariable("pulumi-user-login", {
  repository: repository.name,
  variableName: "PULUMI_USER_LOGIN",
  value: pulumiUserLogin,
});

// Not a secret, so a plain repository variable. ci.yml's `preview` and
// `deploy` jobs run only when it is "true".
new github.ActionsVariable("pulumi-ci-enabled", {
  repository: repository.name,
  variableName: "PULUMI_CI_ENABLED",
  value: String(pulumiCiEnabled),
});

const tokens = mintCloudflareTokens
  ? createCiTokens({
      accountId: cloudflareAccountId,
      zoneId: cloudflareZoneId,
      repositoryName,
    })
  : undefined;

if (tokens) {
  // Scoped per environment, so only jobs that declare `environment:` (and pass
  // its branch policy and reviewers) can read them. Same secret name in both,
  // so the workflow steps read alike.
  for (const [name, environment, value] of [
    ["preview", preview, tokens.read],
    ["prod", prod, tokens.write],
  ] as const) {
    new github.ActionsEnvironmentSecret(`${name}-cloudflare_api_token`, {
      repository: repository.name,
      environment: environment.environment,
      secretName: "CLOUDFLARE_API_TOKEN",
      value,
    });
  }
}

// ci.yml's Pulumi jobs log in through this instead of a stored token, and so
// do other repos' listed in pulumiOidcRepositories. This repo's entry must
// list every environment a Pulumi job in ci.yml declares.
const thisRepository = `${owner}/${repositoryName}`;
// GitHub matches owner and repo names case-insensitively.
if (
  Object.keys(pulumiOidcRepositories).some(
    (repository) => repository.toLowerCase() === thisRepository.toLowerCase(),
  )
) {
  throw new Error(
    `pulumiOidcRepositories lists ${thisRepository}; its environments are set in index.ts.`,
  );
}
createPulumiOidcIssuer({
  organization: pulumiOrganization,
  userLogin: pulumiUserLogin,
  repositories: {
    [thisRepository]: ["preview", "prod"],
    ...pulumiOidcRepositories,
  },
});

// No token outputs: nothing that runs infra/cloudflare needs them. (Not a
// security boundary on its own; the tokens are in this stack's state either
// way. The reviewer on `preview` is what keeps PR branches out of it.)
export const repositoryUrl = repository.htmlUrl;
