#!/usr/bin/env node
// Resend API helper invoked by @pulumi/command local.Command resources
// (src/resend.ts). Ported from ucmc.spencerwill.com, which owned the Resend
// domain before #2 moved it here.
//
// Usage: node resend.mjs <action>
// Actions: create-domain, delete-domain, verify-domain,
//          create-api-key, delete-api-key
//
// Inputs come from env vars (set via the Command resource's `environment`
// property). Successful create actions print a single JSON object to
// stdout so Pulumi can parse it via Output.apply(). Errors go to stderr
// with a non-zero exit. Delete actions are idempotent (404 treated as
// success) and locate resources by name (not ID) to avoid needing the
// create-time output at delete time.

const API = "https://api.resend.com";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function request(method, path, body) {
  const apiKey = requireEnv("RESEND_API_KEY");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "spencerwill-shared-pulumi/1.0",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(
      `resend ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`,
    );
    err.status = res.status;
    throw err;
  }
  return json;
}

async function findDomainByName(name) {
  const list = await request("GET", "/domains");
  return (list.data ?? []).find((d) => d.name === name);
}

async function findApiKeyByName(name) {
  const list = await request("GET", "/api-keys");
  return (list.data ?? []).find((k) => k.name === name);
}

async function createDomain() {
  const name = requireEnv("DOMAIN_NAME");
  const region = process.env.DOMAIN_REGION || "us-east-1";

  // Idempotency: if the domain already exists (e.g. a prior `pulumi up`
  // created it but failed further down the pipeline), reuse it. GET
  // /domains/{id} returns the DNS records we need to write.
  const existing = await findDomainByName(name);
  if (existing) {
    const full = await request("GET", `/domains/${existing.id}`);
    process.stdout.write(
      JSON.stringify({ id: full.id, records: full.records ?? [] }),
    );
    return;
  }

  const created = await request("POST", "/domains", { name, region });
  process.stdout.write(
    JSON.stringify({ id: created.id, records: created.records ?? [] }),
  );
}

async function deleteDomain() {
  const name = requireEnv("DOMAIN_NAME");
  const existing = await findDomainByName(name);
  if (!existing) return;
  try {
    await request("DELETE", `/domains/${existing.id}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

async function verifyDomain() {
  const id = requireEnv("DOMAIN_ID");
  await request("POST", `/domains/${id}/verify`);
}

async function createApiKey() {
  const name = requireEnv("KEY_NAME");
  const permission = process.env.PERMISSION || "sending_access";
  const domainId = process.env.DOMAIN_ID;

  // Resend only discloses the token on creation; re-create to guarantee a
  // usable token on every run. The Worker re-reads the secret on each
  // deploy, so the new token propagates without additional coordination.
  const existing = await findApiKeyByName(name);
  if (existing) await request("DELETE", `/api-keys/${existing.id}`);

  const body = { name, permission };
  if (permission === "sending_access" && domainId) body.domain_id = domainId;

  const created = await request("POST", "/api-keys", body);
  process.stdout.write(
    JSON.stringify({ id: created.id, token: created.token }),
  );
}

async function deleteApiKey() {
  const name = requireEnv("KEY_NAME");
  const existing = await findApiKeyByName(name);
  if (!existing) return;
  try {
    await request("DELETE", `/api-keys/${existing.id}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

const actions = {
  "create-domain": createDomain,
  "delete-domain": deleteDomain,
  "verify-domain": verifyDomain,
  "create-api-key": createApiKey,
  "delete-api-key": deleteApiKey,
};

const action = process.argv[2];
const fn = actions[action];
if (!fn) {
  console.error(
    `unknown action: ${action}. valid: ${Object.keys(actions).join(", ")}`,
  );
  process.exit(1);
}

fn().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
