import * as pulumiservice from "@pulumi/pulumiservice";

/**
 * Lets ci.yml's Pulumi jobs exchange GitHub's OIDC token for a short-lived
 * Pulumi access token, so no long-lived PULUMI_ACCESS_TOKEN is stored in
 * GitHub. https://www.pulumi.com/docs/pulumi-cloud/access-management/oidc/client/github/
 *
 * Only jobs that declare one of `environments` can exchange: GitHub puts the
 * environment in the token's `sub` (`repo:<owner>/<repo>:environment:<name>`)
 * whenever a job declares one, and that replaces the ref. No other workflow,
 * no Dependabot run, and no other repository matches.
 *
 * The tokens are personal: on this Pulumi edition, organization and team
 * tokens (which could be scoped to fewer stacks) aren't offered. So a token
 * carries `userLogin`'s full access, and `preview` (open to every PR branch)
 * can mint one. See "Security model" in the README.
 */
export function createPulumiOidcIssuer({
  organization,
  userLogin,
  repository,
  environments,
}: {
  readonly organization: string;
  readonly userLogin: string;
  /** `<owner>/<repo>`. */
  readonly repository: string;
  readonly environments: readonly string[];
}) {
  // One issuer per Pulumi organization and URL. If another repo (ucmc,
  // flareling) moves to OIDC, add its policies here rather than registering
  // GitHub again.
  return new pulumiservice.OidcIssuer("github-actions", {
    organization,
    name: "GitHub Actions",
    url: "https://token.actions.githubusercontent.com",
    // Enough for the longest Pulumi job (deploy, 20 min timeout) with room to
    // spare. The token dies with it either way.
    maxExpirationSeconds: 3600,
    // Pulumi Cloud adds a deny-all policy to a new issuer; these are the only
    // exchanges allowed. One policy per environment rather than a wildcard,
    // so adding an environment is a deliberate change here.
    policies: environments.map((environment) => ({
      decision: "allow",
      tokenType: "personal",
      userLogin,
      rules: {
        aud: `urn:pulumi:org:${organization}`,
        sub: `repo:${repository}:environment:${environment}`,
      },
    })),
  });
}
