const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
  reference: { type: String, required: true, unique: true },
  idempotencyKey: { type: String, default: null },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true, default: 'NGN' },
  mode: { type: String, enum: ['test', 'live'], required: true },
  destinationBankCode: { type: String, required: true },
  destinationAccountNumber: { type: String, required: true },
  destinationAccountName: { type: String, required: true },
  status: { type: String, enum: ['pending','reserved','processing','finalizing','successful','failed','ambiguous','reversing','reversed'], default: 'pending' },
  providerRef: { type: String, default: null },
  failureReason: { type: String, default: null },
  submittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

withdrawalSchema.index({ merchant: 1, idempotencyKey: 1, mode: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
withdrawalSchema.index({ providerRef: 1 }, { sparse: true });
module.exports = mongoose.model('Withdrawal', withdrawalSchema);
