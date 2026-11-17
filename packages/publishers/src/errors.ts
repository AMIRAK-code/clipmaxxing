export interface PublishErrorInit {
  code: string;
  retryable?: boolean;
  needsReconnect?: boolean;
  retryAfterSec?: number;
  providerPayload?: unknown;
  status?: number;
  committed?: boolean;
  externalId?: string;
}

/** Normalised error thrown by every adapter. */
export class PublishError extends Error {
  code: string;
  retryable: boolean;
  needsReconnect: boolean;
  retryAfterSec?: number;
  providerPayload?: unknown;
  /** HTTP status when the error came from a provider response. */
  status?: number;
  /**
   * The platform may already have the post (the error came during or after the request that creates
   * it). Publishing again could post the video twice, so callers must not retry the publish: poll
   * `externalId` when there is one, otherwise let the user check the platform.
   */
  committed: boolean;
  /** Platform id to poll when `committed` is set and the post is known to exist. */
  externalId?: string;

  constructor(message: string, init: PublishErrorInit) {
    super(message);
    this.name = 'PublishError';
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.needsReconnect = init.needsReconnect ?? false;
    this.committed = init.committed ?? false;
    if (init.retryAfterSec !== undefined) this.retryAfterSec = init.retryAfterSec;
    if (init.providerPayload !== undefined) this.providerPayload = init.providerPayload;
    if (init.status !== undefined) this.status = init.status;
    if (init.externalId !== undefined) this.externalId = init.externalId;
  }
}

export function isPublishError(e: unknown): e is PublishError {
  return e instanceof PublishError;
}

/**
 * Phase of a publish relative to the moment the platform creates the post:
 *  - 'creating': the request that creates the post. A 4xx answer means the platform refused it, so a
 *    retry is still safe; no answer (network error) or a 5xx is ambiguous: it may have been created.
 *  - 'created': the post exists (e.g. status polling afterwards). Any retry would post it again.
 */
export type CommitPhase = 'creating' | 'created';

/**
 * Turn an error from a committing phase into a non-retryable `committed` error, so the engine never
 * uploads and posts a second time. Definitive errors (not retryable, no reconnect needed) and, while
 * 'creating', refusals with a 4xx status pass through unchanged.
 */
export function toCommitted(e: unknown, phase: CommitPhase, externalId?: string): unknown {
  if (isPublishError(e)) {
    if (e.committed) return e;
    if (!e.retryable && !e.needsReconnect) return e;
    if (phase === 'creating' && e.status !== undefined && e.status < 500) return e;
  }
  const message = e instanceof Error ? e.message : String(e);
  const init: PublishErrorInit = { code: isPublishError(e) ? e.code : 'unexpected_error', retryable: false, committed: true };
  if (isPublishError(e)) {
    init.needsReconnect = e.needsReconnect;
    if (e.status !== undefined) init.status = e.status;
    if (e.providerPayload !== undefined) init.providerPayload = e.providerPayload;
  }
  if (externalId !== undefined) init.externalId = externalId;
  return new PublishError(message, init);
}

/** Run one committing phase of a publish (see CommitPhase); errors go through toCommitted(). */
export async function commitPhase<T>(phase: CommitPhase, fn: () => Promise<T>, externalId?: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toCommitted(e, phase, externalId);
  }
}
