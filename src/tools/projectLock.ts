// Who currently has a project open.
//
// A project used to live only in the app folder, where two copies of ArtDaddy on one machine
// are the only way to open it twice. Save As lets it live in Dropbox or on a shared drive,
// so two MACHINES can now open the same project and autosave over each other with no
// warning and no merge. Premiere writes a lock file beside the project and warns; this is
// that, and it warns rather than refusing — a crash leaves a stale lock behind, and being
// unable to open your own project is worse than being told to check.
import { INTERNAL_DIR, joinPath, type FsLike } from "./store";

const LOCK = `${INTERNAL_DIR}/.lock`;

/** How often the holder re-stamps its claim while the project is open. */
export const HEARTBEAT_MS = 20_000;

/** How long a claim outlives its last stamp. A lock is a claim by a LIVE editor, so this is a
 *  few missed beats — NOT a guess at how long someone might be editing. It used to be 12
 *  hours on the theory that a stale lock is rare; a crash then warned about a second instance
 *  that did not exist for the rest of the day, which is exactly how a warning gets ignored.
 *  The margin is generous because a backgrounded window has its timers throttled to ~1/min. */
const STALE_MS = 6 * HEARTBEAT_MS;

export interface ProjectLock {
  /** Random per app RUN, so the holder can be told apart from this one on any machine. */
  instance: string;
  at: number;
}

/** Random per app RUN, shared by every copy of this module in the realm.
 *
 *  It used to be a module-level `let`, which made it per MODULE INSTANCE. A second copy of this
 *  module (a dynamic import reaching a different module graph, HMR) gets its OWN id, so one app
 *  ends up with two identities: copy A claims the lock and heartbeats it forever, copy B reads a
 *  fresh FOREIGN lock and refuses to take ownership. The app then locks itself out of its own
 *  project permanently — reads keep working (they need no document) while every mutation fails,
 *  and the only cure is a restart. Observed with a single process running and the lock stamped
 *  19s earlier. Hanging it off globalThis makes the identity process-wide, which is what it
 *  always meant. */
function instanceId(): string {
  const g = globalThis as { __artdaddyLockInstance?: string };
  if (!g.__artdaddyLockInstance) g.__artdaddyLockInstance = Math.random().toString(36).slice(2, 10);
  return g.__artdaddyLockInstance;
}

function lockPath(projectDir: string): string {
  return joinPath(projectDir, LOCK);
}

/** The lock currently on `projectDir`, or null when there is none, it is unreadable, or it
 *  is our own. A lock we cannot parse is treated as absent: a corrupt byte must not be able
 *  to lock someone out of their project. */
export async function readProjectLock(fs: FsLike, projectDir: string): Promise<ProjectLock | null> {
  try {
    const raw = JSON.parse(await fs.readTextFile(lockPath(projectDir))) as Partial<ProjectLock>;
    if (typeof raw.instance !== "string" || raw.instance === instanceId()) return null;
    return { instance: raw.instance, at: typeof raw.at === "number" ? raw.at : 0 };
  } catch {
    return null;
  }
}

/** Someone else's lock that is recent enough to be a live editor, or null. This is the one
 *  the user is warned about; an older one is reported as absent so a crash months ago does
 *  not warn forever. */
export async function foreignProjectLock(
  fs: FsLike,
  projectDir: string,
  now = Date.now(),
): Promise<ProjectLock | null> {
  const held = await readProjectLock(fs, projectDir);
  return held && now - held.at < STALE_MS ? held : null;
}

/** Claim the project and keep the claim ALIVE. Best-effort by design: a read-only volume or a
 *  full disk must not stop someone opening their own project, so a failed claim is silent. */
export async function claimProjectLock(fs: FsLike, projectDir: string): Promise<void> {
  await stamp(fs, projectDir);
  stopHeartbeat(projectDir);
  const timer = setInterval(() => void beat(fs, projectDir), HEARTBEAT_MS);
  // Node/test runners would otherwise be held open by the interval.
  (timer as unknown as { unref?: () => void }).unref?.();
  beats.set(projectDir, timer);
}

const beats = new Map<string, ReturnType<typeof setInterval>>();

function stopHeartbeat(projectDir: string): void {
  const t = beats.get(projectDir);
  if (t !== undefined) clearInterval(t);
  beats.delete(projectDir);
}

async function stamp(fs: FsLike, projectDir: string): Promise<void> {
  try {
    await fs.mkdir(joinPath(projectDir, INTERNAL_DIR));
    await fs.writeTextFile(
      lockPath(projectDir),
      JSON.stringify({ instance: instanceId(), at: Date.now() }),
    );
  } catch {
    /* unwritable project folder — the warning is a courtesy, not a gate */
  }
}

/** One beat. Stops rather than re-stamping if the lock is no longer OURS: another editor
 *  taking it over must not have its claim silently overwritten by our timer. */
async function beat(fs: FsLike, projectDir: string): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readTextFile(lockPath(projectDir))) as Partial<ProjectLock>;
    if (raw.instance !== instanceId()) {
      stopHeartbeat(projectDir);
      return;
    }
  } catch {
    /* gone or unreadable: re-stamp below, the project is still open here */
  }
  await stamp(fs, projectDir);
}

/** Release on close. Only ever removes OUR lock: releasing on the way out of a project that
 *  another machine has since claimed would hand them a false all-clear. */
export async function releaseProjectLock(fs: FsLike, projectDir: string): Promise<void> {
  stopHeartbeat(projectDir); // before the delete, so no beat can resurrect the file
  try {
    const raw = JSON.parse(await fs.readTextFile(lockPath(projectDir))) as Partial<ProjectLock>;
    if (raw.instance !== instanceId()) return;
    await fs.remove?.(lockPath(projectDir));
  } catch {
    /* no lock, unreadable, or no delete support: nothing to release */
  }
}
