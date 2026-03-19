/**
 * ─── PRICING UTILITY ─────────────────────────────────────────────────────────
 * All pricing logic lives here. Controllers import these helpers.
 * Prices are always locked at order creation — immune to future catalog changes.
 */

/**
 * Compute full pricing breakdown for an order.
 * discountInr is capped at 50% of base price.
 */
function computeOrderPricing(service, discountInr = 0) {
  const base       = parseFloat(service.base_price_inr);
  const discount   = Math.min(Math.max(parseFloat(discountInr) || 0, 0), base * 0.5);
  const final      = round2(base - discount);
  const advancePct = service.advance_percent; // e.g. 50
  const advance    = round2(final * advancePct / 100);
  const balance    = round2(final - advance);

  return {
    base_price_inr:  base,
    advance_percent: advancePct,
    advance_amount:  advance,
    balance_amount:  balance,
    discount_inr:    discount,
    final_price_inr: final,
  };
}

/**
 * Calculate base price dynamically based on service type and brief inputs.
 * Used at order creation to override the catalog base_price when needed.
 */
function calculateDynamicPrice(serviceType, brief) {
  switch (serviceType) {
    case 'ai_avatar_video':
      // Fixed per order
      return 15000;

    case 'product_photo_shoot': {
      const count = Math.max(parseInt(brief.shot_count) || 1, 1);
      return count * 2000;
    }

    case 'product_video_shoot': {
      const basePerVideo = brief.video_type === 'professional' ? 5000 : 3000;
      const count        = Math.max(parseInt(brief.video_count) || 1, 1);
      const lengthMin    = parseFloat(brief.length_min) || 1;
      const lengthFactor = lengthMin > 2 ? 1.5 : 1.0;
      return round2(count * basePerVideo * lengthFactor);
    }

    case 'ai_ugc_ad_creator': {
      const adCount = Math.max(parseInt(brief.ad_count) || 1, 1);
      return adCount * 2500;
    }

    default:
      throw Object.assign(new Error(`Unknown service type: ${serviceType}`), { status: 400 });
  }
}

/**
 * Determine the INR amount due for a specific payment type,
 * accounting for payments already captured.
 */
async function getPaymentAmount(order, paymentType, supabase) {
  const { data: captured } = await supabase
    .from('payments')
    .select('payment_type, amount_paise')
    .eq('order_id', order.id)
    .eq('status', 'captured');

  const byType = {};
  (captured || []).forEach((p) => {
    byType[p.payment_type] = (byType[p.payment_type] || 0) + p.amount_paise;
  });

  switch (paymentType) {
    case 'advance':
      if (byType.advance) throw Object.assign(new Error('Advance already paid.'), { status: 409 });
      return parseFloat(order.advance_amount);

    case 'balance':
      if (!byType.advance && !byType.full)
        throw Object.assign(new Error('Pay advance first.'), { status: 400 });
      if (byType.balance) throw Object.assign(new Error('Balance already paid.'), { status: 409 });
      return parseFloat(order.balance_amount);

    case 'full':
      if (byType.advance || byType.full)
        throw Object.assign(new Error('Payment already initiated. Use "balance" to pay remaining.'), { status: 409 });
      return parseFloat(order.final_price_inr);

    default:
      throw Object.assign(new Error('Invalid payment type. Use: advance, balance, or full.'), { status: 400 });
  }
}

/** Convert INR to paise (smallest unit) for gateway APIs */
const toPaise  = (inr)   => Math.round(parseFloat(inr) * 100);

/** Convert paise back to INR string */
const fromPaise = (paise) => (paise / 100).toFixed(2);

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { computeOrderPricing, calculateDynamicPrice, getPaymentAmount, toPaise, fromPaise };
