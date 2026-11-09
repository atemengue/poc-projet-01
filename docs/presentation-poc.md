# POC — Communication synchrone ou orientée événements ?

*Traitement des commandes d'une plateforme de commerce électronique*
*État au 2026-11-08 — résultats sur une répétition, verdicts provisoires*

---

## 1. La question posée

> Quelle architecture retenir pour le traitement des commandes : **synchrone**, **orientée événements**, ou **hybride** ?

- Cinq services : Order, Payment, Inventory, Shipping, Notification.
- Croissance du trafic attendue, avec des pics promotionnels.
- La direction refuse l'événementiel « parce qu'il est plus scalable » : **elle veut des preuves**.
- Un invariant non négociable : **une commande n'est confirmée que si le paiement est autorisé et le stock réservé**.
- Décisions possibles : `ADOPT SYNCHRONOUS`, `ADOPT EVENT-DRIVEN`, `ADOPT HYBRID ARCHITECTURE`, `NO DECISION`.

Ce qui est évalué : la chaîne **preuve → raisonnement → décision**.

---

## 2. La démarche

Chaque étape suit le même cycle (`docs/methodologie.md`) :

1. **Faire le point** sur l'état réel du dépôt.
2. **Expliquer et discuter** la conception : aucun code avant accord.
3. **Implémenter** le périmètre validé, et seulement lui.
4. **Vérifier sur la pile réelle**, pas seulement par des tests unitaires.
5. **Expliquer comment tester**, pour que l'équipe rejoue elle-même.
6. **Documenter**, en distinguant l'énoncé, les décisions de l'équipe et les propositions.
7. **Commiter, puis pousser**, sur demande.

Deux principes :
- **Les hypothèses, les seuils et les critères sont écrits avant de mesurer.**
- **Éprouver l'existant tôt** : regarder le système fonctionner, puis faire des essais à blanc. Les essais à blanc ne sont jamais cités comme résultats.

---

## 3. Le raisonnement avant le code

| Étape | Contenu |
|---|---|
| **Problème** | Tenir des pics de charge et des dépendances défaillantes sans jamais violer l'invariant |
| **Incertitude** | *Nous ne savons pas si* le découplage par événements améliore assez la tenue au pic et la tolérance aux pannes pour compenser sa complexité |
| **Assumption centrale** | *Nous supposons que* l'événementiel est plus scalable : la file absorbe les pics |
| **Décision candidate** (ADR-001, figée avant les mesures) | **ADOPT EVENT-DRIVEN** |

Les assumptions (A-01 à A-30) et les questions ouvertes sont dans `docs/hypotheses-assumption.md`.

---

## 4. Les hypothèses (avec mesure et seuil)

| # | Hypothèse | Scénario | Seuil |
|---|---|---|---|
| **H1** | Au pic, l'async garde son débit | S2 : 500 cmd/s pendant 5 min | Débit accepté ≥ 95 %, acceptation p95 < 1 s, 0 violation de I1 |
| **H2** | En charge normale, le sync complète plus vite | S1 : 100 cmd/s | Complétion p95 au moins 20 % plus faible |
| **H3a** | Avec un service secondaire en panne, l'async termine les commandes | S4b : Shipping arrêté 30 s | ≥ 99 % terminées en moins de 2 min |
| **H3b** | Avec Payment en panne, l'async ne perd rien et rattrape | S4 : Payment arrêté 30 s | 0 perdue, ≥ 99 % en état final en moins de 2 min |
| **H3c** | Avec Payment lent, le client n'attend pas en async | S3 : Payment à 2 s pendant 60 s | Async : réponse < 200 ms et 0 abandon ; sync : plus de 50 % d'abandons |
| **H4** | L'idempotence tient l'invariant à faible coût | S5 : doublons | 0 effet en double, surcoût < 10 % |
| **H5** | Une commande est plus difficile à tracer en async | S1 | Moins de 99 % de traces complètes |
| H6 | L'hybride cumule les avantages | S1, S4b | *En brouillon* |

Règle : un verdict n'est définitif qu'avec **deux répétitions concordantes**.

---

## 5. Ce qui a été construit

```
sync/   Order appelle Payment → Inventory → (confirmation) → Shipping → Notification en REST
async/  Order publie OrderCreated ; chaque service réagit aux événements (chorégraphie, RabbitMQ)
common/ schéma et données, vérification des invariants, charge k6, scripts de mesure, observabilité
docs/   ADR, hypothèses, décisions, invariants, résultats, cas de compréhension
```

| Étape | Livrable |
|---|---|
| 1. Socle | PostgreSQL 17, schéma commun ; observabilité (Jaeger, Prometheus, Grafana) ; images Docker figées |
| 2. Variante sync | 5 services REST, compensation (annulation du paiement si stock insuffisant) |
| 3. Invariants | I1 (énoncé) + I2 à I11 ; `verify` (sûreté / vivacité), `reset` |
| 4. Variante async | RabbitMQ, outbox transactionnel, idempotence des consommateurs, DLQ |
| 5. Parité | `check-parity.js` : mêmes `domain.js`, même configuration (45 contrôles) |
| 6. Traces | Une trace par commande à travers les 5 services, cherchable par `order.id` |
| 7. Scénarios | Crochets (panne, lenteur, doublons), profils k6, `run-scenario.js`, mesure par phase |

---

## 6. Les règles d'équité

La comparaison n'a de sens que si **seul le style de communication diffère** :

- **Même logique métier** : `domain.js` identiques, vérifiés automatiquement.
- **Mêmes ressources** : 1 CPU et 512 Mo par service, pool de 20 connexions à la base.
- **Même concurrence** : 64 traitements en parallèle par service (`prefetch` = connexions sortantes).
- **Même budget de nouvelles tentatives : 0.** Aucune résilience ajoutée à une seule variante.
- **Même charge** (k6), **mêmes latences simulées**, **même invariant**, appliqué par **la même requête SQL**.
- **Latences mesurées en base**, avec les mêmes requêtes : acceptation, confirmation, complétion.
- **Délai client de 5 s** et traces échantillonnées à 10 % pendant la charge, pour les deux.

---

## 7. Le protocole d'un run

`node common/scripts/run-scenario.js --project sync|async --scenario s1 … s5 --rep N`

1. **Contrôles** : un seul projet actif, observabilité vivante, parité respectée.
2. **Réglages du run** : taux de traces, idempotence, doublons.
3. **Remise à zéro** de la base et des files.
4. **Charge k6** : préchauffage non compté, puis phases. **La phase est écrite dans chaque commande.**
5. **Panne au bon moment** (arrêt d'un service, ou lenteur injectée), avec l'heure réelle contrôlée.
6. **Drainage** : on attend que tout soit terminé, plafonné à 10 min.
7. **Mesures** : invariants, latences par phase, métriques Prometheus, ressources des conteneurs, traces.
8. **Validité** : *valide*, *valide sous saturation* (ne peut que rejeter) ou *invalide* → `run.json`.

---

## 8. Les défauts trouvés en chemin

Les essais à blanc ont surtout servi à **corriger le banc d'essai** avant de mesurer.

| Défaut | Effet | Correction |
|---|---|---|
| `received_at` écrit trop tard | Latences sous-estimées sous charge | Heure d'arrivée notée dès la réception (C3) |
| **Algorithme de Nagle (TCP)** | +40 ms par événement, soit 240 ms au lieu de 113 ms par commande en async | Connexion AMQP en `noDelay` (C6) |
| Jaeger tué faute de mémoire | Traces perdues, mémoire volée aux services | Plafond de traces, bruit `/health` supprimé |
| Panne levée 6 min en retard | Le scénario joué n'était plus S3 | Heure réelle de la panne contrôlée |
| k6 à court de VUs | Itérations perdues, run invalide | VUs préparés d'avance, avec marge |
| k6 sature la machine | Mesure d'une machine surchargée | Surveillance de k6 ; critère de santé à corriger |
| `now()` en début de transaction | Horodatages inversés en async (I9) | Noté, à corriger (`clock_timestamp()`) |

**Un défaut corrigé est un biais évité.** Sans la correction de Nagle, H2 aurait été faussée contre l'async.

---

## 9. Les résultats (1 répétition, provisoires)

| Hypothèse | Verdict | Mesures clés (sync / async) |
|---|---|---|
| Exigence S1 | **Respectée** par les deux | Acceptation p95 : 68 / 77 ms |
| H2 (latence) | **Rejetée** | Complétion p95 : 146 / 162 ms, soit un écart de 9,9 % |
| H5 (traces) | **Rejetée** | Traces complètes : 100 % / 100 % |
| H3a (Shipping arrêté) | **Supportée** | Commandes terminées : ≈ 3 % / **100 %** |
| H3b (Payment arrêté) | **Supportée** | Commandes bloquées : 2 976 / **0** |
| H3c (Payment lent) | **Supportée** | Abandons côté client : **87,6 %** / 0 % |
| H4 (doublons) | **Supportée** | 0 effet en double avec protection ; surcoût nul à la médiane |
| **H1 (pic)** | **Non concluante, tendance rejetée** | À 500 cmd/s : accepté 70,6 % / 52,6 % ; acceptation p95 3,7 s / 370 s |

Détail et fichiers de preuve : `docs/resultats.md`.

---

## 10. Ce que disent les mesures

**L'async gagne sur la résilience**
- Une panne ou une lenteur de dépendance **n'atteint pas le client** : les commandes attendent dans la file, puis aboutissent toutes.
- Le sync, sans nouvelle tentative, **abandonne** les commandes de la panne : erreur côté client, commandes bloquées.

**Le sync gagne sur la montée en charge, sur ce banc d'essai**
- Il reste sous 1 s jusqu'à **300 cmd/s**, contre 200 pour l'async.
- Le sync sature **Order** (un cœur). L'async sature **la base partagée** : il fait beaucoup plus d'écritures par commande (outbox, idempotence, une transaction par événement).

**Le coût caché de l'async**
- Après une panne, la file fait **attendre les commandes suivantes** (5 à 7 s au p95).

**Ce qui ne départage pas**
- La latence en charge normale, et la traçabilité.

---

## 11. Les limites

- **Un seul hôte** : k6, les services, la base, le broker et l'observabilité se partagent la machine. Au pic, k6 lui-même a saturé.
- **Une base PostgreSQL unique partagée**. Elle pénalise l'async ; avec une base par service, le goulot serait réparti.
- **Un cœur par service** : on mesure la tenue à ressources égales, pas la montée en charge horizontale.
- **Services simulés** : latences et pannes injectées.
- **Budget de nouvelles tentatives à 0** : une part de l'avantage de l'async en résilience vient de là.
- **Orchestration (sync) contre chorégraphie (async)** : deux choses changent à la fois.
- **D5** : la confirmation précède l'expédition, contrairement à la chaîne de l'énoncé. Une branche `experiment/workflow-enonce` est prévue pour tester l'autre ordre.

On conclut sur **ce banc d'essai**, pas sur « le synchrone » ou « l'événementiel » en général.

---

## 12. Vers la décision

**La tendance actuelle** est contraire à la décision candidate (ADOPT EVENT-DRIVEN) :
- l'async apporte une **vraie résilience** face aux dépendances ;
- mais il **ne tient pas mieux le pic** sur ce banc d'essai, et il **consomme plus de ressources**.

Ce profil évoque **l'hybride** : synchrone sur le chemin critique (paiement, stock), événements pour l'expédition et la notification. **Il n'est pas encore mesuré** (H6).

**Reste à faire avant l'ADR final :**
1. Répétitions 2 et 3 de chaque scénario.
2. Un run async exploitable pour S2.
3. Corriger `now()` et le critère de santé de k6.
4. Décider la preuve pour l'hybride : une 3ᵉ variante mesurée, ou une déduction.
5. Rédiger l'ADR final : *Evidence*, *Results*, *Trade-offs*, *Limitations*, *Final decision*, *Consequences*.
