import { randomUUID } from "node:crypto";
import { lyricSeedsFromProfile } from "./lyric-profile.mjs";

import { isUuid } from "./uuid-v5.mjs";
import { createListeningHistoryProfileProjection } from "../profile/spotify-archive-taste.mjs";

const PROFILE_DEFAULT_ITEMS = 6;
const PROFILE_MAX_ITEMS = 10;
const HISTORY_DEFAULT_ITEMS = 6;
const HISTORY_MAX_ITEMS = 12;
const CANDIDATE_SETS_MAX = 8;
const SPOTIFY_TRACK_ID = /^[A-Za-z0-9]{22}$/u;
const historySupportSignals = new Set([
  "explicit listener preference",
  "saved-library state",
  "private playlist curation",
  "historical attention only",
]);
const backToBackSignals = new Set(["adjacent retained plays"]);

function modelArguments(value, allowedKeys) {
  const input = value ?? {};
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowedKeys.has(key))
  ) {
    throw new TypeError("Profile service arguments are invalid");
  }
  return input;
}

function boundedItems(value) {
  if (value === undefined) return PROFILE_DEFAULT_ITEMS;
  if (!Number.isInteger(value) || value < 1 || value > PROFILE_MAX_ITEMS) {
    throw new TypeError("Profile service limit is invalid");
  }
  return value;
}

function boundedHistoryItems(value, minimum = 1) {
  if (value === undefined) return HISTORY_DEFAULT_ITEMS;
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > HISTORY_MAX_ITEMS
  ) {
    throw new TypeError("Listening-history candidate limit is invalid");
  }
  return value;
}

function cleanText(value, maximum, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Array.from(value.trim()).length > maximum
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.trim();
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function safeTimestamp(value, label) {
  const cleaned = cleanText(value, 64, label);
  const parsed = Date.parse(cleaned);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== cleaned) {
    throw new TypeError(`${label} is invalid`);
  }
  return cleaned;
}

function safeExternalRefs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1) {
    throw new TypeError("Listening-history provider identity is invalid");
  }
  return value.map((reference) => {
    if (
      !reference ||
      typeof reference !== "object" ||
      Array.isArray(reference) ||
      reference.system !== "spotify" ||
      reference.entity_type !== "spotify.track" ||
      typeof reference.external_id !== "string" ||
      !SPOTIFY_TRACK_ID.test(reference.external_id)
    ) {
      throw new TypeError("Listening-history provider identity is invalid");
    }
    return {
      system: "spotify",
      entity_type: "spotify.track",
      external_id: reference.external_id,
    };
  });
}

function safeHistoryTrack(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.candidate_scope !== "private_history" ||
    !isUuid(value.track_ref_id)
  ) {
    throw new TypeError("Listening-history candidate is invalid");
  }
  const hasRediscovery =
    value.rediscovery &&
    typeof value.rediscovery === "object" &&
    !Array.isArray(value.rediscovery);
  const hasTimeCapsule =
    value.time_capsule &&
    typeof value.time_capsule === "object" &&
    !Array.isArray(value.time_capsule);
  const hasHistoricalReturn =
    value.historical_return &&
    typeof value.historical_return === "object" &&
    !Array.isArray(value.historical_return);
  const hasBackToBack =
    value.back_to_back &&
    typeof value.back_to_back === "object" &&
    !Array.isArray(value.back_to_back);
  if (
    [
      hasRediscovery,
      hasHistoricalReturn,
      hasTimeCapsule,
      hasBackToBack,
    ].filter(Boolean).length !== 1
  ) {
    throw new TypeError("Listening-history candidate context is invalid");
  }
  if (!new Set(["resolved", "provisional"]).has(value.identity_status)) {
    throw new TypeError("Listening-history candidate identity is invalid");
  }
  const playCount = safeCount(
    value.observation_summary?.familiarity?.play_count,
    "Listening-history play count",
  );
  const track = {
    track_ref_id: value.track_ref_id.toLowerCase(),
    title: cleanText(value.title, 512, "Listening-history title"),
    artist_credit: cleanText(
      value.artist_credit,
      512,
      "Listening-history artist",
    ),
    release: cleanText(value.release, 512, "Listening-history release"),
    candidate_scope: "private_history",
    identity_status: value.identity_status,
    labels: { genres: [] },
    observation_summary: {
      preference_signals: [],
      familiarity: {
        level:
          playCount >= 20 ? "high" : playCount >= 5 ? "medium" : "low",
        basis: "effective_listening_history",
        play_count: playCount,
      },
    },
  };
  if (hasRediscovery) {
    const context = value.rediscovery;
    if (!isUuid(context.evidence_id)) {
      throw new TypeError("Listening-history evidence is invalid");
    }
    const rediscoverySignal = cleanText(
      context.rediscovery_signal,
      128,
      "Rediscovery signal",
    );
    if (!historySupportSignals.has(rediscoverySignal)) {
      throw new TypeError("Rediscovery signal is invalid");
    }
    track.rediscovery = {
      listening_minutes: safeCount(
        context.listening_minutes,
        "Rediscovery listening minutes",
      ),
      engaged_play_count: safeCount(
        context.engaged_play_count,
        "Rediscovery engaged plays",
      ),
      explicit_skips: safeCount(
        context.explicit_skips,
        "Rediscovery skips",
      ),
      first_played_at: safeTimestamp(
        context.first_played_at,
        "Rediscovery first play",
      ),
      last_played_at: safeTimestamp(
        context.last_played_at,
        "Rediscovery last play",
      ),
      quiet_days: safeCount(context.quiet_days, "Rediscovery quiet days"),
      rediscovery_signal: rediscoverySignal,
      ...(Number.isSafeInteger(context.peak_year)
        ? {
            peak_year: safeCount(context.peak_year, "Rediscovery peak year"),
            peak_year_play_count: safeCount(
              context.peak_year_play_count,
              "Rediscovery peak-year plays",
            ),
            peak_year_listening_minutes: safeCount(
              context.peak_year_listening_minutes,
              "Rediscovery peak-year minutes",
            ),
          }
        : {}),
      evidence_id: context.evidence_id.toLowerCase(),
    };
  } else if (hasHistoricalReturn) {
    const context = value.historical_return;
    const returnCount = safeCount(
      context.return_count,
      "Historical-return count",
    );
    const longestGapDays = safeCount(
      context.longest_gap_days,
      "Historical-return longest gap",
    );
    const latestReturnGapDays = safeCount(
      context.latest_return_gap_days,
      "Historical-return latest gap",
    );
    const historicalReturnSignal = cleanText(
      context.historical_return_signal,
      128,
      "Historical-return signal",
    );
    const firstPlayedAt = safeTimestamp(
      context.first_played_at,
      "Historical-return first play",
    );
    const lastPlayedAt = safeTimestamp(
      context.last_played_at,
      "Historical-return last play",
    );
    const latestReturnAt = safeTimestamp(
      context.latest_return_at,
      "Historical-return latest return",
    );
    const engagedPlayCount = safeCount(
      context.engaged_play_count,
      "Historical-return engaged plays",
    );
    const explicitSkips = safeCount(
      context.explicit_skips,
      "Historical-return skips",
    );
    if (
      returnCount < 1 ||
      longestGapDays < 1 ||
      latestReturnGapDays < 1 ||
      latestReturnGapDays > longestGapDays ||
      engagedPlayCount > playCount ||
      explicitSkips > playCount ||
      Date.parse(firstPlayedAt) > Date.parse(latestReturnAt) ||
      Date.parse(latestReturnAt) > Date.parse(lastPlayedAt) ||
      !historySupportSignals.has(historicalReturnSignal) ||
      !isUuid(context.evidence_id)
    ) {
      throw new TypeError("Historical-return candidate is invalid");
    }
    track.historical_return = {
      listening_minutes: safeCount(
        context.listening_minutes,
        "Historical-return listening minutes",
      ),
      engaged_play_count: engagedPlayCount,
      explicit_skips: explicitSkips,
      first_played_at: firstPlayedAt,
      last_played_at: lastPlayedAt,
      return_count: returnCount,
      longest_gap_days: longestGapDays,
      latest_return_at: latestReturnAt,
      latest_return_gap_days: latestReturnGapDays,
      historical_return_signal: historicalReturnSignal,
      evidence_id: context.evidence_id.toLowerCase(),
    };
  } else if (hasTimeCapsule) {
    const context = value.time_capsule;
    const year = safeCount(context.year, "Time Machine year");
    if (year < 1900 || year > 9999 || !isUuid(context.evidence_id)) {
      throw new TypeError("Time Machine candidate is invalid");
    }
    track.time_capsule = {
      year,
      year_play_count: safeCount(
        context.year_play_count,
        "Time Machine year plays",
      ),
      year_engaged_play_count: safeCount(
        context.year_engaged_play_count,
        "Time Machine engaged plays",
      ),
      year_listening_minutes: safeCount(
        context.year_listening_minutes,
        "Time Machine year minutes",
      ),
      year_explicit_skips: safeCount(
        context.year_explicit_skips,
        "Time Machine year skips",
      ),
      lifetime_listening_minutes: safeCount(
        context.lifetime_listening_minutes,
        "Time Machine lifetime minutes",
      ),
      representative_signal: cleanText(
        context.representative_signal,
        128,
        "Time Machine signal",
      ),
      evidence_id: context.evidence_id.toLowerCase(),
    };
  } else {
    const context = value.back_to_back;
    const engagedPlayCount = safeCount(
      context.engaged_play_count,
      "Back-to-back engaged plays",
    );
    const explicitSkips = safeCount(
      context.explicit_skips,
      "Back-to-back skips",
    );
    const burstCount = safeCount(
      context.burst_count,
      "Back-to-back burst count",
    );
    const maximumConsecutivePlays = safeCount(
      context.maximum_consecutive_plays,
      "Back-to-back maximum consecutive plays",
    );
    const playsInBursts = safeCount(
      context.plays_in_bursts,
      "Back-to-back plays in bursts",
    );
    const sequenceSignal = cleanText(
      context.sequence_signal,
      128,
      "Back-to-back sequence signal",
    );
    if (
      burstCount < 1 ||
      maximumConsecutivePlays < 2 ||
      playsInBursts < maximumConsecutivePlays ||
      playsInBursts < burstCount * 2 ||
      playsInBursts > playCount ||
      engagedPlayCount > playCount ||
      explicitSkips > playCount ||
      !backToBackSignals.has(sequenceSignal) ||
      !isUuid(context.evidence_id)
    ) {
      throw new TypeError("Back-to-back candidate is invalid");
    }
    track.back_to_back = {
      engaged_play_count: engagedPlayCount,
      explicit_skips: explicitSkips,
      burst_count: burstCount,
      maximum_consecutive_plays: maximumConsecutivePlays,
      plays_in_bursts: playsInBursts,
      listening_minutes_in_bursts: safeCount(
        context.listening_minutes_in_bursts,
        "Back-to-back listening minutes",
      ),
      latest_burst_at: safeTimestamp(
        context.latest_burst_at,
        "Back-to-back latest burst",
      ),
      sequence_signal: sequenceSignal,
      evidence_id: context.evidence_id.toLowerCase(),
    };
  }
  if (
    Number.isSafeInteger(value.duration_ms) &&
    value.duration_ms >= 0 &&
    value.duration_ms <= 86_400_000
  ) {
    track.duration_ms = value.duration_ms;
  }
  const refs = safeExternalRefs(value.external_refs);
  if (refs.length > 0) track.external_refs = refs;
  return track;
}

function publicHistoryTrack(track) {
  const result = structuredClone(track);
  delete result.external_refs;
  return result;
}

export class ListeningProfileDomainServices {
  #store;
  #subjectId;
  #candidateSets = new Map();

  constructor({ listeningHistoryStore, subjectId } = {}) {
    if (
      !listeningHistoryStore ||
      typeof listeningHistoryStore.profileSummary !== "function" ||
      typeof listeningHistoryStore.explainProfileEvidence !== "function" ||
      typeof listeningHistoryStore.subjectDataStatus !== "function"
    ) {
      throw new TypeError("A trusted listening-history store is required");
    }
    if (!isUuid(subjectId)) {
      throw new TypeError("A trusted listening profile subject is required");
    }
    this.#store = listeningHistoryStore;
    this.#subjectId = subjectId.toLowerCase();
  }

  status() {
    return {
      state: "ready",
      adapter: "listening_history_profile",
      subject_scope: "trusted_runtime",
      external_effects: "none",
    };
  }

  profileStatus() {
    const source = this.#store.subjectDataStatus({
      subjectId: this.#subjectId,
    });
    const listening = this.#store.profileSummary({
      subjectId: this.#subjectId,
      maxItems: 1,
    });
    return {
      state: source.state,
      projection_version: "profile-projection/listening-history/1",
      evidence_records:
        source.profile_evidence + source.active_taste_assertions,
      effective_listening_events: source.effective_listening_events,
      listening_hours: listening.coverage.listening_hours,
      spotify_profile_evidence: source.profile_evidence,
      claims: source.active_taste_assertions,
      listening_sources: listening.source.providers ?? [],
      reason:
        "The local profile combines supported private persistent listening-history evidence with current explicit, retractable listener assertions. Apple Music setup is optional.",
    };
  }

  rediscoveryReady() {
    return typeof this.#store.rediscoveryCandidates === "function";
  }

  historicalReturnReady() {
    return typeof this.#store.historicalReturnCandidates === "function";
  }

  timeCapsuleReady() {
    return typeof this.#store.timeCapsuleCandidates === "function";
  }

  backToBackReady() {
    return typeof this.#store.backToBackCandidates === "function";
  }

  playlistReady() {
    return (
      this.rediscoveryReady() ||
      this.historicalReturnReady() ||
      this.timeCapsuleReady() ||
      this.backToBackReady()
    );
  }

  beginPrompt() {
    return this.resetCandidateSets();
  }

  endPrompt() {
    return this.resetCandidateSets();
  }

  resetCandidateSets() {
    const invalidated = this.#candidateSets.size;
    this.#candidateSets.clear();
    return { invalidated_candidate_sets: invalidated };
  }

  #registerHistoryTracks(tracks) {
    if (this.#candidateSets.size >= CANDIDATE_SETS_MAX) {
      throw new Error("The prompt has reached its candidate set limit");
    }
    const prepared = tracks.map(safeHistoryTrack);
    if (
      new Set(prepared.map((track) => track.track_ref_id)).size !==
      prepared.length
    ) {
      throw new TypeError("Listening-history candidates are duplicated");
    }
    const candidateSetId = randomUUID();
    this.#candidateSets.set(
      candidateSetId,
      new Map(
        prepared.map((track) => [track.track_ref_id, structuredClone(track)]),
      ),
    );
    return { candidateSetId, tracks: prepared };
  }

  async getLyricSeeds() {
    return {
      subjectId: this.#subjectId,
      tracks: lyricSeedsFromProfile(this.#store.lyricProfile({ subjectId: this.#subjectId })),
    };
  }

  async getProfileSummary(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["maxItems"]));
    const maxItems = boundedItems(input.maxItems);
    const listening = this.#store.profileSummary({
      subjectId: this.#subjectId,
      maxItems,
    });
    return createListeningHistoryProfileProjection(listening, { maxItems });
  }

  async getRediscoveryCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedHistoryItems(input.limit);
    if (!this.rediscoveryReady()) {
      throw new Error("Listening-history rediscovery is unavailable");
    }
    const raw = this.#store.rediscoveryCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    const tracks = Array.isArray(raw?.tracks) ? raw.tracks : [];
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        reference_date: raw?.reference_date ?? null,
        quiet_days: safeCount(raw?.quiet_days, "Rediscovery quiet days"),
        minimum_plays: safeCount(
          raw?.minimum_plays,
          "Rediscovery minimum plays",
        ),
        minimum_engaged_plays: safeCount(
          raw?.minimum_engaged_plays,
          "Rediscovery minimum engaged plays",
        ),
        minimum_listening_minutes: safeCount(
          raw?.minimum_listening_minutes,
          "Rediscovery minimum minutes",
        ),
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    const registered = this.#registerHistoryTracks(tracks.slice(0, limit));
    return {
      state: "ready",
      candidate_set_id: registered.candidateSetId,
      candidate_scope: "private_history",
      result_count: registered.tracks.length,
      limit_applied: limit,
      reference_date: safeTimestamp(raw.reference_date, "Rediscovery reference date"),
      quiet_days: safeCount(raw.quiet_days, "Rediscovery quiet days"),
      minimum_plays: safeCount(raw.minimum_plays, "Rediscovery minimum plays"),
      minimum_engaged_plays: safeCount(
        raw.minimum_engaged_plays,
        "Rediscovery minimum engaged plays",
      ),
      minimum_listening_minutes: safeCount(
        raw.minimum_listening_minutes,
        "Rediscovery minimum minutes",
      ),
      expires_on: "prompt_end",
      tracks: registered.tracks.map(publicHistoryTrack),
    };
  }

  async getHistoricalReturnCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedHistoryItems(input.limit);
    if (!this.historicalReturnReady()) {
      throw new Error("Listening-history returns are unavailable");
    }
    const raw = this.#store.historicalReturnCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    const tracks = Array.isArray(raw?.tracks) ? raw.tracks : [];
    const common = {
      reference_date: raw?.reference_date ?? null,
      minimum_gap_days: safeCount(
        raw?.minimum_gap_days,
        "Historical-return minimum gap",
      ),
      minimum_plays: safeCount(
        raw?.minimum_plays,
        "Historical-return minimum plays",
      ),
      minimum_engaged_plays: safeCount(
        raw?.minimum_engaged_plays,
        "Historical-return minimum engaged plays",
      ),
      minimum_listening_minutes: safeCount(
        raw?.minimum_listening_minutes,
        "Historical-return minimum minutes",
      ),
    };
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        ...common,
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    const registered = this.#registerHistoryTracks(tracks.slice(0, limit));
    return {
      state: "ready",
      candidate_set_id: registered.candidateSetId,
      candidate_scope: "private_history",
      result_count: registered.tracks.length,
      limit_applied: limit,
      ...common,
      reference_date: safeTimestamp(
        raw.reference_date,
        "Historical-return reference date",
      ),
      expires_on: "prompt_end",
      tracks: registered.tracks.map(publicHistoryTrack),
    };
  }

  async getBackToBackCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedHistoryItems(input.limit);
    if (!this.backToBackReady()) {
      throw new Error("Listening-history back-to-back playback is unavailable");
    }
    const raw = this.#store.backToBackCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    const tracks = Array.isArray(raw?.tracks) ? raw.tracks : [];
    const common = {
      reference_date: raw?.reference_date ?? null,
      minimum_consecutive_plays: safeCount(
        raw?.minimum_consecutive_plays,
        "Back-to-back minimum consecutive plays",
      ),
      minimum_played_seconds: safeCount(
        raw?.minimum_played_seconds,
        "Back-to-back minimum played seconds",
      ),
      maximum_gap_minutes: safeCount(
        raw?.maximum_gap_minutes,
        "Back-to-back maximum gap minutes",
      ),
    };
    if (
      common.minimum_consecutive_plays < 2 ||
      common.minimum_played_seconds < 1 ||
      common.maximum_gap_minutes < 1
    ) {
      throw new TypeError("Back-to-back thresholds are invalid");
    }
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        ...common,
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    const registered = this.#registerHistoryTracks(tracks.slice(0, limit));
    return {
      state: "ready",
      candidate_set_id: registered.candidateSetId,
      candidate_scope: "private_history",
      result_count: registered.tracks.length,
      limit_applied: limit,
      ...common,
      reference_date: safeTimestamp(
        raw.reference_date,
        "Back-to-back reference date",
      ),
      expires_on: "prompt_end",
      tracks: registered.tracks.map(publicHistoryTrack),
    };
  }

  async getTimeCapsuleCandidates(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["limit"]));
    const limit = boundedHistoryItems(input.limit, 2);
    if (!this.timeCapsuleReady()) {
      throw new Error("Listening-history Time Machine is unavailable");
    }
    const raw = this.#store.timeCapsuleCandidates({
      subjectId: this.#subjectId,
      limit,
    });
    const tracks = Array.isArray(raw?.tracks) ? raw.tracks : [];
    const common = {
      reference_date: raw?.reference_date ?? null,
      history_start_year: raw?.history_start_year ?? null,
      history_end_year: raw?.history_end_year ?? null,
      minimum_years: safeCount(raw?.minimum_years, "Time Machine minimum years"),
      minimum_engaged_plays: safeCount(
        raw?.minimum_engaged_plays,
        "Time Machine minimum engaged plays",
      ),
      minimum_listening_minutes: safeCount(
        raw?.minimum_listening_minutes,
        "Time Machine minimum minutes",
      ),
    };
    if (tracks.length === 0) {
      return {
        state: "empty",
        candidate_set_id: null,
        candidate_scope: "private_history",
        result_count: 0,
        limit_applied: limit,
        ...common,
        represented_years: [],
        expires_on: "prompt_end",
        tracks: [],
      };
    }
    const registered = this.#registerHistoryTracks(tracks.slice(0, limit));
    const representedYears = registered.tracks.map(
      (track) => track.time_capsule.year,
    );
    if (
      representedYears.length < common.minimum_years ||
      representedYears.some(
        (year, index) => index > 0 && year <= representedYears[index - 1],
      )
    ) {
      throw new TypeError("Time Machine candidate years are invalid");
    }
    return {
      state: "ready",
      candidate_set_id: registered.candidateSetId,
      candidate_scope: "private_history",
      result_count: registered.tracks.length,
      limit_applied: limit,
      ...common,
      reference_date: safeTimestamp(
        raw.reference_date,
        "Time Machine reference date",
      ),
      represented_years: representedYears,
      expires_on: "prompt_end",
      tracks: registered.tracks.map(publicHistoryTrack),
    };
  }

  async buildPlaylistPlan(argumentsValue) {
    const input = modelArguments(
      argumentsValue,
      new Set([
        "intent",
        "requestedTrackCount",
        "candidateSetIds",
        "trackRefs",
        "orderingNotes",
      ]),
    );
    const intent = cleanText(input.intent, 500, "Playlist intent");
    const orderingNotes = cleanText(
      input.orderingNotes,
      500,
      "Playlist ordering notes",
    );
    if (
      !Number.isInteger(input.requestedTrackCount) ||
      input.requestedTrackCount < 1 ||
      input.requestedTrackCount > HISTORY_MAX_ITEMS ||
      !Array.isArray(input.candidateSetIds) ||
      input.candidateSetIds.length < 1 ||
      input.candidateSetIds.length > CANDIDATE_SETS_MAX ||
      new Set(input.candidateSetIds).size !== input.candidateSetIds.length ||
      !Array.isArray(input.trackRefs) ||
      input.trackRefs.length !== input.requestedTrackCount
    ) {
      throw new TypeError("Playlist plan request is invalid");
    }
    const trusted = new Map();
    for (const candidateSetId of input.candidateSetIds) {
      const set = this.#candidateSets.get(candidateSetId);
      if (!set) throw new Error("A playlist candidate set is unavailable or expired");
      for (const [trackRefId, track] of set) trusted.set(trackRefId, track);
    }
    const selected = input.trackRefs.map((selection) => {
      if (
        !selection ||
        typeof selection !== "object" ||
        Array.isArray(selection) ||
        Object.keys(selection).some(
          (key) => !new Set(["trackRefId", "selectionReason"]).has(key),
        ) ||
        !isUuid(selection.trackRefId)
      ) {
        throw new TypeError("Playlist track selection is invalid");
      }
      const track = trusted.get(selection.trackRefId.toLowerCase());
      if (!track) throw new Error("A playlist track was not returned by a trusted candidate set");
      return {
        track,
        selectionReason: cleanText(
          selection.selectionReason,
          256,
          "Playlist selection reason",
        ),
      };
    });
    if (
      new Set(selected.map(({ track }) => track.track_ref_id)).size !==
      selected.length
    ) {
      throw new TypeError("A playlist plan cannot contain duplicate tracks");
    }
    const tracks = selected.map(({ track, selectionReason }, index) => ({
      position: index + 1,
      track_ref_id: track.track_ref_id,
      title: track.title,
      artist_credit: track.artist_credit,
      release: track.release,
      candidate_scope: "private_history",
      selection_reason: selectionReason,
      ...(track.duration_ms !== undefined
        ? { duration_ms: track.duration_ms }
        : {}),
      history_context: track.time_capsule
        ? { kind: "time_capsule", year: track.time_capsule.year }
        : track.historical_return
          ? { kind: "historical_return" }
          : track.back_to_back
            ? { kind: "back_to_back" }
            : { kind: "rediscovery" },
    }));
    return {
      plan_version: "playlist_plan/0",
      intent,
      requested_track_count: input.requestedTrackCount,
      track_count: tracks.length,
      tracks,
      candidate_scope: "private_history",
      ordering_rationale: orderingNotes,
      candidate_sets_validated: input.candidateSetIds.length,
      persistence: "none",
      external_effects: "none",
    };
  }

  getTrustedTracks(trackRefs) {
    if (
      !Array.isArray(trackRefs) ||
      trackRefs.length < 1 ||
      trackRefs.length > HISTORY_MAX_ITEMS
    ) {
      throw new TypeError("Trusted track references are invalid");
    }
    const tracks = [];
    for (const trackRefId of trackRefs) {
      if (!isUuid(trackRefId)) {
        throw new TypeError("Trusted track references are invalid");
      }
      let found = null;
      for (const set of this.#candidateSets.values()) {
        const candidate = set.get(trackRefId.toLowerCase());
        if (candidate) {
          found = candidate;
          break;
        }
      }
      if (!found) throw new Error("A trusted track reference is unavailable");
      tracks.push(structuredClone(found));
    }
    return tracks;
  }

  registerRetainedPlaylistCandidateSet({ tracks } = {}) {
    if (
      !Array.isArray(tracks) ||
      tracks.length < 1 ||
      tracks.length > HISTORY_MAX_ITEMS
    ) {
      throw new TypeError("Retained playlist candidates are invalid");
    }
    const registered = this.#registerHistoryTracks(tracks);
    return {
      candidate_set_id: registered.candidateSetId,
      candidate_scope: "private_history",
      result_count: registered.tracks.length,
      expires_on: "prompt_end",
      tracks: registered.tracks.map(publicHistoryTrack),
    };
  }

  async explainProfileEvidence(argumentsValue) {
    const input = modelArguments(argumentsValue, new Set(["evidenceId"]));
    if (!isUuid(input.evidenceId)) {
      throw new TypeError("Profile evidence ID is invalid");
    }
    const value = this.#store.explainProfileEvidence({
      subjectId: this.#subjectId,
      evidenceId: input.evidenceId,
    });
    if (!value) {
      throw new Error(
        "Profile evidence is unavailable in the trusted subject scope",
      );
    }
    return value;
  }

  close() {
    this.resetCandidateSets();
    this.#store.close();
  }
}

export function createListeningProfileDomainServices(options) {
  return new ListeningProfileDomainServices(options);
}
