// Avatar button + dropdown in the menu bar. The app is gated, so this is the one place the
// signed-in identity is visible and the way out.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { signOutDesktop } from "../api/desktopAuth";
import { useAuth } from "../store/auth";

/** Initials for the avatar fallback — Clerk has no picture for plenty of accounts. */
function initialsOf(name: string, email: string): string {
  const source = name.trim() || email.trim();
  if (!source) return "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]);
  return letters.join("").toUpperCase() || "?";
}

export default function AccountMenu() {
  const profile = useAuth((s) => s.profile);
  const status = useAuth((s) => s.status);
  const markLocked = useAuth((s) => s.markLocked);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const name = profile?.display_name ?? "";
  const email = profile?.email ?? "";
  // Offline with a stored session: we are signed in but /me never answered.
  const label = name || email || (status === "offline" ? "Offline" : "Account");

  const signOut = async () => {
    setSigningOut(true);
    await signOutDesktop();
    markLocked(); // the gate takes over from here
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={email || label}
        className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
      >
        {profile?.image_url ? (
          <img src={profile.image_url} alt="" className="h-5 w-5 rounded-full object-cover" />
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-700 text-[9px] font-semibold text-neutral-200">
            {initialsOf(name, email)}
          </span>
        )}
        <span className="max-w-[120px] truncate">{label}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[90]" onClick={() => setOpen(false)} aria-hidden />
          <div
            role="menu"
            className="absolute right-0 z-[91] mt-1 w-56 rounded-md border border-edge bg-panel py-1 shadow-2xl"
          >
            <div className="border-b border-edge px-3 pb-2 pt-1">
              <div className="truncate text-xs font-medium text-ink">{label}</div>
              {email && <div className="truncate text-[11px] text-ink-dim">{email}</div>}
            </div>
            <button
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800"
              onClick={() => {
                setOpen(false);
                navigate("/profile");
              }}
            >
              Profile
            </button>
            <button
              role="menuitem"
              disabled={signingOut}
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              onClick={() => void signOut()}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
