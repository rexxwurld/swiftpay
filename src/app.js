const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const {
  generalLimiter,
  authLimiter,
  webhookLimiter,
  demoLimiter,
} = require('./middleware/rateLimit.middleware');

const authRoutes = require('./modules/auth/auth.routes');
const merchantRoutes = require('./modules/merchant/merchant.routes');
const customerRoutes = require('./modules/customer/customer.routes');
const virtualAccountRoutes = require('./modules/virtualAccount/virtualAccount.routes');
const walletRoutes = require('./modules/wallet/wallet.routes');
const transactionRoutes = require('./modules/transaction/transaction.routes');
const webhookRoutes = require('./modules/webhook/webhook.routes');
const payoutRoutes = require('./modules/payout/payout.routes');
const refundRoutes = require('./modules/refund/refund.routes');
const subaccountRoutes = require('./modules/subaccount/subaccount.routes');
const recipientRoutes = require('./modules/recipient/recipient.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const paymentRoutes = require('./modules/payment/payment.routes');
const checkoutRoutes = require('./modules/checkout/checkout.routes');
const subscriptionRoutes = require('./modules/subscription/subscription.routes');
const disputeRoutes = require('./modules/dispute/dispute.routes');
const settlementRoutes = require('./modules/settlement/settlement.routes');
const demoRoutes = require('./modules/demo/demo.routes');
const refundWebhookRoutes = require('./modules/refund/refund.webhook.routes');

const {
  notFound,
  errorHandler,
} = require('./middleware/error.middleware');

const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');

const app = express();


app.set('trust proxy', 1);

app.use(cors());
app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json());
app.use(generalLimiter);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
    },
  },
}));


// Hosted checkout.
// Example:
// https://checkout-rexxpay.onrender.com/pay/9d7f8c...
//
// The token is the ONLY thing in the URL.
app.get('/pay/:checkoutToken', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      '..',
      'public',
      'pay.html'
    )
  );
});

// Public, no-signup-required demo of the checkout flow. Talks only to
// POST /api/demo/checkout (see demo.routes.js), which is test-mode-only
// and scoped to one dedicated demo merchant.
app.get('/demo', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      '..',
      'public',
      'demo.html'
    )
  );
});

// Operator dashboard (pool status + manual provisioning). Auth happens
// client-side against the existing key-protected /api/admin/* routes -
// see public/js/admin.js and src/middleware/adminKey.middleware.js.
app.get('/admin', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      '..',
      'public',
      'admin.html'
    )
  );
});


// Static frontend files.
app.use(
  express.static(
    path.join(
      __dirname,
      '..',
      'public'
    )
  )
);


// --- API versioning --------------------------------------------------
// All routes live on a versioned router (apiV1). It's mounted at both
// /api/v1 (the real, going-forward path) and /api (unversioned, kept so
// existing integrations - the hosted dashboard, pay.html, any merchant
// already wired to /api/... - don't break overnight). New integrations
// should be told to use /api/v1 explicitly; the bare /api alias is a
// deprecation runway, not a permanent second contract.
const apiV1 = express.Router();

apiV1.get('/', (req, res) => {
  res.json({
    status: true,
    message: 'SwiftPay API is running',
    version: 'v1',
  });
});

apiV1.use('/auth', authLimiter, authRoutes);
apiV1.use('/merchant', merchantRoutes);
apiV1.use('/customers', customerRoutes);
apiV1.use('/virtual-accounts', virtualAccountRoutes);
apiV1.use('/checkout', checkoutRoutes);
apiV1.use('/wallet', walletRoutes);
apiV1.use('/transactions', transactionRoutes);
apiV1.use('/webhooks', webhookLimiter, webhookRoutes);
apiV1.use('/payouts', payoutRoutes);
apiV1.use('/refunds', refundRoutes);
apiV1.use('/subaccounts', subaccountRoutes);
apiV1.use('/recipients', recipientRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/admin/settlement', settlementRoutes);
apiV1.use('/payments', paymentRoutes);
apiV1.use('/subscriptions', subscriptionRoutes);
apiV1.use('/disputes', disputeRoutes);
apiV1.use('/demo', demoLimiter, demoRoutes);
apiV1.use('/webhooks/refunds', webhookLimiter, refundWebhookRoutes);



app.use('/api/v1', apiV1);
app.use('/api', apiV1); // back-compat alias - see note above

// API docs (Swagger UI), served unversioned since it documents both paths.
try {
  const openapiDocument = YAML.load(path.join(__dirname, '..', 'docs', 'openapi.yaml'));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
} catch (err) {
  console.warn('[app] could not load OpenAPI spec for /api/docs:', err.message);
}

app.use(notFound);
app.use(errorHandler);

module.exports = app;
