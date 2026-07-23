# Konnector Gan Assurances

Konnector [Cozy](https://cozy.io) **client-side (clisk)** qui récupère vos
**décomptes de remboursement santé** depuis l'espace client Gan Assurances
(<https://espaceclient.ganassurances.fr>).

## Pourquoi un konnector client-side (clisk) ?

L'espace client Gan combine trois obstacles qui rendent un konnector
« server-side » classique inexploitable :

- **Keycloak OIDC** avec un formulaire de connexion en *web components*
  (les champs `#username` / `#password` vivent dans un shadow DOM).
- **WAF F5 BIG-IP** qui bloque toute requête ne ressemblant pas à un vrai
  navigateur (« The requested URL was rejected »).
- **Double authentification par SMS** obligatoire à la première connexion.

En mode clisk, c'est le **vrai navigateur de votre app Cozy** (mobile ou
desktop) qui affiche la page : le WAF voit un navigateur légitime, et **vous**
saisissez vous-même le code SMS. Cochez « Se fier à cet appareil » pour éviter
la 2FA aux synchronisations suivantes.

## Ce qui est récupéré

- Vos **remboursements santé** en tant que factures Cozy (`io.cozy.bills`),
  marquées `isRefund: true` et qualifiées `health_invoice`, liables à vos
  opérations bancaires Gan via l'app Banks.
- **Aucune donnée personnelle superflue** : le konnector ne sauvegarde pas
  d'identité (ni nom, ni adresse). Le seul identifiant conservé est le **numéro
  de contrat santé**, utilisé comme identifiant de compte Cozy.

## API utilisée (interne Gan, BFF)

- `GET /api/ecli/bff/hubs/sante-prevoyance/full` → numéro de contrat santé
  (`contratsSante[0].identifiant`) + les 3 remboursements récents.
- `GET /api/ecli/bff/v1/remboursement/page-remboursements/{contrat}` →
  historique des remboursements, groupés par mois dans
  `blocRemboursements.remboursementsParMois` (≈ 15 derniers).
  Chaque remboursement : `dateVersement`, `montant` (« 5,40 € »),
  `partieAyantRecu` (prestataire), `action.url` (id du détail).

## Architecture

| Fichier | Rôle |
| --- | --- |
| `src/index.js` | Le `ContentScript` : authentification (pilotée côté *pilot*, saisie côté *worker*), navigation vers le hub santé, `fetch`, `saveBills`. |
| `src/interceptor.js` | Override de `window.fetch` / `XMLHttpRequest` dans la page pour capturer les réponses JSON de l'API interne et l'en-tête `Authorization` (token OIDC). |
| `src/parsing.js` | Fonctions pures (montants FR, dates UTC, construction des `bills`). Testées dans `src/parsing.spec.js`. |

## Développement

```sh
yarn install
yarn build      # build unique → build/
yarn watch      # rebuild à chaque modification (dev)
yarn lint
```

> ℹ️ Un konnector clisk s'exécute **dans une webview**, pas en ligne de
> commande : il n'y a pas de `yarn standalone`. Pour le tester en conditions
> réelles, chargez le build local dans l'**app Cozy mobile/desktop en mode
> développeur** (elle pointe sur votre `build/` ou sur la branche `build` de
> votre fork). Voir la doc Cozy : <https://docs.cozy.io/en/tutorials/clisk-konnector/>.

Les fonctions de parsing, elles, se testent hors navigateur via `parsing.spec.js`
(jest, exécuté en CI).

## Re-cartographier l'API (si Gan change son site)

Le konnector embarque un **mode découverte** désactivé par défaut. Si Gan
modifie ses endpoints, passez `DISCOVERY_MODE = true` dans `src/index.js` :
il logue alors chaque appel JSON (`📡 API …`) et la structure des réponses
interceptées (`🔎 DISCOVERY … → keys`), et explore le hub santé + ses
sous-onglets. Repérez le bon endpoint, ajustez `INTERCEPTIONS` et le mapping
dans `normalizeReimbursement` (`src/parsing.js`), puis remettez `false`.

> Astuce dev (hors app) : on peut sonder l'API en pilotant Chromium via
> Playwright en **headful** (le WAF F5 bloque le headless) avec un profil
> persistant pour ne saisir le SMS qu'une fois — voir les scripts `gan-*.mjs`
> utilisés lors de la mise au point.

Le mode découverte **ne logge que les clés** des objets JSON (via
`summarizeJson`), pas leurs valeurs — pour ne pas exposer de données
personnelles dans les logs.

## Déploiement

```sh
yarn build
yarn deploy     # pousse build/ sur la branche `build`
```

Puis, côté cozy-stack :

```sh
cozy-stack konnectors update ganassurances 'git://github.com/florian-bellencontre/cozy-konnector-ganassurances.git#build' --domain <domaine>
```
