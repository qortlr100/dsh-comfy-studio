// Host scenario that fails, to see the failure come back as a rejection.

export const MESSAGE = "cs scenario failed on purpose";

export default async function throws(): Promise<never> {
  await Promise.resolve();
  throw new RangeError(MESSAGE);
}
