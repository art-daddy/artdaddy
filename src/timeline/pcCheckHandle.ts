// HELD OFF ON PURPOSE, NOT DELETED (owner decision 2026-11-18): part of the held export-time guess machinery (flags
// `estimate_v2` and `pc_check`, both in OFF_IN_THIS_BUILD). Kept for a later release, so do not remove it as unused.
// The full note is in src/api/exportFlags.ts.
//
// Where the rest of the app finds the PC check service that the app started (see `pcCheckStart.ts`). One handle, nothing else: no service started (a page without the native app, a test) is no handle, and
// everything that reads it treats that as "this PC has not been checked".
import type { PcCheckService } from "../platform/pcCheck";

let service: PcCheckService | null = null;

export function setPcCheckService(next: PcCheckService | null): void {
  service = next;
}

export function pcCheckService(): PcCheckService | null {
  return service;
}
