export interface PublishErrorInit {
  code: string;
  retryable?: boolean;
  needsReconnect?: boolean;
  retryAfterSec?: number;
  providerPayload?: unknown;
  status?: number;
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

  constructor(message: string, init: PublishErrorInit) {
    super(message);
    this.name = 'PublishError';
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.needsReconnect = init.needsReconnect ?? false;
    if (init.retryAfterSec !== undefined) this.retryAfterSec = init.retryAfterSec;
    if (init.providerPayload !== undefined) this.providerPayload = init.providerPayload;
    if (init.status !== undefined) this.status = init.status;
  }
}

export function isPublishError(e: unknown): e is PublishError {
  return e instanceof PublishError;
}
