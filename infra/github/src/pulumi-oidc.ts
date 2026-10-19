import * as github from "@pulumi/github";
import * as pulumi from "@pulumi/pulumi";
import * as pulumiservice from "@pulumi/pulumiservice";

/**
 * Lets GitHub Actions jobs exchange GitHub's OIDC token for a short-lived
 * Pulumi access token, so no long-lived PULUMI_ACCESS_TOKEN is stored in
 * GitHub. https://www.pulumi.com/docs/pulumi-cloud/access-management/oidc/client/github/
 *
 * Account-wide, which is why it lives in this repo: Pulumi Cloud allows one
 * issuer per URL per organization (registering GitHub a second time fails
 * with "issuer ... already registered", checked 2026-10-19). So every repo
 * whose CI logs in to `organization` this way (this one, and ucmc, www, or
 * flareling when they move to OIDC) gets its policies here, through
 * `repositories`. The resource owns the whole policy list, so a policy added
 * by hand in the Pulumi Cloud UI is removed on the next apply.
 *
 * Each policy allows exactly one repository and environment, matched on the
 * token's `sub`. GitHub puts the environment there whenever a job declares
 * one, so only jobs that declare a listed environment can exchange. Nothing
 * matches a job without an environment or an unlisted repository.
 *
 * The `sub` is GitHub's immutable form,
 * `repo:<owner>@<owner id>/<repo>@<repo id>:environment:<name>`, with the
 * numeric IDs looked up here. A repo deleted and re-created under the same
 * name gets a new ID and doesn't match. Every listed repo must send that
 * form ("use_immutable_subject": true; check with
 * `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`). Repos
 * created recently do by default; older ones must switch first, see the
 * README.
 *
 * The tokens are personal: on this Pulumi edition, organization and team
 * tokens (which could be scoped to fewer stacks) aren't offered. So every
 * token carries `userLogin`'s full access, across every repo's stacks. See
 * "Security model" in the README.
 */
export function createPulumiOidcIssuer({
  organization,
  userLogin,
  repositories,
}: {
  readonly organization: string;
  readonly userLogin: string;
  /** `<owner>/<repo>` to the GitHub environments allowed to log in. */
  readonly repositories: Readonly<Record<string, readonly string[]>>;
}) {
  const subjects = Object.entries(repositories).flatMap(
    ([repository, environments]) => {
      const [owner = "", name = ""] = repository.split("/");
      const ownerId = github.getUserOutput({ username: owner }).id;
      const repoId = github.getRepositoryOutput({
        fullName: repository,
      }).repoId;
      return environments.map(
        (environment) =>
          pulumi.interpolate`repo:${owner}@${ownerId}/${name}@${repoId}:environment:${environment}`,
      );
    },
  );

  return new pulumiservice.OidcIssuer(
    "github-actions",
    {
      organization,
      // Says where it is managed, for anyone who finds it in the Pulumi Cloud
      // UI and wants to change it.
      name: "GitHub Actions (managed by SpencerAWill/spencerwill.com infra/github)",
      url: "https://token.actions.githubusercontent.com",
      // Declared because the provider (1.4.0) sends this input on every
      // update, and Pulumi Cloud rejects an update with none ("You must
      // provide at least one thumbprint"). Pulumi Cloud checks the issuer's
      // certificate against trusted CAs first and falls back to thumbprints
      // only if that fails, so GitHub renewing this (Let's Encrypt) leaf
      // certificate doesn't break login; a stale value here is harmless.
      // Refresh with:
      //   echo | openssl s_client -connect token.actions.githubusercontent.com:443 \
      //     -servername token.actions.githubusercontent.com 2>/dev/null \
      //     | openssl x509 -noout -fingerprint -sha256
      // (lowercase, colons removed). The value recorded at registration was
      // the SHA-256 one below, for the leaf expiring 2026-12-07.
      thumbprints: [
        "2a6aa56347230d695e4ab7a8e5b6f8672d18c2bf98790d06d54dd0706388e6a1",
      ],
      // Enough for the longest Pulumi job in any repo, with room to spare.
      // A job can ask for less (pulumi/auth-actions' token-expiration).
      maxExpirationSeconds: 3600,
      // Pulumi Cloud denies any exchange no allow policy matches. One policy
      // per subject rather than wildcards, so every grant is listed here.
      policies: subjects.map((sub) => ({
        decision: "allow",
        tokenType: "personal",
        userLogin,
        rules: { aud: `urn:pulumi:org:${organization}`, sub },
      })),
    },
    // Deleting it breaks Pulumi login in every repo that uses it.
    { protect: true },
  );
}
