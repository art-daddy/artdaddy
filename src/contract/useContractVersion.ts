import { contractVersion } from ".";

/** The bundled contract's version. Static — the catalog ships with the app. */
export function useContractVersion(): string {
  return contractVersion();
}
