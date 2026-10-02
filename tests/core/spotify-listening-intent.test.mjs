import assert from "node:assert/strict";
import test from "node:test";
import { queueListeningIntent } from "../../src/core/spotify-listening-intent.mjs";

test("queue counts belong to the additive command, in English, Arabic or Chinese", () => {
  for (const [request, count] of [
    ["queue two songs", 2], ["Queue TWELVE tracks.", 12], ["queue two more songs", 2],
    ["queue only two country songs", 2], ["queue two songs by John Denver", 2], ["queue 2 songs", 2], ["queue １２ songs", 12],
    ["add 12 songs to my queue", 12], ["please put two tracks in my queue", 2],
    ["Queue me 2 songs", 2], ["Queue the best 2 songs", 2], ["Add the top 2 tracks to the queue", 2], ["Queue me two DJ songs", 2],
    ["could you place 2 tracks on the queue?", 2], ["queue a song", 1],
    ["great，再来十二首国风DJ，queue", 12], ["把两首歌加入队列", 2],
    ["帮我找两首国风DJ加入队列", 2], ["把刚才推荐的两首歌加入队列", 2],
    ["请加十二首歌到队列", 12], ["加入队列 2 首歌", 2],
    ["Queue has 12 songs already; add two more songs to my queue.", 2],
    ["queue 2 songs, not 12 songs", 2], ["Queue two songs, don’t play anything yet", 2],
  ]) assert.equal(queueListeningIntent(request)?.requested, count, request);
});

test("queue descriptions, questions, negations and bare confirmations cannot grant a batch", () => {
  for (const request of [
    "Queue has 12 songs already.", "Queue contains two songs.", "Queue keeps 12 songs.",
    "Queue doesn’t have two songs.", "The queue already has twelve tracks.",
    "The queue is not a playlist and has 12 songs.", "队列里已经有十二首歌", "我把两首歌加入队列了",
    "Explain why queue needs two songs", "What happens if I queue two songs?", "请问加入队列是什么意思",
    "请告诉我如何加入队列", "请给我解释，如何加入队列", "请告诉我，队列有几首歌",
    "帮我看看加入队列会发生什么", "Please don’t queue two songs", "Do not add two songs to my queue",
    "I do not want you to queue two songs", "Never put two songs in my queue", "不要把两首歌加入队列",
    "queue", "1", "yes", "retry", "确认", "I meant queue, not a playlist",
  ]) assert.equal(queueListeningIntent(request), null, request);
});

test("invalid or ambiguous explicit counts never become an unspecified candidate-pool count", () => {
  for (const request of [
    "queue zero songs", "queue 0 songs", "queue -2 songs", "queue 2.5 songs", "queue .5 songs",
    "queue thirteen songs", "queue twenty-one tracks", "queue 1,000 songs", "queue 二十首", "queue 一百首",
    "queue one hundred songs", "queue one two songs", "queue 两三首", "queue two or three songs",
    "queue two and a half songs", "queue 2-3 songs", "queue 2,3 songs",
    "Queue me two or three songs", "Queue me two and a half songs",
    "queue twelve songs, actually only two", "queue two songs; add three tracks to my queue",
    "Queue songs like this, 2 songs please",
    "queue no songs", "queue nothing", "queue none",
  ]) {
    const count = queueListeningIntent(request)?.requested;
    assert.ok(count != null && (!Number.isInteger(count) || count < 1 || count > 12), `${request}: ${count}`);
  }
});

test("song-title words and genuinely unspecified requests do not invent a count", () => {
  for (const request of ["queue Two Princes by Spin Doctors", "queue Seven Nation Army", "queue some jazz songs", "queue 80s songs"]) {
    assert.equal(queueListeningIntent(request)?.requested, null, request);
  }
});

test("only an explicit queue correction inherits host-retained count and attempted receipt", () => {
  const previous = { requested: 2, request: "queue two unheard songs", excludeKnown: true };
  for (const request of ["I meant queue, not a playlist", "queue, not a playlist", "我要的是queue，不是歌单"]) {
    const intent = queueListeningIntent(request, previous);
    assert.equal(intent.requested, 2); assert.equal(intent.request, previous.request);
    assert.equal(intent.queue_only, true); assert.equal(intent.excludeKnown, true);
    assert.equal(intent.clarification_only, undefined);
    assert.equal(queueListeningIntent(request, { ...previous, attempted: true }).clarification_only, true);
  }
  for (const request of ["yes", "确认", "1", "retry", "The queue is not a playlist and has 12 songs."]) {
    assert.equal(queueListeningIntent(request, previous), null, request);
  }
  assert.equal(queueListeningIntent("queue two songs, don't play anything yet").queue_only, true);
});
