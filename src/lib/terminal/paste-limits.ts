export const TERMINAL_PASTE_ASSET_MAX_FILES = 10;
export const TERMINAL_PASTE_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
// Reserve space for multipart boundaries, names, and headers, including unused fields.
export const TERMINAL_PASTE_ASSET_MAX_REQUEST_BYTES =
  TERMINAL_PASTE_ASSET_MAX_TOTAL_BYTES + 1024 * 1024;
