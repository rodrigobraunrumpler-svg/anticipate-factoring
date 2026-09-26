import { z } from 'zod'
import { isoDateSchema } from '../dates/index.js'
import type { Amount } from '../money/index.js'
import { isXmlText } from '../text/index.js'
import { PAYMENT_TERMS } from './codes.js'

// El límite de 12 dígitos en la parte entera refleja la columna Decimal(14, 2) de PostgreSQL
// (STACK.md §9, D14), igual que AMOUNT_FORMAT en money/amount.ts.
const parsedAmountSchema = z
  .string()
  .regex(/^\d{1,12}\.\d{2}$/)
  .transform((v) => v as Amount)

/**
 * Topes y formatos de lo que se lee del XML. Todo dato que viene de un archivo no confiable tiene
 * tope de tamaño: un nombre de 200 000 caracteres o miles de cuotas se rechazan aquí, no en la base
 * de datos ni en la interfaz.
 */
export const PARSED_INVOICE_LIMITS = {
  /** Razón social del emisor o del receptor. */
  maxNameLength: 1500,
  maxInstallments: 100,
} as const

/**
 * Razón social del emisor o del receptor: texto libre con tope y solo con caracteres de XML 1.0. Es
 * la gemela del tipo de las columnas de texto de la base (`invoices.issuer_name`): PostgreSQL no
 * guarda U+0000, así que un nombre que cumple esto nunca hace fallar el INSERT. El lector ya rechaza
 * esos XML como ilegibles; esto lo garantiza para toda factura que viaje con esta forma.
 */
const nameSchema = z.string().max(PARSED_INVOICE_LIMITS.maxNameLength).refine(isXmlText)

/** Serie de cuatro caracteres y correlativo de hasta ocho dígitos (`F001-123`, `E001-00000001`). */
const SERIES_NUMBER = /^[A-Z0-9]{4}-\d{1,8}$/
/** Solo dígitos: las reglas deciden después si es el RUC del pagador o del proveedor. */
const RUC_DIGITS = /^\d{1,15}$/

export const installmentSchema = z.object({
  id: z.string().regex(/^Cuota\d{1,8}$/i),
  amount: parsedAmountSchema,
  dueDate: isoDateSchema,
})
export type Installment = z.infer<typeof installmentSchema>

/** Lo que el lector extrae de un XML. Es la forma que viaja entre landing, API y admin. */
export const parsedInvoiceSchema = z.object({
  /** Catálogo 01 de SUNAT: dos dígitos. */
  documentType: z.string().regex(/^\d{2}$/),
  /** Canónica: sin espacios y en mayúsculas. */
  seriesNumber: z.string().trim().toUpperCase().regex(SERIES_NUMBER),
  issueDate: isoDateSchema,
  /** Código ISO 4217 de tres letras. Qué monedas se aceptan lo decide la regla, no el lector. */
  currency: z.string().regex(/^[A-Z]{3}$/),
  issuerRuc: z.string().regex(RUC_DIGITS),
  issuerName: nameSchema,
  recipientRuc: z.string().regex(RUC_DIGITS),
  recipientName: nameSchema.nullable(),
  /** Total a pagar del comprobante. Puede ser 0.00 en casos raros; por eso no usa amountSchema. */
  total: parsedAmountSchema,
  paymentTerms: z.enum(PAYMENT_TERMS).nullable(),
  /** Solo al crédito: monto neto pendiente de pago declarado en el XML (ya descuenta detracción o retención). */
  netPendingAmount: parsedAmountSchema.nullable(),
  installments: z.array(installmentSchema).max(PARSED_INVOICE_LIMITS.maxInstallments),
  detraction: z
    .object({ percent: z.number().min(0).max(100), amount: parsedAmountSchema })
    .nullable(),
  signed: z.boolean(),
})
export type ParsedInvoice = z.infer<typeof parsedInvoiceSchema>
