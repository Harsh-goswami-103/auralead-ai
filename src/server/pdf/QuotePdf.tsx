/**
 * The PDF presenter of a quote version (T16, C1, ADR-08): a react-pdf document built from the same
 * render model as the HTML page (src/components/quote/QuoteDocument.tsx), so text extracted from
 * the PDF carries exactly the page's total, number, version and short content hash (AT6).
 *  - Inter (with U+20B9) is registered by render.ts and embedded as a TrueType subset.
 *  - Every page has a fixed footer with the quote number, version, short hash, the P8 notice
 *    "Quotation, not a tax invoice" and "Page n of N".
 *  - Rows never split across pages; the totals and terms stay together after the last row, so a
 *    long quote paginates with its total on the last page. (No page-level lineHeight: it stops
 *    react-pdf from drawing fixed absolute elements such as the footer.)
 *  - DEMO prints the "DEMO: not a valid offer" watermark on every page (plan §10).
 * No HTML engine is involved: there is no URL, file or script surface in this document.
 */
import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { QuoteRenderModel } from '@/server/services/quotes/render-model';

export const PDF_FONT_FAMILY = 'Inter';

const INK_1 = '#111318';
const INK_2 = '#4A5060';
const RULE = '#E3E6EC';

const s = StyleSheet.create({
  page: { fontFamily: PDF_FONT_FAMILY, fontSize: 10, color: INK_1, paddingTop: 40, paddingBottom: 64, paddingHorizontal: 44 },
  watermark: { position: 'absolute', top: 380, left: 70, fontSize: 40, fontWeight: 600, color: '#F2C9A0', transform: 'rotate(-30deg)' },
  brand: { height: 4, marginBottom: 16 },
  head: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: RULE },
  sender: { fontSize: 14, fontWeight: 600 },
  muted: { color: INK_2, fontSize: 9 },
  meta: { alignItems: 'flex-end' },
  title: { fontSize: 18, fontWeight: 600 },
  label: { fontSize: 8, fontWeight: 600, color: INK_2, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 2 },
  section: { marginTop: 14 },
  tableHead: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: RULE, paddingVertical: 5, marginTop: 16 },
  th: { fontSize: 8, fontWeight: 600, color: INK_2, textTransform: 'uppercase' },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: RULE, paddingVertical: 6 },
  colName: { flexGrow: 1, flexBasis: 0, paddingRight: 8 },
  colQty: { width: 40, textAlign: 'right' },
  colUnit: { width: 90, textAlign: 'right' },
  colAmount: { width: 100, textAlign: 'right' },
  totals: { marginTop: 12, marginLeft: 'auto', width: 250 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  grand: { flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1.5, borderTopColor: INK_1, marginTop: 4, paddingTop: 5, fontSize: 12, fontWeight: 600 },
  footer: { position: 'absolute', bottom: 28, left: 44, right: 44, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: RULE, paddingTop: 6, fontSize: 8, color: INK_2 },
});

export function QuotePdf({ model }: { model: QuoteRenderModel }) {
  const t = model.totals;
  return (
    <Document
      title={`Quotation ${model.quoteNumber} ${model.versionLabel}`}
      author={model.sender.name}
      subject={`Quotation for ${model.recipient.name}`}
      creator="AuraLead AI"
      producer="AuraLead AI"
      creationDate={new Date(model.issuedAtIso)}
      language="en-IN"
    >
      <Page size="A4" style={s.page} wrap>
        {model.watermark ? (
          <Text style={s.watermark} fixed>
            {model.watermark}
          </Text>
        ) : null}
        <View style={[s.brand, { backgroundColor: model.sender.brandColor }]} />
        <View style={s.head}>
          <View>
            <Text style={s.sender}>{model.sender.name}</Text>
            {model.sender.gstin ? <Text style={s.muted}>GSTIN {model.sender.gstin}</Text> : null}
          </View>
          <View style={s.meta}>
            <Text style={s.title}>Quotation</Text>
            <Text>
              {model.quoteNumber} {model.versionLabel}
            </Text>
            <Text style={s.muted}>Issued {model.issuedOn}</Text>
            <Text style={s.muted}>Valid until {model.validUntil}</Text>
          </View>
        </View>

        <View style={s.section}>
          <Text style={s.label}>Prepared for</Text>
          <Text>{model.recipient.name}</Text>
        </View>

        <View style={s.section} wrap={false}>
          <Text style={s.label}>Scope</Text>
          <Text>{model.scopeText}</Text>
        </View>
        <View style={s.section} wrap={false}>
          <Text style={s.label}>Timeline</Text>
          <Text>{model.timelineText}</Text>
        </View>
        <View style={s.tableHead}>
          <Text style={[s.th, s.colName]}>Service</Text>
          <Text style={[s.th, s.colQty]}>Qty</Text>
          <Text style={[s.th, s.colUnit]}>Unit price</Text>
          <Text style={[s.th, s.colAmount]}>Amount</Text>
        </View>
        {model.lines.map((line) => (
          <View key={line.position} style={s.row} wrap={false}>
            <View style={s.colName}>
              <Text>{line.name}</Text>
              <Text style={s.muted}>per {line.unitLabel}</Text>
            </View>
            <Text style={s.colQty}>{String(line.qty)}</Text>
            <Text style={s.colUnit}>{line.unitPrice}</Text>
            <Text style={s.colAmount}>{line.lineTotal}</Text>
          </View>
        ))}

        {/* Totals and terms stay together, so the total is on the last page. */}
        <View wrap={false}>
          <View style={s.totals}>
            <View style={s.totalRow}>
              <Text style={s.muted}>Subtotal</Text>
              <Text>{t.subtotal}</Text>
            </View>
            {t.discount ? (
              <View style={s.totalRow}>
                <Text style={s.muted}>{t.discountLabel}</Text>
                <Text>-{t.discount}</Text>
              </View>
            ) : null}
            {t.tax ? (
              <View style={s.totalRow}>
                <Text style={s.muted}>Taxable amount</Text>
                <Text>{t.taxable}</Text>
              </View>
            ) : null}
            {t.tax ? (
              <View style={s.totalRow}>
                <Text style={s.muted}>{t.taxLabel}</Text>
                <Text>{t.tax}</Text>
              </View>
            ) : null}
            <View style={s.grand}>
              <Text>Total</Text>
              <Text>{t.total}</Text>
            </View>
          </View>

          {model.sender.termsText ? (
            <View style={s.section}>
              <Text style={s.label}>Terms</Text>
              <Text style={s.muted}>{model.sender.termsText}</Text>
            </View>
          ) : null}
        </View>

        <View style={s.footer} fixed>
          <Text>
            {model.quoteNumber} {model.versionLabel} {model.shortHash}
          </Text>
          <Text>{model.notice}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
