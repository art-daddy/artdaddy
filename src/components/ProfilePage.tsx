// Full-page account view, reached from the avatar menu. Identity comes from /me, the balance
// from the same usage store the chat meter reads, so the two can never disagree.
import { useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";

import { signOutDesktop } from "../api/desktopAuth";
import { getUsage, refreshUsage, subscribeUsage } from "../api/usage";
import { BRAND } from "../brand";
import { useAuth } from "../store/auth";
import { Button } from "./ui";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-ink-dim">{label}</span>
      <span className="truncate text-xs text-ink">{value}</span>
    </div>
  );
}

export default function ProfilePage() {
  const profile = useAuth((s) => s.profile);
  const status = useAuth((s) => s.status);
  const markLocked = useAuth((s) => s.markLocked);
  const verify = useAuth((s) => s.verify);
  const usage = useSyncExternalStore(subscribeUsage, getUsage);
  const navigate = useNavigate();

  useEffect(() => {
    // Opening the page is the moment the numbers need to be current.
    void refreshUsage();
    if (!profile && status === "unlocked") void verify();
  }, [profile, status, verify]);

  const name = profile?.display_name ?? "";
  const email = profile?.email ?? "";

  return (
    <div className="h-full overflow-auto bg-bg">
      <div className="mx-auto w-full max-w-2xl px-8 py-10">
        <button
          onClick={() => navigate(-1)}
          className="text-xs text-ink-dim hover:text-ink"
          aria-label="Go back"
        >
          ← Back
        </button>

        <header className="mt-4 flex items-center gap-4">
          {profile?.image_url ? (
            <img
              src={profile.image_url}
              alt=""
              className="h-16 w-16 rounded-full object-cover"
              width={64}
              height={64}
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-800 text-lg font-semibold text-neutral-200">
              {(name || email || "?").trim().charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-ink">
              {name || email || "Your account"}
            </h1>
            {email && <p className="truncate text-sm text-ink-dim">{email}</p>}
          </div>
        </header>

        {status === "offline" && (
          <p className="mt-4 rounded-md border border-edge bg-surface px-3 py-2 text-xs text-amber-400">
            Offline — showing the last known details. Editing and export still work.
          </p>
        )}

        <section className="mt-6 rounded-lg border border-edge bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">Credits</h2>
          {usage.metered ? (
            <div className="mt-2">
              <Row label="Remaining" value={String(usage.remaining)} />
              <Row label="Used" value={String(usage.used)} />
              <Row label="Limit" value={String(usage.limit)} />
              {usage.over && (
                <p className="mt-2 text-xs text-red-400">
                  You have used your allowance for this period.
                </p>
              )}
            </div>
          ) : (
            <p className="mt-1 text-xs text-ink-dim">This account is not metered.</p>
          )}
        </section>

        <section className="mt-4 rounded-lg border border-edge bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">About</h2>
          <div className="mt-2">
            <Row label="App" value={BRAND.displayName} />
            <Row label="Version" value={__ARTDADDY_RELEASE__} />
            {profile?.user_id && <Row label="User id" value={profile.user_id} />}
          </div>
        </section>

        <Button
          variant="danger"
          className="mt-6"
          onClick={() => {
            void signOutDesktop().then(() => markLocked());
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
