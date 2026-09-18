// src/modules/subscription/invoice.model.js
//
// An invoice is a bill for one billing cycle of a subscription. SwiftPay
// has no saved-card/token rail to auto-charge, so an invoice is settled
// the same way any other inbound payment is: the customer pays into a
// dedicated virtual account, and the webhook that lands on that account
// marks the invoice paid. generateDueInvoices() creates the invoice AND
// the virtual account together so the customer always has somewhere to
// pay.

const mongoose = require('mongoose');
const { nanoid } = require('nanoid');

const invoiceSchema = new mongoose.Schema(
  {
    merchant: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true },

    invoiceNumber: { type: String, required: true, unique: true, default: () => `inv_${nanoid(14)}` },

    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },
    // Copied from subscription.mode - see plan.model.js for why this
    // matters. Ensures the cron sweep in generateDueInvoices() can never
    // pass the wrong mode to assignVirtualAccount().
    mode: { type: String, enum: ['test', 'live'], required: true },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    dueDate: { type: Date, required: true },

    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'void'],
      default: 'pending',
    },

    // The virtual account the customer pays this invoice into.
    virtualAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', default: null },
    // The transaction that actually paid it, once one lands.
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

invoiceSchema.index({ merchant: 1, status: 1 });
invoiceSchema.index({ subscription: 1, periodStart: 1 }, { unique: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
