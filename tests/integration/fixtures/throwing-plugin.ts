// A host plugin whose `apply` fails, to see how the harness reports an inactive entry.
// dsh's Node loads this file directly through a patch row.

export const MESSAGE = "cs fixture plugin failed on purpose";

export function apply(): void {
  throw new Error(MESSAGE);
}
