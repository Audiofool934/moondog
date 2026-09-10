import {
  createListenerCorrection,
  createListenerCorrectionRetraction,
  listenerCorrectionTargetKey,
} from "../profile/listener-corrections.mjs";
import { createPublicTasteprintDemoProfile } from "./moondog-tasteprint-demo.mjs";

const DEMO_SUBJECT_ID = "70000000-0000-4000-8000-000000000001";

function demoCorrectionError(code, message) {
  const error = new Error(message);
  error.name = "ListenerCorrectionError";
  error.code = code;
  return error;
}

function activeAssertions(records) {
  const retracted = new Set(
    records
      .filter((record) => record.operation === "retract")
      .map((record) => record.retracts_taste_event_id),
  );
  const superseded = new Set(
    records
      .filter((record) => record.operation === "assert")
      .map((record) => record.supersedes_taste_event_id)
      .filter(Boolean),
  );
  return records
    .filter(
      (record) =>
        record.operation === "assert" &&
        !retracted.has(record.taste_event_id) &&
        !superseded.has(record.taste_event_id),
    )
    .sort((left, right) => {
      const time = right.recorded_at.localeCompare(left.recorded_at);
      return time || right.taste_event_id.localeCompare(left.taste_event_id);
    });
}

function publicCorrection(record) {
  const artistCredit = record.extensions?.["moondog.artist_credit"];
  return {
    correction_id: record.taste_event_id,
    state: "active",
    entity_type: record.target.entity_type,
    label: record.target.label,
    ...(artistCredit ? { artist_credit: artistCredit } : {}),
    stance: record.signal_type === "avoidance" ? "avoid" : "like",
    occurred_at: record.occurred_at,
    ...(record.note ? { note: record.note } : {}),
  };
}

function projectedAssertion(record) {
  const correction = publicCorrection(record);
  return {
    correction_id: correction.correction_id,
    evidence_id: correction.correction_id,
    entity_type: correction.entity_type,
    label: correction.label,
    ...(correction.artist_credit
      ? { artist_credit: correction.artist_credit }
      : {}),
    stance: correction.stance,
    strength: 1,
    asserted_at: correction.occurred_at,
    ...(correction.note ? { note: correction.note } : {}),
  };
}

function normalizedText(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("und").trim();
}

function strongPreferenceAvoided(item, avoids) {
  const label = normalizedText(item.label);
  return avoids.some((avoid) => {
    if (normalizedText(avoid.label) !== label) return false;
    if (avoid.entity_type === "track") return true;
    return /artist/iu.test(item.signal ?? "");
  });
}

function behaviorTrackAvoided(item, avoids) {
  const label = normalizedText(item?.label);
  const artist = normalizedText(item?.artist_credit);
  return avoids.some((avoid) => {
    if (avoid.entity_type === "artist") {
      return artist && artist === normalizedText(avoid.label);
    }
    if (avoid.entity_type !== "track" || label !== normalizedText(avoid.label)) {
      return false;
    }
    return !avoid.artist_credit ||
      artist === normalizedText(avoid.artist_credit);
  });
}

function directPreference(assertion, kind) {
  return {
    label: assertion.artist_credit
      ? `${assertion.label} / ${assertion.artist_credit}`
      : assertion.label,
    signal: `Direct ${kind === "demo" ? "demo" : "session"} ${assertion.entity_type} preference`,
  };
}

export class InteractiveTasteprintDemoSession {
  #records = [];
  #baseProfileFactory;
  #kind;

  constructor({
    baseProfileFactory = createPublicTasteprintDemoProfile,
    kind = "demo",
  } = {}) {
    if (typeof baseProfileFactory !== "function") {
      throw new TypeError("The interactive demo profile factory is invalid.");
    }
    if (!new Set(["demo", "private_session"]).has(kind)) {
      throw new TypeError("The interactive profile session kind is invalid.");
    }
    this.#baseProfileFactory = baseProfileFactory;
    this.#kind = kind;
  }

  get activeCount() {
    return activeAssertions(this.#records).length;
  }

  corrections() {
    return activeAssertions(this.#records).map(publicCorrection);
  }

  profile() {
    const profile = this.#baseProfileFactory();
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new TypeError("The interactive demo base profile is invalid.");
    }
    const active = activeAssertions(this.#records).map(projectedAssertion);
    const preferences = active.filter((item) => item.stance === "like");
    const avoids = active.filter((item) => item.stance === "avoid");
    const assertions = this.#records.filter(
      (record) => record.operation === "assert",
    ).length;
    const retractions = this.#records.filter(
      (record) => record.operation === "retract",
    ).length;
    profile.coverage = {
      ...profile.coverage,
      listener_assertion_events: assertions,
      active_listener_assertions: active.length,
      listener_retractions: retractions,
    };
    profile.listener_assertions = {
      active,
      preferences,
      avoids,
      retractions,
    };
    profile.strong_preferences = [
      ...preferences.map((item) => directPreference(item, this.#kind)),
      ...profile.strong_preferences.filter(
        (item) => !strongPreferenceAvoided(item, avoids),
      ),
    ].slice(0, 10);
    profile.curated_preferences = {
      ...profile.curated_preferences,
      avoids: avoids.map((item) => ({
        entity_type: item.entity_type,
        label: item.label,
        ...(item.artist_credit
          ? { artist_credit: item.artist_credit }
          : {}),
        stance: "avoid",
      })),
    };
    if (profile.listening_behavior) {
      // Refilter every listen-again selection from the original bounded profile.
      // Descriptive history remains evidence even when the listener avoids it.
      // Retraction restores the original candidates without inventing replacements.
      profile.listening_behavior = { ...profile.listening_behavior };
      for (const key of [
        "rediscovery_tracks",
        "time_capsule_tracks",
        "historical_return_tracks",
        "back_to_back_tracks",
      ]) {
        const candidates = profile.listening_behavior[key];
        if (Array.isArray(candidates)) {
          profile.listening_behavior[key] = candidates.filter(
            (item) => !behaviorTrackAvoided(item, avoids),
          );
        }
      }
    }
    profile.limitations = [
      this.#kind === "demo"
        ? "Interactive demo corrections exist only in this Studio process and disappear when it stops."
        : "Session-only corrections exist only in this Studio process and disappear when it stops.",
      ...profile.limitations,
    ].slice(0, 8);
    return profile;
  }

  record({
    entityType,
    label,
    artistCredit,
    stance,
    note,
    occurredAt,
    recordedAt = occurredAt,
  } = {}) {
    const initial = createListenerCorrection({
      subjectId: DEMO_SUBJECT_ID,
      entityType,
      label,
      artistCredit,
      stance,
      note,
      occurredAt,
      recordedAt,
    });
    const previous = activeAssertions(this.#records).find(
      (record) => listenerCorrectionTargetKey(record) === initial.targetKey,
    );
    const value = previous
      ? createListenerCorrection({
          subjectId: DEMO_SUBJECT_ID,
          entityType,
          label,
          artistCredit,
          stance,
          note,
          occurredAt,
          recordedAt,
          correctionId: initial.record.taste_event_id,
          supersedesCorrectionId: previous.taste_event_id,
        })
      : initial;
    this.#records.push(value.record);
    return publicCorrection(value.record);
  }

  retract({
    correctionId,
    occurredAt,
    recordedAt = occurredAt,
  } = {}) {
    const assertion = this.#records.find(
      (record) =>
        record.operation === "assert" &&
        record.taste_event_id === correctionId?.toLocaleLowerCase("en-US"),
    );
    if (!assertion) {
      throw demoCorrectionError(
        "listener_correction_not_found",
        this.#kind === "demo"
          ? "The demo listener correction was not found."
          : "The session-only listener correction was not found.",
      );
    }
    if (
      !activeAssertions(this.#records).some(
        (record) => record.taste_event_id === assertion.taste_event_id,
      )
    ) {
      throw demoCorrectionError(
        "listener_correction_inactive",
        this.#kind === "demo"
          ? "Only an active demo listener correction can be retracted."
          : "Only an active session-only listener correction can be retracted.",
      );
    }
    const retraction = createListenerCorrectionRetraction({
      subjectId: DEMO_SUBJECT_ID,
      retractsCorrectionId: assertion.taste_event_id,
      occurredAt,
      recordedAt,
    });
    this.#records.push(retraction);
    return {
      state: "retracted",
      correction_id: assertion.taste_event_id,
      retraction_id: retraction.taste_event_id,
      entity_type: assertion.target.entity_type,
      label: assertion.target.label,
    };
  }
}
