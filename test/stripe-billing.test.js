import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  createStripeCheckoutSession,
  createStripeOffSessionPaymentIntent,
  retrieveStripeCheckoutSession,
  verifyStripeWebhook,
} from '../src/platform/stripe-billing.js';

test('Stripe checkout uses fixed credit metadata and safe return URLs', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({
      id: 'cs_test_credit',
      url: 'https://checkout.stripe.com/c/pay/cs_test_credit',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const checkout = await createStripeCheckoutSession({
    secretKey: 'sk_test_secret',
    baseUrl: 'https://webbrain.cloud',
    user: { id: 'usr_test', email: 'billing@example.com' },
    amountCents: 2500,
    fetchImpl,
  });
  assert.equal(checkout.id, 'cs_test_credit');
  assert.equal(captured.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(captured.options.headers.authorization, 'Bearer sk_test_secret');
  const form = new URLSearchParams(captured.options.body);
  assert.equal(form.get('mode'), 'payment');
  assert.equal(form.get('metadata[user_id]'), 'usr_test');
  assert.equal(form.get('metadata[credit_cents]'), '2500');
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(
    form.get('success_url'),
    'https://webbrain.cloud/billing/complete?session_id={CHECKOUT_SESSION_ID}'
  );
  assert.equal(form.get('cancel_url'), 'https://webbrain.cloud/?billing=cancelled#billing');
});

test('Stripe checkout saves a card only with explicit automatic top-up consent', async () => {
  let captured = null;
  await createStripeCheckoutSession({
    secretKey: 'sk_test_secret',
    baseUrl: 'https://webbrain.cloud',
    user: { id: 'usr_auto', email: 'auto@example.com' },
    amountCents: 2500,
    saveForAutoTopUp: true,
    autoTopUpThresholdCents: 500,
    autoTopUpAmountCents: 2500,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        id: 'cs_test_auto',
        url: 'https://checkout.stripe.com/c/pay/cs_test_auto',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const form = new URLSearchParams(captured.options.body);
  assert.equal(form.get('customer_creation'), 'always');
  assert.equal(form.get('payment_intent_data[setup_future_usage]'), 'off_session');
  assert.equal(form.get('metadata[auto_top_up_enabled]'), 'true');
  assert.equal(form.get('metadata[auto_top_up_threshold_cents]'), '500');
  assert.equal(form.get('metadata[auto_top_up_amount_cents]'), '2500');
});

test('Stripe off-session top-up confirms the saved payment method with an idempotency key', async () => {
  let captured = null;
  const paymentIntent = await createStripeOffSessionPaymentIntent({
    secretKey: 'sk_test_secret',
    customerId: 'cus_test',
    paymentMethodId: 'pm_test',
    amountCents: 2500,
    userId: 'usr_test',
    attemptId: 'atu_test',
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ id: 'pi_test', status: 'succeeded' }), { status: 200 });
    },
  });
  assert.equal(paymentIntent.id, 'pi_test');
  assert.equal(captured.options.headers['idempotency-key'], 'webbrain-auto-top-up-atu_test');
  const form = new URLSearchParams(captured.options.body);
  assert.equal(form.get('off_session'), 'true');
  assert.equal(form.get('confirm'), 'true');
});

test('Stripe checkout retrieval escapes the provider id', async () => {
  let requestedUrl = '';
  const session = await retrieveStripeCheckoutSession('cs_test/a', {
    secretKey: 'sk_test_secret',
    fetchImpl: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify({ id: 'cs_test/a', payment_status: 'paid' }), { status: 200 });
    },
  });
  assert.equal(session.payment_status, 'paid');
  assert.equal(requestedUrl, 'https://api.stripe.com/v1/checkout/sessions/cs_test%2Fa');
});

test('Stripe webhook verification accepts the valid payload and rejects tampering', () => {
  const secret = 'whsec_test';
  const timestamp = 1_800_000_000;
  const payload = Buffer.from(JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' }));
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest('hex');
  const header = `t=${timestamp},v1=${signature}`;
  assert.equal(
    verifyStripeWebhook(payload, header, secret, { now: timestamp * 1000 }).id,
    'evt_test'
  );
  assert.throws(
    () => verifyStripeWebhook(Buffer.from('{}'), header, secret, { now: timestamp * 1000 }),
    /Invalid Stripe webhook signature/
  );
});
