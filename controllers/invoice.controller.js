/**
 * ─── INVOICE CONTROLLER ──────────────────────────────────────────────────────
 * GET /api/orders/:orderId/invoice  — Stream a PDF invoice for the order
 *
 * Availability: order must have at least one captured payment.
 */

const PDFDocument = require('pdfkit');
const supabase    = require('../config/supabase');

const isProd    = process.env.NODE_ENV === 'production';
const log       = (...a) => { if (!isProd) console.error(...a); };
const sendError = (res, s, m) => res.status(s).json({ success: false, error: m });

// ─── Colours ──────────────────────────────────────────────────────────────────
const BRAND   = '#F97316'; // orange-500
const DARK    = '#111827'; // gray-900
const MID     = '#6B7280'; // gray-500
const LIGHT   = '#F3F4F6'; // gray-100
const GREEN   = '#16A34A';
const WHITE   = '#FFFFFF';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const inr = (n) =>
  '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0 });

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

function paymentStatusLabel(order, capturedPaise) {
  const totalPaise = Math.round(order.final_price_inr * 100);
  if (capturedPaise >= totalPaise) return { label: 'PAID IN FULL', color: GREEN };
  if (capturedPaise > 0)           return { label: 'ADVANCE PAID', color: BRAND };
  return                                  { label: 'UNPAID',        color: MID  };
}

// ─── Row helper for the price table ──────────────────────────────────────────
function tableRow(doc, y, label, value, bold = false, valueColor = DARK) {
  if (bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
  doc.fontSize(10).fillColor(MID).text(label, 55, y, { width: 300 });
  doc.fontSize(10).fillColor(valueColor).font(bold ? 'Helvetica-Bold' : 'Helvetica')
     .text(value, 355, y, { width: 180, align: 'right' });
}

// ─── Divider ─────────────────────────────────────────────────────────────────
function divider(doc, y, color = LIGHT) {
  doc.moveTo(55, y).lineTo(540, y).strokeColor(color).lineWidth(1).stroke();
}

// ─── GET /api/orders/:orderId/invoice ────────────────────────────────────────
const downloadInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;

    // 1. Fetch order + service
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select(`
        *,
        services ( display_name, description )
      `)
      .eq('id', orderId)
      .eq('client_id', req.user.id)
      .single();

    if (orderErr || !order) return sendError(res, 404, 'Order not found.');

    // 2. Fetch payments
    const { data: payments } = await supabase
      .from('payments')
      .select('id, payment_type, status, amount_paise, paid_at')
      .eq('order_id', orderId)
      .order('paid_at', { ascending: true });

    const captured = (payments || []).filter((p) => p.status === 'captured');
    if (captured.length === 0)
      return sendError(res, 400, 'Invoice is not available until payment has been made.');

    // 3. Fetch client profile
    const { data: profile } = await supabase
      .from('users')
      .select('full_name, email, organization_name, whatsapp_number')
      .eq('id', req.user.id)
      .single();

    // 4. Compute totals
    const capturedPaise  = captured.reduce((s, p) => s + p.amount_paise, 0);
    const amountPaid     = capturedPaise / 100;
    const balanceDue     = Math.max(order.final_price_inr - amountPaid, 0);
    const { label: statusLabel, color: statusColor } = paymentStatusLabel(order, capturedPaise);
    const invoiceNumber  = `INV-${order.order_number}`;
    const invoiceDate    = fmtDate(captured[captured.length - 1].paid_at || order.updated_at);
    const serviceName    = order.services?.display_name || order.service_type.replace(/_/g, ' ');

    // 5. Build PDF
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: {
      Title:    invoiceNumber,
      Author:   'AI Agentic Verse',
      Subject:  `Invoice for ${serviceName}`,
      Creator:  'AI Agentic Verse Dashboard',
    }});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoiceNumber}.pdf"`);
    doc.pipe(res);

    // ── Header bar ────────────────────────────────────────────────────────────
    doc.rect(0, 0, 595, 90).fill(DARK);
    doc.fontSize(22).font('Helvetica-Bold').fillColor(WHITE)
       .text('AI Agentic Verse', 55, 28);
    doc.fontSize(9).font('Helvetica').fillColor(BRAND)
       .text('Creative Production Platform', 55, 56);

    // Status badge (top-right)
    const badgeX = 370, badgeY = 32, badgeW = 120, badgeH = 26;
    doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 4).fill(statusColor);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE)
       .text(statusLabel, badgeX, badgeY + 8, { width: badgeW, align: 'center' });

    // ── Invoice meta ─────────────────────────────────────────────────────────
    doc.fontSize(18).font('Helvetica-Bold').fillColor(DARK)
       .text('INVOICE', 55, 110);
    doc.fontSize(10).font('Helvetica').fillColor(MID)
       .text(invoiceNumber, 55, 134);

    doc.fontSize(9).font('Helvetica').fillColor(MID);
    doc.text('Invoice Date', 380, 110);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text(invoiceDate, 380, 123);

    doc.fontSize(9).font('Helvetica').fillColor(MID).text('Order Number', 380, 142);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(DARK).text(order.order_number, 380, 155);

    divider(doc, 172, LIGHT);

    // ── Bill To ──────────────────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor(BRAND)
       .text('BILL TO', 55, 185);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(DARK)
       .text(profile?.full_name || req.user.email, 55, 198);
    doc.fontSize(9).font('Helvetica').fillColor(MID);
    if (profile?.organization_name) doc.text(profile.organization_name, 55, 213);
    doc.text(profile?.email || req.user.email, 55, profile?.organization_name ? 226 : 213);
    if (profile?.whatsapp_number)   doc.text(profile.whatsapp_number, 55, profile?.organization_name ? 239 : 226);

    // ── Service section header ────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor(BRAND)
       .text('SERVICE DETAILS', 380, 185);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(DARK)
       .text(serviceName, 380, 198, { width: 160 });
    doc.fontSize(9).font('Helvetica').fillColor(MID)
       .text('Service Type', 380, 216)
       .text(order.service_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), 380, 228);

    divider(doc, 270, LIGHT);

    // ── Price breakdown table header ─────────────────────────────────────────
    doc.rect(55, 280, 485, 28).fill(DARK);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(WHITE)
       .text('DESCRIPTION', 65, 290, { width: 280 })
       .text('AMOUNT', 355, 290, { width: 180, align: 'right' });

    let rowY = 322;

    // Base price
    tableRow(doc, rowY, serviceName, inr(order.base_price_inr)); rowY += 22;

    // Brief fields (qty, count, etc.)
    const brief = order.brief || {};
    if (brief.shot_count)   { tableRow(doc, rowY, `  Photos × ${brief.shot_count}`, ''); rowY += 18; }
    if (brief.video_count)  { tableRow(doc, rowY, `  Videos × ${brief.video_count}`, ''); rowY += 18; }
    if (brief.ad_count)     { tableRow(doc, rowY, `  Ads × ${brief.ad_count}`, ''); rowY += 18; }
    if (brief.video_length) { tableRow(doc, rowY, `  Length: ${brief.video_length} min`, ''); rowY += 18; }
    if (brief.video_type)   { tableRow(doc, rowY, `  Type: ${brief.video_type}`, ''); rowY += 18; }

    divider(doc, rowY + 4, LIGHT); rowY += 14;

    if (order.discount_inr && order.discount_inr > 0) {
      tableRow(doc, rowY, 'Discount', `- ${inr(order.discount_inr)}`, false, GREEN);
      rowY += 22;
    }

    divider(doc, rowY + 2, '#D1D5DB'); rowY += 12;

    // Total
    tableRow(doc, rowY, 'Total', inr(order.final_price_inr), true); rowY += 26;

    // Amount paid
    tableRow(doc, rowY, 'Amount Paid', inr(amountPaid), false, GREEN); rowY += 22;

    // Balance due
    if (balanceDue > 0) {
      tableRow(doc, rowY, 'Balance Due', inr(balanceDue), true, BRAND); rowY += 22;
    }

    divider(doc, rowY + 6, LIGHT); rowY += 20;

    // ── Payment history ───────────────────────────────────────────────────────
    doc.fontSize(8).font('Helvetica-Bold').fillColor(BRAND).text('PAYMENT HISTORY', 55, rowY);
    rowY += 16;

    captured.forEach((p) => {
      const ptLabel = p.payment_type.charAt(0).toUpperCase() + p.payment_type.slice(1);
      const ptDate  = p.paid_at ? fmtDate(p.paid_at) : 'N/A';
      doc.fontSize(9).font('Helvetica').fillColor(MID)
         .text(`${ptLabel} payment — ${ptDate}`, 55, rowY, { width: 300 });
      doc.fontSize(9).font('Helvetica-Bold').fillColor(GREEN)
         .text(inr(p.amount_paise / 100), 355, rowY, { width: 180, align: 'right' });
      rowY += 18;
    });

    // ── Expected delivery ─────────────────────────────────────────────────────
    if (order.expected_delivery_at) {
      rowY += 10;
      divider(doc, rowY, LIGHT); rowY += 14;
      doc.fontSize(9).font('Helvetica').fillColor(MID)
         .text('Expected Delivery:', 55, rowY);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(DARK)
         .text(fmtDate(order.expected_delivery_at), 200, rowY);
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = 760;
    doc.rect(0, footerY, 595, 82).fill(LIGHT);
    doc.fontSize(9).font('Helvetica').fillColor(MID)
       .text('Thank you for your business!', 55, footerY + 14, { align: 'center', width: 485 });
    doc.fontSize(8).font('Helvetica').fillColor(MID)
       .text('AI Agentic Verse  •  support@aiagentic.com', 55, footerY + 32, { align: 'center', width: 485 });
    doc.fontSize(7).font('Helvetica').fillColor('#9CA3AF')
       .text(
         'This is a computer-generated invoice and does not require a physical signature.',
         55, footerY + 50, { align: 'center', width: 485 }
       );

    doc.end();

  } catch (err) {
    log('[downloadInvoice]', err);
    if (!res.headersSent) sendError(res, 500, 'Failed to generate invoice.');
  }
};

module.exports = { downloadInvoice };
