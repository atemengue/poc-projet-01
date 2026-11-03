# Méthodologie de travail

> Rédigé le 2026-11-03 à partir de la façon dont le travail s'est réellement déroulé sur ce POC.
> À corriger ou compléter par l'auteur du POC : ce document décrit sa méthode, pas celle de Claude.

## 1. Cycle d'une étape

Chaque étape du POC suit le même cycle. On ne passe à la phase suivante qu'une fois la précédente validée.

| # | Phase | Ce qui se passe | Produit |
|---|---|---|---|
| 1 | **Faire le point** | Résumer l'état réel du dépôt (ce qui existe, ce qui manque, ce qui est en discussion) avant de commencer. | Résumé de situation |
| 1 bis | **Éprouver l'existant** | Quand c'est utile : vérifier si l'on peut déjà exécuter un cas, puis faire un essai à blanc du système actuel pour voir ce qu'il retourne (voir §2). | Constat de capacité, chiffres de calibrage |
| 2 | **Expliquer et discuter** | Claude présente la conception de l'étape : découpage, déroulé, choix proposés, points à valider. On en discute. **Aucun code n'est écrit avant l'accord.** | Conception validée |
| 3 | **Implémenter** | Uniquement le périmètre de l'étape validée, sans anticiper les suivantes. | Code, configuration |
| 4 | **Vérifier sur la pile réelle** | Faire tourner ce qui a été construit et contrôler le résultat (pas seulement des tests unitaires) : parcours nominaux, cas d'erreur, pannes, observabilité. | Constat de vérification |
| 5 | **Expliquer comment tester** | Donner les commandes et les résultats attendus pour que l'auteur refasse lui-même la vérification. | Procédure de test |
| 6 | **Documenter** | Mettre à jour le README (tout doit pouvoir démarrer à partir de lui), l'état d'avancement de `CLAUDE.md`, et consigner les décisions dans `docs/` avec leur source. | Documentation à jour |
| 7 | **Commiter, puis pousser** | Seulement sur demande explicite. « Commit » et « push » sont deux demandes distinctes. Les commits vont directement sur `main`. | Historique git |

## 2. Principes

### Preuves avant décision
- Ce qui compte est la chaîne **preuve → raisonnement → décision**, pas le choix final.
- Les **hypothèses**, les **assumptions** et les **critères de verdict** sont écrits **avant** de mesurer (`docs/hypotheses-assumption.md`), pour ne pas interpréter les résultats après coup.
- Rien n'est présenté comme mesuré s'il ne l'a pas été ; tout résultat cite le fichier de `results/` qui le prouve.
- Un essai à blanc (calibrage du banc d'essai) n'est jamais cité comme résultat.

### Traçabilité des sources
- Chaque élément est étiqueté : **énoncé**, **Régis** (précision reçue), **proposition** ou **interprétation**.
- Une proposition n'est pas une décision : les arbitrages reviennent à Régis.
- Les décisions de conception vont dans `docs/decisions-conception.md`, les invariants dans `docs/invariants.md`.

### Le dépôt fait foi
- Si un document dit une chose et que le code en dit une autre, le code fait foi : on **signale l'écart** au lieu de le corriger en silence.
- L'état d'avancement de `CLAUDE.md` décrit ce qui est réellement dans le dépôt, vérifié, pas ce qui est annoncé.

### Éprouver l'existant tôt
- Régulièrement, et en particulier avant d'investir dans la suite, on se demande : **« est-on capable, aujourd'hui, d'exécuter tel cas ? »** (par exemple le scénario S1).
- La réponse distingue ce qui est prêt de ce qui manque pour une exécution valide selon le protocole.
- **D'abord, voir le fonctionnement** du système tel qu'il est, sans charge : quelques commandes isolées couvrant chaque parcours et chaque panne, puis lecture de ce qu'il retourne (réponses HTTP, état en base, traces, logs). On commente ce qu'on observe, y compris les surprises.
- Chaque observation qui aide à comprendre le système est notée comme **cas de compréhension rejouable** dans `docs/cas-de-comprehension.md` (question, explication simple, commandes pour rejouer, ce qu'on doit observer, pourquoi ça compte).
- **Ensuite seulement, l'essai à blanc sous charge** (banc d'essai) : est-ce qu'il tient la charge, où il casse, quels chiffres il donne.
- Objectifs : calibrer le banc d'essai (si le système s'effondre, le problème vient du banc, pas du style d'architecture), découvrir les problèmes tôt, et produire des outils réutilisables pour les vraies mesures (script k6, requêtes de latence).
- Un essai à blanc est rangé à part et **n'est jamais cité comme résultat** dans l'ADR.

### Faire le point régulièrement
- Avant une nouvelle étape, ou quand le contexte change, on s'arrête pour résumer la situation.
- Les questions de fond (définition d'une hypothèse, critère de mesure) sont discutées avant d'écrire le code qui en dépend.

### Prudence sur les actions à effet de bord
- Avant une action qui détruit ou recrée quelque chose (conteneur, volume, fichier non versionné), on regarde ce qui sera perdu et on prévient.

## 3. Conventions pratiques

- **Langue** : échanges et documentation en français ; code, identifiants et noms de métriques en anglais.
- **Commandes** : toujours lancées depuis la racine du dépôt (`docker compose -f <projet>/docker-compose.yml …`).
- **Versions** : images Docker figées (numéro de version + empreinte) ; jamais `:latest`.
- **Configuration** : tout ce qui doit survivre à une recréation de conteneur est dans des fichiers versionnés (ex. provisioning Grafana).

## 4. À compléter

Points de méthode que ce document ne couvre pas encore (rythme des échanges avec Régis, échéances, critères de fin d'étape, etc.) :

- …
