// Whose export it is. An export belongs to the account that asked for it, which is not necessarily
// the account signed in when it ends: it can finish after a sign-out and a different sign-in, or in a
// later launch before the profile has loaded. So the owner is captured when the export is admitted
// and carried with the job (exportQueue.ts); what is read here is only the answer to "who is signed
// in now", and it never throws: nothing that decides an owner may be able to fail an export.
import { useAuth } from "../store/auth";
import { lastKnownUser } from "./exportOutbox";

type SessionUserReader = () => string | null;
let sessionUserReader: SessionUserReader | null = null;

/** Install how to read the account the session's own token names (main.tsx points it at the desktop
 *  session). It is registered rather than imported so that this module, which the export queue and the
 *  reporter both need, does not pull the whole sign-in machinery into everything that exports. */
export function setSessionUserReader(reader: SessionUserReader | null): () => void {
  sessionUserReader = reader;
  return () => {
    if (sessionUserReader === reader) sessionUserReader = null;
  };
}

/** The account whose session a request sent now would carry: the session's own token first (it is
 *  what the request carries, and it exists before the profile has loaded), else the profile. Empty
 *  while neither is known. */
export function signedInUser(): string {
  try {
    return sessionUserReader?.() || useAuth.getState().profile?.user_id || "";
  } catch {
    return "";
  }
}

/** The account to file an export under when it is asked for: whoever is signed in, else the account
 *  this device last saw signed in. Empty when nobody is known. */
export function exportOwnerNow(): string {
  return signedInUser() || lastKnownUser();
}
