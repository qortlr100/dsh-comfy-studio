/**
 * Helpers of this package's tests. The type assertion the tests need lives here, in one place:
 * a test hands a library function a hand-written stand-in or reads a body it wrote itself.
 */

/**
 * A value the test wrote by hand, taken as the type the code under test expects (a fake `fetch`,
 * a parsed JSON body, a partial server answer).
 * @param value - the stand-in.
 * @param _witness - never passed; it names `T` a second time in the signature, which the lint
 *   rule on lone type parameters wants.
 * @returns the same value, typed.
 */
export function standIn<T>(value: unknown, ..._witness: T[]): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one cast of the tests; see the module comment.
  return value as T;
}
