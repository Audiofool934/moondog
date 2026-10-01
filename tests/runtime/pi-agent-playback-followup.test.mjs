import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { MoondogApplication } from "../../src/core/moondog-application.mjs";
import { createSyntheticDomainServices } from "../../src/core/synthetic-domain-services.mjs";
import { createSpotifyWebApiClient } from "../../src/integrations/spotify/web-api-client.mjs";
import { createSpotifyService } from "../../src/integrations/spotify/service.mjs";
import { PiAgentRuntime } from "../../src/runtime/pi/agent-runtime.mjs";

const tool = (args) => fauxAssistantMessage([fauxToolCall("moondog_spotify_player_control", { action: "resume", ...args })], { stopReason: "toolUse" });
const answer = (text = "已发送播放请求。") => fauxAssistantMessage([fauxText(text)]);
const song = (id, name, artists, duration_ms) => ({ id, uri: `spotify:track:${id}`, type: "track", name,
  artists: artists.map(name => ({ name })), album: { name: "Fictional Record" }, duration_ms });
// Reported public titles, entirely fictional provider identities and transport.
const songs = [song("fictionalLiu", "天長地久", ["刘森"], 367_000),
  song("fictionalDJ1", "精卫（关中王进行曲）-DJ版", ["DJ罐头鱼"], 151_000),
  song("fictionalDJ2", "精卫（万物终归向海）-DJ铁柱版", ["银翼杀手", "DJ铁柱"], 140_000),
  song("fictionalDJ3", "精卫-Remix版", ["DJ达苏deep"], 321_000)];

function fixture(t, { status = 204, cancelOnWrite = false } = {}) {
  const writes = [];
  const client = createSpotifyWebApiClient({ tokenProvider: async () => "FICTIONAL_TOKEN",
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      if (init.method !== "GET") {
        writes.push({ path: parsed.pathname, body: JSON.parse(init.body ?? "null") });
        if (cancelOnWrite) runtime.abort();
        return status === 204 ? new Response(null, { status }) : Response.json({ error: { status, message: "PRIVATE_ERROR" } }, { status });
      }
      if (parsed.pathname === "/v1/search") return Response.json({ tracks: { items: parsed.searchParams.get("q").includes("刘森") ? [songs[0]] : songs.slice(1) } });
      if (parsed.pathname === "/v1/me/player/devices") return Response.json({ devices: [{ id: "fictionalDevice", name: "Fictional speaker", type: "Speaker", is_active: true, is_restricted: false, supports_volume: true }] });
      if (parsed.pathname === "/v1/me/player") return Response.json({ is_playing: false });
      throw new Error(`Unexpected fixture request: ${parsed.pathname}`);
    } });
  const application = new MoondogApplication({ importsRoot: "/private/moondog-synthetic-missing-source",
    domainServices: createSyntheticDomainServices({ subjectScope: { subjectId: "synthetic-followup" } }),
    spotifyConnection: { ready: () => true, missingScopes: () => [], publicStatus: () => ({ provider: "spotify", state: "ready" }),
      service: createSpotifyService({ client }) } });
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const runtime = new PiAgentRuntime({ application, models, model: faux.getModel(), provider: "faux", modelId: "faux-1" });
  t.after(() => application.close());
  const prompt = async (text, responses) => { faux.setResponses(responses); return runtime.prompt(text); };
  const search = async (query = "精卫 DJ") => {
    let items;
    await prompt(query.includes("刘森") ? "找刘森的天长地久" : "我想听国风dj曲目精卫", [
      fauxAssistantMessage([fauxToolCall("moondog_spotify_search", { query })], { stopReason: "toolUse" }), context => {
        const result = context.messages.filter(m => m.role === "toolResult" && m.toolName === "moondog_spotify_search").at(-1);
        items = JSON.parse(result.content[0].text).items;
        return answer("找到可供选择的歌曲。");
      }]);
    return items;
  };
  return { application, runtime, faux, writes, prompt, search };
}

for (const source of ["item_ref_id", "uri", "track_refs"]) {
  test(`reported Chinese follow-up retains selection through lyrics with ${source}`, async t => {
    const f = fixture(t);
    const [liu] = await f.search("刘森 天长地久");
    await f.prompt("播放一首刘森的“天长地久”", [tool({ item_ref_id: liu.item_ref_id }), answer()]);
    await f.prompt("歌词呢？", [answer("可以聊聊歌词。")]);
    const items = await f.search();
    await f.prompt("这首有什么特点？", [answer("可以比较几个版本。")]);
    const selected = items[1];
    const value = source === "track_refs" ? [selected.track_ref_id] : selected.item_ref_id;
    const result = await f.prompt("来一个你看着顺眼的", [context => {
      assert.ok(JSON.stringify(context.messages).includes(selected.item_ref_id));
      return tool({ [source]: value });
    }, answer()]);
    assert.equal(result.status, "completed");
    assert.equal(result.spotify_write_receipts[0].state, "accepted");
    assert.deepEqual(f.writes.map(write => write.body), [{ uris: [songs[0].uri] }, { uris: [songs[2].uri] }]);
    await f.prompt("DJ铁柱版来一个", [tool({ item_ref_id: selected.item_ref_id }), answer()]);
    assert.equal(f.writes.length, 3); // A new explicit instruction is a new action.
    assert.deepEqual(f.writes.at(-1).body, { uris: [songs[2].uri] });
  });
}

test("a local invalid URI permits a corrected call in the same turn and never claims uncertainty", async t => {
  const f = fixture(t); const [, item] = await f.search();
  const result = await f.prompt("来一个你看着顺眼的", [tool({ uri: `spotify:track:${item.item_ref_id}` }),
    context => {
      const failure = context.messages.filter(m => m.role === "toolResult").at(-1);
      assert.match(JSON.stringify(failure), /No Spotify write was dispatched/u);
      return tool({ item_ref_id: item.item_ref_id });
    }, answer("已播放DJ铁柱版。")]);
  assert.equal(f.writes.length, 1);
  assert.equal(result.spotify_playback_failures[0].not_sent, true);
  assert.equal(result.spotify_playback_failures[0].outcome_unknown, false);
  assert.equal(result.spotify_write_receipts[0].state, "accepted");
  assert.doesNotMatch(result.text, /未获确认|不确定/u);
});

test("misplaced exact references resolve, and a second model call cannot replay that accepted selection", async t => {
  const f = fixture(t); const [, item] = await f.search();
  const result = await f.prompt("来一个你看着顺眼的", [tool({ uri: item.item_ref_id }),
    tool({ track_refs: [item.track_ref_id] }), answer()]);
  assert.equal(f.writes.length, 1);
  assert.equal(result.spotify_playback_failures[0].code, "spotify_playback_already_accepted");
  assert.equal(result.spotify_write_receipts[0].state, "accepted");
  assert.doesNotMatch(result.text, /未获确认|不确定|本地被拒绝/u);
});

test("two locally rejected model calls send no requests, and a fresh explicit selection works", async t => {
  const f = fixture(t); const [, item] = await f.search();
  const result = await f.prompt("来一个你看着顺眼的", [tool({ uri: "not-a-uri" }), tool({ uri: "also-not-a-uri" }), answer("错误地声称播放了。")]);
  assert.equal(f.writes.length, 0);
  assert.equal(result.spotify_playback_failures.length, 2);
  assert.ok(result.spotify_playback_failures.every(f => f.not_sent && !f.outcome_unknown));
  assert.match(result.text, /本地被拒绝.*没有向 Spotify 发送播放请求/u);
  assert.doesNotMatch(result.text, /设备|未获确认|不确定|错误地声称/u);
  await f.prompt("DJ铁柱版来一个", [tool({ item_ref_id: item.item_ref_id }), answer()]);
  assert.equal(f.writes.length, 1);
});

for (const status of [400, 503]) {
  test(`local correction followed by actual HTTP ${status} keeps the no-replay boundary`, async t => {
    const f = fixture(t, { status }); const [, item] = await f.search();
    const result = await f.prompt("来一个你看着顺眼的", [tool({ uri: "invalid" }), tool({ item_ref_id: item.item_ref_id }),
      tool({ item_ref_id: item.item_ref_id }), tool({ action: "next" }), answer()]);
    assert.equal(f.writes.length, 1);
    assert.ok(result.spotify_playback_failures.some(f => f.status === status && !f.not_sent));
    assert.match(result.text, new RegExp(`HTTP ${status}`, "u"));
    if (status === 503) assert.equal(result.spotify_write_receipts[0].state, "unknown");
  });
}

for (const cancelOnWrite of [false, true]) {
  test(`cancellation ${cancelOnWrite ? "after accepted dispatch" : "before dispatch"} preserves actual effects`, async t => {
    const f = fixture(t, { cancelOnWrite }); const [item] = await f.search();
    if (!cancelOnWrite) {
      const controller = new AbortController(); controller.abort();
      assert.throws(() => f.application.spotifyControl({ action: "resume", itemRefId: item.item_ref_id }, { signal: controller.signal }), { name: "AbortError" });
      assert.equal(f.writes.length, 0);
    } else {
      const result = await f.prompt("播放选择的歌", [tool({ item_ref_id: item.item_ref_id }), answer()]);
      assert.equal(result.status, "aborted");
      assert.equal(result.spotify_write_receipts[0].state, "accepted");
      assert.equal(f.writes.length, 1);
    }
  });
}

for (const invalidate of ["replacement", "session-reset"]) {
  test(`a reference expired by ${invalidate} and a forged reference cannot select playback`, async t => {
    const f = fixture(t); const [item] = await f.search();
    if (invalidate === "replacement") await f.search("another lookup");
    else f.runtime.reset();
    const result = await f.prompt("播放刚才的歌", [tool({ item_ref_id: item.item_ref_id }),
      tool({ item_ref_id: "00000000-0000-4000-8000-000000000000" }), answer()]);
    assert.equal(f.writes.length, 0);
    assert.ok(result.spotify_playback_failures.every(f => f.not_sent));
    assert.match(result.text, /spotify_item_not_available/u);
  });
}

for (const supplied of ["spotify:track:fictionalUser", "https://open.spotify.com/intl-zh/track/fictionalUser?si=fictional"]) {
  test(`an explicit user target is accepted: ${supplied}`, async t => {
    const f = fixture(t);
    const result = await f.prompt(`播放 ${supplied}`, [tool({ uri: supplied }), answer()]);
    assert.equal(result.spotify_write_receipts[0].state, "accepted");
    assert.deepEqual(f.writes[0].body, { uris: ["spotify:track:fictionalUser"] });
  });
}

test("syntactically valid invented provider IDs and conflicting source fields are rejected locally", async t => {
  const f = fixture(t); const [item] = await f.search();
  const result = await f.prompt("来一个你看着顺眼的", [tool({ uri: "spotify:track:invented" }),
    tool({ uri: songs[1].uri, item_ref_id: item.item_ref_id }), answer()]);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(result.spotify_playback_failures.map(f => f.code), ["spotify_playback_source_untrusted", "spotify_playback_source_conflict"]);
});

test("a later local rejection cannot hide behind an earlier accepted playback receipt", async t => {
  const f = fixture(t); const [item] = await f.search();
  const result = await f.prompt("先播放第一首，再播放另一首", [tool({ item_ref_id: item.item_ref_id }), tool({ uri: "invalid" }), answer()]);
  assert.equal(f.writes.length, 1);
  assert.match(result.text, /Spotify 已接受/u);
  assert.match(result.text, /本地被拒绝/u);
});

for (const pasted of ["spotify:track:fictionalUser_other", "https://open.spotify.com/track/fictionalUser-other"]) {
  test(`a malformed pasted target never authorizes its valid prefix: ${pasted}`, async t => {
    const f = fixture(t);
    const result = await f.prompt(`播放 ${pasted}`, [tool({ uri: "spotify:track:fictionalUser" }), answer()]);
    assert.equal(f.writes.length, 0);
    assert.equal(result.spotify_playback_failures[0].code, "spotify_playback_source_untrusted");
  });
}

test("success for a different selection cannot erase an earlier locally rejected attempt", async t => {
  const f = fixture(t); const [first, second] = await f.search();
  const result = await f.prompt("播放第一个版本，再播放第二个版本", [tool({ uri: `spotify:track:${first.item_ref_id}` }),
    tool({ item_ref_id: second.item_ref_id }), answer("两个版本都播放了。")]);
  assert.equal(f.writes.length, 1);
  assert.match(result.text, /本地被拒绝/u);
  assert.match(result.text, /Spotify 已接受/u);
  assert.doesNotMatch(result.text, /两个版本都播放了/u);
});

test("changing settings cannot turn a second model call into another accepted playback write", async t => {
  const f = fixture(t); const [item] = await f.search();
  const result = await f.prompt("播放第一首并开启随机播放", [tool({ item_ref_id: item.item_ref_id }),
    tool({ action: "shuffle", state: true }), tool({ item_ref_id: item.item_ref_id }), answer()]);
  assert.equal(f.writes.filter(write => write.path === "/v1/me/player/play").length, 1);
  assert.equal(result.spotify_write_receipts.length, 2);
});

test("a locally rejected device selector can be corrected before the first playback write", async t => {
  const f = fixture(t); const [item] = await f.search();
  const result = await f.prompt("Play that on Fictional speaker", [tool({ item_ref_id: item.item_ref_id, device_name: "Unknown device" }),
    tool({ item_ref_id: item.item_ref_id, device_name: "Fictional speaker" }), answer()]);
  assert.equal(f.writes.length, 1);
  assert.equal(result.spotify_playback_failures[0].not_sent, true);
  assert.equal(result.spotify_write_receipts[0].state, "accepted");
});
