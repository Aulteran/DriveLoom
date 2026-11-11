// Errors map one-to-one onto RFC 9457 problem responses (docs/CONTRACTS.md).
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
  toProblem() {
    return { type: 'about:blank', title: this.code, status: this.status, detail: this.message, code: this.code };
  }
}
/** Also used for "exists but you are not a member": never reveals existence. */
export const notFound = () => new ApiError(404, 'vehicle_not_found', 'Vehicle not found.');
export const forbidden = (what: string) => new ApiError(403, 'forbidden', `Your role does not allow ${what}.`);
export const invalid = (detail: string) => new ApiError(422, 'validation_failed', detail);
export const conflict = (code: string, detail: string) => new ApiError(409, code, detail);
