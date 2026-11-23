export const hiveProductionOrigin = "https://hive.kethalia.com";
export const hivePreviewDomain = "hive-preview.kethalia.com";
export const appPreviewPrefix = "/app-preview/";
export const appPreviewBuildPath = "/api/app-preview-build";
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** @param {string} branch */
export function appPreviewBranchSlug(branch) {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** @param {string} slug */
export function appPreviewOrigin(slug) {
  return slugPattern.test(slug) ? `https://${slug}.${hivePreviewDomain}` : null;
}

export function isEmbeddedAppPreview() {
  return (
    window.parent !== window &&
    appPreviewOrigin(window.location.hostname.split(".")[0]) === window.location.origin
  );
}

/** @param {string} pathname */
export function appPreviewPathOrigin(pathname) {
  return pathname.startsWith(appPreviewPrefix)
    ? appPreviewOrigin(pathname.slice(appPreviewPrefix.length))
    : null;
}
