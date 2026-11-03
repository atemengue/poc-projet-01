# POC « Communication synchrone et asynchrone » — Hypothèses et assumptions

> Source : l'énoncé « Choisir l'architecture du traitement des commandes d'une plateforme de commerce électronique » et les précisions de Régis (2026-10-23 et 2026-10-27).
> Date de rédaction : 2026-11-02.
> Rien n'est implémenté ni mesuré. Les éléments sont étiquetés : **énoncé**, **Régis** (précision reçue), **proposition** ou **interprétation** (de ma part, à valider).

---

## Partie 1 — Hypothèses

L'énoncé exige **au moins trois hypothèses**, chacune devant pouvoir être confrontée à des observations. Règle centrale : chaque métrique doit répondre à la question « quelle hypothèse permet-elle d'évaluer ? ».

### 1.1 Hypothèses de l'énoncé

| ID | Thème | Hypothèse | Scénarios | Origine |
|---|---|---|---|---|
| H1 | Scalabilité | Sous forte charge, l'architecture événementielle maintient un débit de traitement supérieur à l'architecture synchrone. | S2 | énoncé |
| H2 | Latence | L'architecture synchrone offre une latence de complétion plus faible lorsque le système fonctionne sous charge normale. | S1 | énoncé |
| H3 | Résilience | Lorsqu'un service secondaire est temporairement indisponible, l'architecture événementielle permet de continuer à accepter des commandes dans davantage de situations. | S3, S4 | énoncé |

### 1.2 Hypothèses additionnelles proposées

| ID | Thème | Hypothèse | Scénarios | Origine |
|---|---|---|---|---|
| H4 | Cohérence | L'architecture événementielle exige des mécanismes d'idempotence explicites pour tenir l'invariant métier en cas de livraison multiple. | S5 | proposition |
| H5 | Observabilité | Reconstruire le traitement d'une commande individuelle est plus coûteux en événementiel qu'en synchrone (propagation du contexte de traçage dans les messages). | S1 à S5 | proposition |

### 1.3 Pistes mentionnées par l'énoncé (non formulées)

Cohérence, complexité de coordination, observabilité, consommation de ressources, coût opérationnel, facilité de débogage.

### 1.4 Traçabilité mesure → hypothèse (proposition)

| Métrique | Hypothèse évaluée | Scénario |
|---|---|---|
| Latence p50/p95/p99 (jusqu'à « accepté » et jusqu'à « confirmé ») | H2 | S1 |
| Débit soutenu et point de saturation | H1 | S2 |
| Longueur de file, retries | H1, H3 | S2, S4 |
| Threads/connexions occupés, latence des autres commandes | H3 | S3 |
| Commandes perdues/rejetées, temps de reprise | H3 | S4 |
| Effets de bord dupliqués, commandes confirmées sans paiement/stock | H4, invariant | S4, S5 |
| Effort de reconstruction d'une trace de commande | H5 | S1 à S5 |

### 1.5 Points de vigilance sur les hypothèses

- **H3 et Payment (interprétation)** : H3 parle d'un service *secondaire*, alors que S3 et S4 ciblent Payment, qui fait partie de l'invariant. Dans le chemin critique, une commande ne peut être au mieux qu'« en attente », jamais confirmée. À préciser dans l'ADR : mesure-t-on le gain d'acceptation ou le gain de confirmation ?
- **H2 et le sens de « latence »** : depuis la précision de Régis (2026-10-27), le p95 < 1 s se mesure jusqu'à l'état « accepté » dans les deux architectures. La latence de complétion (jusqu'à « confirmé ») doit être rapportée séparément pour que la comparaison reste honnête.
- **S5 symétrique (proposition)** : un retry client ou un timeout suivi d'un nouvel appel peut dupliquer un paiement ou une réservation en synchrone. Tester l'idempotence des deux variantes rendrait la comparaison équitable.

### 1.6 Verdicts (à remplir après exécution)

| ID | Verdict (supportée / réfutée / non concluante) | Preuve | Notes |
|---|---|---|---|
| H1 | — | — | — |
| H2 | — | — | — |
| H3 | — | — | — |
| H4 | — | — | — |
| H5 | — | — | — |

---

## Partie 2 — Assumptions

### 2.1 Posées par l'énoncé

| # | Assumption | Précision |
|---|---|---|
| A-01 | Les seuils chiffrés sont pédagogiques. | 100 cmd/s en charge normale, 500 cmd/s pendant 5 min en pic, p95 < 1 s. Ils ne proviennent pas des références. |
| A-02 | Le trafic va croître fortement. | Les pics promotionnels peuvent être plusieurs fois supérieurs à la charge normale. |
| A-03 | Les services peuvent être simulés. | Pas de vrai fournisseur de paiement. Seul le comportement architectural doit être réaliste. |
| A-04 | Un seul scénario métier : Place Order. | Requête minimale : `customerId`, `items[]`, `quantity`, `paymentInformation`, `shippingAddress`. |
| A-05 | Le broker est interchangeable. | Kafka, RabbitMQ, NATS, Redis Streams ou autre. On compare un style, pas des brokers. |
| A-06 | Les valeurs de panne sont indicatives. | Payment à 2 s de latence (S3), indisponible 30 s (S4). |
| A-07 | L'hybride est une piste, pas un acquis. | Paiement et stock en synchrone, puis événements pour expédition et notification. À tester, non à présupposer. |
| A-08 | L'ADR provisoire contient une décision candidate. | Intuition de départ que la PoC doit confirmer ou infirmer. |
| A-09 | L'invariant s'applique aux deux architectures. | Pas de confirmation sans paiement autorisé **et** stock réservé. |
| A-10 | « NO DECISION » est une conclusion acceptable. | À condition d'être justifiée. |

### 2.2 Précisions de Régis

| # | Assumption | Date | Statut |
|---|---|---|---|
| A-11 | **Accepté = paiement passé.** Le service Payment est un simulateur qui renvoie simplement une réponse (autorisé ou refusé). | 2026-10-23 | Confirmée |
| A-12 | **Le critère de latence (p95 < 1 s) se mesure jusqu'à l'état « accepté »**, dans les deux architectures. | 2026-10-27 | Confirmée |
| A-13 | **Confirmé = la transaction sur Order.** Transition finale d'état écrite par le service Order, validée seulement si paiement autorisé et stock réservé. Point unique d'application de l'invariant. | 2026-10-27 | Confirmée (formulation de ma part, à valider) |

### 2.3 Mes assumptions, à valider

| # | Assumption | Origine | Statut |
|---|---|---|---|
| A-14 | Le simulateur Payment est configurable : succès, refus, latence injectée, indisponibilité. | proposition | À valider |
| A-15 | Tout tourne sur un seul hôte : générateur de charge, broker, services et monitoring partagent les ressources. | interprétation | À valider |
| A-16 | La variante B utilise la **chorégraphie** (comme dans l'énoncé) plutôt qu'une saga orchestrée. | interprétation | À valider |
| A-17 | Les états visibles d'une commande sont au moins : reçue, acceptée, confirmée, rejetée. | interprétation | À valider |
| A-18 | « Accepté » ≠ « confirmé » : acceptée = paiement passé ; confirmée = paiement passé **et** stock réservé. | interprétation | À valider |

### 2.4 Points encore flous

| # | Question ouverte | Pourquoi ça compte |
|---|---|---|
| Q-01 | **Forme du pic** : montée progressive jusqu'à 500 cmd/s (S2) ou palier direct de 5 minutes (section Exigences) ? | Change le profil de charge de S2 et la lecture de la dégradation. |
| Q-02 | **Frontière de l'hybride** : quelles étapes restent dans le chemin critique (paiement, stock) et lesquelles passent en asynchrone (expédition, notification) ? | Définit l'option hybride à comparer. |
| Q-03 | **Confirmation en B** : attend-elle l'expédition (`ShipmentRequested`) ou suit-elle directement la réservation du stock ? | Détermine la latence de complétion et l'endroit où l'invariant est appliqué. |
| Q-04 | **Réponse initiale en B** : attend-elle le paiement ? Si oui, B ressemble à l'hybride. Si non, « accepté » arrive de façon asynchrone. | Change le sens de H2 et de H3. |
| Q-05 | **Comment le client apprend-il qu'il est « accepté »** en B (réponse directe, consultation, notification) ? | Change l'expérience, pas ce qu'on mesure. |
| Q-06 | **Priorité des drivers** (performance, disponibilité, cohérence, complexité opérationnelle…) : dans quel ordre ? | Sans hiérarchie, la matrice de décision reste difficile à arbitrer. |
| Q-07 | **Notification si l'expédition échoue** : quand Shipping est indisponible après la confirmation, faut-il quand même notifier le client ? Aujourd'hui (sync), la notification de confirmation n'est pas envoyée et la commande n'est jamais terminée (cas de compréhension C1-d). L'énoncé donne l'ordre Shipping → Notification, pas leur dépendance. *(proposition : ne rien changer, ajouter un comportement reviendrait à ajouter de la résilience à une variante)* | Influe sur I11 (complétion) et sur ce que mesure une panne de Shipping (variante S4b éventuelle). |

---

## Partie 3 — Menaces à la validité liées aux assumptions (proposition)

- Services simulés : latences et pannes injectées, pas réelles.
- Un seul hôte : les ressources partagées biaisent les mesures de saturation.
- Les résultats dépendent du broker choisi alors que l'énoncé veut comparer un style.
- Comparer p95 d'acceptation (B) à p95 de complétion (A) fausserait la lecture ; A-12 corrige ce risque.
- Chorégraphie contre orchestration : le choix en B influe sur la complexité et l'observabilité mesurées.
- Un NO DECISION reste légitime si le dispositif ne discrimine pas.