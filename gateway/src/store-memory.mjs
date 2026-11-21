// The gateway's store held in memory, for tests and the local development server.

export function createMemoryStore() {
  const invites = [];
  const usage = new Map();
  const minutes = new Map();
  const key = (id, day) => `${id} ${day}`;
  return {
    usage,
    async lookup(hash, day) {
      const invite = invites.find((entry) => entry.hash === hash) ?? null;
      const row = invite && usage.get(key(invite.id, day));
      let totalUsed = 0;
      for (const [name, value] of usage) if (name.endsWith(` ${day}`)) totalUsed += value.input + value.output;
      return { invite, used: row ? row.input + row.output : 0, totalUsed };
    },
    async addUsage(id, day, { input, output }) {
      const row = usage.get(key(id, day)) ?? { input: 0, output: 0, requests: 0 };
      usage.set(key(id, day), { input: row.input + input, output: row.output + output, requests: row.requests + 1 });
    },
    async countRequest(id, minute) {
      const name = `${id} ${minute}`;
      minutes.set(name, (minutes.get(name) ?? 0) + 1);
      return minutes.get(name);
    },
    async createInvite({ hash, label, note = "", dailyTokenLimit, expiresAt, createdAt = Date.now() }) {
      invites.push({ id: invites.length + 1, hash, label, note, status: "active", dailyTokenLimit, expiresAt, createdAt });
      return invites.length;
    },
    // The same fields as the D1 store's listing.
    async listInvites(day) {
      return invites.map((invite) => {
        const today = usage.get(key(invite.id, day)) ?? { input: 0, output: 0, requests: 0 };
        let total = 0;
        for (const [name, value] of usage) if (name.startsWith(`${invite.id} `)) total += value.input + value.output;
        return {
          id: invite.id, label: invite.label, note: invite.note, status: invite.status,
          daily_token_limit: invite.dailyTokenLimit, expires_at: invite.expiresAt, created_at: invite.createdAt,
          input_today: today.input, output_today: today.output, requests_today: today.requests, tokens_total: total,
        };
      });
    },
    async editInvite(id, { label, note }) {
      const invite = invites.find((entry) => entry.id === id);
      if (!invite) return false;
      if (label !== undefined) invite.label = label;
      if (note !== undefined) invite.note = note;
      return true;
    },
    async setStatus(id, status) {
      const invite = invites.find((entry) => entry.id === id);
      if (invite) invite.status = status;
      return Boolean(invite);
    },
  };
}
