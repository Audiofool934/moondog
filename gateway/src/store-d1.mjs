// Invites and daily token counts in Cloudflare D1. See ../schema.sql.

const inviteFrom = (row) => row && {
  id: row.id,
  label: row.label,
  status: row.status,
  dailyTokenLimit: row.daily_token_limit,
  expiresAt: row.expires_at,
};

export function createD1Store(database) {
  return {
    async lookup(hash, day) {
      const [invite, total] = await database.batch([
        database.prepare(
          "SELECT i.*, COALESCE(u.input_tokens + u.output_tokens, 0) AS used FROM invites i LEFT JOIN usage u ON u.invite_id = i.id AND u.day = ?2 WHERE i.code_hash = ?1",
        ).bind(hash, day),
        database.prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM usage WHERE day = ?1").bind(day),
      ]);
      const row = invite.results[0] ?? null;
      return { invite: inviteFrom(row), used: row?.used ?? 0, totalUsed: total.results[0]?.total ?? 0 };
    },

    async addUsage(inviteId, day, { input, output }) {
      await database.prepare(
        "INSERT INTO usage (invite_id, day, input_tokens, output_tokens, requests) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT (invite_id, day) DO UPDATE SET input_tokens = input_tokens + ?3, output_tokens = output_tokens + ?4, requests = requests + 1",
      ).bind(inviteId, day, input, output).run();
    },

    async createInvite({ hash, label, dailyTokenLimit, expiresAt, createdAt }) {
      const result = await database.prepare(
        "INSERT INTO invites (code_hash, label, status, daily_token_limit, expires_at, created_at) VALUES (?1, ?2, 'active', ?3, ?4, ?5)",
      ).bind(hash, label, dailyTokenLimit, expiresAt, createdAt).run();
      return result.meta.last_row_id;
    },

    async listInvites(day) {
      const { results } = await database.prepare(
        "SELECT i.id, i.label, i.status, i.daily_token_limit, i.expires_at, i.created_at, COALESCE(u.input_tokens, 0) AS input_today, COALESCE(u.output_tokens, 0) AS output_today, COALESCE(u.requests, 0) AS requests_today, COALESCE(t.tokens, 0) AS tokens_total FROM invites i LEFT JOIN usage u ON u.invite_id = i.id AND u.day = ?1 LEFT JOIN (SELECT invite_id, SUM(input_tokens + output_tokens) AS tokens FROM usage GROUP BY invite_id) t ON t.invite_id = i.id ORDER BY i.id",
      ).bind(day).all();
      return results;
    },

    async setStatus(id, status) {
      const result = await database.prepare("UPDATE invites SET status = ?2 WHERE id = ?1").bind(id, status).run();
      return result.meta.changes > 0;
    },
  };
}
