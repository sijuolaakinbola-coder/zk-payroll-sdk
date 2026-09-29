/**
 * Payroll domain error definitions and permission mappers.
 */
export * from "../errors/permissions";

import {
  BatchCreatorPermissionError,
  BatchCreatorPermissionErrorCode,
  type BatchCreatorRole,
} from "../errors/permissions";
import type { ErrorContext } from "../core/errors";

export interface PayrollState {
  /** Unique identifier for the payroll batch. */
  batchId: string;
  /** Current lifecycle state of the payroll batch. */
  status: "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED";
  /** Optional last modified timestamp (ms). */
  updatedAt?: number;
}

export const PAYROLL_STATE_TRANSITIONS: Readonly<
  Record<PayrollState["status"], readonly PayrollState["status"][]>
> = {
  PENDING: ["EXECUTING", "FAILED"],
  EXECUTING: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
};

export class PayrollStateConsistencyError extends Error {
  public readonly code = "PAYROLL_STATE_INCONSISTENT" as const;
  public readonly context: ErrorContext;
  public readonly details: {
    batchId?: string;
    currentStatus?: PayrollState["status"];
    targetStatus?: PayrollState["status"];
    allowedTransitions?: readonly PayrollState["status"][];
  };

  constructor(
    message: string,
    context: ErrorContext = {},
    details: PayrollStateConsistencyError["details"] = {}
  ) {
    super(message);
    this.name = "PayrollStateConsistencyError";
    this.context = context;
    this.details = details;
  }
}

export class TreasuryReserveReleaseError extends Error {
  public readonly code = "TREASURY_RESERVE_RELEASE_INVALID" as const;
  public readonly context: ErrorContext;
  public readonly details: {
    batchId?: string;
    requestedAmount?: bigint;
    availableReserve?: bigint;
    reason?: TreasuryReserveReleaseReason;
  };

  constructor(
    message: string,
    context: ErrorContext = {},
    details: TreasuryReserveReleaseError["details"] = {}
  ) {
    super(message);
    this.name = "TreasuryReserveReleaseError";
    this.context = context;
    this.details = details;
  }
}

export type TreasuryReserveReleaseReason =
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_RESERVE";

export interface TreasuryReserveReleaseParamsBase {
  /** Amount to release from the treasury reserve, in the smallest unit. */
  requestedAmount: bigint | number | string;
  /** Currently available treasury reserve balance, in the smallest unit. */
  availableReserve: bigint | number | string;
}

export interface TreasuryReserveReleaseParams extends TreasuryReserveReleaseParamsBase {
  /** Optional payroll batch identifier for error context. */
  batchId?: string;
}

function toBigInt(
  value: bigint | number | string,
  field: "requestedAmount" | "availableReserve"
): bigint {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isFinite(value)) {
      throw new TreasuryReserveReleaseError(
        `Treasury reserve release field "${field}" must be a finite integer`,
        { field },
        { reason: "INVALID_AMOUNT" }
      );
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new TreasuryReserveReleaseError(
        `Treasury reserve release field "${field}" must be a valid integer string`,
        { field },
        { reason: "INVALID_AMOUNT" }
      );
    }
    return BigInt(trimmed);
  }

  throw new TreasuryReserveReleaseError(
    `Treasury reserve release field "${field}" is required`,
    { field },
    { reason: "INVALID_AMOUNT" }
  );
}

/**
 * Asserts that a treasury reserve release request is valid.
 * Throws a typed `TreasuryReserveReleaseError` with actionable remediation if invalid.
 *
 * Validation rules:
 * - `requestedAmount` must be a positive integer.
 * - `availableReserve` must be a non-negative integer.
 * - `requestedAmount` must not exceed `availableReserve`.
 *
 * @params params - Release request parameters.
 * @params context - Optional debugging context.
 */
export function assertTreasuryReserveReleaseValid(
  params: TreasuryReserveReleaseParams,
  context: ErrorContext = {}
): void {
  if (!params || typeof params !== "object") {
    throw new TreasuryReserveReleaseError(
      "Treasury reserve release params are required",
      context,
      { reason: "INVALID_AMOUNT" }
    );
  }

  const batchId = params.batchId;
  const requestedAmount = toBigInt(params.requestedAmount, "requestedAmount");
  const availableReserve = toBigInt(params.availableReserve, "availableReserve");

  if (availableReserve < BigInt(0)) {
    throw new TreasuryReserveReleaseError(
      `Treasury reserve release available reserve must be non-negative, received ${availableReserve.toString()}`,
      { ...context, batchId },
      { batchId, requestedAmount, availableReserve, reason: "INVALID_AMOUNT" }
    );
  }

  if (requestedAmount <= BigInt(0)) {
    throw new TreasuryReserveReleaseError(
      `Treasury reserve release amount must be greater than zero, received ${requestedAmount.toString()}`,
      { ...context, batchId },
      { batchId, requestedAmount, availableReserve, reason: "INVALID_AMOUNT" }
    );
  }

  if (requestedAmount > availableReserve) {
    throw new TreasuryReserveReleaseError(
      `Treasury reserve release amount ${requestedAmount.toString()} exceeds available reserve ${availableReserve.toString()}`,
      { ...context, batchId },
      { batchId, requestedAmount, availableReserve, reason: "INSUFFICIENT_RESERVE" }
    );
  }
}

/**
 * Asserts that an executing caller possesses one of the required batch creator roles.
 * Throws a typed `BatchCreatorPermissionError` with actionable remediation if unauthorized.
 *
 * @param caller - Address of the caller attempting batch creation.
 * @param callerRoles - Array of roles currently held by the caller.
 * @param requiredRoles - Optional list of required roles (default: BATCH_CREATOR, PAYROLL_ADMIN, EMPLOYER).
 * @param context - Optional debugging context.
 */
export function assertBatchCreatorAuthorized(
  caller: string,
  callerRoles: string[] = [],
  requiredRoles: BatchCreatorRole[] = ["BATCH_CREATOR", "PAYROLL_ADMIN", "EMPLOYER"],
  context: ErrorContext = {}
): void {
  if (!caller || typeof caller !== "string") {
    throw new BatchCreatorPermissionError(
      "Caller address is required to verify batch creator authorization",
      BatchCreatorPermissionErrorCode.UNAUTHORIZED_CREATOR,
      { ...context, caller: caller || "[empty]" },
      {
        attemptedCaller: caller,
        requiredRoles,
      }
    );
  }

  const isAuthorized = callerRoles.some((role) =>
    requiredRoles.includes(role.toUpperCase() as BatchCreatorRole)
  );

  if (!isAuthorized) {
    throw new BatchCreatorPermissionError(
      `Caller ${caller} is not authorized to create payroll batches. Required one of: ${requiredRoles.join(", ")}`,
      BatchCreatorPermissionErrorCode.UNAUTHORIZED_CREATOR,
      { ...context, caller },
      {
        attemptedCaller: caller,
        requiredRoles,
      }
    );
  }
}

/**
 * Asserts that a payroll batch state transition is consistent and allowed.
 * Throws a typed `PayrollStateConsistencyError` with actionable remediation if invalid.
 *
 * @param current - Current payroll state snapshot.
 * @param targetStatus - Desired next status.
 * @param context - Optional debugging context.
 */
export function assertPayrollStateTransition(
  current: PayrollState,
  targetStatus: PayrollState["status"],
  context: ErrorContext = {}
): void {
  if (!current || typeof current !== "object") {
    throw new PayrollStateConsistencyError(
      "Current payroll state is required to verify state consistency",
      context,
      { targetStatus }
    );
  }

  if (!current.batchId || typeof current.batchId !== "string") {
    throw new PayrollStateConsistencyError(
      "Payroll batch ID is required to verify state consistency",
      context,
      { currentStatus: current.status, targetStatus }
    );
  }

  const allowed = PAYROLL_STATE_TRANSITIONS[current.status] ?? [];

  if (!allowed.includes(targetStatus)) {
    throw new PayrollStateConsistencyError(
      `Invalid payroll state transition for batch ${current.batchId} from ${current.status} to ${targetStatus}. Allowed: ${allowed.length > 0 ? allowed.join(", ") : "none (terminal state)"}`,
      context,
      {
        batchId: current.batchId,
        currentStatus: current.status,
        targetStatus,
        allowedTransitions: allowed,
      }
    );
  }
}
