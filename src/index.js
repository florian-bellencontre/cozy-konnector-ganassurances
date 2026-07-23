import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import pTimeout from 'p-timeout'
import RequestInterceptor from './interceptor'
import { parseReimbursements, buildBills, summarizeJson } from './parsing'

const log = Minilog('ContentScript')
Minilog.enable()

// --- Site constants -------------------------------------------------------
const BASE_URL = 'https://espaceclient.ganassurances.fr'
const LOGIN_URL = 'https://www.espaceclient.gan.fr'
const AUTH_HOST = 'authentification.ganassurances.fr'
const HUB_SANTE_URL = `${BASE_URL}/front/hub/sante-prevoyance`

// Marker of the F5 WAF challenge page. If the WAF blocks the request, the page
// body contains this text; we then let the user retry in a visible webview.
const WAF_REJECTED_TEXT = 'The requested URL was rejected'

// DOM marker of the Keycloak login form. The real inputs live inside `gdt-*`
// web components shadow DOM; worker-side methods look them up shadow-aware.
const USERNAME_SELECTOR = '#username'

// Set to true only to re-map the API (logs every JSON endpoint + shapes) when
// Gan changes its site. Normal operation is false.
const DISCOVERY_MODE = false

// Endpoints we intercept (JSON bodies). Confirmed by recon:
// - sante-prevoyance/full → contract id + `remboursementsRecents` (3 latest)
// - page-remboursements/{contract} → `blocRemboursements.remboursementsParMois`
//   (full history, ~15 latest per page)
const INTERCEPTIONS = [
  {
    label: 'sante-full',
    method: 'GET',
    url: '/api/ecli/bff/hubs/sante-prevoyance/full',
    serialization: 'json'
  },
  {
    label: 'page-remboursements',
    method: 'GET',
    url: '/api/ecli/bff/v1/remboursement/page-remboursements/',
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

    if (!account) {
      await this.ensureNotAuthenticated()
    }

    await this.navigateToLoginForm()

    const authenticated = await this.runInWorker('checkAuthenticated')
    if (authenticated) {
      this.log('info', 'Already authenticated')
      this.unblockWorkerInteractions()
      return true
    }

    // Optionally pre-fill known credentials, but never auto-submit: the WAF and
    // the SMS 2FA make a fully automated login unreliable, so the user finishes
    // the login (and the SMS code) themselves in the visible webview.
    const credentials = await this.getCredentials()
    if (credentials?.login) {
      await this.autoFill(credentials)
    }

    await this.showLoginFormAndWaitForAuthentication()
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) return true
    // Trigger Keycloak logout, then wait for the login form to come back.
    await this.goto(
      `https://${AUTH_HOST}/auth/realms/gan-assurances/protocol/openid-connect/logout`
    )
    await this.waitForElementInWorker(USERNAME_SELECTOR)
    return true
  }

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(LOGIN_URL)
    // Wait for either the login form (username field) or the WAF challenge.
    await Promise.race([
      this.waitForElementInWorker(USERNAME_SELECTOR),
      this.waitForElementInWorker('body', { includesText: WAF_REJECTED_TEXT }),
      // Already-authenticated case: the espace client dashboard.
      this.waitForElementInWorker('[data-testid], main, #root', {})
    ])

    if (await this.runInWorker('checkWafRejected')) {
      this.log('warn', 'WAF challenge detected, asking user to retry')
      await this.showLoginFormAndWaitForAuthentication()
    }
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
   * Authenticated when we are on the espace client (not on the auth host and
   * not on the SMS 2FA step). Returning false keeps the visible webview open so
   * the user can enter the SMS code.
   */
  async checkAuthenticated() {
    const href = document.location.href
    // Still on the identity provider → not done (login or SMS step).
    if (href.includes('authentification.ganassurances.fr')) {
      const txt = document.body?.innerText || ''
      if (/code de confirmation|vérification de votre identité/i.test(txt)) {
        // 2FA SMS step — wait for the user.
        return false
      }
      return false
    }
    // On the espace client domain and past the OAuth redirect.
    if (href.includes('espaceclient.ganassurances.fr')) {
      return !href.includes('/login/oauth2/')
    }
    return false
  }

  // -----------------------------------------------------------------------
  // Account identity
  // -----------------------------------------------------------------------
  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    // The stable identifier is the santé contract number. Visit the santé hub
    // so sante-prevoyance/full is intercepted, then read the contract id.
    if (!this.getSanteContractId()) {
      await Promise.all([
        this.waitForInterceptionSafe('sante-full', { timeout: 45000 }),
        (async () => {
          await this.goto(HUB_SANTE_URL)
          await this.waitForElementInWorker('body', {})
        })()
      ])
    }
    const sourceAccountIdentifier =
      this.getSanteContractId() || this.store?.userCredentials?.login
    if (!sourceAccountIdentifier) {
      throw new Error(
        'No sourceAccountIdentifier found — the connector should be fixed'
      )
    }
    return { sourceAccountIdentifier }
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
    const full = this.store?.interceptions?.['sante-full']?.response
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

    // 1. Open the santé hub → triggers sante-prevoyance/full (contract id + recents).
    const [full] = await Promise.all([
      this.waitForInterceptionSafe('sante-full', { timeout: 45000 }),
      (async () => {
        await this.goto(HUB_SANTE_URL)
        await this.waitForElementInWorker('body', {})
      })()
    ])

    const contractId =
      this.getSanteContractId() ||
      (full && full.response && full.response.contratsSante?.[0]?.identifiant)

    // 2. Get the full reimbursement history. The SPA fires the
    // page-remboursements XHR when the user opens "Voir tous mes
    // remboursements"; navigating to the raw API url would NOT trigger it. So
    // we click that link in the worker and wait for the interception. If it
    // doesn't come, we fall back to the recent list (already in `full`).
    let historyData = null
    if (contractId) {
      const [page] = await Promise.all([
        this.waitForInterceptionSafe('page-remboursements', { timeout: 20000 }),
        this.runInWorker('clickAllReimbursements').catch(() => false)
      ])
      historyData = page && page.response
      if (!historyData) {
        this.log('info', 'Full history not captured, using recent list')
      }
    } else {
      this.log(
        'warn',
        'No santé contract id found; falling back to recent list'
      )
    }

    // Prefer the full history; fall back to the recent list from the hub.
    const source = historyData || (full && full.response) || null
    const reimbursements = parseReimbursements(source, log)
    this.log('info', `Parsed ${reimbursements.length} reimbursement(s)`)

    const bills = buildBills(reimbursements)
    if (bills.length) {
      await this.saveBills(bills, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'text/plain',
        qualificationLabel: 'health_invoice'
      })
    } else {
      this.log('info', 'No reimbursement to save')
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

  /**
   * Worker method: click the "Voir tous mes remboursements" link/button in the
   * santé hub (shadow-DOM aware) to trigger the page-remboursements API call.
   * @returns {boolean} true if a control was clicked
   */
  async clickAllReimbursements() {
    const matches = el => {
      const t = (el.innerText || el.textContent || '').trim().toLowerCase()
      return (
        (t.includes('rembours') &&
          (t.includes('tous') || t.includes('voir') || t.includes('mes'))) ||
        t === 'remboursements'
      )
    }
    const walk = root => {
      for (const el of root.querySelectorAll(
        'a, button, [role="link"], [role="button"], [role="tab"]'
      )) {
        if (matches(el)) {
          el.click()
          return true
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && walk(el.shadowRoot)) return true
      }
      return false
    }
    return walk(document)
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
      'clickAllReimbursements'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
