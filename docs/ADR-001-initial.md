# ADR-001 — Communication architecture for order processing

## Status

Version initiale, écrite **avant** toute mesure. Pour cet ADR nous sommes partie par intuition et nous
avons ete influencer par la connaisance technologique, notre experience et des suppositions.

## Context

Une plateforme de commerce électronique traite les commandes avec cinq services : Order, Payment, Inventory, Shipping, Notification. Pour chaque commande : création, validation du paiement, réservation du stock, demande d'expédition, confirmation au client.

L'entreprise prévoit une forte croissance du trafic, avec des pics promotionnels plusieurs fois supérieurs à la charge normale (paramètres pédagogiques : 100 cmd/s en charge normale, 500 cmd/s pendant 5 min en pic, p95 < 1 s pour la réponse initiale).

Quelle que soit l'architecture, un invariant doit tenir : **une commande ne peut être confirmée que si le paiement est autorisé et le stock réservé.**

La direction technique ne veut pas adopter une architecture événementielle « parce qu'elle est plus scalable » : elle demande des preuves.

## Problem

**Nous ne savons pas si** le découplage par événements améliore suffisamment la tenue au pic (500 cmd/s) et la tolérance aux pannes de dépendances pour compenser la complexité qu'il ajoute pour préserver l'invariant (idempotence, outbox, cohérence à terme).

## Options considered

1. **Synchronous workflow** — Order appelle successivement Payment → Inventory → Shipping → Notification (REST).
2. **Event-driven workflow** — Order enregistre la commande et publie un événement ; les autres services réagissent aux événements (chorégraphie, RabbitMQ).
3. **Hybrid** — Payment et Inventory en synchrone jusqu'à la confirmation ; Shipping et Notification par événements.

## Architectural drivers

| Driver | Ce qui compte ici |
|---|---|
| Scalability | Tenir le pic de 500 cmd/s sans effondrement incontrôlé |
| Availability | Continuer à prendre en compte les commandes quand une dépendance est lente ou indisponible, et revenir à la normale après |
| Performance | p95 < 1 s jusqu'à l'acceptation en charge normale |
| Consistency | Invariant tenu, y compris en cas de message traité plusieurs fois |
| Observability | Pouvoir reconstruire le traitement d'une commande individuelle |
| Operational complexity | Coût d'exploitation et de compréhension du système |

L'ordre de priorité des drivers reste à fixer (Q-06).

## Candidate decision

**ADOPT EVENT-DRIVEN** — intuition de l'equipe, 2026-11-07.

Raisons :
- la file absorbe les pics de charge, là où la chaîne synchrone sature ;
- une dépendance lente ou indisponible ne bloque pas la prise en compte des commandes.

Cette décision est volontairement provisoire. Elle sera confirmée ou infirmée principalement par **H1** (scalabilité) et **H3** (résilience), en tenant compte du coût mesuré par **H4** (idempotence) et **H5** (observabilité).


Les sections ci-dessous seront completes apres execution des scenarios de test de notre ADR.

## Evidence collected

—

## Experimental results

—

## Trade-offs

—

## Limitations

—

## Final decision

—

## Consequences

—
