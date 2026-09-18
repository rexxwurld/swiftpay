const mongoose = require('mongoose');

const virtualAccountSchema = new mongoose.Schema(
  {
    accountNumber: { type: String, required: true, unique: true },
    bank: { type: mongoose.Schema.Types.ObjectId, ref: 'BankPartner', required: true },
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },

    // Whether this account number is a REAL RexxPay Bank wallet ('live')
    // or a locally-generated fake number that never touches the real
    // bank ('test'). Set once, at provisioning time, and never changed -
    // an account's identity as real-vs-fake money doesn't change over
    // its lifecycle. Defaults to 'live' so pre-existing accounts (all
    // of which were real before this field existed) keep working.
    mode: { type: String, enum: ['test', 'live'], required: true, default: 'live', index: true },

    status: {
      type: String,
      enum: ['available', 'assigned', 'deactivated'],
      default: 'available',
      index: true,
    },

    assignedAt: { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },
    cooldownUntil: { type: Date, default: null, index: true },

    amountExpected: { type: Number, default: null },
    reference: { type: String, default: null },
    bankSyncStatus: {
  type: String,
  enum: ['synced', 'pending', 'ambiguous', 'failed'],
  default: 'synced',
},

    splitSubaccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Subaccount', default: null },
    splitPercentage: { type: Number, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('VirtualAccount', virtualAccountSchema);
