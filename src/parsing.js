/**
 * Pure helpers for the Gan Assurances connector.
 *
 * These run in the pilot context (not the page), so they may live at module
 * scope. They are intentionally defensive: the exact shape of Gan's internal
 * reimbursement API is confirmed from a first "discovery" run, and this file is
 * where you adapt the field mapping once the payload is known.
 */

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
 * Build Cozy file entries from normalized documents (real PDFs).
 *
 * These are statements (documents), not invoices with an amount, so they are
 * meant for saveFiles (not saveBills). The PDF is downloaded from `fileurl`;
 * `vendorRef` gives a short stable id per document for dedup.
 *
 * @param {Array<object>} documents
 * @returns {Array<object>}
 */
export function buildFiles(documents) {
  return documents.map((d, index) => {
    const date = d.date || new Date()
    const dateStr = date.toISOString().slice(0, 10)
    // A short, stable ref: the document JWT is long, so hash it by content.
    const vendorRef = `${dateStr}-${shortHash(d.id)}`
    return {
      vendorRef,
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
