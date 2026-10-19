import * as cloudflare from "@pulumi/cloudflare";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";

// Relative to infra/cloudflare, where Pulumi runs local commands from (the
// program directory), in CI and locally alike. Never an absolute path: the
// command string is saved in state, so a path that differs between machines
// (CI's /home/runner/..., a laptop's /Users/...) changes the command and
// re-runs it, and re-running create-api-key rotates every app's sending key.
const SCRIPT = "scripts/resend.mjs";

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
 * SPF, the return path), `resend._domainkey.<domain>` (DKIM), and, for domains
 * added since about October 2026, a DNS-only CNAME at `rsend.<domain>` that
 * Resend also classifies as SPF. The apex's Email Routing MX and SPF are
 * untouched. Every record Resend returns must match exactly one of the kinds
 * handled below, or the program fails at preview: a fourth record was once
 * silently dropped, leaving the domain only partially verified.
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
    const runScript = `node ${SCRIPT}`;

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

    // Resend classifies the return-path MX and the rsend CNAME as "SPF" too,
    // so tell its records apart by type. The keys name the DnsRecords below
    // (`<name>-<kind>`): renaming one deletes and re-creates a live record.
    const kinds: Record<string, (r: ResendRecord) => boolean> = {
      mx: (r) => r.type === "MX",
      spf: (r) => r.record === "SPF" && r.type === "TXT",
      dkim: (r) => r.record === "DKIM",
      cname: (r) => r.type === "CNAME",
    };
    const describe = (list: ResendRecord[]) =>
      JSON.stringify(
        list.map((r) => ({ record: r.record, type: r.type, name: r.name })),
      );

    // Each record must match exactly one kind, and each kind one record.
    const checked = domainOutput.apply(({ records }) => {
      const unhandled = records.filter(
        (r) =>
          Object.values(kinds).filter((matches) => matches(r)).length !== 1,
      );
      if (unhandled.length > 0) {
        throw new Error(
          `resend: records match no kind, or more than one, in src/resend.ts: ${describe(unhandled)}`,
        );
      }
      return records;
    });

    const records = Object.fromEntries(
      Object.entries(kinds).map(([kind, matches]) => [
        kind,
        checked.apply((list) => {
          const found = list.filter(matches);
          if (found.length !== 1) {
            throw new Error(
              `resend: expected one ${kind} record, got ${describe(found)} of ${describe(list)}`,
            );
          }
          return found[0] as ResendRecord;
        }),
      ]),
    );

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
            // Resend checks this CNAME's target directly, so it must not be
            // proxied (which would answer with Cloudflare's own addresses).
            ...(kind === "cname" && { proxied: false }),
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
