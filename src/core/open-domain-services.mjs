import {
  openAppleProjectionDomainServices,
  resolveAppleMusicSubjectId,
} from "./apple-projection-domain-services.mjs";
import { readAppleMusicSourceStatus } from "./apple-library-source-status.mjs";
import { createListeningProfileDomainServices } from "./listening-profile-domain-services.mjs";
import { openListeningHistoryStore } from "../profile/listening-history-store.mjs";

export async function optionalAppleMusicSubjectId() {
  const source = await readAppleMusicSourceStatus();
  if (source.state === "missing") return null;
  if (source.state === "invalid") {
    const error = new Error("The canonical Apple Music import source is invalid");
    error.code = "projection_source_invalid";
    throw error;
  }
  return resolveAppleMusicSubjectId();
}

function projectionErrorCode(error) {
  return typeof error?.code === "string" &&
    /^projection_[a-z0-9_]+$/u.test(error.code)
    ? error.code
    : null;
}

export async function loadDomainServices() {
  const listeningHistoryStore = await openListeningHistoryStore();
  let domainServicesError = null;
  let subjectId = null;
  try {
    const appleSubjectId = await optionalAppleMusicSubjectId();
    subjectId = listeningHistoryStore.localSubjectId({
      ...(appleSubjectId ? { preferredSubjectId: appleSubjectId } : {}),
    });
    if (appleSubjectId) {
      try {
        return {
          domainServices: await openAppleProjectionDomainServices({
            listeningHistoryStore,
            subjectId: appleSubjectId,
          }),
          domainServicesError: null,
        };
      } catch (error) {
        domainServicesError = projectionErrorCode(error);
        if (!domainServicesError) throw error;
      }
    } else {
      domainServicesError = "projection_subject_unavailable";
    }
  } catch (error) {
    domainServicesError = projectionErrorCode(error);
    if (!domainServicesError) {
      listeningHistoryStore.close();
      throw error;
    }
    subjectId ??= listeningHistoryStore.localSubjectId();
  }

  if (
    subjectId &&
    listeningHistoryStore.subjectDataStatus({ subjectId }).state === "ready"
  ) {
    return {
      domainServices: createListeningProfileDomainServices({
        listeningHistoryStore,
        subjectId,
      }),
      domainServicesError,
    };
  }
  listeningHistoryStore.close();
  return { domainServices: null, domainServicesError };
}
