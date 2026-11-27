/**
 * The operation spec and the parsed agent tool call of an operation. Both use DSH tool types
 * (`@deepseek-ai/dsh-tools`), so they live apart from `types.ts`, which is the client face `@cs/project/types` and
 * imports no host module.
 *
 * @module @cs/project/operation-types
 */
import type { ParameterSchemaSpec, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {
  OperationContext,
  OperationInput,
  OperationOutput,
  OperationResult,
  ProjectRecord,
  ProjectState,
  RecordId,
  RunRequest,
} from "./types.ts";

/**
 * One agent tool call of an operation, after Project parsed it and before Project runs it. An operation's
 * `prepareToolCall` receives it.
 */
export interface OperationToolCall {
  /** The tool arguments as the model sent them, including the operation's `toolParams`. */
  args: Record<string, unknown>;
  /** The run request Project will send; `prepareToolCall` may change its `params` and `inputs`. */
  request: RunRequest;
  /** The project's current state, which the inputs were parsed against. */
  state: ProjectState;
  /** The DSH tool call: the calling agent, the call ID and the stop signal. */
  exec: ToolRunContext;
}

/**
 * An operation a component implements and registers with `csProject.registerOperation`. Each operation is run only
 * through `csProject.run`. The spec also declares the operation's agent tool and form in a view: `description`, `inputs`,
 * `outputs` and `summarize`.
 */
export interface OperationSpec {
  /** `<component key>.<verb>` or `<component key>.<object>_<verb>`, for example `asset.tag_add`. */
  name: string;
  /** The owning component's key; it equals the part of `name` before the dot. */
  component: string;
  /** The version of the parameter schema, written to each record's `operation_version`. */
  version: string;
  /** What the operation does, for the model (its tool description) and the form in a view. */
  description: string;
  /** The name that views show for the operation; Project only stores it. */
  label?: string;
  /** The parameter schema in the DSH tool parameter format; the runner validates `params` against it. */
  params: ParameterSchemaSpec;
  /** The input roles the operation accepts; the runner refuses an input with any other role. */
  inputs: Record<string, OperationInput>;
  /**
   * Input roles whose `{record, output}` reference may name a record that has not finished `done`. The runner and the
   * scheduler do not wait for those producers and do not fail the record on a null `resolved_asset` for those roles;
   * the record's current form fills `resolved_asset` when the producer is done, and a failed producer leaves it null.
   */
  pendingInputRoles?: string[];
  /** The outputs, in the order `execute` returns them. */
  outputs: OperationOutput[];
  /** Whether identical inputs and parameters always give identical outputs; the runner then reuses earlier outputs. */
  deterministic: boolean;
  /** The scheduler's concurrency class: `gpu` and `cpu` calls share a configured limit each; `none` is unlimited. */
  resource: "none" | "cpu" | "gpu";
  /** A read: the runner writes no record and takes no lock. */
  readOnly?: boolean;
  /** Whether this call may overlap other agent tool calls; the provider must own resource reservation. */
  isConcurrencySafe?(params: Record<string, unknown>): boolean;
  /**
   * A durable setting outside the undo history, such as a conversation's default workflow: the runner writes the record
   * after the current position without making it a step, so the call discards no step and cancels no record, and
   * undo, redo and moves never change its effect. The owning reducer receives every such record of the project, in
   * write order, after the history list up to the current position.
   */
  outsideHistory?: boolean;
  /**
   * The records a call of this operation replaces; the runner adds them to the record's `supersedes`.
   * @param params - the call's parameters.
   * @param state - the project's current state, which the call writes after.
   * @returns the replaced records; omit the function for operations that replace nothing by themselves.
   */
  supersedes?(params: Record<string, unknown>, state: ProjectState): RecordId[];
  /**
   * The record a call of this operation is a changed copy of, for a call whose caller names no `based_on`.
   * @param params - the call's parameters.
   * @param state - the project's current state, which the call writes after.
   * @returns the record, or null for none; omit the function for operations whose calls copy no record by themselves.
   */
  basedOn?(params: Record<string, unknown>, state: ProjectState): RecordId | null;
  /**
   * One line for a chat card or a card in a view.
   * @param record - a finished record of this operation.
   * @returns the line.
   */
  summarize(record: ProjectRecord): string;
  /**
   * Whether the agent tool's model-visible result leaves out its `params:` line. Set it for an operation whose params
   * are the model's own long arguments, which the model's tool call already holds; the logged result value keeps
   * `params`.
   */
  omitParamsFromResult?: boolean;
  /** Tool-only arguments besides `params`; Project removes them from the run request's params before `prepareToolCall`. */
  toolParams?: ParameterSchemaSpec;
  /**
   * Check or change an agent tool call before Project runs it, for example to turn a tool-only argument into an input.
   * @param call - the parsed call; throw to refuse it with the error's message.
   */
  prepareToolCall?(call: OperationToolCall): Promise<void>;
  /**
   * Refuse a call of any caller before Project writes a record, for a rule the operation itself enforces (a run
   * needs a reference image). The runner calls it under the project lock, after the params and inputs are valid, so
   * it must stay fast and must never call `csProject.run`.
   * @param request - the call.
   * @param state - the project's current state, which the call writes after (or reads, for a read-only operation).
   * @throws Error that rejects `run` unchanged; nothing is written.
   */
  precondition?(request: RunRequest, state: ProjectState): Promise<void>;
  /**
   * Run the operation. A throw fails the record with the error's message and the code `operation_failed`, or the
   * code of a thrown `OperationFailure`.
   * @param context - the record, resolved inputs, parameters, state, and asset storage.
   * @returns the outputs and the report.
   */
  execute(context: OperationContext): Promise<OperationResult>;
}
