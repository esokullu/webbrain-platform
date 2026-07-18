import { nowIso, randomId } from '../shared/ids.js';
import { createStripeOffSessionPaymentIntent } from './stripe-billing.js';

const AUTO_TOP_UP_RETRY_MS = 60 * 60 * 1000;

function retryAt(at) {
  return new Date(new Date(at).getTime() + AUTO_TOP_UP_RETRY_MS).toISOString();
}

export async function attemptAutoTopUp({
  store,
  config,
  account,
  at = nowIso(),
  fetchImpl = fetch,
}) {
  if (
    !account
    || account.unlimited
    || !account.auto_top_up_enabled
    || Number(account.credit_cents) > Number(account.auto_top_up_threshold_cents)
  ) {
    return { attempted: false, account };
  }
  if (!config.billing?.stripe?.secretKey) {
    return { attempted: false, account, reason: 'stripe_not_configured' };
  }
  const claimed = await store.beginAutoTopUpAttempt(account.user_id, {
    attempt_id: randomId('atu'),
    at,
  });
  if (!claimed) return { attempted: false, account: await store.getBillingAccount(account.user_id) };
  const attemptId = claimed.auto_top_up_attempt_id;
  let paymentSucceeded = false;
  try {
    const paymentIntent = await createStripeOffSessionPaymentIntent({
      secretKey: config.billing.stripe.secretKey,
      customerId: claimed.stripe_customer_id,
      paymentMethodId: claimed.stripe_payment_method_id,
      amountCents: Number(claimed.auto_top_up_amount_cents),
      userId: claimed.user_id,
      attemptId,
      fetchImpl,
    });
    if (paymentIntent.status !== 'succeeded') {
      throw Object.assign(
        new Error('The saved payment method requires confirmation before it can be charged again.'),
        { status: 402 }
      );
    }
    paymentSucceeded = true;
    const credited = await store.applyBillingCredit({
      id: randomId('btx'),
      user_id: claimed.user_id,
      amount_cents: Number(claimed.auto_top_up_amount_cents),
      kind: 'auto_top_up',
      provider: 'stripe',
      provider_ref: paymentIntent.id,
      description: `$${(Number(claimed.auto_top_up_amount_cents) / 100).toFixed(2)} automatic Stripe top-up`,
      created_at: at,
    });
    const completed = await store.completeAutoTopUpAttempt(claimed.user_id, attemptId, {
      auto_top_up_status: 'idle',
      auto_top_up_next_attempt_at: null,
      auto_top_up_last_error: null,
      updated_at: at,
    });
    return {
      attempted: true,
      succeeded: true,
      account: completed || credited.account,
      transaction: credited.transaction,
    };
  } catch (error) {
    const message = String(error?.message || 'Automatic top-up failed').slice(0, 255);
    if (paymentSucceeded) {
      const pending = await store.updateBillingAutoTopUp(claimed.user_id, {
        auto_top_up_status: 'charging',
        auto_top_up_next_attempt_at: null,
        auto_top_up_last_error: message,
        updated_at: at,
      });
      return {
        attempted: true,
        succeeded: false,
        pending_credit: true,
        account: pending,
        error: message,
      };
    }
    const failed = await store.completeAutoTopUpAttempt(claimed.user_id, attemptId, {
      auto_top_up_status: 'failed',
      auto_top_up_next_attempt_at: retryAt(at),
      auto_top_up_last_error: message,
      updated_at: at,
    });
    return {
      attempted: true,
      succeeded: false,
      account: failed || await store.getBillingAccount(claimed.user_id),
      error: message,
    };
  }
}

export async function reconcileBilling({
  store,
  config,
  at = nowIso(),
  fetchImpl = fetch,
}) {
  const metered = [];
  for (const session of await store.listBillableBrowserSessions()) {
    metered.push(await store.meterBrowserSessionUsage(session.id, {
      metered_at: at,
      rate_cents: config.billing?.browserHourCents || 10,
    }));
  }
  const topUps = [];
  for (const account of await store.listDueAutoTopUpAccounts(at)) {
    topUps.push(await attemptAutoTopUp({ store, config, account, at, fetchImpl }));
  }
  return { metered, top_ups: topUps };
}
