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

/**
 * Turn the "page-remboursements" API payload into a normalized list.
 *
 * Real Gan shape (GET /api/ecli/bff/v1/remboursement/page-remboursements/{id}):
 *   { blocRemboursements: { remboursementsParMois: [
 *       { mois, annee, remboursements: [
 *           { dateVersement, montant: "5,40 €", partieAyantRecu,
 *             beneficiaire, libelleRemboursementPar, action: { url } } ] } ] } }
 *
 * Also tolerates the `remboursementsRecents` array from sante-prevoyance/full.
 *
 * Normalized item: { id, date, amount, label, currency, fileurl? }
 *
 * @param {*} data - the API JSON body (or null)
 * @param {object} [logger]
 * @returns {Array<object>}
 */
export function parseReimbursements(data, logger) {
  if (!data) return []

  let list = []
  const bloc = data.blocRemboursements
  if (bloc && Array.isArray(bloc.remboursementsParMois)) {
    // Flatten month groups into a single list.
    list = bloc.remboursementsParMois.flatMap(m =>
      Array.isArray(m.remboursements) ? m.remboursements : []
    )
  } else if (Array.isArray(data.remboursementsRecents)) {
    list = data.remboursementsRecents
  } else if (Array.isArray(data)) {
    list = data
  } else if (Array.isArray(data.remboursements)) {
    list = data.remboursements
  }

  if (!Array.isArray(list) || !list.length) {
    if (logger)
      logger.info('parseReimbursements: no reimbursement found in payload')
    return []
  }

  return list
    .map(raw => normalizeReimbursement(raw))
    .filter(r => r && r.date && Number.isFinite(r.amount))
}

/**
 * Map one raw Gan reimbursement to the normalized shape.
 *
 * @param {object} raw
 * @returns {object|null}
 */
function normalizeReimbursement(raw) {
  if (!raw || typeof raw !== 'object') return null

  // Date: page-remboursements uses `dateVersement`; the recent list uses
  // `dateDuVersement`. Prefer the payment date (matches the bank operation).
  const rawDate = raw.dateVersement || raw.dateDuVersement || raw.date
  // Amount: page-remboursements uses a FR string "5,40 €"; the recent list uses
  // a number `montantDuVersement`.
  const rawAmount = raw.montant != null ? raw.montant : raw.montantDuVersement

  const date = parseFrDate(rawDate)
  const amount = parseAmount(rawAmount)

  // The action url embeds a stable reimbursement id:
  // /remboursements/{contrat}/remboursement/{id}
  const actionUrl = raw.action && raw.action.url ? String(raw.action.url) : ''
  const idMatch = actionUrl.match(/remboursement\/([^/?]+)/)
  const id =
    (idMatch && idMatch[1]) ||
    (date ? `${date.toISOString().slice(0, 10)}-${amount}` : undefined)

  // Payee (lab, doctor, pharmacy…) makes the most useful label.
  const payee = raw.partieAyantRecu || raw.destinataireDuPaiement || ''
  const label = payee ? `Remboursement santé — ${payee}` : 'Remboursement santé'

  return {
    id: id != null ? String(id) : undefined,
    date,
    amount,
    label,
    currency: '€',
    // Gan exposes a detail page, not a per-reimbursement PDF; leave fileurl
    // undefined so a bill is still saved (linked to the bank operation).
    fileurl: undefined
  }
}

/**
 * Build Cozy bill objects from normalized reimbursements.
 *
 * A reimbursement is money the insurer pays back to the user, so `isRefund` is
 * true. When the API exposes a document URL, it is downloaded (with the OIDC
 * bearer token if any); otherwise the bill is saved without a file.
 *
 * @param {Array<object>} reimbursements
 * @param {object} [opts]
 * @param {string} [opts.token] - Authorization header value for downloads
 * @returns {Array<object>}
 */
export function buildBills(reimbursements) {
  return reimbursements.map(r => {
    const dateStr = r.date.toISOString().slice(0, 10)
    const amountStr = Math.abs(r.amount).toFixed(2).replace('.', ',')

    // Gan does not expose a per-reimbursement PDF, and saveBills always needs a
    // file, so we attach a small text receipt (as a base64 data URI) that
    // saveFiles turns into a real document in the Drive.
    const receipt = buildReceiptText(r)
    const dataUri = 'data:text/plain;base64,' + base64EncodeUtf8(receipt)

    return {
      vendor: VENDOR,
      vendorRef: r.id || `${dateStr}-${r.amount}`,
      date: r.date,
      amount: Math.abs(r.amount),
      isRefund: true,
      currency: r.currency || '€',
      filename: `${dateStr}_gan_remboursement_${amountStr}EUR.txt`,
      dataUri,
      fileAttributes: {
        metadata: {
          contentAuthor: 'ganassurances',
          datetime: r.date,
          datetimeLabel: 'issueDate',
          issueDate: r.date,
          carbonCopy: true
        }
      }
    }
  })
}

/**
 * Human-readable receipt text for one reimbursement.
 * @param {object} r - normalized reimbursement
 * @returns {string}
 */
export function buildReceiptText(r) {
  const dateStr = r.date.toISOString().slice(0, 10)
  const amountStr = Math.abs(r.amount).toFixed(2).replace('.', ',')
  return [
    'Remboursement santé — Gan Assurances',
    '',
    `Date du versement : ${dateStr}`,
    `Montant remboursé : ${amountStr} €`,
    `Libellé : ${r.label}`,
    r.id ? `Référence : ${r.id}` : null
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Base64-encode a UTF-8 string (works in the pilot/browser context).
 * @param {string} str
 * @returns {string}
 */
export function base64EncodeUtf8(str) {
  // Encode UTF-8 safely before btoa (which is latin1-only).
  const utf8 = encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  )
  if (typeof btoa === 'function') return btoa(utf8)
  // Node fallback (tests)
  return Buffer.from(utf8, 'binary').toString('base64')
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

  // ISO (YYYY-MM-DD...) — accepted as-is.
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str)
    return isNaN(d) ? null : d
  }
  // French DD/MM/YYYY — build in UTC so the calendar day is preserved regardless
  // of the machine timezone (a local-time Date would shift a day west of UTC).
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
