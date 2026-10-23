// The Apple Music storefront the catalog searches: the listener's own account's when the desktop
// app's MusicKit helper reports it, otherwise the region of the system's locale, otherwise the US.
// Catalog ids and previews differ between storefronts, so whole songs need the account's one.

const code = (value) => (typeof value === "string" && /^[a-z]{2}$/iu.test(value) ? value.toUpperCase() : null);

function localeRegion() {
  try {
    return code(new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).maximize().region);
  } catch {
    return null;
  }
}

let account = null;

/** The storefront's two-letter country code, upper case, such as "US". */
export function appleMusicStorefront() {
  return account ?? localeRegion() ?? "US";
}

/** Records the listener's account storefront; an invalid code leaves the current one. */
export function setAppleMusicStorefront(value) {
  const valid = code(value);
  if (valid) account = valid;
  return Boolean(valid);
}
