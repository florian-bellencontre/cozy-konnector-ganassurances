/**
 * Pure helpers for the Gan Assurances connector.
 *
 * These run in the pilot context (not the page), so they may live at module
 * scope. They are intentionally defensive: the exact shape of Gan's internal
 * reimbursement API is confirmed from a first "discovery" run, and this file is
 * where you adapt the field mapping once the payload is known.
 */

const VENDOR = 'Gan Assurances'

/**
 * Log-friendly summary of an intercepted JSON body: its top-level keys and, for
 * arrays, the keys of the first item. Used in discovery mode to identify the
 * reimbursement endpoint without dumping personal data.
 *
 * @param {*} json
 * @returns {string}
 */
export function summarizeJson(json) {
  try {
    if (Array.isArray(json)) {
      const first = json[0]
      const keys = first && typeof first === 'object' ? Object.keys(first) : []
      return `Array(${json.length}) item keys: [${keys.join(', ')}]`
    }
    if (json && typeof json === 'object') {
      const keys = Object.keys(json)
      const arrayKeys = keys.filter(k => Array.isArray(json[k]))
      return `Object keys: [${keys.join(', ')}]${
        arrayKeys.length ? ` (arrays: ${arrayKeys.join(', ')})` : ''
      }`
    }
    return `${typeof json}`
  } catch (err) {
    return 'unserializable'
  }
}

// Base download URL for a document (a real PDF). The document `identifiant`
// (a JWT) is appended, plus the `/pdf?print=false` suffix. Confirmed via
// DevTools: GET /api/ecli/edd/document/{id}/pdf?print=false
export const DOC_DOWNLOAD_BASE =
  'https://espaceclient.ganassurances.fr/api/ecli/edd/document/'

/**
 * Parse the "espace-documentaire" API payload into a normalized list of
 * downloadable documents (real PDFs).
 *
 * Real Gan shape (GET /api/ecli/bff/espace-documentaire):
 *   { hubs: [ { code:'H_SANTE', contrats: [ { identifiant, documents: [
 *       { identifiant:<JWT>, libelle, codeType:'RELEVE_DE_PRESTATIONS_SANTE',
 *         datePublication } ] } ] } ],
 *     attestationsTiersPayant: { contrats: [ { documents: [ { identifiant,
 *       naturePiece:'ATPG', libelle, codeType, datePublication } ] } ] } }
 *
 * Normalized item: { id, date, label, codeType, fileurl }
 *
 * @param {*} data - the API JSON body (or null)
 * @param {object} [opts]
 * @param {boolean} [opts.attestations] - also include tiers-payant attestations
 * @param {object} [logger]
 * @returns {Array<object>}
 */
export function parseDocuments(data, opts = {}, logger) {
  if (!data || typeof data !== 'object') return []

  const raw = []
  // Health hub documents (relevés de prestations santé).
  for (const hub of data.hubs || []) {
    for (const contrat of hub.contrats || []) {
      for (const doc of contrat.documents || []) raw.push(doc)
    }
  }
  // Optionally the tiers-payant attestations (mutuelle card).
  if (opts.attestations && data.attestationsTiersPayant) {
    for (const contrat of data.attestationsTiersPayant.contrats || []) {
      for (const doc of contrat.documents || []) raw.push(doc)
    }
  }

  const docs = raw.map(normalizeDocument).filter(Boolean)
  if (logger) logger.info(`parseDocuments: ${docs.length} document(s)`)
  return docs
}

/**
 * Map one raw Gan document to the normalized shape.
 * @param {object} raw
 * @returns {object|null}
 */
function normalizeDocument(raw) {
  if (!raw || typeof raw !== 'object' || !raw.identifiant) return null
  const id = String(raw.identifiant)
  const date = parseFrDate(raw.datePublication) || null
  const codeType = raw.codeType || 'DOCUMENT'
  const label =
    raw.libelle ||
    (codeType === 'RELEVE_DE_PRESTATIONS_SANTE'
      ? 'Relevé de prestations santé'
      : 'Document Gan')
  return {
    id,
    date,
    label,
    codeType,
    fileurl: DOC_DOWNLOAD_BASE + encodeURIComponent(id) + '/pdf?print=false'
  }
}

/**
 * Build Cozy bill objects from normalized documents (real PDFs).
 *
 * Reimbursement statements are money paid back, so `isRefund` is true. The PDF
 * is downloaded from `fileurl`; a short stable id per document keeps dedup safe.
 *
 * @param {Array<object>} documents
 * @returns {Array<object>}
 */
export function buildBills(documents) {
  return documents.map((d, index) => {
    const date = d.date || new Date()
    const dateStr = date.toISOString().slice(0, 10)
    // A short, stable ref: the document JWT is long, so hash-ish it by index+date.
    const vendorRef = `${dateStr}-${shortHash(d.id)}`
    return {
      vendor: VENDOR,
      vendorRef,
      date,
      isRefund: true,
      currency: '€',
      filename: `${dateStr}_gan_releve_prestations${
        documents.length > 1 ? '_' + (index + 1) : ''
      }.pdf`,
      fileurl: d.fileurl,
      fileAttributes: {
        metadata: {
          contentAuthor: 'ganassurances',
          datetime: date,
          datetimeLabel: 'issueDate',
          issueDate: date,
          carbonCopy: true
        }
      }
    }
  })
}

/**
 * Small stable hash of a string → short hex, to build a compact bill ref from
 * the long JWT document id.
 * @param {string} str
 * @returns {string}
 */
export function shortHash(str) {
  let h = 0
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16)
}

/**
 * Build a minimal identity from intercepted responses. Deliberately keeps only
 * the name and, if present, the email — no address, phone or civil data.
 *
 * @param {object} [interceptions] - map label → intercepted payload
 * @returns {object|null}
 */
export function buildIdentity(interceptions) {
  if (!interceptions) return null
  const contact = {}

  for (const key of Object.keys(interceptions)) {
    const r = interceptions[key]?.response
    if (!r || typeof r !== 'object') continue

    const given = r.given_name || r.prenom || r.firstName
    const family = r.family_name || r.nom || r.lastName
    if ((given || family) && !contact.name) {
      contact.name = {}
      if (given) contact.name.givenName = String(given)
      if (family) contact.name.familyName = String(family)
    }

    const email = r.email || r.mail || r.adresseEmail
    if (email && !contact.email) {
      contact.email = [{ address: String(email) }]
    }
  }

  return Object.keys(contact).length ? { contact } : null
}

/**
 * Parse a French-formatted or ISO date string into a Date.
 *
 * @param {string} value
 * @returns {Date|null}
 */
export function parseFrDate(value) {
  if (!value) return null
  if (value instanceof Date) return isNaN(value) ? null : value
  const str = String(value).trim()

  // ISO (YYYY-MM-DD, optionally with a time). Build from the date parts in UTC
  // so the calendar day is preserved: `new Date('2026-07-16T00:00:00')` (no
  // timezone) is parsed as LOCAL time and toISOString() would shift it a day
  // west of UTC.
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const d = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    )
    return isNaN(d) ? null : d
  }
  // French DD/MM/YYYY — build in UTC too.
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])))
    return isNaN(d) ? null : d
  }
  const fallback = new Date(str)
  return isNaN(fallback) ? null : fallback
}

/**
 * Parse an amount that may be a number, or a French string like "5,20 €".
 *
 * @param {*} value
 * @returns {number} NaN if unparsable
 */
export function parseAmount(value) {
  if (typeof value === 'number') return value
  if (value == null) return NaN
  const cleaned = String(value)
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3}\b)/g, '') // thousands dot
    .replace(',', '.')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : NaN
}
