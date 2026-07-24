import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import pTimeout from 'p-timeout'
import RequestInterceptor from './interceptor'
import { parseDocuments, buildFiles, summarizeJson } from './parsing'

const log = Minilog('ContentScript')
Minilog.enable()

// --- Site constants -------------------------------------------------------
const BASE_URL = 'https://espaceclient.ganassurances.fr'
const AUTH_HOST = 'authentification.ganassurances.fr'

// Set to true only to re-map the API (logs every JSON endpoint + shapes) when
// Gan changes its site. Normal operation is false.
const DISCOVERY_MODE = false

// Endpoints we intercept (JSON bodies). Confirmed by recon:
// - sante-prevoyance/full → contract id (contratsSante[0].identifiant)
// - espace-documentaire → list of downloadable documents (relevés PDF), each
//   with a JWT `identifiant` used to build the /api/ecli/edd/document/{id}/pdf URL
const INTERCEPTIONS = [
  {
    label: 'sante-full',
    method: 'GET',
    url: '/api/ecli/bff/hubs/sante-prevoyance/full',
    serialization: 'json'
  },
  {
    label: 'espace-documentaire',
    method: 'GET',
    url: '/api/ecli/bff/espace-documentaire',
    serialization: 'json'
  }
]

const interceptor = new RequestInterceptor(INTERCEPTIONS)
interceptor.init()

class GanContentScript extends ContentScript {
  // -----------------------------------------------------------------------
  // Wiring
  // -----------------------------------------------------------------------
  async init(options) {
    await super.init(options)
    interceptor.on('response', response => {
      this.bridge.emit('workerEvent', {
        event: 'interceptedResponse',
        payload: response
      })
    })
    // Discovery: every request the page makes (url + method + content-type only).
    interceptor.on('sawRequest', meta => {
      this.bridge.emit('workerEvent', { event: 'sawRequest', payload: meta })
    })
  }

  /**
   * Pilot-side handler for events emitted by the worker (login + interceptions).
   */
  onWorkerEvent({ event, payload }) {
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit')
      if (payload?.login) {
        this.store = this.store || {}
        this.store.userCredentials = {
          login: payload.login,
          password: payload.password
        }
      }
    } else if (event === 'interceptedResponse') {
      this.onInterceptedResponse(payload)
    } else if (event === 'sawRequest') {
      // A Bearer-authenticated API call means the session is active. Record it
      // as a reliable "authenticated" signal (no DOM selector guessing needed).
      if (payload?.authenticated) {
        this.store = this.store || {}
        this.store.seenAuthenticatedApiCall = true
      }
      if (DISCOVERY_MODE && /json/i.test(payload.contentType || '')) {
        // Only surface JSON endpoints — those are the API calls worth mapping.
        this.log('info', `📡 API ${payload.method} ${payload.url}`)
      }
    }
  }

  /**
   * Store intercepted responses and, in discovery mode, log their shape so the
   * reimbursement API can be identified from the logs of a first run.
   */
  onInterceptedResponse(payload) {
    this.store = this.store || {}
    this.store.interceptions = this.store.interceptions || {}
    this.store.interceptions[payload.label] = payload

    // Capture the OIDC bearer token when present — needed later to download
    // any PDF behind the authenticated API.
    const auth =
      payload?.requestHeaders?.Authorization ||
      payload?.requestHeaders?.authorization
    if (auth) this.store.token = auth

    if (DISCOVERY_MODE) {
      this.log(
        'info',
        `🔎 DISCOVERY ${payload.method} ${payload.url} → ${summarizeJson(
          payload.response
        )}`
      )
    }
  }

  // -----------------------------------------------------------------------
  // Authentication (user logs in + does the SMS 2FA in the visible webview)
  // -----------------------------------------------------------------------
  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))

    const credentials = await this.getCredentials()

    // Reset the per-run "session active" signal so a stale value from a previous
    // run can never make us skip a genuinely-needed login.
    this.store = this.store || {}
    this.store.seenAuthenticatedApiCall = false

    // ONLY force a logout on a brand-new connection (no account AND no saved
    // credentials), so the user goes through login + SMS explicitly. On a
    // re-sync of an existing account we must NEVER log out: the trusted-device
    // session is exactly what lets the sync run silently. (This is the bug that
    // made manual syncs re-open the login form even while logged in.)
    if (!account && !credentials) {
      await this.ensureNotAuthenticated()
    }

    // Load the espace client. If the trusted-device session is valid we land on
    // the dashboard (the SPA fires sante-prevoyance/full, which we intercept);
    // otherwise we are redirected to the Keycloak login (#username shows up).
    await this.goto(BASE_URL)
    await this.waitForDomReadySafe()

    if (await this.runInWorker('checkWafRejected')) {
      this.log('warn', 'WAF challenge detected, asking user to retry')
      await this.showLoginFormAndWaitForAuthentication()
      this.unblockWorkerInteractions()
      return true
    }

    // Decide the session by racing the possible outcomes (never a URL snapshot,
    // since Gan may briefly bounce through the SSO host on a valid session).
    if (await this.waitForAuthOrLogin()) {
      this.log('info', 'Already authenticated')
      // No user input needed: keep the webview hidden so the sync stays silent.
      await this.setWorkerState({ visible: false })
      this.unblockWorkerInteractions()
      return true
    }

    // Logged out: pre-fill the saved login if any (never auto-submit — the WAF
    // and SMS 2FA make full automation unreliable), then let the user finish
    // the login and the SMS code in the visible webview.
    if (credentials?.login) {
      await this.autoFill(credentials).catch(() => {})
    }

    await this.showLoginFormAndWaitForAuthentication()
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.goto(
      `https://${AUTH_HOST}/auth/realms/gan-assurances/protocol/openid-connect/logout`
    )
    await this.waitForDomReadySafe()
    return true
  }

  /**
   * After loading the espace client, decide the session by racing the two
   * possible outcomes, without ever throwing:
   *   - the SPA's own call to sante-prevoyance/full is intercepted → logged in;
   *   - the Keycloak login field (#username) appears → logged out.
   * Returns true if authenticated, false otherwise. A generous timeout absorbs
   * the SSO token-refresh bounce that can happen on a valid session.
   *
   * @returns {Promise<boolean>}
   */
  async waitForAuthOrLogin() {
    // Poll for ~30s. The decision is made by an actual authenticated API call
    // from inside the page (apiGet uses the page's own session cookies), which
    // is the same call fetch() relies on and is proven to work when logged in:
    //   - apiGet returns JSON        → session active  → authenticated;
    //   - the #username field shows  → logged out;
    // We also accept the passive signals (a Bearer API call seen, or the santé
    // payload intercepted) as a fast path. This never hangs on the dashboard.
    const deadline = 30000
    const step = 1500
    for (let waited = 0; waited < deadline; waited += step) {
      // Fast path: passive signals already prove an active session.
      if (
        this.store?.seenAuthenticatedApiCall ||
        this.store?.interceptions?.['sante-full']
      ) {
        return true
      }
      // Active probe: ask the page to call an authenticated API with its own
      // session. We use espace-documentaire because we already know it answers
      // JSON when logged in (fetch() collects the 30 PDFs from it), and cache it
      // so fetch() can reuse it without a second call.
      const docs = await this.runInWorker(
        'apiGet',
        '/api/ecli/bff/espace-documentaire'
      )
      if (docs && typeof docs === 'object') {
        this.store = this.store || {}
        this.store.espaceDocumentaire = docs
        return true
      }
      // Otherwise, if the login field is present we are logged out.
      if (await this.runInWorker('waitForLoginField')) {
        return false
      }
      await this.wait(step)
    }
    // Timed out: last-resort DOM check.
    return await this.runInWorker('checkAuthenticated')
  }

  /**
   * Wait for the page DOM to be ready without ever throwing on timeout, so the
   * auth flow keeps going whatever the landing page (login, dashboard, WAF).
   */
  async waitForDomReadySafe() {
    try {
      await this.waitForElementInWorker('body', {})
    } catch (err) {
      this.log('info', `waitForDomReadySafe: ${err.message}`)
    }
    await this.wait(3000)
  }

  /**
   * Runs in the worker: pre-fill the login form without submitting.
   */
  async autoFill(credentials) {
    await this.runInWorker('fillLoginForm', credentials)
  }

  async showLoginFormAndWaitForAuthentication() {
    this.log('info', 'showLoginFormAndWaitForAuthentication')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
  }

  // -----------------------------------------------------------------------
  // Worker-side methods (executed inside the Gan page)
  // -----------------------------------------------------------------------
  onWorkerReady() {
    // shadow-aware querySelector, inlined because this runs inside the page.
    const shadowQuery = selector => {
      const walk = root => {
        const direct = root.querySelector(selector)
        if (direct) return direct
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = walk(el.shadowRoot)
            if (found) return found
          }
        }
        return null
      }
      return walk(document)
    }
    const usernameSelector = '#username'
    const passwordSelector = '#password'

    const attach = () => {
      const form = shadowQuery('form') || document.querySelector('form')
      if (!form || form.dataset.ganWatched) return
      form.dataset.ganWatched = 'true'
      form.addEventListener('submit', () => {
        const u = shadowQuery(usernameSelector)
        const p = shadowQuery(passwordSelector)
        this.bridge.emit('workerEvent', {
          event: 'loginSubmit',
          payload: { login: u?.value, password: p?.value }
        })
      })
    }
    window.addEventListener('DOMContentLoaded', attach)
    // Keycloak re-renders via web components; retry attaching for a while.
    let tries = 0
    const timer = setInterval(() => {
      attach()
      if (++tries > 40) clearInterval(timer)
    }, 500)
  }

  async checkWafRejected() {
    return document.body?.innerText?.includes('The requested URL was rejected')
  }

  /**
   * Runs in the worker (inside the authenticated Gan page): GET a same-origin
   * API endpoint and return its parsed JSON. Uses the page's own session
   * (cookies) so no visible navigation is needed to collect data. Returns null
   * on any failure so the pilot can fall back gracefully.
   */
  async apiGet(path) {
    try {
      const url = path.startsWith('http')
        ? path
        : `${document.location.origin}${path}`
      const res = await window.fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' }
      })
      if (!res.ok) return null
      return await res.json()
    } catch (err) {
      return null
    }
  }

  async fillLoginForm(credentials) {
    const shadowQuery = selector => {
      const walk = root => {
        const direct = root.querySelector(selector)
        if (direct) return direct
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = walk(el.shadowRoot)
            if (found) return found
          }
        }
        return null
      }
      return walk(document)
    }
    const setNativeValue = (el, value) => {
      const proto = Object.getPrototypeOf(el)
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, value)
      else el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const u = shadowQuery('#username')
    const p = shadowQuery('#password')
    if (u && credentials.login) setNativeValue(u, credentials.login)
    if (p && credentials.password) setNativeValue(p, credentials.password)
    return true
  }

  /**
   * Runs in the worker. Used by the base `waitForAuthenticated` (polled after a
   * manual login) to know when the session is established. Authenticated iff we
   * are on the espace client domain, past the OAuth redirect, and NOT showing
   * the Keycloak login field. This is polled, so a URL check is fine here — the
   * loop tolerates the brief SSO bounce (it just keeps polling until we land).
   */
  async checkAuthenticated() {
    const href = document.location.href
    // Still on the identity provider (login or SMS step) → not done.
    if (href.includes('authentification.ganassurances.fr')) return false
    if (!href.includes('espaceclient.ganassurances.fr')) return false
    if (href.includes('/login/oauth2/')) return false
    // On the espace client, but make sure the login field is not somehow present.
    return !this.hasLoginField()
  }

  /**
   * Runs in the worker: true once the Keycloak login field (#username) is
   * present. Used to detect the logged-out outcome without inspecting the URL.
   */
  async waitForLoginField() {
    return this.hasLoginField()
  }

  /** Shadow-DOM-aware check for the presence of the Keycloak username field. */
  hasLoginField() {
    const walk = root => {
      if (root.querySelector('#username')) return true
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && walk(el.shadowRoot)) return true
      }
      return false
    }
    return walk(document)
  }

  // -----------------------------------------------------------------------
  // Account identity
  // -----------------------------------------------------------------------
  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    // Stable identifier = the santé contract number. Try, in order and without
    // any visible navigation: the santé payload we may already hold, the
    // contract id embedded in the documents payload fetched during auth, a
    // direct santé API call, then the submitted login as a last resort.
    let contractId = this.getSanteContractId() || this.contractIdFromDocs()
    if (!contractId) {
      const full = await this.runInWorker(
        'apiGet',
        '/api/ecli/bff/hubs/sante-prevoyance/full'
      )
      if (full && typeof full === 'object') {
        this.store = this.store || {}
        this.store.santeFull = full
        contractId = this.getSanteContractId()
      }
    }
    const sourceAccountIdentifier =
      contractId || this.store?.userCredentials?.login
    if (!sourceAccountIdentifier) {
      throw new Error(
        'No sourceAccountIdentifier found — the connector should be fixed'
      )
    }
    return { sourceAccountIdentifier }
  }

  /** Contract id read from the documents payload (hubs[].contrats[].identifiant). */
  contractIdFromDocs() {
    const docs = this.store?.espaceDocumentaire
    const hub = docs && Array.isArray(docs.hubs) && docs.hubs[0]
    const contrat = hub && Array.isArray(hub.contrats) && hub.contrats[0]
    const id = contrat && contrat.identifiant
    return id ? String(id) : null
  }

  /**
   * Stable account id = the santé contract number, taken from the intercepted
   * `sante-prevoyance/full` (contratsSante[0].identifiant). Falls back to the
   * submitted login only if nothing better is available.
   */
  extractSourceAccountIdentifier() {
    return this.getSanteContractId()
  }

  /** @returns {string|null} the santé contract id, or null */
  getSanteContractId() {
    // Prefer the payload fetched during auth (store.santeFull), fall back to the
    // intercepted one if the SPA happened to call it on its own.
    const full =
      this.store?.santeFull ||
      this.store?.interceptions?.['sante-full']?.response
    const c =
      full &&
      Array.isArray(full.contratsSante) &&
      full.contratsSante[0] &&
      full.contratsSante[0].identifiant
    return c ? String(c) : null
  }

  // -----------------------------------------------------------------------
  // Data collection
  // -----------------------------------------------------------------------
  async fetch(context) {
    this.log('info', '🤖 fetch')

    if (this.store?.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }

    if (DISCOVERY_MODE) {
      // Kept for future re-discovery; not used in normal operation.
      await this.goto(BASE_URL)
      await this.waitForElementInWorker('body', {})
      await this.runDiscovery()
      return
    }

    // Fetch the documents list directly from the API (no visible navigation to
    // the documents page). Reuse the payload already fetched during the auth
    // probe when available, else call the endpoint now. We are authenticated,
    // so it returns the relevés with their JWT ids used to build each
    // /api/ecli/edd/... PDF url.
    const docPayload =
      this.store?.espaceDocumentaire ||
      (await this.runInWorker('apiGet', '/api/ecli/bff/espace-documentaire'))

    const documents = parseDocuments(docPayload, { attestations: false }, log)
    this.log('info', `Found ${documents.length} document(s) to save`)

    const files = buildFiles(documents)
    if (files.length) {
      // These are documents (PDF statements), not invoices with an amount, so
      // saveFiles (not saveBills, which requires `amount`) is the right call.
      await this.saveFiles(files, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'health_invoice'
      })
    } else {
      this.log('info', 'No document to save')
    }
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------
  /**
   * First-run exploration: map the navigation, actively visit the likely
   * reimbursement sections so their API calls fire, and log every JSON endpoint
   * seen (via the sawRequest event). Copy the logged URLs back into
   * INTERCEPTIONS, then set DISCOVERY_MODE = false.
   */
  async runDiscovery() {
    this.log(
      'info',
      '🔎 DISCOVERY_MODE on — mapping the API. Copy the "📡 API ..." lines below.'
    )
    const startUrl = await this.evaluateInWorker(() => document.location.href)
    this.log('info', `🔎 landing url: ${startUrl}`)

    // Map the navigation menu so we know what sections exist.
    const links = await this.runInWorker('scanNavigation')
    this.log('info', `🔎 nav candidates: ${JSON.stringify(links)}`)

    // Visit each same-origin candidate whose label smells like health/refunds,
    // pausing so the SPA fires (and we intercept) its API calls.
    const candidates = links.filter(l =>
      /rembours|santé|sante|décompte|decompte|prestation|garantie|soin|mes remboursements/i.test(
        l.text
      )
    )
    if (!candidates.length) {
      this.log(
        'info',
        '🔎 no obvious reimbursement link found — dumping all API calls seen on the dashboard'
      )
    }
    for (const c of candidates.slice(0, 6)) {
      if (!c.href) continue
      this.log('info', `🔎 visiting "${c.text}" → ${c.href}`)
      try {
        await this.goto(c.href)
        await this.waitForElementInWorker('body', {})
        await this.wait(6000)

        // The health hub often has sub-tabs (e.g. "Mes remboursements"): scan
        // and visit the reimbursement-looking ones so their API calls fire.
        const subLinks = await this.runInWorker('scanNavigation')
        const subs = subLinks.filter(
          l =>
            l.href &&
            l.href !== c.href &&
            /rembours|décompte|decompte|prestation|soin|garantie/i.test(l.text)
        )
        this.log(
          'info',
          `🔎 sub-tabs on "${c.text}": ${JSON.stringify(subs.map(s => s.text))}`
        )
        for (const s of subs.slice(0, 5)) {
          this.log('info', `🔎 visiting sub "${s.text}" → ${s.href}`)
          try {
            await this.goto(s.href)
            await this.waitForElementInWorker('body', {})
            await this.wait(6000)
          } catch (err) {
            this.log('warn', `🔎 sub ${s.href}: ${err.message}`)
          }
        }
      } catch (err) {
        this.log('warn', `🔎 could not visit ${c.href}: ${err.message}`)
      }
    }
    // Final settle time to catch late XHR calls.
    await this.wait(5000)
    this.log(
      'info',
      '🔎 DISCOVERY done — send me the 📡 API and 🔎 DISCOVERY (→ keys) lines above.'
    )
  }

  /**
   * Worker method: list navigation links/buttons (text + href), shadow-DOM
   * aware. Returns text only (no personal data).
   */
  async scanNavigation() {
    const out = []
    const seen = new Set()
    const collect = root => {
      const els = root.querySelectorAll(
        'a, button, [role="link"], [role="tab"]'
      )
      for (const el of els) {
        const text = (el.innerText || el.textContent || '').trim()
        if (!text || text.length > 60) continue
        const href = el.getAttribute && el.getAttribute('href')
        const key = text + '|' + (href || '')
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          text,
          href: href ? new URL(href, document.location.href).href : ''
        })
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collect(el.shadowRoot)
      }
    }
    collect(document)
    return out.slice(0, 80)
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------
  /**
   * Like EDF's waitForInterception but never rejects the whole run on timeout;
   * returns null instead so discovery/first runs stay resilient.
   */
  async waitForInterceptionSafe(label, { timeout = 60000 } = {}) {
    // If already captured, return immediately.
    const existing = this.store?.interceptions?.[label]
    if (existing) return existing

    const promise = new Promise(resolve => {
      const listener = ({ event, payload }) => {
        if (event === 'interceptedResponse' && payload.label === label) {
          this.bridge.removeEventListener('workerEvent', listener)
          resolve(payload)
        }
      }
      this.bridge.addEventListener('workerEvent', listener)
    })
    try {
      return await pTimeout(promise, {
        milliseconds: timeout,
        message: `Timed out after ${timeout}ms waiting for "${label}"`
      })
    } catch (err) {
      this.log('warn', err.message)
      return null
    }
  }

  /**
   * Pilot-side delay (the base ContentScript has no sleep()).
   * @param {number} ms
   */
  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

const connector = new GanContentScript()
connector
  .init({
    // checkAuthenticated / waitForAuthenticated / fetch etc. are already exposed
    // by the base ContentScript — only our custom worker methods go here.
    additionalExposedMethodsNames: [
      'checkWafRejected',
      'fillLoginForm',
      'scanNavigation',
      'apiGet',
      'waitForLoginField'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
