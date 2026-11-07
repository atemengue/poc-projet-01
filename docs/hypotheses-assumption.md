# POC « Communication synchrone et asynchrone » — Problème, incertitude, assumptions et hypothèses

> Source : l'énoncé « Choisir l'architecture du traitement des commandes d'une plateforme de commerce électronique » (`docs/contexte.md`) et les précisions du responsable du projet (2026-10-23 et 2026-10-27).
> Rédaction : 2026-11-02 ; restructuré le 2026-11-07 (problème → incertitude → assumptions → hypothèses).
> Rien n'est mesuré. Les éléments sont étiquetés : **énoncé**, **Responsable** (précision reçue du responsable du projet), **proposition** ou **interprétation** (de ma part, à valider).
> Le cours distingue l'**assumption** (ce que nous croyons actuellement) de l'**hypothèse** (cette croyance exposée à la falsification, avec une mesure et un seuil).

---

## 1. Problème architectural

La plateforme doit traiter des commandes dont la charge peut devenir plusieurs fois supérieure à la normale lors des événements promotionnels, et dont certaines dépendances (paiement) peuvent ralentir ou devenir indisponibles, sans jamais confirmer une commande dont le paiement n'est pas autorisé ou le stock pas réservé. Il faut choisir comment les cinq services (Order, Payment, Inventory, Shipping, Notification) communiquent pour traiter une commande, et aucune donnée ne permet aujourd'hui de dire quel style de communication tient ces contraintes.

## 2. Incertitude

**Nous ne savons pas si** le découplage par événements améliore suffisamment la tenue au pic (500 cmd/s) et la tolérance aux pannes de dépendances pour compenser la complexité qu'il ajoute pour préserver l'invariant (idempotence, outbox, cohérence à terme).

Pourquoi cette formulation :
- la charge de la preuve est sur l'événementiel (A-19) : le synchrone, plus simple, est l'option retenue par défaut ;
- la question est un compromis bénéfice / coût, pas une course : les conclusions données en exemple par l'énoncé (§12) ont toutes cette forme ;
- elle mène aux quatre décisions : bénéfice partout → `ADOPT EVENT-DRIVEN` ; bénéfice seulement hors du chemin critique → `ADOPT HYBRID ARCHITECTURE` ; aucun bénéfice qui compense → `ADOPT SYNCHRONOUS` ; résultats qui ne discriminent pas → `NO DECISION`.

Limite connue : la formulation est asymétrique, elle ne pose pas d'abord la question « le synchrone tient-il le pic ? ». H1 la couvre en comparant les deux variantes aux mêmes seuils.

---

## 3. Assumptions

### 3.1 Assumption centrale

**Nous supposons que** l'architecture orientée événements est plus scalable que l'architecture synchrone : sous un pic, la file absorbe la charge et les commandes continuent d'être acceptées dans les délais, alors que la chaîne synchrone sature.

C'est la croyance que la direction refuse d'adopter sans preuve (énoncé). Elle est exposée à la falsification par **H1** (§4). Choix de l'assumption centrale et seuils de H1 : responsable du POC, 2026-11-07.

### 3.2 Posées par l'énoncé

| # | Assumption | Précision |
|---|---|---|
| A-01 | Les seuils chiffrés sont pédagogiques. | 100 cmd/s en charge normale, 500 cmd/s pendant 5 min en pic, p95 < 1 s. Ils ne proviennent pas des références. |
| A-02 | Le trafic va croître fortement. | Les pics promotionnels peuvent être plusieurs fois supérieurs à la charge normale. |
| A-03 | Les services peuvent être simulés. | Pas de vrai fournisseur de paiement. Seul le comportement architectural doit être réaliste. |
| A-04 | Un seul scénario métier : Place Order. | Requête minimale : `customerId`, `items[]`, `quantity`, `paymentInformation`, `shippingAddress` (forme retenue : décision SV5). |
| A-05 | Le broker est interchangeable. | Kafka, RabbitMQ, NATS, Redis Streams ou autre. On compare un style, pas des brokers. |
| A-06 | Les valeurs de panne sont indicatives. | Payment à 2 s de latence (S3), indisponible 30 s (S4). |
| A-07 | L'hybride est une piste, pas un acquis. | Paiement et stock en synchrone, puis événements pour expédition et notification. À tester, non à présupposer (H6). |
| A-08 | L'ADR provisoire contient une décision candidate. | Intuition de départ que la PoC doit confirmer ou infirmer, écrite avant l'expérience. |
| A-09 | L'invariant s'applique à toutes les options. | Pas de confirmation sans paiement autorisé **et** stock réservé. C'est une contrainte, pas un critère de comparaison. |
| A-10 | « NO DECISION » est une conclusion acceptable. | À condition d'être justifiée. |
| A-19 | La charge de la preuve est sur l'événementiel. | « La direction technique ne souhaite pas adopter une architecture événementielle uniquement parce qu'elle est considérée comme plus scalable. Elle demande des preuves. » |
| A-20 | La décision porte sur la coordination des services, pas sur leur découpage. | Les cinq responsabilités sont données ; seule la façon de les faire communiquer change. |
| A-21 | Le choix se juge sur plusieurs critères à la fois. | Performance, scalabilité, disponibilité, cohérence, fiabilité, maintenabilité, observabilité, complexité opérationnelle. |
| A-22 | Une réponse initiale peut précéder la fin du workflow. | Pour l'asynchrone, l'énoncé distingue latence d'acceptation et latence de complétion. |
| A-23 | Au pic, on exige une dégradation contrôlée, pas l'absence de dégradation. | « Continuer à accepter ou traiter les commandes sans effondrement incontrôlé. » |
| A-24 | Après une panne, le système doit revenir à un état normal. | S4 : « L'architecture revient-elle à un état normal après la panne ? » La récupération fait partie du critère. |
| A-25 | Il doit être possible de reconstruire le traitement d'une commande individuelle. | Y compris à travers les messages (propagation du contexte de traçage). |
| A-26 | Le traitement multiple d'un message est un risque propre à l'asynchrone. | S5 n'est demandé que « pour la variante événementielle ». |

### 3.3 Précisions du responsable

| # | Assumption | Date | Statut |
|---|---|---|---|
| A-11 | **Accepté = paiement passé.** Le service Payment est un simulateur qui renvoie simplement une réponse (autorisé ou refusé). Accepté ≠ confirmé (ancienne A-18, fusionnée ici). | 2026-10-23 | Confirmée |
| A-12 | **Le critère de latence (p95 < 1 s) se mesure jusqu'à l'état « accepté »**, dans les deux architectures. | 2026-10-27 | Confirmée |
| A-13 | **Confirmé = la transaction sur Order.** Transition finale d'état écrite par le service Order, validée seulement si paiement autorisé et stock réservé. Point unique d'application de l'invariant. | 2026-10-27 | Confirmée (formulation de ma part, à valider) |

Écart à signaler dans l'ADR : pour l'Option A, l'énoncé dit que la commande n'est « acceptée qu'après l'exécution du workflow prévu » ; A-11 place l'acceptation au paiement.

### 3.4 Propositions, à valider

| # | Assumption | Origine | Statut |
|---|---|---|---|
| A-14 | Le simulateur Payment est configurable : succès, refus, latence injectée, indisponibilité. | proposition | Partiel : refus (`tok_declined`) et indisponibilité (arrêt du conteneur) existent ; la latence injectée pendant un run (`POST /admin/chaos`) reste à faire. |
| A-15 | Tout tourne sur un seul hôte : générateur de charge, broker, services et monitoring partagent les ressources. | interprétation | Constaté ; limite à citer dans l'ADR. |
| A-16 | La variante B utilise la **chorégraphie** (comme dans l'énoncé) plutôt qu'une saga orchestrée. | interprétation | À valider |
| A-17 | Les états visibles d'une commande sont au moins : reçue, acceptée, confirmée, rejetée. | interprétation | Appliqué dans le schéma (`orders.status`). |
| A-27 | Shipping et Notification sont des services secondaires : les retarder après la confirmation n'a pas de conséquence métier. | proposition (les exemples des §12 et §13 de l'énoncé vont dans ce sens) | À valider |
| A-28 | Payment est une dépendance externe qui peut être lente ou indisponible. | proposition (justifie S3 et S4) | À valider |
| A-29 | Les pics sont courts (de l'ordre de 5 min) : une file peut les absorber puis se vider. | proposition | À valider |
| A-30 | L'équipe peut exploiter un broker en production et maîtrise l'idempotence, l'outbox et le traçage distribué. | proposition | Non testable par le POC : à porter dans l'ADR comme limite. |

### 3.5 Questions ouvertes

| # | Question | Valeur par défaut / état | Pourquoi ça compte |
|---|---|---|---|
| Q-01 | **Forme du pic** : montée progressive jusqu'à 500 cmd/s (S2) ou palier direct de 5 minutes (section Exigences) ? | D8 : montée 2 min puis palier 5 min | Change le profil de charge de S2 et la lecture de la dégradation. |
| Q-02 | **Hybride** : frontière (paiement et stock dans le chemin critique, expédition et notification en asynchrone ?) et preuve (troisième variante `hybrid/` mesurée, ou déduction à partir de A et B, à étiqueter comme interprétation) ? | En attente (H6, brouillon) | Définit l'option hybride et la force de la preuve. À trancher avant les mesures. |
| Q-03 | **Confirmation en B** : attend-elle l'expédition (`ShipmentRequested`) ou suit-elle directement la réservation du stock ? | D5 : dès `InventoryReserved`, à l'identique dans A et B | Détermine la latence de complétion ; change la lecture de H3a (voir §4). |
| Q-04 | **Réponse initiale en B** : attend-elle le paiement ? | D4 : `202` sur « reçue », acceptation mesurée par horodatage | Change le sens de H2 et de H3. |
| Q-05 | **Comment le client apprend-il qu'il est « accepté »** en B (réponse directe, consultation, notification) ? | `GET /orders/:id` | Change l'expérience, pas ce qu'on mesure. |
| Q-06 | **Priorité des drivers** (performance, disponibilité, cohérence, complexité opérationnelle…) : dans quel ordre ? | Ouverte | Sans hiérarchie, la matrice de décision reste difficile à arbitrer. |
| Q-07 | **Notification si l'expédition échoue** : quand Shipping est indisponible après la confirmation, faut-il quand même notifier le client ? | Ne rien changer (ajouter un comportement reviendrait à ajouter de la résilience à une variante) | Influe sur I11 (complétion) et sur H3a. |

---

## 4. Hypothèses

Format du cours : *Sous les conditions …, l'utilisation de … permettra de … avec … inférieur/supérieur à …* Chaque hypothèse précise la décision évaluée, les conditions, l'attribut de qualité, la mesure et le seuil.

Latences calculées depuis la base, avec les mêmes requêtes pour toutes les variantes :
- **acceptation** = `accepted_at − received_at` (paiement passé) ;
- **confirmation** = `confirmed_at − received_at` (stock réservé, invariant satisfait) ;
- **complétion** = `completed_at − received_at` (expédition et notification faites).

Règles communes :
- **non concluante** si un run est invalide (`dropped_iterations` ≥ 1 % côté k6), si une mesure manque, ou si les trois répétitions ne donnent pas le même verdict ;
- les chiffres de l'énoncé (100 et 500 cmd/s, 1 s, 2 s, 30 s) sont repris tels quels ; les autres seuils sont des propositions, sauf mention contraire, et doivent être fixés avant toute mesure.

### H1 — Scalabilité (hypothèse centrale)

> Sous un **pic de 500 cmd/s pendant 5 min** (S2), sur ce rig (1 CPU / 512 Mo par service, PostgreSQL partagé, un seul hôte), l'utilisation de l'**architecture événementielle** permettra d'**accepter les commandes** avec un **débit accepté ≥ 95 % du débit offert**, une **latence d'acceptation p95 < 1 s** et **0 violation de I1**, alors que l'architecture synchrone manquera au moins un de ces seuils.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Scalabilité (tenue en charge à ressources égales) |
| Mesure | Débit accepté (commandes avec `accepted_at` par seconde, sur le palier), latence d'acceptation p95 des commandes reçues pendant le palier, violations de I1 (`verify`) |
| Supportée | B respecte les trois seuils et A en manque au moins un. |
| Rejetée | B manque un seuil sans faire mieux que A, ou A respecte aussi les trois seuils (la scalabilité ne départage pas). |
| Origine | Énoncé ; seuils validés par le responsable du POC le 2026-11-07 (95 % : proposition acceptée ; 1 s : énoncé). |

Point d'attention : en B, `accepted_at` n'est écrit qu'après le traitement du paiement. Si la file s'allonge, la latence d'acceptation de B augmente aussi : l'hypothèse est réellement falsifiable.

### H2 — Latence

> Sous une **charge normale de 100 cmd/s pendant 3 min** (S1), l'utilisation de l'**architecture synchrone** permettra de **compléter les commandes** avec une **latence de complétion p95 au moins 20 % inférieure** à celle de l'architecture événementielle, tout en respectant une **latence d'acceptation p95 < 1 s**.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Performance (latence en charge normale) |
| Mesure | Latence de complétion p95 de A et de B ; latence d'acceptation p95 de A |
| Supportée | Écart ≥ 20 % en faveur de A, et A respecte le seuil de 1 s. |
| Rejetée | Écart < 20 %, ou en faveur de B. |
| Origine | Énoncé (« latence de complétion ») ; seuil de 20 % : proposition (marge contre le bruit de mesure), à valider. |

Les latences d'acceptation et de complétion sont rapportées séparément : on ne compare jamais l'acceptation d'une variante à la complétion de l'autre.

### H3 — Résilience

L'énoncé parle d'un service **secondaire** indisponible, alors que S3 et S4 ciblent Payment, qui est dans le chemin de l'invariant. H3 est donc découpée en trois.

**H3a — Service secondaire indisponible** *(demande un scénario S4b)*

> Sous **100 cmd/s avec Shipping indisponible pendant 30 s**, l'utilisation de l'**architecture événementielle** permettra de **terminer les commandes reçues pendant la panne**, avec **≥ 99 % de ces commandes terminées (`completed_at`) dans les 2 min** suivant le retour de Shipping.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Disponibilité, fiabilité (récupération) |
| Mesure | Part des commandes reçues pendant la panne qui sont terminées, et délai après le retour de Shipping |
| Supportée | B ≥ 99 % en moins de 2 min. |
| Rejetée | B < 99 %, ou plus de 2 min. |
| Origine | Énoncé (H3) ; découpage, scénario S4b et seuils : proposition, à valider. |

Constat à porter dans l'ADR : avec D5, le synchrone confirme lui aussi pendant une panne de Shipping (la confirmation précède l'expédition). Le critère « accepter » de l'énoncé ne départage donc pas les variantes ici ; ce qui les distingue est la **complétion** (sans nouvelle tentative, A ne termine jamais ces commandes : violation de I11).

**H3b — Payment indisponible (S4)**

> Sous **100 cmd/s avec Payment indisponible pendant 30 s**, l'utilisation de l'**architecture événementielle** permettra de **prendre en compte les commandes** avec **0 commande perdue**, et **≥ 99 % des commandes reçues pendant la panne dans un état final** (`CONFIRMED` ou `REJECTED`) **moins de 2 min** après le retour de Payment.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Disponibilité, fiabilité (récupération) |
| Mesure | Commandes perdues (envoyées par k6 mais absentes de la base), part en état final et délai de récupération après le retour de Payment |
| Supportée | 0 perdue et ≥ 99 % en état final en moins de 2 min. |
| Rejetée | Au moins une commande perdue, ou < 99 %, ou plus de 2 min. |
| Origine | Énoncé (S4) ; seuils : proposition, à valider. |

Une commande prise en compte pendant la panne ne peut être, au mieux, qu'« en attente » : jamais acceptée ni confirmée sans paiement autorisé.

**H3c — Payment lent (S3)**

> Sous **100 cmd/s avec Payment à 2 s**, l'utilisation de l'**architecture événementielle** permettra de **répondre au client** avec une **latence de réponse HTTP p95 < 200 ms**, les commandes s'accumulant dans la file plutôt que dans les connexions ouvertes.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Disponibilité (isolation des dépendances lentes) |
| Mesure | Latence de réponse HTTP p95 (k6) ; diagnostic : profondeur de file (B), requêtes en vol et attente du pool sortant (A) |
| Supportée | B < 200 ms. |
| Rejetée | B ≥ 200 ms. |
| Origine | Énoncé (S3) ; seuil : proposition, à valider. |

La latence d'acceptation dépasse forcément 2 s dans les deux variantes ; ce qui se compare est l'effet sur les clients et sur les autres commandes.

### H4 — Cohérence (coût de l'idempotence)

> Sous une **livraison en double de chaque événement à 10 cmd/s** (S5), l'utilisation de l'**idempotence des consommateurs** (`processed_events`) permettra de **préserver l'invariant** avec **0 effet en double (I7)** et **0 violation de I1**, pour un **surcoût de latence de complétion p95 inférieur à 10 %** par rapport au même débit sans doublons.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Cohérence, complexité de coordination |
| Mesure | Violations de I7 et I1 ; latence de complétion p95 avec et sans doublons |
| Supportée | I7 = 0, I1 = 0, surcoût < 10 %. |
| Rejetée | I7 > 0 ou I1 > 0 avec idempotence, ou surcoût ≥ 10 %. |
| Validité | Le témoin sans idempotence doit montrer I7 > 0 ; sinon, le test ne prouve rien. |
| Origine | Proposition (reformulée le 2026-11-07 : l'ancienne version, « l'événementiel exige de l'idempotence », était vraie par construction). Seuil de 10 % à valider. |

S5 symétrique (proposition) : un retry client après un timeout peut aussi dupliquer un paiement en synchrone. L'énoncé ne demande S5 que pour l'asynchrone ; tester aussi A (avec `Idempotency-Key`) rendrait la comparaison du coût équitable.

### H5 — Observabilité

> Sous **100 cmd/s** (S1), dans l'**architecture événementielle**, la **reconstruction du traitement d'une commande** sera plus difficile : **moins de 99 % des commandes** auront une trace complète, alors que le synchrone en aura au moins 99 %. Une trace est complète si les étapes de la commande partagent le même `traceId`.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Observabilité, facilité de débogage |
| Mesure | Part des commandes dont la trace Jaeger est complète, sur un échantillon (script à écrire) |
| Supportée | B < 99 % et A ≥ 99 %. |
| Rejetée | B ≥ 99 %. |
| Origine | Proposition ; seuil à valider. |

### H6 — Architecture hybride *(brouillon, en attente de Q-02)*

> Sous une **charge normale de 100 cmd/s** (S1), puis avec **Shipping indisponible pendant 30 s** (S4b), l'utilisation de l'**architecture hybride** (Payment et Inventory en synchrone jusqu'à la confirmation, Shipping et Notification par événements) permettra de **confirmer les commandes** avec une **latence de confirmation p95 au plus 10 % supérieure à celle du synchrone**, et de **terminer ≥ 99 % des commandes reçues pendant la panne** dans les **2 min** suivant le retour de Shipping, avec **0 violation de I1**.

| Élément | Valeur |
|---|---|
| Attribut de qualité | Performance sur le chemin critique, disponibilité en aval |
| Supportée | Les deux conditions sont respectées. |
| Rejetée | L'une des deux échoue. |
| Hors champ | Le pic à 500 cmd/s : le chemin critique de l'hybride est synchrone, c'est H1 qui en décide. |
| Origine | Proposition (demandée par le responsable du POC le 2026-11-07) ; preuve à trancher (Q-02). |

---

## 5. Traçabilité métrique → hypothèse (proposition)

Une métrique **de verdict** décide ; une métrique **de diagnostic** explique le verdict, elle ne décide rien.

| Métrique | Source | Rôle | Hypothèse | Scénario |
|---|---|---|---|---|
| Débit offert, `dropped_iterations` | k6 | Validité du run | toutes | toutes |
| Débit accepté | base | Verdict | H1 | S2 |
| Latence d'acceptation p50/p95/p99 | base | Verdict | H1, H2 | S1, S2 |
| Latence de confirmation p95 | base | Verdict | H6 | S1 |
| Latence de complétion p95 | base | Verdict | H2, H4 | S1, S5 |
| Latence de réponse HTTP p95 | k6 | Verdict | H3c | S3 |
| Commandes perdues, part en état final, délai de récupération | k6 + base | Verdict | H3a, H3b, H6 | S4, S4b |
| Violations I1 à I11 | `verify` | Verdict (I1, I7) | H1, H4, H6 | toutes |
| Part de traces complètes | Jaeger | Verdict | H5 | S1 |
| Temps de drainage après le pic | base | Diagnostic | H1 | S2 |
| Profondeur des files (B) ; requêtes en vol, attente du pool sortant (A) | Prometheus | Diagnostic | H1, H3 | S2, S3, S4 |
| Retard de la boucle d'événements | Prometheus | Diagnostic | H1, H3c | S2, S3 |
| CPU, mémoire par conteneur | Prometheus / Docker | Diagnostic (goulot du rig ou du style ?) | H1 | S1, S2 |

---

## 6. Verdicts (à remplir après exécution)

| ID | Verdict (supportée / rejetée / non concluante) | Preuve (fichier de `results/`) | Notes |
|---|---|---|---|
| H1 | — | — | — |
| H2 | — | — | — |
| H3a | — | — | — |
| H3b | — | — | — |
| H3c | — | — | — |
| H4 | — | — | — |
| H5 | — | — | — |
| H6 | — | — | — |

---

## 7. Menaces à la validité (proposition)

- Services simulés : latences et pannes injectées, pas réelles.
- Un seul hôte (A-15) : les ressources partagées biaisent les mesures de saturation.
- Les résultats dépendent du broker choisi alors que l'énoncé veut comparer un style (A-05).
- Comparer le p95 d'acceptation d'une variante au p95 de complétion de l'autre fausserait la lecture ; A-12 corrige ce risque.
- **Deux variables changent à la fois** : A est orchestrée (Order appelle chaque service), B est chorégraphiée (A-16). Un écart entre A et B peut venir de la communication ou de la coordination.
- **Une seule instance par service** : H1 mesure la tenue en charge à ressources égales, pas la capacité à monter en charge horizontalement.
- **Une base PostgreSQL partagée** : un goulot commun peut masquer l'effet du style.
- **D5 et H3a** : la confirmation avant l'expédition rend le synchrone tolérant à une panne de Shipping pour l'acceptation et la confirmation ; seule la complétion départage.
- Aucune résilience dans aucune variante (règle d'équité) : le synchrone est jugé sans ses protections habituelles (retry, circuit breaker).
- Un `NO DECISION` reste légitime si le dispositif ne discrimine pas.
