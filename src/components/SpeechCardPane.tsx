// The speech card, mounted: the one place the chat pane meets it. It is its own component so that the many small
// changes of the speech jobs (every chunk of the engine's output) re-render the card and not the whole pane.
import type { ChatKey } from "../store/speechWake";
import SpeechCard from "./SpeechCard";
import { useSpeechCard } from "./useSpeechCard";

export default function SpeechCardPane({ chat }: { chat: ChatKey | null }): JSX.Element | null {
  const card = useSpeechCard(chat);
  return <SpeechCard view={card.view} onDismiss={card.dismiss} />;
}
