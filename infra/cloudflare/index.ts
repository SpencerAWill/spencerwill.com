import * as pulumi from "@pulumi/pulumi";
import { ResendDomain } from "./src/resend.ts";
import { manageSecurity } from "./src/security.ts";
import { manageZeroTrust } from "./src/zero-trust.ts";
import { manageZone } from "./src/zone.ts";

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
 * Scope, tracked in issues:
 *   #2  shared Resend sending domain and per-app keys (below)
 *   #3  Zero Trust organization and login methods (src/zero-trust.ts)
 *   #4  zone security settings (src/security.ts)
 *   #5  the zone itself and the DNS records nobody else owns (src/zone.ts)
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

// ---- The zone and its unowned DNS records (#5) ----
manageZone({ accountId, zoneId, zoneName });

// ---- Zero Trust organization (#3) ----
const zeroTrust = manageZeroTrust({ accountId });

/**
 * The Zero Trust team domain, a bare host (`<team>.cloudflareaccess.com`).
 * Access JWTs carry `iss: "https://<this>"`; compare with the scheme added.
 * For ucmc's and flareling's dev outboxes, which set it in their own stack
 * config today (#16 moves them to this output).
 */
export const accessTeamDomain = zeroTrust.teamDomain;

// ---- Zone security settings (#4) ----
manageSecurity({ zoneId });

// ---- Resend (#2) ----
//
// One verified sending domain, the zone itself, shared by every app's prod:
// the free Resend plan allows one domain per account. Each app gets its own
// sending key and its own from-address.
//
// This can only be applied once ucmc has released the domain slot it held
// (ucmc.spencerwill.com#298): see that runbook for the order.

const resend = new ResendDomain("resend", {
  domainName: zoneName,
  managementApiKey: cfg.requireSecret("resendManagementApiKey"),
  zoneId,
  // Names unique in the Resend account, and different from the keys apps
  // created for themselves before (ucmc's was "ucmc-web-prod-sending"),
  // because creating a key first deletes any key with the same name.
  sendingKeys: {
    ucmc: "spencerwill-shared-ucmc-sending",
    flareling: "spencerwill-shared-flareling-sending",
  },
});

const sendingKey = (app: string) => {
  const token = resend.sendingKeyTokens[app];
  if (!token) throw new Error(`no Resend sending key for ${app}`);
  return token;
};

/** Read by ucmc.spencerwill.com's prod stack. */
export const ucmcResendApiKey = sendingKey("ucmc");
export const ucmcFromEmail = `ucmc@${zoneName}`;

/** For flareling's prod stack. */
export const flarelingResendApiKey = sendingKey("flareling");
export const flarelingFromEmail = `flareling@${zoneName}`;

export const resendDomainId = resend.domainId;
