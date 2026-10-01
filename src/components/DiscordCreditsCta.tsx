import { openDiscord } from "../lib/community";

/** The out-of-credits offer, worded once. Every surface that says credits ran out shows it
 *  (`isOutOfCredits` decides which do); a second literal is how the offer gets reworded in one
 *  place and left stale in another. Colour is inherited so it reads correctly on the red error
 *  plate and on neutral surfaces alike. */
export default function DiscordCreditsCta({ className }: { className?: string }) {
  return (
    <span className={className}>
      For more credits,{" "}
      <button
        type="button"
        onClick={() => void openDiscord()}
        className="font-medium underline underline-offset-2 hover:opacity-80"
      >
        Join our Discord
      </button>{" "}
      and raise a request.
    </span>
  );
}
