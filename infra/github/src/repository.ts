import * as github from "@pulumi/github";
import {
  description,
  repositoryName,
  requiredChecks,
  visibility,
} from "./config.ts";

/**
 * The repository itself. It already exists when this program first runs, so
 * it is adopted with `pnpm adopt` (a `pulumi import`) rather than created.
 *
 * Every setting is declared explicitly, even ones that match GitHub's
 * defaults. The provider treats an omitted optional field as "clear it", so
 * leaving out `description` or `hasIssues` would quietly change the repo.
 */
export const repository = new github.Repository(
  "repository",
  {
    name: repositoryName,
    description,
    visibility,

    hasIssues: true,
    hasProjects: true,
    hasWiki: true,
    hasDiscussions: false,

    // Squash-only, titled from the PR. lint-pr.yml enforces Conventional
    // Commit PR titles, so every commit on main stays conventional too.
    allowSquashMerge: true,
    allowMergeCommit: false,
    allowRebaseMerge: false,
    squashMergeCommitTitle: "PR_TITLE",
    squashMergeCommitMessage: "PR_BODY",
    allowAutoMerge: false,
    allowUpdateBranch: true,
    deleteBranchOnMerge: true,
    webCommitSignoffRequired: false,

    securityAndAnalysis: {
      secretScanning: { status: "enabled" },
      secretScanningPushProtection: { status: "enabled" },
    },

    // `protect` blocks any plan that would delete the repo, and
    // `retainOnDelete` makes Pulumi only forget it, never call GitHub's
    // delete. This archive-instead-of-delete applies only if both are removed.
    archiveOnDestroy: true,
  },
  { protect: true, retainOnDelete: true },
);

// Dependabot alerts. A separate resource now; the `vulnerabilityAlerts` field
// on Repository is deprecated.
new github.RepositoryVulnerabilityAlerts("vulnerability-alerts", {
  repository: repository.name,
  enabled: true,
});

/**
 * Safeguards on the default branch. Repository admins can bypass, which keeps
 * direct pushes to main possible in an emergency and means nobody can be
 * locked out by a bad rule.
 */
new github.RepositoryRuleset("default-branch", {
  repository: repository.name,
  name: "default branch",
  target: "branch",
  enforcement: "active",
  conditions: {
    refName: { includes: ["~DEFAULT_BRANCH"], excludes: [] },
  },
  bypassActors: [
    // actorId 5 is GitHub's built-in "Repository admin" role.
    { actorId: 5, actorType: "RepositoryRole", bypassMode: "always" },
  ],
  rules: {
    deletion: true,
    nonFastForward: true,
    requiredLinearHistory: true,
    pullRequest: {
      requiredApprovingReviewCount: 0,
      dismissStaleReviewsOnPush: true,
      requiredReviewThreadResolution: true,
    },
    ...(requiredChecks.length > 0 && {
      requiredStatusChecks: {
        strictRequiredStatusChecksPolicy: true,
        // Only GitHub Actions (app id 15368) can satisfy the check, not a
        // commit status of the same name posted through the API.
        requiredChecks: requiredChecks.map((context) => ({
          context,
          integrationId: 15368,
        })),
      },
    }),
  },
});
