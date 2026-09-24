import { z } from 'zod'
import { isoDateSchema } from '../dates/index.js'
import type { Amount } from '../money/index.js'
import { PAYMENT_TERMS } from './codes.js'

// El límite de 12 dígitos en la parte entera refleja la columna Decimal(14, 2) de PostgreSQL
// (STACK.md §9, D14), igual que AMOUNT_FORMAT en money/amount.ts.
const parsedAmountSchema = z
  .string()
  .regex(/^\d{1,12}\.\d{2}$/)
  .transform((v) => v as Amount)

export const installmentSchema = z.object({
  id: z.string().min(1),
  amount: parsedAmountSchema,
  dueDate: isoDateSchema,
})
export type Installment = z.infer<typeof installmentSchema>

/** Lo que el lector extrae de un XML. Es la forma que viaja entre landing, API y admin. */
export const parsedInvoiceSchema = z.object({
  documentType: z.string().min(1),
  seriesNumber: z.string().min(1),
  issueDate: isoDateSchema,
  currency: z.string().length(3),
  issuerRuc: z.string().min(1),
  issuerName: z.string(),
  recipientRuc: z.string().min(1),
  recipientName: z.string().nullable(),
  /** Total a pagar del comprobante. Puede ser 0.00 en casos raros; por eso no usa amountSchema. */
  total: parsedAmountSchema,
  paymentTerms: z.enum(PAYMENT_TERMS).nullable(),
  /** Solo al crédito: monto neto pendiente de pago declarado en el XML (ya descuenta detracción o retención). */
  netPendingAmount: parsedAmountSchema.nullable(),
  installments: z.array(installmentSchema),
  detraction: z
    .object({ percent: z.number().min(0).max(100), amount: parsedAmountSchema })
    .nullable(),
  signed: z.boolean(),
})
export type ParsedInvoice = z.infer<typeof parsedInvoiceSchema>
