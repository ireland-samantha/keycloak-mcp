import { runWorkflow } from './runner.js';

export class WorkflowBuilder {
  constructor(admin) { this.admin = admin; this.steps = []; }
  step(operation, args = {}, compensation = null) {
    this.steps.push({ operation, args, ...(compensation ? { compensate: compensation } : {}) });
    return this;
  }
  plan() { return runWorkflow(this.admin, this.steps, { dryRun: true }); }
  run() { return runWorkflow(this.admin, this.steps, { dryRun: false }); }
}
