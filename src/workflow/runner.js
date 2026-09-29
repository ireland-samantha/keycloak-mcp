import { wasNotSent } from '../http/transport.js';
import { execute } from '../internal/capabilities.js';
import { isMutation, needsFreshTokenToCompensate } from '../policy/classify.js';
import { resolveCompensation } from './compensation.js';
import { completedReceipt, openJournal, receiptPath } from './journal.js';
import { acquireRealmLock } from './locks.js';
import { preflight } from './preflight.js';

// Each completed step with Keycloak's Location, when it sent one, and the ID of what it created.
const summary = completed => completed.map(({ step, status, location, created }) =>
  ({ operation: step.operation, status, ...(location ? { location } : {}), ...(created ? { id: created.id } : {}) }));
const journalFailures = journal => (journal.failures.length ? { journalErrors: [...journal.failures] } : {});

async function compensateStep(admin, lock, done) {
  const { operation, args } = done.compensate;
  try {
    await lock.assertHeld();
    if (needsFreshTokenToCompensate(done.step.operation, operation)) admin.invalidateToken();
    const result = await execute(admin, operation, args);
    return { operation, path: receiptPath(args), status: result.status, outcome: 'COMPENSATED' };
  } catch (compensationError) {
    return { operation, path: receiptPath(args), outcome: 'FAILED', error: String(compensationError.message) };
  }
}

// Compensates the completed steps in reverse order after `failure.step` failed with `failure.error`;
// `failure.sent` is false when its request never left keycloak-mcp.
async function rollBack(admin, lock, journal, completed, { step: failed, error, sent }) {
  const failure = { failedOperation: failed.operation, failedPath: receiptPath(failed.args) };
  const rollback = [];
  journal.record({ status: 'COMPENSATING', ...failure, completed: completedReceipt(completed) });
  for (const done of [...completed].reverse()) {
    if (!done.compensate) continue;
    rollback.push(await compensateStep(admin, lock, done));
    journal.record({ status: 'COMPENSATING', ...failure, completed: completedReceipt(completed), rollback });
  }
  // A failed mutation response does not prove the server skipped the write.
  // Earlier compensation also needs readback before restoration is claimed.
  const status = 'IN_DOUBT';
  const failedStepMayHaveCommitted = sent && isMutation(failed.operation, admin.catalog);
  const priorStepsCompensated = !rollback.some(item => item.outcome === 'FAILED') && !completed.some(item => item.step.irreversible);
  journal.record({ status, ...failure, completed: completedReceipt(completed), failedStepMayHaveCommitted, priorStepsCompensated, rollback });
  return { runId: journal.id, status, failedOperation: failed.operation, error: String(error.message), failedStepMayHaveCommitted,
    priorStepsCompensated, rollback, completed: summary(completed), ...journalFailures(journal) };
}

// Runs one planned step and returns { done } with its completed entry, or { failure } to stop the run.
async function runStep(admin, lock, journal, step, completed) {
  try {
    await lock.assertHeld();
    journal.write({ status: 'STEP_IN_FLIGHT', completed: completedReceipt(completed), next: step.operation, nextPath: receiptPath(step.args) });
  } catch (error) {
    return { failure: { step, error, sent: false } };
  }
  try {
    const result = await execute(admin, step.operation, step.args);
    const { compensate, created } = resolveCompensation(admin.config, admin.catalog, step, result);
    return { done: { step, status: result.status, location: result.location, created, compensate } };
  } catch (error) {
    return { failure: { step, error, sent: !wasNotSent(error) } };
  }
}

async function runSteps(admin, plan, lock) {
  const completed = [];
  const journal = openJournal(admin.config, plan);
  journal.write({ status: 'RUNNING', completed: [], next: plan[0].operation });
  for (const step of plan) {
    const { done, failure } = await runStep(admin, lock, journal, step, completed);
    if (failure) return rollBack(admin, lock, journal, completed, failure);
    completed.push(done);
    journal.record({ status: 'RUNNING', completed: completedReceipt(completed) });
  }
  journal.record({ status: 'COMPLETED', completed: completedReceipt(completed) });
  return { runId: journal.id, status: 'COMPLETED', completed: summary(completed), ...journalFailures(journal) };
}

// Releases the realm lock and returns the error it failed with, if any, so a failed release never
// replaces the outcome of a run whose steps are already decided.
async function releaseQuietly(lock) {
  try {
    await lock.release();
    return null;
  } catch (error) {
    return error;
  }
}

export async function runWorkflow(admin, steps, { dryRun = true } = {}) {
  const plan = preflight(admin.config, steps, admin.catalog);
  if (dryRun) return { status: 'PREFLIGHT_OK', steps: plan.map(step => ({ operation: step.operation, compensation: step.compensate?.operation ?? null })) };
  const lock = await acquireRealmLock(admin.config);
  let result;
  try {
    result = await runSteps(admin, plan, lock);
  } catch (error) {
    // Only the journal can fail here, and only before the first request is sent.
    await releaseQuietly(lock);
    throw error;
  }
  const releaseError = await releaseQuietly(lock);
  return releaseError ? { ...result, lockReleaseError: String(releaseError.message) } : result;
}
