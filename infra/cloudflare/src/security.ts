import * as cloudflare from "@pulumi/cloudflare";

/**
 * Zone-wide security settings (#4). They apply to every site on the zone
 * (www, ucmc, flareling), which is why they live here and nowhere else.
 *
 * Imported with their values as they were set by hand (2026-10-19). Changes
 * come in later PRs, each showing its own `~ update`, never mixed into an
 * import: Pulumi fails an import whose declared values differ from the live
 * ones.
 *
 * Not managed here:
 * - The zone's `http_request_dynamic_redirect` ruleset belongs to
 *   www.spencerwill.com's stack (its www-to-apex redirect). Phase entrypoint
 *   rulesets are zone singletons, so declaring it here too would make two
 *   stacks fight over it.
 * - Settings with no security bearing (caching, compression, Early Hints and
 *   the like) stay as set in the dashboard until there's a reason to own one.
 */
export function manageSecurity({ zoneId }: { readonly zoneId: string }) {
  // retainOnDelete on every setting: a zone setting always exists, so taking
  // one out of this program (or renaming it here) should only stop managing
  // it, never reset a zone-wide setting to the provider's default.
  const setting = (settingId: string, value: unknown) =>
    new cloudflare.ZoneSetting(
      `setting-${settingId.replaceAll("_", "-")}`,
      { zoneId, settingId, value },
      { import: `${zoneId}/${settingId}`, retainOnDelete: true },
    );

  // ---- TLS ----
  // Encryption to the origin, validating its certificate ("strict", Full
  // (strict) in the dashboard). Every proxied hostname is a Worker or an R2
  // custom domain today, which this doesn't affect; it matters for the first
  // record that points at a real origin, which must then have a certificate
  // that's valid for its hostname (a public CA's or a Cloudflare Origin CA).
  setting("ssl", "strict");
  // TLS 1.0 and 1.1 are deprecated; anything still on them is very old.
  setting("min_tls_version", "1.2");
  // "zrt": TLS 1.3 with 0-RTT.
  setting("tls_1_3", "zrt");
  setting("always_use_https", "on");
  setting("automatic_https_rewrites", "on");
  // Edge HSTS (`security_header`, off) is deliberately not managed: provider
  // 6.22.0 panics reading it (nil pointer in math/big; upstream
  // cloudflare/terraform-provider-cloudflare#6879, open). Apps that want
  // HSTS send it themselves (flareling's Worker does). Add it here once a
  // provider release reads it without crashing.

  // ---- Page behavior ----
  // Off: Rocket Loader rewrites and defers page scripts, which can break the
  // React apps on this zone (www, ucmc, flareling) and fights a strict
  // Content-Security-Policy. Each app bundles and loads its own scripts.
  setting("rocket_loader", "off");

  // ---- Challenges ----
  setting("security_level", "medium");
  setting("browser_check", "on");

  // Bot settings, Free plan. Bot Fight Mode (`fightMode`) challenges what
  // Cloudflare scores as automated, and on this plan no rule can skip it
  // (only Super Bot Fight Mode, a paid feature, can be skipped). It is the
  // suspect in flareling#14 (CI smoke tests getting 403); diagnose that
  // before changing it.
  new cloudflare.BotManagement(
    "bot-management",
    {
      zoneId,
      fightMode: true,
      enableJs: true,
      aiBotsProtection: "block",
      contentBotsProtection: "disabled",
      crawlerProtection: "disabled",
      aiTraining: "disallow",
      aisearch: "disabled",
      aiUser: "disabled",
      isRobotsTxtManaged: true,
      aiBotsMigrationOptOut: false,
      // Not declared: botPreferenceSyncEnabled (true) and cfRobotsVariant
      // ("off"). Provider 6.22.0 doesn't read them back on import, so
      // declaring them plans a write of values that are already live. Left
      // out, they keep their dashboard values.
    },
    // Same reasoning as the zone settings above.
    { import: zoneId, retainOnDelete: true },
  );

  // The zone's rate-limiting entrypoint, a singleton per phase: this resource
  // owns every rate-limiting rule on the zone, and a rule added in the
  // dashboard is removed on the next apply. Its one rule blocks requests
  // carrying a password known to be leaked, once one IP (per data center)
  // sends more than 5 in 10 seconds.
  new cloudflare.Ruleset(
    "rate-limit",
    {
      zoneId,
      kind: "zone",
      phase: "http_ratelimit",
      name: "default",
      description: "",
      rules: [
        {
          ref: "911d4d42169e42da87bef3b507ba914a",
          description: "Leaked credential check",
          enabled: true,
          expression: "(cf.waf.credential_check.password_leaked)",
          action: "block",
          ratelimit: {
            characteristics: ["ip.src", "cf.colo.id"],
            period: 10,
            requestsPerPeriod: 5,
            mitigationTimeout: 10,
          },
        },
      ],
    },
    // Protected: deleting it removes the zone's leaked-credential blocking.
    {
      protect: true,
      import: `zones/${zoneId}/080cdde487aa4db99ac1fbc1b6bfe273`,
    },
  );
}
