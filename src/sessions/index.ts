/**
 * Conversation scoping module.
 * Manages how SDK sessions are keyed per integration.
 */

export type { ScopeMode, SessionScope } from "./types.ts";
export { SessionStore } from "./store.ts";
export { IdentityLinker, type LinkedIdentity } from "./identity.ts";
