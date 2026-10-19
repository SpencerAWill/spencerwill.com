/**
 * Biome is the entire lint-staged toolchain: it lints, formats, and sorts
 * imports in a single pass. (The secret scan runs separately in
 * .husky/pre-commit, over the whole staged diff rather than per file.)
 *
 * The "*" glob hands Biome every staged path and lets biome.json decide what is
 * in scope, so the include list lives in exactly one place.
 *
 *   --write                    apply fixes; lint-staged re-stages what changes
 *   --no-errors-on-unmatched   staging only out-of-scope files is not a failure
 *   --files-ignore-unknown     skip file types Biome has no parser for
 *                              (.md, .yaml, images) instead of erroring
 *   --error-on-warnings        make warnings block the commit
 *
 * Several rules in Biome's recommended set (noUnusedVariables among them) are
 * warnings, and `biome check` exits 0 on a warning. Without the last flag the
 * hook would commit unused variables and dead imports.
 */
export default {
  "*": [
    "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true --error-on-warnings",
  ],
};
