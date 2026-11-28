// The chat tab of the right panel: dsh's own conversation, the chat view only.

import type { ConversationViewsProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { PropsRenderFactories, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import styles from "./ChatTab.module.css";
import { strings } from "./strings.ts";

export type ChatTabProps = PropsRuntime<"sidebar.right.pane.tab"> & PropsRenderFactories;

/**
 * The conversation's views, cut down to the chat itself. Module-level so the Factory slot
 * keeps one component identity across renders.
 * @param props - the Factory slot's local view props.
 * @returns the chat view.
 */
function ChatOnlyView(props: ConversationViewsProps) {
  return <>{props.renderSlot("conversation.session", { view: "chat" })}</>;
}

/**
 * The main session's messages and composer, sized for the panel.
 * @param props - the tab's slot props.
 * @returns the conversation.
 */
export function ChatTab({
  sessionId,
  useSession,
  useConversation,
  useSessions,
  renderFactorySlot,
}: ChatTabProps) {
  const session = useSession((state) => state);
  const conversation = useConversation((state) => state);
  const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank);
  const active =
    conversation.activeTargets.size > 0 ||
    (!session.blank && !session.awaitingFirstTurn) ||
    session.running;
  // dsh's `conversationPhase`: `blank` until a prompt was attempted or the session is active.
  // Only a blank session that is still replaying hides its composer (upstream
  // ui-conversation `ConversationMainPanel`); one the list already proves blank does not.
  const blank = !active && !session.promptAttempted;
  const settling = blank && session.openState === "loading" && !summaryBlank;
  return (
    <div className={styles.tab} data-cs-chat="">
      {blank && !settling && <p className={styles.hint}>{strings.chatHint}</p>}
      {renderFactorySlot(
        "conversation.content",
        { variant: "embedded", phase: settling ? "settling" : "active", hero: false },
        { slots: { views: ChatOnlyView } },
      )}
    </div>
  );
}
