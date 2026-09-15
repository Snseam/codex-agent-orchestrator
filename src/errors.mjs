export class OrchestratorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details) {
  if (!condition) throw new OrchestratorError(code, message, details);
}
