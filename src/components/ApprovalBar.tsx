import { useSyncExternalStore } from "react";

import { getUsage, subscribeUsage } from "../api/usage";
import type { PendingApproval } from "../api/types";
import { BRAND } from "../brand";
import { describeApproval, priceLine } from "./approvalCopy";
import { Button } from "./ui";
import { useGenerationQuote } from "./useGenerationQuote";

/** The one place the agent stops and asks. It has to be readable by someone who has never
 *  heard of our tool names, so it leads with the action and says why it is being asked. A
 *  generation also says what it may cost, once the server has said; the price is advice, so
 *  the buttons never wait for it. */
export default function ApprovalBar({
  pending,
  onApprove,
  onDeny,
}: {
  pending: PendingApproval;
  onApprove: () => void | Promise<void>;
  onDeny: () => void | Promise<void>;
}) {
  const copy = describeApproval(pending.name, pending.arguments);
  const action = copy?.action ?? pending.name;
  const detail = copy?.subject ?? pending.rationale;
  const quote = useGenerationQuote(pending.name, pending.arguments);
  const usage = useSyncExternalStore(subscribeUsage, getUsage);

  return (
    <div className="flex items-start gap-3 border-t border-amber-500/30 bg-amber-500/10 px-5 py-3">
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-amber-200">
          {BRAND.displayName} wants to: <span className="font-medium text-amber-100">{action}</span>
        </p>
        {detail && <p className="mt-0.5 truncate text-xs text-neutral-400">“{detail}”</p>}
        {copy && <p className="mt-0.5 text-xs text-neutral-400">{copy.because}</p>}
        {quote && (
          <p className="mt-0.5 text-xs tabular-nums text-amber-200">
            {priceLine(quote.credits, usage)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="primary" onClick={() => void onApprove()}>
          {copy?.approveLabel ?? "Allow"}
        </Button>
        <Button variant="danger" onClick={() => void onDeny()}>
          Deny
        </Button>
      </div>
    </div>
  );
}
