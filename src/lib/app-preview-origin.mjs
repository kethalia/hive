export const hiveProductionOrigin = "https://hive.kethalia.com";
export const hivePreviewDomain = "hive-preview.kethalia.com";
export const appPreviewPrefix = "/app-preview/";
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** @param {string} slug */
export function appPreviewOrigin(slug) {
  return slugPattern.test(slug) ? `https://${slug}.${hivePreviewDomain}` : null;
}

/** @param {string} pathname */
export function appPreviewPathOrigin(pathname) {
  return pathname.startsWith(appPreviewPrefix)
    ? appPreviewOrigin(pathname.slice(appPreviewPrefix.length))
    : null;
}
