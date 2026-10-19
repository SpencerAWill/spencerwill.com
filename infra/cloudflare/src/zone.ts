import * as cloudflare from "@pulumi/cloudflare";

/**
 * The spencerwill.com zone itself, and the DNS records nobody else owns (#5).
 *
 * Every record in the zone has exactly one owner. As of the import
 * (2026-10-19), the zone's 17 records were:
 *
 * - Here: the apex SPF TXT, and `_dmarc` (DMARC, #6).
 * - Here, through src/resend.ts: Resend's four records.
 * - www.spencerwill.com's stack: the `www` CNAME.
 * - Read-only, made by a Cloudflare feature that owns them, and never declared
 *   anywhere: Email Routing's apex MX records and `cf2024-1._domainkey` DKIM,
 *   and the records behind Worker custom domains (apex, `ucmc`, `dev.ucmc`,
 *   `dev.flareling`) and R2 custom domains (`cdn.ucmc`, `cdn.dev.ucmc`). Each
 *   belongs to the feature (and stack) that created the hostname.
 *
 * A new record goes in the stack of the app it serves if that stack creates
 * the hostname, and here otherwise. See "Adding a DNS record" in the README.
 */
export function manageZone({
  accountId,
  zoneId,
  zoneName,
}: {
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
}) {
  // Imported, never created: the zone has existed since before this repo.
  // Protected, because deleting it takes every site on it down.
  const zone = new cloudflare.Zone(
    "zone",
    {
      account: { id: accountId },
      name: zoneName,
      type: "full",
      paused: false,
    },
    { protect: true, import: zoneId },
  );

  // TXT contents are declared with their quotes, exactly as Cloudflare
  // stores them; without them every refresh would show a diff.

  // Authorizes Cloudflare Email Routing to send for the apex (its forwards).
  // Resend's SPF is separate, on `send.`.
  const apexSpf = new cloudflare.DnsRecord(
    "apex-spf",
    {
      zoneId,
      name: zoneName,
      type: "TXT",
      content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"',
      ttl: 1,
      proxied: false,
      comment: "For mail@spencerwill.com",
    },
    { import: `${zoneId}/c0f6f59e4c52f87a50fdbf60800fd3ba` },
  );

  // Still p=none; stepping it up is #6. Reports go to Cloudflare's DMARC
  // Management.
  const dmarc = new cloudflare.DnsRecord(
    "dmarc",
    {
      zoneId,
      name: `_dmarc.${zoneName}`,
      type: "TXT",
      content:
        '"v=DMARC1; p=none; rua=mailto:e70de9296fa144aea28d1f7122d083c3@dmarc-reports.cloudflare.net"',
      ttl: 1,
      proxied: false,
      comment: "Email DMARC record",
    },
    { import: `${zoneId}/86a62acad36f1503073ee7eedca5a29d` },
  );

  return { zone, apexSpf, dmarc };
}
