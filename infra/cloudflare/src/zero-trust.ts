import * as cloudflare from "@pulumi/cloudflare";

/**
 * The team domain, a bare host. Access JWTs carry `iss: "https://" + this`,
 * and their signing keys are at `https://<this>/cdn-cgi/access/certs`.
 * Renaming it (#16) breaks every app still configured with the old value.
 */
const TEAM_DOMAIN = "late-hat-fec1.cloudflareaccess.com";

/**
 * The account's Zero Trust organization and its login methods (#3). Shared by
 * every app's Access applications (ucmc's and flareling's dev outboxes), which
 * stay in each app's own stack. This repo owns only the organization they
 * live in.
 *
 * Both were set up by hand (2026-10-16) and are imported with their values as
 * they were then. Both are protected: deleting the organization or its only
 * login method locks everyone out of every Access application.
 */
export function manageZeroTrust({ accountId }: { readonly accountId: string }) {
  const organization = new cloudflare.ZeroTrustOrganization(
    "zero-trust-organization",
    {
      accountId,
      // Cloudflare stores the team domain as the name too.
      name: TEAM_DOMAIN,
      authDomain: TEAM_DOMAIN,
      isUiReadOnly: false,
      allowAuthenticateViaWarp: false,
      warpAuthNonBrowser401: false,
      denyUnmatchedRequests: false,
      denyUnmatchedRequestsExemptedZoneNames: [],
      strictServiceTokenAuth: true,
      // Off, as it is. Cloudflare stores it as { enabled: false } with a null
      // action and threshold, but the provider requires all three fields, so
      // this fills in unused ones (the import plans that as a one-time
      // update). With enabled: false, nothing acts on inactive tokens.
      serviceTokenInactivity: {
        enabled: false,
        action: "disable",
        inactivityThresholdDays: 90,
      },
    },
    { protect: true },
  );

  // Cloudflare's own identity provider, restricted to account members: the
  // only login method. Organizations created since June 2026 start with it.
  // Someone outside the account (an outbox viewer, say) needs another method,
  // such as One-time PIN, added here.
  new cloudflare.ZeroTrustAccessIdentityProvider(
    "cloudflare-login",
    {
      accountId,
      // Empty, as Cloudflare created it; the dashboard shows its type instead.
      name: "",
      type: "cloudflare",
      config: { restrictToAccountMembers: true },
    },
    { protect: true },
  );

  return { teamDomain: organization.authDomain };
}
