import { createPersistentCredentialStore } from "../../runtime/pi/persistent-credential-store.mjs";

const providerId = "spotify";

export function createSpotifyCredentialStore({
  environment = process.env,
  credentialStore = createPersistentCredentialStore(environment),
} = {}) {
  return {
    async read(options) {
      return credentialStore.read(providerId, options);
    },

    async write(credential, options) {
      return credentialStore.modify(
        providerId,
        async () => ({ type: "oauth", ...credential }),
        options,
      );
    },

    async delete(options) {
      await credentialStore.delete(providerId, options);
    },
  };
}
