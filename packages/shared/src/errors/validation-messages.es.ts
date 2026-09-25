/**
 * Mensajes de validación para personas (esquemas Zod y lectura del XML), agrupados por dominio.
 * Junto con `MESSAGES_ES` (problemas de negocio) y `API_MESSAGES_ES` (respuestas de la API) son el
 * único lugar de `shared` con texto en español para el usuario final:
 * los dominios toman sus mensajes de aquí, así ninguna validación deja pasar el inglés por defecto de
 * Zod (`zodResolver` lo mostraría tal cual en un formulario en español) y traducir la interfaz es
 * cambiar esta tabla, no buscar textos por el código.
 *
 * Los mensajes de los esquemas son finales (sin marcadores). Los nombres de campos del XML con
 * `{installment}` se completan con `formatMessage` y viajan en el dato `{field}` de
 * `XML_MISSING_REQUIRED_FIELD` y `XML_INVALID_FIELD`.
 */
export const VALIDATION_MESSAGES_ES = {
  dates: {
    isoDate: 'La fecha debe tener el formato AAAA-MM-DD.',
  },
  payer: {
    publicPayer: 'Los datos del pagador no tienen el formato esperado.',
    slug: 'El slug solo admite minúsculas, números y guiones.',
    slugMax: 'El slug no puede tener más de 60 caracteres.',
    legalNameMin: 'La razón social debe tener al menos 3 caracteres.',
    legalNameMax: 'La razón social no puede tener más de 200 caracteres.',
    shortNameMin: 'El nombre corto debe tener al menos 2 caracteres.',
    shortNameMax: 'El nombre corto no puede tener más de 40 caracteres.',
    advancePercent: 'El porcentaje de adelanto debe estar entre 1 y 100, con hasta dos decimales.',
    minTermDays: 'El plazo mínimo debe ser un número entero de días, desde 0.',
    maxInvoices: 'El máximo de facturas por solicitud debe ser un número entero mayor que cero.',
    allowedCurrencies: 'Elige al menos una moneda válida (PEN o USD).',
    accentColor: 'El color debe ser hexadecimal, por ejemplo #0E7C86.',
    logoUrl: 'El logo debe ser una URL http o https válida.',
    texts: 'Los textos del pagador deben ser pares de clave y texto.',
    textKey:
      'La clave del texto debe ser camelCase (iniciar en minúscula) y tener como máximo 40 caracteres.',
    textValueMax: 'El texto no debe superar los 2000 caracteres.',
    textsTooMany: 'Hay demasiados textos (máximo 30).',
  },
  advanceRequestForm: {
    form: 'La solicitud no tiene el formato esperado.',
    contact: 'Faltan los datos de contacto o no tienen el formato esperado.',
    company: 'Faltan los datos de la empresa o no tienen el formato esperado.',
    financing: 'Faltan los datos del financiamiento o no tienen el formato esperado.',
    consents: 'Faltan los consentimientos o no tienen el formato esperado.',
    source: 'Los datos de origen de la visita no tienen el formato esperado.',
    fullNameMin: 'Escribe tu nombre completo.',
    fullNameMax: 'El nombre no puede tener más de 120 caracteres.',
    mobile: 'El celular debe tener 9 dígitos y empezar con 9.',
    emailMax: 'El correo no puede tener más de 254 caracteres.',
    email: 'El correo no es válido.',
    isLegalRepresentative: 'Indica si eres representante legal de la empresa.',
    jobTitleMin: 'El cargo debe tener al menos 2 caracteres.',
    jobTitleMax: 'El cargo no puede tener más de 80 caracteres.',
    jobTitleRequired: 'Indica tu cargo en la empresa.',
    contactTimeSlot: 'Selecciona un horario de contacto válido.',
    legalNameMin: 'La razón social debe tener al menos 3 caracteres.',
    legalNameMax: 'La razón social no puede tener más de 200 caracteres.',
    purposeMax: 'El destino del financiamiento no puede tener más de 500 caracteres.',
    cavaliRegistration: 'Selecciona una opción válida de registro en CAVALI.',
    terms: 'Debes aceptar los términos y condiciones.',
    personalData: 'Debes autorizar el tratamiento de tus datos personales.',
    termsVersionMin: 'Falta la versión de los términos y condiciones.',
    termsVersionMax: 'La versión de los términos y condiciones no es válida.',
    privacyVersionMin: 'Falta la versión de la política de privacidad.',
    privacyVersionMax: 'La versión de la política de privacidad no es válida.',
    utm: 'Los parámetros de origen deben ser pares de clave y texto.',
    utmKey: 'Los parámetros de origen solo pueden usar claves utm_* de hasta 40 caracteres.',
    utmValueMax: 'El valor del parámetro de origen es demasiado largo.',
    utmTooMany: 'Hay demasiados parámetros de origen (máximo 10).',
    referrer: 'La URL de referencia no es válida.',
    referrerMax: 'La URL de referencia no puede tener más de 2000 caracteres.',
  },
  money: {
    currency: 'Selecciona una moneda válida (PEN o USD).',
  },
  user: {
    role: 'Selecciona un rol válido.',
  },
  supplierDocument: {
    type: 'Selecciona un tipo de documento válido.',
    status: 'Selecciona un estado de documento válido.',
  },
  advanceRequest: {
    statusChange: 'El cambio de estado no tiene el formato esperado.',
    publicCode: 'El código de solicitud no es válido.',
    status: 'Selecciona un estado de solicitud válido.',
    closeReason: 'Selecciona un motivo de cierre válido.',
    version: 'La versión de la solicitud no es válida; recarga la página.',
    closeReasonDetailMax: 'El detalle del motivo no puede tener más de 500 caracteres.',
  },
  invoiceXml: {
    /** Nombre en español de cada dato que el lector extrae del XML. */
    fields: {
      documentType: 'tipo de comprobante',
      seriesNumber: 'serie y número',
      issueDate: 'fecha de emisión',
      currency: 'moneda',
      issuerRuc: 'RUC del emisor',
      issuerName: 'razón social del emisor',
      recipientRuc: 'RUC del receptor',
      recipientName: 'razón social del receptor',
      total: 'total',
      paymentTerms: 'forma de pago',
      netPendingAmount: 'monto neto pendiente',
      installments: 'cuotas',
      installmentDueDates: 'fechas de vencimiento (cuotas)',
      installmentDueDate: 'fecha de vencimiento de {installment}',
      installmentAmount: 'monto de {installment}',
      detractionPercent: 'porcentaje de detracción',
      detractionAmount: 'monto de detracción',
      signed: 'firma digital',
    },
    /** Catálogo 01 de SUNAT en español (dato `{kind}` de DOCUMENT_TYPE_NOT_ALLOWED). */
    documentTypes: {
      '01': 'factura',
      '03': 'boleta de venta',
      '07': 'nota de crédito',
      '08': 'nota de débito',
    },
    /** Qué es el documento cuando la raíz del XML no es `Invoice` (dato `{kind}` de XML_NOT_AN_INVOICE). */
    documentKinds: {
      ApplicationResponse: 'constancia de recepción (CDR)',
      CreditNote: 'nota de crédito',
      DebitNote: 'nota de débito',
      SummaryDocuments: 'resumen diario',
      VoidedDocuments: 'comunicación de baja',
    },
    unknownDocumentKind: 'desconocido',
  },
} as const
