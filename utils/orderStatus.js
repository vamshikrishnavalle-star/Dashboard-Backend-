/**
 * ─── ORDER STATUS STATE MACHINE ──────────────────────────────────────────────
 * Defines valid transitions and human-readable labels.
 * All status changes must go through assertTransition() to prevent invalid states.
 */

const TRANSITIONS = {
  draft:               ['pending_payment', 'cancelled'],
  pending_payment:     ['payment_partial', 'confirmed', 'cancelled'],
  payment_partial:     ['confirmed', 'cancelled'],
  confirmed:           ['in_progress', 'cancelled'],
  in_progress:         ['review'],
  review:              ['completed', 'revision_requested'],
  revision_requested:  ['review'],
  completed:           [],  // terminal
  cancelled:           [],  // terminal
};

const STATUS_LABELS = {
  draft:               'Draft',
  pending_payment:     'Awaiting Payment',
  payment_partial:     'Advance Paid',
  confirmed:           'Confirmed',
  in_progress:         'In Progress',
  review:              'Under Review',
  revision_requested:  'Revision Requested',
  completed:           'Completed',
  cancelled:           'Cancelled',
};

/**
 * Returns true if the transition is valid.
 */
function canTransition(fromStatus, toStatus) {
  return (TRANSITIONS[fromStatus] || []).includes(toStatus);
}

/**
 * Throws a 400 error if the transition is not allowed.
 */
function assertTransition(fromStatus, toStatus) {
  if (!canTransition(fromStatus, toStatus)) {
    throw Object.assign(
      new Error(`Cannot move order from "${STATUS_LABELS[fromStatus]}" to "${STATUS_LABELS[toStatus]}".`),
      { status: 400 }
    );
  }
}

/**
 * After a payment is captured, determine what the order status should become.
 * totalCapuredPaise = total already captured for this order (including current payment).
 */
function resolveStatusAfterPayment(order, paymentType, totalCapturedPaise) {
  const finalPaise = Math.round(parseFloat(order.final_price_inr) * 100);

  if (paymentType === 'full' || totalCapturedPaise >= finalPaise) {
    return 'confirmed';
  }
  return 'payment_partial';
}

module.exports = { TRANSITIONS, STATUS_LABELS, canTransition, assertTransition, resolveStatusAfterPayment };
