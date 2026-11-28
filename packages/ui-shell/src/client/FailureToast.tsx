// The toast that shows why a shell action failed.

import { IconWarningOutlineRegular, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ShellInjected } from "./contract.ts";

/** How long the message stays at full opacity; a failure that names what broke needs reading. */
const HOLD_MS = 6000;

export type FailureToastProps = PropsRuntime<"shell.overlay"> & InjectFace<ShellInjected>;

/**
 * Show the latest failure, if any.
 * @param props - the shell's actions and state hook.
 * @returns the toast, or nothing.
 */
export function FailureToast({ actions, useShell }: FailureToastProps) {
  const failure = useShell((state) => state.failure);
  if (failure === null) return null;
  return (
    <Toast
      key={failure.seq}
      text={failure.message}
      icon={<IconWarningOutlineRegular />}
      holdMs={HOLD_MS}
      onDone={() => {
        actions.dismissFailure(failure.seq);
      }}
    />
  );
}
