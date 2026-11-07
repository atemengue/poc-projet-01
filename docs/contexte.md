Choisir l’architecture du traitement des commandes d’une plateforme de commerce électronique
Pondération : 20 %
Travail : en équipe
Résultat attendu : une décision architecturale documentée et justifiée par des preuves expérimentales

Contexte
Une entreprise exploite une plateforme de commerce électronique. Son architecture actuelle traite les commandes à l’aide d’un ensemble de services.

Lorsqu’un client confirme une commande, plusieurs opérations doivent être réalisées :

création de la commande;

validation du paiement;

réservation du stock;

création de la demande d’expédition;

envoi de la confirmation au client.

L’entreprise prévoit une croissance importante de son trafic, notamment pendant des événements promotionnels où la charge peut être plusieurs fois supérieure à la charge normale.

L’équipe d’architecture doit décider comment réaliser le workflow de traitement des commandes dans la prochaine version du système.

Deux approches sont envisagées.

Option A — Architecture principalement synchrone

Le service de commande appelle successivement les autres services, par exemple par REST ou gRPC :

Order → Payment → Inventory → Shipping → Notification

La commande n’est considérée comme acceptée qu’après l’exécution du workflow prévu.

Option B — Architecture orientée événements

Le service de commande enregistre la commande puis publie un événement tel que OrderCreated.

Les autres services réagissent aux événements :

OrderCreated → PaymentAuthorized → InventoryReserved → ShipmentRequested → OrderConfirmed

Une plateforme de messagerie telle que Kafka, RabbitMQ, NATS ou une technologie équivalente assure les échanges.

La direction technique ne souhaite pas adopter une architecture événementielle uniquement parce qu’elle est considérée comme « plus scalable ». Elle demande des preuves.

La question posée à l’équipe d’architecture est donc :

Quelle architecture devrait être retenue pour le traitement des commandes : principalement synchrone, orientée événements, ou hybride ?

C’est cette question que votre PoC doit permettre de trancher.

1. Votre rôle
Vous êtes l’équipe chargée de préparer une recommandation pour l’Architecture Review Board de l’entreprise.

Vous ne devez pas construire la future plateforme.

Vous devez réaliser une expérience architecturale limitée permettant de réduire l’incertitude associée à cette décision.

La PoC devra produire suffisamment de preuves pour conduire à l’une des décisions suivantes :

ADOPT SYNCHRONOUS
ADOPT EVENT-DRIVEN
ADOPT HYBRID ARCHITECTURE
NO DECISION — additional evidence required

La dernière conclusion est acceptable si elle est correctement justifiée.

2. Décision architecturale candidate
Avant d’implémenter la PoC, créez un premier ADR :

ADR-001 — Communication architecture for order processing

Il doit contenir :

Context
Pourquoi cette décision doit-elle être prise?

Problem
Quelle incertitude architecturale empêche actuellement de décider?

Options

synchronous workflow;

event-driven workflow;

éventuellement une solution hybride.

Architectural drivers

Par exemple :

performance;

scalability;

availability;

consistency;

reliability;

maintainability;

observability;

operational complexity.

Candidate decision

Indiquez quelle solution vous choisiriez aujourd’hui avec les informations disponibles.

Cette décision est volontairement provisoire.

Le rôle de la PoC est précisément de déterminer si les preuves confirment cette intuition.

3. Scénario métier à implémenter
Le scénario étudié est :

Place Order

Une requête contient au minimum :

customerId
items[]
quantity
paymentInformation
shippingAddress
Le scénario comporte les responsabilités suivantes :

Order Service
Payment Service
Inventory Service
Shipping Service
Notification Service
Vous pouvez simplifier fortement leur implémentation.

Par exemple, il n’est pas nécessaire d’intégrer un véritable fournisseur de paiement.

Les services peuvent simuler les comportements nécessaires.

Ce qui doit être réaliste est le comportement architectural, et non la richesse fonctionnelle du système.

4. Invariant métier
Quel que soit le choix architectural, l’invariant suivant doit être préservé :

Une commande ne peut être confirmée que si le paiement est autorisé et si le stock correspondant a été réservé.

Vous devez également déterminer ce qu’il advient lorsque :

le paiement échoue;

le stock est insuffisant;

un service devient temporairement indisponible;

un message est traité plusieurs fois;

une étape du workflow devient très lente.

Cet invariant rend la comparaison plus intéressante qu’un simple benchmark de requêtes HTTP.

5. Hypothèses
Votre équipe doit formuler au moins trois hypothèses.

Exemples :

H1 — Scalabilité

Sous forte charge, l’architecture orientée événements maintiendra un débit de traitement supérieur à l’architecture synchrone.

H2 — Latence

L’architecture synchrone offrira une latence de complétion plus faible lorsque le système fonctionne sous charge normale.

H3 — Résilience

Lorsqu’un service secondaire est temporairement indisponible, l’architecture événementielle permettra de continuer à accepter des commandes dans davantage de situations.

Vous pouvez ajouter des hypothèses concernant :

cohérence;

complexité de coordination;

observabilité;

consommation de ressources;

coût opérationnel;

facilité de débogage.

Une hypothèse doit pouvoir être confrontée à des observations.

6. Exigences architecturales
Pour les besoins de l’exercice, on suppose que l’entreprise impose les objectifs suivants.

Ces valeurs sont des paramètres pédagogiques proposés pour la PoC; elles ne proviennent pas des deux références fournies.

Charge normale
100 commandes/s
Le système doit fonctionner sans accumulation significative de travail.

Pic promotionnel
500 commandes/s pendant 5 minutes
Le système doit continuer à accepter ou traiter les commandes sans effondrement incontrôlé.

Latence
Sous charge normale :

p95 < 1 seconde
pour obtenir une réponse initiale concernant la commande.

Pour une architecture asynchrone, vous devez distinguer :

latence d'acceptation
et

latence de complétion du workflow.
Fiabilité
Au terme de l’expérience :

aucune commande ne doit être confirmée
si le paiement ou la réservation du stock a échoué.
Observabilité
Il doit être possible de reconstruire le traitement d’une commande individuelle.

7. Les deux variantes minimales
Vous devez construire suffisamment de système pour comparer deux architectures.

Architecture A — Synchrone
Une possibilité est :

Client
   |
Order Service
   |
   +--> Payment Service
   |
   +--> Inventory Service
   |
   +--> Shipping Service
   |
   +--> Notification Service
REST ou gRPC peuvent être utilisés.

Architecture B — Event-driven
Par exemple :

Client
   |
Order Service
   |
 OrderCreated
   |
 Event Broker
   |
   +--> Payment
   +--> Inventory
   +--> Shipping
   +--> Notification
La solution peut employer :

Kafka;

RabbitMQ;

NATS;

Redis Streams;

autre technologie justifiée.

L’objectif n’est pas d’évaluer ces brokers entre eux.

Le broker est simplement un mécanisme permettant d’expérimenter avec le style architectural.

8. Scénarios expérimentaux obligatoires
La PoC doit exécuter au minimum cinq scénarios.

S1 — Fonctionnement nominal
Charge :

100 commandes/s
Observer notamment :

débit;

p50/p95/p99;

taux d’erreur;

consommation CPU/mémoire;

temps de complétion.

Question :

Les deux architectures satisfont-elles les exigences dans des conditions normales?

S2 — Pic de trafic
Faire progressivement augmenter la charge jusqu’à :

500 commandes/s
Observer :

saturation;

débit maximal;

files d’attente;

latence;

erreurs;

backpressure éventuelle.

Question :

Quelle architecture se dégrade le plus progressivement lorsque la charge augmente?

S3 — Payment Service lent
Introduire par exemple :

latence Payment = 2 secondes
Question :

Comment cette dépendance lente affecte-t-elle l’ensemble du workflow?

Mesurez notamment son impact sur :

threads/connections;

débit;

files;

latence;

autres commandes.

S4 — Payment Service indisponible
Rendre le service indisponible pendant une courte période.

Par exemple :

30 secondes
Observer :

commandes perdues;

commandes rejetées;

retries;

accumulation;

récupération après le retour du service.

Question :

L’architecture revient-elle à un état normal après la panne?

S5 — Livraison multiple d’un événement
Pour la variante événementielle, simulez la réception multiple d’un événement.

Exemple :

PaymentAuthorized
PaymentAuthorized
Évaluez notamment :

idempotence;

cohérence;

duplication d'effets secondaires.

Question :

Quelle complexité supplémentaire l’asynchronisme introduit-il pour conserver les invariants métier?

Le framework présenté dans le mémoire accorde précisément aux scénarios ce rôle : relier les objectifs du test aux exigences, mesures de succès et métriques, puis utiliser leur résultat pour alimenter la conclusion de la PoC.

9. Observabilité
Vous devez être capables d’expliquer ce qui s’est produit.

Les métriques seules ne suffisent pas nécessairement.

Vous pouvez utiliser :

OpenTelemetry
Prometheus
Grafana
Jaeger
Tempo
Loki
OpenObserve
ou des technologies équivalentes.

Une trace devrait idéalement permettre de suivre une commande comme :

ORDER-15382

Order created
   ↓
Payment authorized
   ↓
Inventory reserved
   ↓
Shipping requested
   ↓
Order confirmed
Dans l’architecture événementielle, vous devrez réfléchir à la propagation du contexte de traçage à travers les messages.

10. Mesures
Le choix des métriques doit découler des hypothèses.

Les métriques pertinentes peuvent inclure :

throughput
p50 latency
p95 latency
p99 latency
workflow completion time
failure rate
queue length
retry count
CPU
memory
network
recovery time
Mais vous ne devez pas mesurer quelque chose simplement parce que la métrique est facile à collecter.

L'article ICSE met précisément en garde contre les PoC qui collectent des mesures sans lien explicite avec la décision architecturale.

Pour chaque métrique, vous devez pouvoir expliquer :

Quelle hypothèse cette mesure permet-elle d’évaluer?

11. Analyse architecturale
À la fin de l’expérimentation, construisez une matrice de décision.

Par exemple :

Critère	Synchrone	Event-driven	Observations
Latence nominale	++	+	 
Débit sous forte charge	 	 	 
Tolérance aux dépendances lentes	 	 	 
Cohérence	 	 	 
Complexité	 	 	 
Observabilité	 	 	 
Débogage	 	 	 
Scalabilité	 	 	 
Opérabilité	 	 	 
Vous devez cependant justifier chaque évaluation par les résultats de la PoC.

Une matrice remplie sur la base d'opinions ne constitue pas une preuve.

12. La question finale
À partir des résultats, répondez explicitement à la question :

Quelle architecture l’entreprise devrait-elle adopter pour le traitement des commandes?

Une conclusion possible pourrait être :

Les résultats ne justifient pas une architecture entièrement événementielle. Sous charge normale, l'architecture synchrone satisfait les exigences avec une latence plus faible et une complexité opérationnelle moindre. Toutefois, lors des pics de trafic et des indisponibilités temporaires, le découplage asynchrone améliore sensiblement la capacité d'absorption. Nous recommandons donc une architecture hybride : validation du paiement et du stock dans le chemin critique, suivie d'une communication événementielle pour l'expédition, les notifications et les traitements secondaires.

Ou au contraire :

L'architecture événementielle satisfait les critères de performance et de disponibilité tout en permettant une dégradation contrôlée lors des pannes. Malgré une complexité opérationnelle supérieure, les résultats soutiennent son adoption.

Ou :

Les deux variantes satisfont les exigences. Le bénéfice mesuré de l'architecture événementielle ne justifie pas sa complexité supplémentaire. Nous recommandons de conserver l'architecture synchrone.

Les trois réponses peuvent être correctes.

Ce qui est évalué est la relation entre :

preuve → raisonnement → décision.

13. ADR final
Votre livrable doit terminer par la mise à jour de :

ADR-001 — Communication architecture for order processing

Avec au minimum :

Status
Context
Architectural drivers
Options considered
Candidate decision

Evidence collected
Experimental results
Trade-offs
Limitations

Final decision
Consequences
Par exemple :

Status: Accepted

Decision:
Use synchronous interactions for Payment and Inventory
within the critical checkout path.

Use asynchronous events for Shipping, Notification
and downstream processing.
L’intérêt pédagogique est ici important : la PoC ne se termine pas par « voici nos résultats », mais par « compte tenu de ces résultats, voici la décision architecturale que nous prenons ». C’est exactement le lien PoC–ADR défendu dans la référence : une expérience architecturale qui ne produit, ne révise ou n’invalide aucune décision laisse la connaissance obtenue hors du cycle de décision.

14. Livrables
Je simplifierais finalement les livrables autour de cinq éléments seulement :

PoC Plan — problème, décision candidate, hypothèses, exigences, success measures, métriques et scénarios.

PoC Implementation — les deux variantes minimales nécessaires à l’expérience.

Experimental Evidence — scripts, données brutes, traces, métriques et graphiques.

Architecture Analysis — interprétation des résultats, compromis et limites.

ADR-001 final — décision architecturale adoptée, révisée ou rejetée.