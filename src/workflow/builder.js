import { runWorkflow } from './runner.js';

export class WorkflowBuilder {
  constructor(admin) { this.admin = admin; this.steps = []; }
  // `options.irreversible` marks the step as a runWorkflow step's `irreversible: true` does.
  step(operation, args = {}, compensation = null, { irreversible = false } = {}) {
    this.steps.push({ operation, args, ...(compensation ? { compensate: compensation } : {}), ...(irreversible ? { irreversible: true } : {}) });
    return this;
  }
  plan() { return runWorkflow(this.admin, this.steps, { dryRun: true }); }
  run() { return runWorkflow(this.admin, this.steps, { dryRun: false }); }
}
