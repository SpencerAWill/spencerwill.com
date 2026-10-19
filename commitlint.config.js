/**
 * Conventional Commits, enforced on commit-msg by husky.
 *
 * This config is also the source of truth for the interactive prompt: `pnpm
 * commit` runs commitizen through @commitlint/cz-commitlint, which builds its
 * questions from the rules below. Editing a rule here changes both what the
 * prompt offers and what the hook accepts, so the two cannot drift apart.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  // Dependabot capitalizes "Bump" after a configured prefix, which fails
  // subject-case, and documents no option to change it. Matched narrowly on the
  // prefixes set in .github/dependabot.yml, so other titles are still checked.
  ignores: [
    (message) => /^(build|chore|ci)(\(deps(-dev)?\))?: Bump /.test(message),
  ],
  rules: {
    // "scope" is the area touched, e.g. feat(cloudflare): or fix(github):.
    // Left unrestricted while the repo is small.
    "scope-empty": [0],
  },
};
