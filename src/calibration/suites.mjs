export const SUITES = Object.freeze({
  quick: Object.freeze({
    id: 'quick',
    version: '1',
    ttlMs: 15 * 60 * 1000,
    contract: Object.freeze({
      mode: 'read-only',
      canary: 'caller-provided-nonce',
      workspaceReuse: false,
    }),
  }),
  code: Object.freeze({
    id: 'code',
    version: '1',
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    contract: Object.freeze({
      mode: 'small-fix-with-independent-tests',
      workspaceReuse: false,
    }),
  }),
});

export const CALIBRATION_TIMEOUT_COOLDOWN_MS = 60 * 1000;
export const CALIBRATION_MAX_RECORD_BYTES = 64 * 1024;
