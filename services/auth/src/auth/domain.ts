// Transport-independent authentication operations. Both Node and Worker entry
// points use these implementations; no HTTP server or queue starts on import.

export { completeCoderOAuth, startCoderOAuth } from "./coder-oauth.js";
export { disconnectCoderOAuth } from "./coder-oauth-disconnect.js";
export { performLogin } from "./login.js";
export { readAuthenticationReadiness } from "./readiness.js";
export { createSession, deleteSession, getSessionById } from "./session.js";
export { rotateCoderCredentials } from "./token-rotation.js";
export { getDecryptedCoderToken, getTokenStatus } from "./token-status.js";
