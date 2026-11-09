# Invariants

Source de chaque règle : **Énoncé**, **Équipe** ou **Proposition** (proposée par Claude, à valider).
Toutes se vérifient en SQL **après drainage** (plus aucun message ni requête en vol), par `common/scripts/verify-invariants.js` (`cd common && npm run verify`). Chaque règle est une requête de `common/scripts/invariants.js` qui renvoie les éléments en infraction ; `common/test/invariants.test.js` prouve que chacune détecte une violation injectée.

Code de sortie : `0` toutes respectées ; `1` au moins une violation (résultat à documenter, le run reste valide) ; `2` inconclusive (base injoignable, ou aucune commande : rien à vérifier).

Une violation est un **résultat à documenter**, jamais un run à jeter (CLAUDE.md §8).

## Invariant non négociable

**I1 — Une commande ne peut être `CONFIRMED` que si le paiement est autorisé et le stock réservé.** *(Énoncé)*

Appliqué en un seul point, par la même requête dans A et B :

```sql
UPDATE orders SET status='CONFIRMED', confirmed_at=now()
 WHERE id=$1 AND status='ACCEPTED'
   AND payment_status='AUTHORIZED' AND stock_status='RESERVED';
```

**Règle de compensation associée** *(Énoncé)* : stock insuffisant après un paiement autorisé ⇒ le paiement est annulé (`void`).

## Règles dérivées

I1 ne lit que des copies stockées dans `orders`. Les règles suivantes vérifient que ces copies disent vrai et que le reste du système est cohérent.

### Sûreté (ce qui ne doit jamais arriver)

| # | Règle | Détecte | Source |
|---|---|---|---|
| I2 | Une commande `CONFIRMED` a exactement un paiement `AUTHORIZED` (non annulé) dans `payments`, de montant `total_cents`. | copie `payment_status` mensongère, paiement manquant | Proposition |
| I3 | Une commande `CONFIRMED` a, pour chaque article, exactement une réservation dans `stock_reservations`, de la quantité commandée. | copie `stock_status` mensongère, réservation manquante | Proposition |
| I4 | Une commande `REJECTED` pour `INSUFFICIENT_STOCK` n'a plus aucun paiement `AUTHORIZED` (tous `VOIDED`). | compensation non faite : client débité sans commande | Énoncé (compensation) |
| I5 | Une commande `REJECTED` pour `PAYMENT_DECLINED` n'a ni réservation, ni expédition. | traitement poursuivi après un refus | Proposition |
| I6 | Conservation du stock : pour chaque SKU, `initial_stock` (valeur du seed) − Σ réservations = stock actuel, et stock ≥ 0. | stock perdu ou réservé deux fois | Proposition |
| I7 | Pas d'effet de bord dupliqué : par commande, au plus un paiement (quel que soit son statut : deux lignes = deux appels au prestataire), une réservation par article, une expédition, une notification par type. | doublons (S5, idempotence désactivée) | Proposition |
| I8 | Une expédition n'existe que pour une commande `CONFIRMED`. | expédition d'une commande non confirmée | Proposition |
| I9 | Horodatages cohérents avec l'état : `received_at ≤ accepted_at ≤ confirmed_at ≤ completed_at` ; `ACCEPTED`/`CONFIRMED` ⇒ `accepted_at` renseigné ; `CONFIRMED` ⇒ `confirmed_at` renseigné ; `REJECTED` ⇒ `rejected_at` renseigné. | latences fausses (elles sont calculées depuis ces colonnes) | Proposition |

### Vivacité (ce qui doit finir par arriver)

| # | Règle | Source |
|---|---|---|
| I10 | Après drainage, aucune commande ne reste `RECEIVED` ou `ACCEPTED` : chacune est `CONFIRMED` ou `REJECTED`. | Proposition |
| I11 | Toute commande `CONFIRMED` finit `completed` (expédition et notification faites, `completed_at` renseigné). | Proposition |

## Lecture des résultats

- **Sûreté ≠ vivacité.** Une commande bloquée en `ACCEPTED` ne viole pas I1 ; elle viole I10 et, si son paiement reste `AUTHORIZED`, pose un problème métier (client débité). Les rapports doivent distinguer les deux familles.
- **Synchrone** : sans mécanisme de résilience (règle d'équité), une panne d'Inventory après un paiement autorisé laisse la commande `ACCEPTED` avec un paiement non annulé : violation de I10 attendue en S4. C'est un résultat, pas un bogue à masquer.
- **Asynchrone** : I10 et I11 ne valent qu'à terme ; d'où l'attente du drainage avant toute vérification.
- **I7** n'est contrôlable que parce que le schéma n'interdit pas les doublons (décision DB6, `docs/decisions-conception.md`).
