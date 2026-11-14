#!/usr/bin/env node
// The owner's tool for invite codes on the Moondog model gateway.
//
//   node gateway/scripts/invite.mjs create "Name one" "Name two"   make one code for each name
//   node gateway/scripts/invite.mjs list                           codes with today's use
//   node gateway/scripts/invite.mjs revoke 12                      stop code 12
//   node gateway/scripts/invite.mjs restore 12                     let code 12 work again
//
// It reads MOONDOG_GATEWAY_ADMIN_TOKEN, and MOONDOG_GATEWAY_URL when the gateway is elsewhere.
// A code is printed once, when it is made: the gateway keeps only its hash.

const base = (process.env.MOONDOG_GATEWAY_URL ?? "https://moondog-api.audiofool.ai").replace(/\/+$/u, "");
const token = process.env.MOONDOG_GATEWAY_ADMIN_TOKEN;
const [command, ...rest] = process.argv.slice(2);

async function call(path, method = "GET", body) {
  const reply = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await reply.json().catch(() => ({}));
  if (!reply.ok) throw new Error(data.error?.message ?? `The gateway answered ${reply.status}.`);
  return data;
}

const millions = (tokens) => `${(tokens / 1e6).toFixed(2)}M`;

try {
  if (!token) throw new Error("Set MOONDOG_GATEWAY_ADMIN_TOKEN first.");
  if (command === "create" && rest.length > 0) {
    const { invites } = await call("/admin/invites", "POST", { labels: rest });
    for (const invite of invites) console.log(`${invite.id}\t${invite.label}\t${invite.code}\t${base}/invite/${invite.code}`);
  } else if (command === "list") {
    const { day, invites } = await call("/admin/invites");
    console.log(`Day ${day} (Beijing time)`);
    for (const invite of invites) {
      console.log(`${invite.id}\t${invite.status}\t${millions(invite.input_today + invite.output_today)} today\t${invite.requests_today} requests\t${millions(invite.tokens_total)} in all\t${invite.label}`);
    }
  } else if ((command === "revoke" || command === "restore") && /^\d+$/u.test(rest[0] ?? "")) {
    const result = await call(`/admin/invites/${rest[0]}/${command}`, "POST");
    console.log(`${result.id}\t${result.status}`);
  } else {
    console.error("Usage: invite.mjs create <name>... | list | revoke <id> | restore <id>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
