// These parsers read only the actual listener message. Metadata and model tool
// arguments never create a contextual selection or an additional write grant.
const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function number(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  if (/^[一二两三四五六七八九]?十[一二三四五六七八九]?$/u.test(value)) {
    const [tens, ones] = value.split("十");
    return (digits[tens] ?? 1) * 10 + (digits[ones] ?? 0);
  }
  return digits[value] ?? null;
}

export function playbackFollowupIntent(text) {
  if (typeof text !== "string" || text.length > 500) return null;
  const value = text.normalize("NFKC").trim().replace(/[.!。！]+$/u, "");
  const ordinal = value.match(/^(?:(?:play|choose|number)\s*|(?:播放|选|来|第)\s*)?(\d{1,2}|[一二三四五六七八九十])(?:\s*(?:个|首|号|那个|这个|版本))?$/iu);
  if (ordinal) return { kind: "ordinal", ordinal: number(ordinal[1]) };
  if (/^(?:please\s+)?(?:retry|try (?:it )?again|play (?:it )?again|重试|再试(?:一次|一下)?|再来一次)$/iu.test(value)) return { kind: "retry" };
  if (/^(?:换(?:一|另一个|个)|换一个(?:版本)?|另一个版本|换个版本|再换一版)(?:[，,。\s].*|不好听|这(?:个)?版本不好听)?$/u.test(value) ||
      /^(?:try|play|choose|pick|put on) (?:a |an )?(?:different|another) (?:one|version|mix)(?:[,.!\s].*)?$/iu.test(value)) return { kind: "alternative" };
  return null;
}

export function queueListeningIntent(text, previous = null) {
  if (typeof text !== "string" || text.length > 2000) return null;
  const value = text.normalize("NFKC").replace(/[‘’]/gu, "'").trim();
  if (!/\bqueue\b|加入队列|加到队列|放到队列|排进队列/iu.test(value) ||
      /(?:don't|do not|never|stop|cancel)\s+(?:\w+\s+){0,2}queue|(?:不要|别|取消|停止)[^，。!?！？]{0,12}(?:queue|队列)/iu.test(value) ||
      /\b(?:explain|describe|what(?:'s| is)|why|how|whether|tell me about|can i|should i|do i|does|show|inspect|list|read|check)\b.*\bqueue\b|^(?:为什么|怎么|如何|查看|看看|显示|读取|队列里|(?:请|可以|能否)?(?:解释|说明|介绍))/iu.test(value)) return null;
  const count = value.match(/(\d+|[一二两三四五六七八九十]{1,3})\s*(?:首|songs?\b|tracks?\b)/iu) ??
    value.match(/\bqueue\s+(\d+)\b/iu);
  const requested = count ? number(count[1]) : null;
  const correction = /不是歌单|不是.*playlist|not (?:a )?playlist|meant.*queue|要的是.*queue/iu.test(value);
  if (correction && !previous && !count) return null;
  if (!correction && !/^(?:(?:please|can you|could you|would you|will you|i want (?:you )?to|i would like (?:you )?to)\s+)?(?:queue\b|(?:add|put|place)\b.*\b(?:to|in|on)\s+(?:the )?queue\b)|(?:^|[，,。.;；])\s*(?:please\s+)?queue\b|(?:加入|加到|放到|排进)队列|(?:再来|给我|帮我|请|把|将).*(?:queue|队列)/iu.test(value)) return null;
  const affirmative = value.replace(/(?:don't|don’t|do not|never)\s+[^,，.;；]+|(?:不要|别)[^，。;；]+/giu, "");
  return { requested: requested ?? (correction && previous ? previous.requested : null),
    request: correction && previous ? previous.request : value,
    queue_only: correction || !/\b(?:play|resume|pause|skip|next|previous|seek|volume|shuffle|repeat|transfer|save|create|follow|unfollow)\b|播放|暂停|下一首|上一首|音量|切换设备|保存|创建|关注/iu.test(affirmative),
    ...(correction && previous?.attempted ? { clarification_only: true } : {}),
    excludeKnown: /没听过|从未听|不要听过|\bunheard\b|\bnever heard\b/iu.test(value) || (correction && previous?.excludeKnown === true) };
}

export function trackVersionFamily(name) {
  return String(name ?? "").normalize("NFKC").toLocaleLowerCase("en-US")
    .split(/[([（【]|\s[-—–]\s|\b(?:dj|remix|mix|version)\b/iu)[0]
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
