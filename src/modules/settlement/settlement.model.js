// src/modules/settlement/settlement.model.js
//
// One row per settlement cycle run (see settlement.service.runSettlementCycle,
// invoked on a schedule by scripts/run-settlement.js). A "cycle" covers
// both phases of the pipeline in one pass:
//
//   pending_settlement --(cutoff passed)--> settled
//   settled            --(availability delay passed)--> available
//
// This is the "settlement records/references" piece from the settlement
// gap list - lets you answer "which batch moved this transaction, and
// when did that batch run" instead of settlement just being an invisible
// side effect of a cron job.

const mongoose = require('mongoose');

const settlementBatchSchema = new mongoose.Schema(
  {
    batchReference: { type: String, required: true, unique: true },

    // Which half of the pipeline this batch performed. Kept separate
    // (rather than one batch doing both) so each phase's cutoff, count,
    // and failure mode can be reasoned about independently.
    phase: { type: String, enum: ['settle', 'make_available'], required: true },

    currency: { type: String, required: true, default: 'NGN' },

    // Every batch is scoped to exactly one mode. Before this field
    // existed, runSettlePhase/runMakeAvailablePhase queried Transaction
    // by currency alone, so a single batch (and its totalAmount/
    // transactionCount) could silently mix real settled money with
    // sandbox test transactions - each individual transaction still
    // credited the CORRECT per-mode wallet (getOrCreateWallet takes
    // mode), so this was never a wallet-crediting bug, but it made a
    // batch's own totals meaningless for reconciliation/audit ("how much
    // *real* money settled in this batch" had no answer) - see
    // requirement: test/live must stay fully separated, settlement
    // included.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live' },

    // The cutoff timestamp used to select transactions for this batch -
    // everything eligible as of this instant, not "as of whenever the
    // job happened to finish running".
    cutoffTime: { type: Date, required: true },

    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
    },

    transactionCount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 }, // minor units
    failedTransactionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' }],

    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SettlementBatch', settlementBatchSchema);
