// SPDX-License-Identifier: EUPL-1.2

/** Normalizes unknown throwables into an Error instance. */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message, { cause: error });
  }

  return new Error(typeof error === 'string' ? error : String(error), { cause: error });
}
