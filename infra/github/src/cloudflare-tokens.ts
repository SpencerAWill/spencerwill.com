import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

/**
 * Cloudflare permissions for each CI token, by the names Cloudflare shows in
 * the dashboard. Names are resolved to IDs at deploy time, and an unknown name
 * fails the run rather than silently granting less.
 *
 * This repo owns the spencerwill.com zone, so unlike flareling's tokens these
 * carry zone-wide permissions: zone settings, WAF, bot settings, DNS, Email
 * Routing (#2, #4, #5, #6), and the account's Zero Trust organization (#3).
 * Zone permissions are still scoped to that one zone, never to every zone in
 * the account.
 *
 * Two tokens with the same reach, differing only in Read vs Write:
 * - `read` is for `pulumi preview` on PRs (the `preview` environment), which
 *   any branch can trigger and which never writes.
 * - `write` is for `pulumi up` (the `prod` environment: main only, behind a
 *   reviewer).
 *
 * Add a permission here in the same PR as the resource that needs it, in both
 * lists, or the PR's preview fails on the read token.
 */
const scopes = {
  account: [
    "Access: Organizations, Identity Providers, and Groups",
    "Email Routing Addresses",
  ],
  zone: [
    "Zone",
    "Zone Settings",
    "DNS",
    "Zone WAF",
    "Bot Management",
    "Email Routing Rules",
  ],
} as const;

const tokenKinds = { read: "Read", write: "Write" } as const;
export type TokenKind = keyof typeof tokenKinds;

export function createCiTokens({
  accountId,
  zoneId,
  repositoryName,
}: {
  readonly accountId: string;
  readonly zoneId: string;
  readonly repositoryName: string;
}): Record<TokenKind, pulumi.Output<string>> {
  const groups = cloudflare.getAccountApiTokenPermissionGroupsListOutput({
    accountId,
    maxItems: 1000,
  });

  // Some names exist at both scopes (for example the Access groups), so the
  // lookup matches on scope as well as name.
  const scopeIds = {
    account: "com.cloudflare.api.account",
    zone: "com.cloudflare.api.account.zone",
  };
  const idsFor = (scope: keyof typeof scopeIds, names: readonly string[]) =>
    groups.results.apply((results) =>
      names.map((name) => {
        const match = results.find(
          (group) =>
            group.name === name && group.scopes.includes(scopeIds[scope]),
        );
        if (!match) {
          throw new Error(
            `Unknown ${scope}-scoped Cloudflare permission group: "${name}"`,
          );
        }
        return { id: match.id };
      }),
    );

  const accountResource = `com.cloudflare.api.account.${accountId}`;
  const zoneResource = JSON.stringify({
    [accountResource]: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
  });

  const mint = (kind: TokenKind) => {
    const level = tokenKinds[kind];
    const named = (names: readonly string[]) =>
      names.map((name) => `${name} ${level}`);
    // Read-only on both: the provider reads account details, nothing here
    // changes them.
    const account = ["Account Settings Read", ...named(scopes.account)];
    const token = new cloudflare.AccountToken(`${kind}-token`, {
      accountId,
      name: `${repositoryName} CI (${kind})`,
      policies: [
        {
          effect: "allow",
          permissionGroups: idsFor("account", account),
          resources: JSON.stringify({ [accountResource]: "*" }),
        },
        {
          effect: "allow",
          permissionGroups: idsFor("zone", named(scopes.zone)),
          resources: zoneResource,
        },
      ],
    });
    return pulumi.secret(token.value);
  };

  return { read: mint("read"), write: mint("write") };
}
