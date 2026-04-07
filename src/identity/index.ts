export {
  createContact,
  getContact,
  listContacts,
  searchContacts,
  updateContact,
  deleteContact,
  mergeContacts,
  type ContactRow,
} from "./contacts.ts";

export {
  linkIdentity,
  unlinkIdentity,
  resolveContact,
  listIdentities,
  findContactByIdentity,
  type ContactIdentityRow,
} from "./identities.ts";

export { findLinkCandidates, runAutoLinker } from "./auto-linker.ts";
export { updateRelationship, getRelationship, computeRelationshipStats } from "./relationship.ts";
