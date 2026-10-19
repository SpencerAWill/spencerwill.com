import * as pulumi from "@pulumi/pulumi";

/**
 * Zone- and account-wide Cloudflare resources for spencerwill.com: things
 * every app on the zone shares and no single app should own. The apps
 * (www.spencerwill.com, ucmc.spencerwill.com, flareling) read the outputs
 * below through a StackReference to `SpencerAWill/spencerwill-shared/prod`.
 *
 * Apply this stack before its consumers: a consumer's `pulumi up` reads the
 * outputs as they are now, so a new or renamed output must exist here first.
 * The README lists every output and who reads it.
 *
 * Empty at bootstrap. Scope is tracked in issues:
 *   #2  shared Resend sending domain, per-app keys, Email Routing
 *   #3  Zero Trust organization and login methods
 *   #4  zone security settings (WAF skip rule for CI smoke tests)
 *   #5  the zone itself and its DNS (until then the zone is NOT managed here)
 *   #6  DMARC
 *
 * Anything that already exists in Cloudflare comes in with `pulumi import`,
 * never by creating it again, and must preview with no changes after import.
 * Anything whose replacement would take sites down or re-issue keys (the
 * zone, the Resend domain) is `protect: true`.
 */

const cfg = new pulumi.Config();

const accountId = cfg.require("accountId");
const zoneId = cfg.require("zoneId");
const zoneName = cfg.require("zoneName");

// Echoed from config so consumers can take the account and zone from here
// instead of repeating the IDs in each of their own stack configs.
export { accountId, zoneId, zoneName };
