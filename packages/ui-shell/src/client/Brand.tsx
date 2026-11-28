// The brand in dsh's brand row: a text name and a small self-drawn mark (temporary art).

import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import styles from "./Brand.module.css";
import { strings } from "./strings.ts";

/** The product name beside the mark. */
export function BrandName(): JSX.Element {
  return (
    <span className={styles.name} data-cs-brand="">
      {strings.brandName}
    </span>
  );
}

/**
 * A rounded square with a geometric letter C, drawn as a stroked arc so it needs no font.
 * @param props.size - the square edge in pixels the sidebar asks for.
 */
export function BrandMark({ size }: PropsRuntime<"sidebar.brand.mark">): JSX.Element {
  return (
    <svg
      className={styles.mark}
      data-cs-brand-mark=""
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect className={styles.markBody} x="0" y="0" width="24" height="24" rx="6" />
      <path className={styles.markLetter} d="M16.2 8.2A5.2 5.2 0 1 0 16.2 15.8" />
    </svg>
  );
}
