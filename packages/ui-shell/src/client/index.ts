// Browser half. This entry exports `inject` and `apply` only. `ctx` stays in this file: React
// components get what they need through the registration's `inject` factory, never `ctx` itself
// (docs/DSH.md "업스트림의 브라우저 코드 규칙").

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import { BuildProbe, type BuildProbeInjected } from "./BuildProbe.tsx";

const OWNER = "@cs/ui-shell";

export const inject = ["slots", "theme"];

export function apply(ctx: Context): void {
  // The theme service publishes a new snapshot object on every change and announces it with an
  // event; that pair is exactly the observable shape the slot renderer binds to a hook.
  const theme: BuildProbeInjected["hooks"]["theme"] = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: (listener) => ctx.on("theme/change", listener),
  };

  // Step 1-1 build probe. Step 3-0 replaces it with the shell's registrations.
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "cs-build-probe",
        inject: (): BuildProbeInjected => ({
          owner: OWNER,
          setColorScheme: (scheme) => ctx.theme.setTheme(scheme),
          hooks: { theme },
        }),
      },
      BuildProbe,
    ),
  );
}
