// Vehicle errors are HTTP problems (RFC 9457) with stable machine-readable codes.
import { HttpProblem } from '../http/problem.ts';

export class ApiError extends HttpProblem {
  constructor(status: number, code: string, title: string, detail?: string) {
    super(status, code, title, detail);
    this.name = 'ApiError';
  }
}
/** Also used for "exists but you are not a member": never reveals existence. */
export const notFound = () => new ApiError(404, 'vehicle_not_found', 'Vehicle not found');
export const forbidden = (what: string) => new ApiError(403, 'forbidden', 'Forbidden', `Your role does not allow ${what}.`);
export const invalid = (detail: string) => new ApiError(422, 'validation_failed', 'Validation failed', detail);
export const conflict = (code: string, detail: string) => new ApiError(409, code, 'Conflict', detail);
