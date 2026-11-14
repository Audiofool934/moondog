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
    async createInvite({ hash, label, dailyTokenLimit, expiresAt }) {
      invites.push({ id: invites.length + 1, hash, label, status: "active", dailyTokenLimit, expiresAt });
      return invites.length;
    },
    async listInvites() {
      return invites.map(({ hash, ...shown }) => shown);
    },
    async setStatus(id, status) {
      const invite = invites.find((entry) => entry.id === id);
      if (invite) invite.status = status;
      return Boolean(invite);
    },
  };
}
