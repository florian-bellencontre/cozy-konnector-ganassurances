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

- Vos **relevés de prestations santé** en tant que **vrais PDF** (les documents
  officiels générés par Gan), enregistrés comme fichiers Cozy (`io.cozy.files`)
  qualifiés `health_invoice` et marqués `carbonCopy` (copie conforme).
- **Aucune donnée personnelle superflue** : le konnector ne sauvegarde pas
  d'identité (ni nom, ni adresse). Le seul identifiant conservé est le **numéro
  de contrat santé**, utilisé comme identifiant de compte Cozy (`accountName`).

> **Synchronisations suivantes :** un nouveau lancement re-télécharge la liste
> des documents, mais la déduplication (`METADATA_DEDUP` +
> `getExistingFilesIndex`) ignore ceux déjà présents dans le Drive. Si aucun
> nouveau relevé n'a été émis depuis la dernière synchro, **rien n'apparaît de
> neuf** : c'est le comportement normal, pas un échec. Les logs affichent alors
> `Found N document(s) to save` puis `Konnector success` sans nouvel import.

## API utilisée (interne Gan, BFF)

- `GET /api/ecli/bff/hubs/sante-prevoyance/full` → numéro de contrat santé
  (`contratsSante[0].identifiant`), utilisé comme `sourceAccountIdentifier`.
- `GET /api/ecli/bff/espace-documentaire` → la liste des documents. Les relevés
  santé sont dans `hubs[].contrats[].documents[]`, chaque document exposant un
  `identifiant` (un JWT), un `libelle`, un `codeType`
  (`RELEVE_DE_PRESTATIONS_SANTE`) et une `datePublication`.
- `GET /api/ecli/edd/document/{identifiant}/pdf?print=false` → le **PDF** du
  document (`identifiant` = le JWT ci-dessus). ⚠️ le préfixe est `edd`
  (et non `edoc`/`ged`/`bff`) et le suffixe `/pdf?print=false` est obligatoire.

## Architecture

| Fichier | Rôle |
| --- | --- |
| `src/index.js` | Le `ContentScript` : authentification (pilotée côté *pilot*, saisie côté *worker*), navigation vers l'espace documentaire, `fetch`, `saveFiles` (téléchargement des PDF). |
| `src/interceptor.js` | Override de `window.fetch` / `XMLHttpRequest` dans la page pour capturer les réponses JSON de l'API interne et l'en-tête `Authorization` (token OIDC). |
| `src/parsing.js` | Fonctions pures (dates UTC, normalisation des documents, construction des entrées `saveFiles` avec l'URL de téléchargement du PDF). Testées dans `src/parsing.spec.js`. |

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
dans `parseDocuments` / `normalizeDocument` (`src/parsing.js`), puis remettez
`false`.

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

> Préférez `konnectors update` à `uninstall`/`install` : `uninstall` supprime le
> compte configuré (identifiants + appareil de confiance) et vous oblige à
> refaire login + SMS. Pensez à bumper `version` (dans `manifest.konnector`
> **et** `package.json`) à chaque build pour lever l'ambiguïté « already
> up-to-date » dans les logs.

## Le bouton « Synchroniser » n'apparaît pas dans l'app mobile

**Symptôme :** le konnector fonctionne (les documents arrivent bien dans Drive),
mais l'app mobile Twake **n'affiche ni le bouton de synchronisation manuelle, ni
le bouton de déconnexion**. Le konnector semble ne se lancer qu'une seule fois
(après configuration).

**Ce n'est PAS** un problème de manifest, de trigger, de compte, ni de cache de
l'app (vérifiés identiques à des konnectors clisk qui fonctionnent, comme
`directenergie` ou `ameli`). Purger le cache ou tester en navigation privée n'y
change rien.

**Cause réelle :** l'affichage du bloc de synchro passe par
`cozy-harvest-lib`. Le composant `LaunchTriggerAlert` ne rend le bouton que si
`maintenanceFetchStatus === 'loaded'`. Ce statut provient de
`useMaintenanceStatus(slug)`, qui interroge le **registre d'applications** Cozy :

```js
Q('io.cozy.apps_registry').getById(slug)
```

Pour un **konnector custom absent du registre** (installé via `git://`, avec un
slug qui n'existe pas dans le registre public), cette requête renvoie **404** →
`fetchStatus: 'failed'` (≠ `'loaded'`) → le bloc bouton n'est **jamais** rendu.
Les konnectors qui affichent le bouton ont, eux, un slug **présent dans le
registre** (même si l'on installe un fork via `git://`), donc la requête
aboutit.

**Vérification :**

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://apps-registry.cozycloud.cc/registry/<slug>
# slug custom absent du registre  → 404  (pas de bouton)
# slug connu du registre          → 200  (bouton affiché)
```

**Correctif :** le hook `useMaintenanceStatus` prévoit une porte de sortie via le
feature flag `harvest.skip-maintenance-for.list`. Un slug listé dedans
court-circuite la requête registre et force `fetchStatus: 'loaded'`, ce qui
débloque l'affichage du bouton :

```sh
cozy-stack features flags --domain <domaine> \
  '{"harvest.skip-maintenance-for.list": ["ganassurances"]}'
```

Vérifiez que le flag est bien posé (`cozy-stack features flags --domain <domaine>`),
puis **fermez complètement** l'app mobile (pas juste en arrière-plan) et rouvrez-la :
le bouton **Synchroniser** et le menu (déconnexion) apparaissent alors sur l'écran
du compte, comme pour les konnectors du registre.

> Ce flag n'a **aucun effet** sur le konnector lui-même (le code, le manifest ou
> le trigger ne changent pas) : il ne fait que dire à l'UI de ne pas attendre une
> réponse « maintenance » du registre pour un slug qu'il ne connaît pas.
