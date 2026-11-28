/**
 * The operation declarations a view turns into parameter forms (`GET /api/cs/operations`).
 *
 * Kept out of `wire.ts`: `OperationSpec` uses dsh tool types, and a browser program that imports them also gets dsh's
 * host declarations (`Context.sessions` as the host session store), which replace the client ones it type-checks
 * against. A browser half must not import this module until that is solved (step 3-3).
 *
 * @module @cs/api/wire-operation
 */
import type { OperationSpec } from "@cs/project";

/** An operation declaration without its executable parts. */
export interface WireOperation {
  name: string;
  version: string;
  description: string;
  /** The name that views show for the operation; absent when the operation declares none. */
  label?: OperationSpec["label"];
  inputs: OperationSpec["inputs"];
  params: OperationSpec["params"];
  outputs: OperationSpec["outputs"];
  deterministic: boolean;
  /** The scheduler class: `none` for operations that wait in neither the CPU nor the GPU queue. */
  resource: OperationSpec["resource"];
}

/**
 * Strip an operation spec to its declaration.
 * @param spec - a registered operation.
 * @returns the wire declaration.
 */
export function toWireOperation(spec: OperationSpec): WireOperation {
  return {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    ...(spec.label === undefined ? {} : { label: spec.label }),
    inputs: spec.inputs,
    params: spec.params,
    outputs: spec.outputs,
    deterministic: spec.deterministic,
    resource: spec.resource,
  };
}
