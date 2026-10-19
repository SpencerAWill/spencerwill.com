import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cloudflare from "@pulumi/cloudflare";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "resend.mjs",
);

interface ResendRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
}

interface CreateDomainOutput {
  id: string;
  records: ResendRecord[];
}

export interface ResendDomainArgs {
  /** The domain to verify in Resend, e.g. "spencerwill.com". */
  domainName: string;
  /** Full-access Resend key, used only to manage the domain and keys. */
  managementApiKey: pulumi.Input<string>;
  /** The Cloudflare zone `domainName` is in. */
  zoneId: pulumi.Input<string>;
  /**
   * Sending keys to issue, by app, as the key's name in Resend. Each is
   * scoped to this domain with `sending_access`. Names must be unique in the
   * Resend account: creating a key first deletes any key with the same name.
   */
  sendingKeys: Readonly<Record<string, string>>;
}

/**
 * A verified Resend sending domain: the domain itself, its DNS records in
 * Cloudflare, and one sending-scoped API key per app.
 *
 * Ported from ucmc.spencerwill.com's ResendDomain, which owned the account's
 * one domain (the free plan allows one) before #2 moved it here. Uses
 * `@pulumi/command` and scripts/resend.mjs rather than a dynamic provider,
 * because Pulumi's dynamic providers don't work with pnpm (pulumi/pulumi#9085).
 *
 * Resend's records for a sending-only domain land on `send.<domain>` (MX and
 * SPF, the return path) and `resend._domainkey.<domain>` (DKIM), so the apex's
 * Email Routing MX and SPF are untouched. If Resend ever returns a different
 * set of records, the record lookups below throw instead of guessing.
 *
 * A key's scope is the domain, not an address: either app's key can send as
 * any `@<domain>` address.
 */
export class ResendDomain extends pulumi.ComponentResource {
  public readonly domainId: pulumi.Output<string>;
  /** Each app's sending key, as a secret. */
  public readonly sendingKeyTokens: Record<string, pulumi.Output<string>>;

  constructor(
    name: string,
    args: ResendDomainArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("spencerwill:resend:Domain", name, {}, opts);

    const parent = { parent: this };
    const runScript = `node ${JSON.stringify(SCRIPT)}`;

    // Creates the domain, or reads it back if it already exists, so a run
    // that failed further down can be retried. Protected: deleting it in
    // Resend re-issues DKIM and stops every app's mail until it verifies
    // again.
    const domain = new command.local.Command(
      `${name}-domain`,
      {
        create: `${runScript} create-domain`,
        delete: `${runScript} delete-domain`,
        environment: {
          RESEND_API_KEY: args.managementApiKey,
          DOMAIN_NAME: args.domainName,
        },
      },
      { ...parent, protect: true },
    );

    const domainOutput = domain.stdout.apply(
      (raw) => JSON.parse(raw) as CreateDomainOutput,
    );
    this.domainId = domainOutput.apply((d) => d.id);

    const pick = (predicate: (r: ResendRecord) => boolean, label: string) =>
      domainOutput.apply(({ records }) => {
        const found = records.find(predicate);
        if (!found) {
          throw new Error(
            `resend: expected a ${label} record, got ${JSON.stringify(records.map((r) => ({ record: r.record, type: r.type })))}`,
          );
        }
        return found;
      });

    // Resend classifies the return-path MX as "SPF" too, so tell the two SPF
    // records apart by type.
    const records = {
      mx: pick((r) => r.type === "MX", "return-path MX"),
      spf: pick((r) => r.record === "SPF" && r.type === "TXT", "SPF TXT"),
      dkim: pick((r) => r.record === "DKIM", "DKIM"),
    };

    // Resend may name records relative to the domain ("send") or in full.
    // Cloudflare always stores the full name, so normalize to that, or every
    // refresh would show a diff.
    const fullName = (record: pulumi.Output<ResendRecord>) =>
      record.apply((r) =>
        r.name === args.domainName || r.name.endsWith(`.${args.domainName}`)
          ? r.name
          : `${r.name}.${args.domainName}`,
      );

    const dns = Object.entries(records).map(
      ([kind, record]) =>
        new cloudflare.DnsRecord(
          `${name}-${kind}`,
          {
            zoneId: args.zoneId,
            name: fullName(record),
            type: record.apply((r) => r.type),
            content: record.apply((r) => r.value),
            ...(kind === "mx" && {
              priority: record.apply((r) => r.priority ?? 10),
            }),
            // 1 is "automatic".
            ttl: 1,
            comment: `Managed by Pulumi (spencerwill-shared): Resend ${kind}`,
          },
          parent,
        ),
    );

    // Asks Resend to check the records. Verification itself is asynchronous
    // and finishes as DNS propagates; this only starts it.
    const verify = new command.local.Command(
      `${name}-verify`,
      {
        create: `${runScript} verify-domain`,
        triggers: [this.domainId],
        environment: {
          RESEND_API_KEY: args.managementApiKey,
          DOMAIN_ID: this.domainId,
        },
      },
      { ...parent, dependsOn: dns },
    );

    // Resend shows a key's token only when it's created, so the script
    // deletes and re-creates a key of the same name to always get a token.
    // Re-created (new token) only when the domain is.
    this.sendingKeyTokens = Object.fromEntries(
      Object.entries(args.sendingKeys).map(([app, keyName]) => {
        const key = new command.local.Command(
          `${name}-${app}-key`,
          {
            create: `${runScript} create-api-key`,
            delete: `${runScript} delete-api-key`,
            triggers: [this.domainId],
            environment: {
              RESEND_API_KEY: args.managementApiKey,
              KEY_NAME: keyName,
              PERMISSION: "sending_access",
              DOMAIN_ID: this.domainId,
            },
            // stdout holds the token; keep it out of the deploy log.
            logging: "none",
          },
          {
            ...parent,
            dependsOn: [verify],
            additionalSecretOutputs: ["stdout"],
          },
        );
        const token = key.stdout.apply(
          (raw) => (JSON.parse(raw) as { token: string }).token,
        );
        return [app, pulumi.secret(token)];
      }),
    );

    this.registerOutputs({ domainId: this.domainId });
  }
}
