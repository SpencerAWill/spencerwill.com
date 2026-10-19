import * as github from "@pulumi/github";
import { createCiTokens } from "./src/cloudflare-tokens.ts";
import {
  cloudflareAccountId,
  cloudflareZoneId,
  mintCloudflareTokens,
  prodReviewerIds,
  pulumiCiEnabled,
  repositoryName,
} from "./src/config.ts";
import { repository } from "./src/repository.ts";

/**
 * GitHub settings and CI secrets for this repo. See "GitHub as code" in the
 * README for what is managed here and why.
 *
 * Run locally by a repo admin, never in CI: the Actions GITHUB_TOKEN cannot
 * change repo settings or write secrets, and CI should not hold a credential
 * that can loosen its own rules.
 */

// PR previews. No branch policy and no reviewer, because every PR branch
// needs it; what keeps it safe is that its token can only read.
const preview = new github.RepositoryEnvironment("preview", {
  repository: repository.name,
  environment: "preview",
  canAdminsBypass: true,
});

// `pulumi up`. Main only, behind a reviewer.
const prod = new github.RepositoryEnvironment("prod", {
  repository: repository.name,
  environment: "prod",
  canAdminsBypass: true,
  preventSelfReview: false,
  reviewers: [{ users: prodReviewerIds }],
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

export const repositoryUrl = repository.htmlUrl;

/**
 * The write token, so local runs of infra/cloudflare use the same scoped token
 * as CI (infra/cloudflare/with-infra-token.sh reads it). Encrypted in state and
 * shown only with --show-secrets.
 */
export const cloudflareWriteToken = tokens?.write;
