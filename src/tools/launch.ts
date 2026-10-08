// Which run of the app this is, for anything that must tell its own leftovers from an earlier
// run's: export partials (UJ-022) and the work folder (4i).

/** This run of the app: the app process's launch id, the same for every page it shows, so a
 *  reload of the page is not a new run (3h part 7); or the page's own where there is no app
 *  process to ask. Whatever an earlier run left behind carries another one. */
export async function currentLaunch(): Promise<string> {
  try {
    const { jobSupervisor } = await import("./jobSupervisor");
    const sup = await jobSupervisor();
    if (sup) return await sup.launchId();
  } catch {
    /* no app process to ask */
  }
  const { APP_SESSION } = await import("../project/jobLedger");
  return APP_SESSION;
}
