/**
 * Hosting adapters implement these behavioral contracts. The Cloudflare Worker
 * uses D1/R2/Clerk; the Node adapter uses SQLite/filesystem/proxy identity.
 *
 * ProjectRepository:
 *   list(identity, { archived })
 *   create(identity, state)
 *   get(identity, projectId)
 *   save(identity, projectId, state, { baseRevision, force })
 *   update(identity, projectId, patch)
 *   revisions(identity, projectId)
 *
 * AttachmentStore:
 *   put(identity, projectId, metadata, bytes)
 *   get(identity, attachmentId)
 *   delete(identity, projectId, attachmentId)
 *
 * ShareRepository:
 *   list(identity, projectId)
 *   create(identity, projectId, options)
 *   revoke(identity, projectId, shareId)
 *   resolve(slug)
 *
 * IdentityProvider:
 *   authenticate(request) -> { subject, email? } | null
 */
export const ADAPTER_CONTRACT_VERSION = 1;

