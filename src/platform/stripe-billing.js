import { createHmac, timingSafeEqual } from 'node:crypto';

function stripeError(status, body) {
  const error = new Error(body?.error?.message || `Stripe request failed with status ${status}`);
  error.status = status >= 500 ? 502 : 400;
  return error;
}

async function stripeRequest(path, {
  secretKey,
  method = 'GET',
  form = null,
  idempotencyKey = '',
  fetchImpl = fetch,
} = {}) {
  if (!secretKey) {
    throw Object.assign(new Error('Stripe checkout is not configured yet.'), { status: 503 });
  }
  const response = await fetchImpl(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) throw stripeError(response.status, body);
  return body;
}

export async function createStripeCheckoutSession({
  secretKey,
  baseUrl,
  user,
  amountCents,
  customerId = '',
  saveForAutoTopUp = false,
  autoTopUpThresholdCents = 0,
  autoTopUpAmountCents = 0,
  fetchImpl = fetch,
}) {
  const successUrl = `${new URL('/billing/complete', baseUrl)}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = new URL('/', baseUrl);
  cancelUrl.searchParams.set('billing', 'cancelled');
  cancelUrl.hash = 'billing';

  const checkout = await stripeRequest('/checkout/sessions', {
    secretKey,
    method: 'POST',
    fetchImpl,
    form: {
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl.toString(),
      ...(customerId ? { customer: customerId } : { customer_email: user.email }),
      ...(!customerId && saveForAutoTopUp ? { customer_creation: 'always' } : {}),
      'metadata[user_id]': user.id,
      'metadata[credit_cents]': String(amountCents),
      ...(saveForAutoTopUp ? {
        'metadata[auto_top_up_enabled]': 'true',
        'metadata[auto_top_up_threshold_cents]': String(autoTopUpThresholdCents),
        'metadata[auto_top_up_amount_cents]': String(autoTopUpAmountCents),
        'payment_intent_data[setup_future_usage]': 'off_session',
      } : {}),
      'payment_intent_data[metadata][user_id]': user.id,
      'payment_intent_data[metadata][credit_cents]': String(amountCents),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][price_data][product_data][name]': 'WebBrain Cloud credit',
      'line_items[0][price_data][product_data][description]': `$${(amountCents / 100).toFixed(2)} platform balance`,
    },
  });
  let checkoutUrl = null;
  try {
    checkoutUrl = new URL(checkout?.url);
  } catch {
    checkoutUrl = null;
  }
  if (!String(checkout?.id || '').startsWith('cs_') || checkoutUrl?.protocol !== 'https:') {
    throw Object.assign(new Error('Stripe did not return a valid Checkout Session.'), { status: 502 });
  }
  return checkout;
}

export async function retrieveStripeCheckoutSession(sessionId, {
  secretKey,
  fetchImpl = fetch,
} = {}) {
  return await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    secretKey,
    fetchImpl,
  });
}

export async function retrieveStripePaymentIntent(paymentIntentId, {
  secretKey,
  fetchImpl = fetch,
} = {}) {
  return await stripeRequest(`/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    secretKey,
    fetchImpl,
  });
}

export async function createStripeOffSessionPaymentIntent({
  secretKey,
  customerId,
  paymentMethodId,
  amountCents,
  userId,
  attemptId,
  fetchImpl = fetch,
}) {
  const paymentIntent = await stripeRequest('/payment_intents', {
    secretKey,
    method: 'POST',
    idempotencyKey: `webbrain-auto-top-up-${attemptId}`,
    fetchImpl,
    form: {
      amount: String(amountCents),
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: 'true',
      confirm: 'true',
      description: `$${(amountCents / 100).toFixed(2)} WebBrain automatic credit top-up`,
      'metadata[user_id]': userId,
      'metadata[credit_cents]': String(amountCents),
      'metadata[auto_top_up_attempt_id]': attemptId,
    },
  });
  if (!String(paymentIntent?.id || '').startsWith('pi_')) {
    throw Object.assign(new Error('Stripe did not return a valid PaymentIntent.'), { status: 502 });
  }
  return paymentIntent;
}

export function verifyStripeWebhook(rawBody, signatureHeader, webhookSecret, {
  now = Date.now(),
  toleranceSeconds = 300,
} = {}) {
  if (!webhookSecret) {
    throw Object.assign(new Error('Stripe webhook is not configured yet.'), { status: 503 });
  }
  const parts = String(signatureHeader || '').split(',').map(part => part.trim());
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || !signatures.length) {
    throw Object.assign(new Error('Invalid Stripe webhook signature.'), { status: 400 });
  }
  if (Math.abs(Math.floor(now / 1000) - timestampNumber) > toleranceSeconds) {
    throw Object.assign(new Error('Expired Stripe webhook signature.'), { status: 400 });
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestampNumber}.`)
    .update(body)
    .digest();
  const valid = signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  if (!valid) {
    throw Object.assign(new Error('Invalid Stripe webhook signature.'), { status: 400 });
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid Stripe webhook payload.'), { status: 400 });
  }
}
