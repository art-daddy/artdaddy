import { useEffect } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
};

export function Button({ variant = "default", className, ...props }: ButtonProps) {
  const base =
    "px-3 py-1.5 rounded-md text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed";
  const styles: Record<string, string> = {
    default: "bg-neutral-800 hover:bg-neutral-700 text-neutral-100",
    primary: "bg-accent hover:bg-indigo-500 text-white",
    ghost: "hover:bg-neutral-800 text-neutral-300",
    danger: "bg-red-600/80 hover:bg-red-600 text-white",
  };
  return <button className={cn(base, styles[variant], className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent",
        className,
      )}
    />
  );
}

/** The modal shell every dialog sits in: scrim, Escape to close, click-outside to close. */
export function Overlay({
  children,
  onClose,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onPointerDown={onClose}
    >
      <div
        className="w-[380px] max-w-[92vw] rounded-lg border border-edge bg-panel p-4 shadow-2xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-neutral-500">
      {children}
    </div>
  );
}
