import { emitOpenAssistant } from '../assistant';
import { AppIcon } from '../icons';

interface Props {
  /** The prompt sent to the assistant, pre-filled and auto-submitted. */
  prompt: string;
  /** Optional accessible label / tooltip. Defaults to a generic explanation. */
  title?: string;
}

/** Small info icon shown on detail pages. Opens the Ask Dockyard assistant
 *  with a prompt asking it to explain the object currently being viewed. */
export function InfoButton({ prompt, title = 'Ask the assistant to explain this' }: Props) {
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm btn--icon info-btn"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        emitOpenAssistant(prompt);
      }}
    >
      <AppIcon name="info" />
    </button>
  );
}
