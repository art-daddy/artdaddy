import { useEffect, useMemo, useState } from "react";

import { quoteHold, type GenerationQuote } from "../api/quote";
import { holdInputs, type HoldInputs } from "../tools/holdInputs";

/** The price the server quotes for a generation tool call, once it arrives. Null until then, when there is no price to show
 *  (the tool holds nothing, would refuse the call, or the server cannot say), and never an answer to an older question.
 *
 *  Keyed by what the price depends on, not by the arguments object: a new object with the same inputs is the same question,
 *  so a changed prompt does not ask again. The question is withdrawn when the bar goes away or the inputs change. */
export function useGenerationQuote(
  tool: string,
  args: Record<string, unknown>,
): GenerationQuote | null {
  const key = JSON.stringify(holdInputs(tool, args));
  const inputs = useMemo(() => JSON.parse(key) as HoldInputs | null, [key]);
  const [answer, setAnswer] = useState<{ key: string; quote: GenerationQuote } | null>(null);

  useEffect(() => {
    if (!inputs) return;
    const controller = new AbortController();
    quoteHold(inputs, controller.signal).then(
      (quote) => {
        if (quote && !controller.signal.aborted) setAnswer({ key, quote });
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [inputs, key]);

  return answer !== null && answer.key === key ? answer.quote : null;
}
