import { openDiscord } from "../lib/community";

/** The out-of-credits offer, worded once. Three surfaces show it — the agent panel's error
 *  part, the composer's credit chip and the profile page — and `community.ts` already
 *  records why that matters: a second literal is how the offer gets reworded in two places
 *  and left stale in the third. Colour is inherited so it reads correctly on the red error
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
