/**
 * Datos iniciales para desarrollo local: los pagadores de ejemplo, las versiones legales de
 * desarrollo y, si se pide, un usuario administrador.
 *
 * Se puede repetir: nunca pisa lo que ya existe. Los pagadores se crean con `update: {}` y las
 * versiones legales con `skipDuplicates`, así que las condiciones que alguien editó en la base
 * quedan como están.
 *
 * Solo corre contra una base local (127.0.0.1, localhost, ::1 o el servicio `postgres` de Compose) y
 * nunca con NODE_ENV=production. Para una base remota que no es producción (staging), exporta
 * SEED_ALLOW_REMOTE=1 a propósito. Los pagadores reales y las versiones legales publicadas llegan
 * desde el admin o con una migración de datos revisada, nunca con este seed.
 *
 * Administrador opcional: se crea si `SEED_ADMIN_EMAIL` y `SEED_ADMIN_PASSWORD` (sección del seed de
 * `apps/api/.env`, o en la línea de comandos) tienen valor. La contraseña nunca se guarda en el
 * repositorio: `SEED_ADMIN_PASSWORD='una-clave-de-12-o-mas' pnpm db:seed`.
 */
import { createHash } from 'node:crypto'
import { type PublicPayer, publicPayerSchema } from '@anticipate/shared/payer'
import { PrismaPg } from '@prisma/adapter-pg'
import argon2 from 'argon2'
import pg from 'pg'
import { PrismaClient } from '../src/infrastructure/prisma/generated/client.js'

try {
  process.loadEnvFile()
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'postgres'])

/** La URL de la base del seed, o un error que explica por qué no corre contra ella. */
function seedDatabaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.NODE_ENV === 'production') {
    throw new Error('El seed no corre con NODE_ENV=production: sus datos son de ejemplo.')
  }
  const url = env.DATABASE_DIRECT_URL?.trim() || env.DATABASE_URL?.trim()
  if (!url) throw new Error('Falta DATABASE_URL (o DATABASE_DIRECT_URL) para correr el seed.')
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error('DATABASE_URL no es una URL válida.')
  }
  if (!LOCAL_HOSTS.has(host) && env.SEED_ALLOW_REMOTE !== '1') {
    throw new Error(
      `El seed solo corre contra una base local y esta apunta a «${host}». Si es staging y lo quieres a propósito, exporta SEED_ALLOW_REMOTE=1.`,
    )
  }
  return url
}

/**
 * Pagadores de ejemplo. DATOS DE EJEMPLO: el RUC, el porcentaje, el plazo mínimo y el máximo de
 * facturas de SEA se reemplazan en la base por los acordados antes de salir a producción.
 */
const PAYERS: readonly PublicPayer[] = [
  {
    slug: 'sea',
    ruc: '20131312955',
    legalName: 'Servicios Energéticos Ambientales S.A.',
    shortName: 'SEA',
    advancePercent: 80,
    minTermDays: 15,
    maxInvoices: 10,
    allowedCurrencies: ['PEN', 'USD'],
    accentColor: '#0E7C86',
    logoUrl: null,
    texts: {
      title: 'Adelanta tus facturas a SEA',
      subtitle: 'Cobra hoy lo que SEA te pagará al vencimiento',
    },
  },
]

/**
 * Versiones legales de DESARROLLO: la landing local envía `2026-09` en `termsVersion` y
 * `privacyVersion`. El `sha256` es el del texto de relleno, no el de un texto publicado.
 */
const DEVELOPMENT_LEGAL_DOCUMENTS = [
  {
    type: 'TERMS' as const,
    version: '2026-09',
    url: 'http://localhost:4321/legal/terminos',
    text: 'Términos y condiciones de desarrollo. No es el texto publicado.',
  },
  {
    type: 'PERSONAL_DATA' as const,
    version: '2026-09',
    url: 'http://localhost:4321/legal/datos-personales',
    text: 'Política de datos personales de desarrollo. No es el texto publicado.',
  },
]

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const pool = new pg.Pool({
  connectionString: seedDatabaseUrl(process.env),
  max: 2,
  application_name: 'anticipate-seed',
})
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

try {
  for (const candidate of PAYERS) {
    // El mismo contrato que valida GET /api/v1/payers: un pagador de ejemplo mal escrito falla aquí.
    const payer = publicPayerSchema.parse(candidate)
    await prisma.payer.upsert({
      where: { slug: payer.slug },
      create: { ...payer, advancePercent: payer.advancePercent.toFixed(2) },
      update: {},
    })
  }

  const legal = await prisma.legalDocumentVersion.createMany({
    data: DEVELOPMENT_LEGAL_DOCUMENTS.map(({ text, ...document }) => ({
      ...document,
      sha256: sha256(text),
      publishedAt: new Date('2026-09-01T05:00:00.000Z'),
    })),
    skipDuplicates: true,
  })

  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() ?? ''
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? ''
  const seedAdmin = adminEmail !== '' && adminPassword !== ''
  if (seedAdmin) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
      throw new Error('SEED_ADMIN_EMAIL no es un correo válido.')
    }
    if (adminPassword.length < 12) {
      throw new Error('SEED_ADMIN_PASSWORD debe tener al menos 12 caracteres.')
    }
    const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id })
    await prisma.user.upsert({
      where: { email: adminEmail },
      create: { email: adminEmail, fullName: 'Administrador', passwordHash, role: 'ADMIN' },
      update: {},
    })
  }

  console.log(
    `Seed listo: ${PAYERS.length} pagador(es) de ejemplo, ${legal.count} versión(es) legal(es) nueva(s) y ${seedAdmin ? 'el administrador' : 'sin administrador (falta SEED_ADMIN_EMAIL o SEED_ADMIN_PASSWORD)'}. Lo que ya existía no se tocó.`,
  )
} finally {
  await prisma.$disconnect()
  await pool.end()
}
