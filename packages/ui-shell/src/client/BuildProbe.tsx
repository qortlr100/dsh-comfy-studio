// Step 1-1 build probe: a small theme switch in the sidebar footer. It exists to show that a
// TSX component, a CSS module, a shared dsh primitive and a registration `inject` face all
// work in a browser bundle built by this repository. Step 3-0 replaces it with the shell.

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ThemeSnapshot } from "@deepseek-ai/dsh-client-ui-theme/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import styles from "./BuildProbe.module.css";
import { strings } from "./strings.ts";

/** A value with the two members the slot renderer turns into a `use<Name>` selector hook. */
interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** What the registration's `inject` factory hands over. Built in `apply`, where `ctx` lives. */
export interface BuildProbeInjected {
  /** Plain value: the package this component was bundled from. */
  owner: string;
  /** Callback into a ctx service. */
  setColorScheme(scheme: "light" | "dark"): void;
  /** Observable source; reaches the component as `useTheme(selector)`. */
  hooks: { theme: Observable<ThemeSnapshot> };
}

type BuildProbeProps = PropsRuntime<"sidebar.footer.action"> & InjectFace<BuildProbeInjected>;

export function BuildProbe({ wide, owner, setColorScheme, useTheme }: BuildProbeProps) {
  const scheme = useTheme((snapshot) => snapshot.active.colorScheme);
  const next = scheme === "dark" ? "light" : "dark";
  const title = next === "dark" ? strings.probeSwitchToDark : strings.probeSwitchToLight;

  return (
    <div className={styles.probe} data-cs-probe={owner} data-cs-scheme={scheme}>
      <Button
        variant="ghost"
        size="sm"
        title={title}
        aria-label={title}
        icon={<span className={styles.swatch} />}
        onClick={() => setColorScheme(next)}
      >
        {wide ? (
          <span className={styles.label}>
            {scheme === "dark" ? strings.probeDark : strings.probeLight}
          </span>
        ) : null}
      </Button>
    </div>
  );
}
