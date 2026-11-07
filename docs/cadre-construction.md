1. Problème architectural
Décrivez en une ou deux phrases le problème architectural réel à résoudre.

Ne décrivez pas encore la solution.

2. Incertitude
Identifiez la principale incertitude empêchant l’équipe de prendre une décision.

Complétez :

Nous ne savons pas si…

3. Assumption
Identifiez une hypothèse implicite présente dans le raisonnement de l’architecte.

Complétez :

Nous supposons que…

Le cours distingue l’assumption de l’hypothèse testable : une assumption représente ce que nous croyons actuellement, tandis qu’une hypothèse expose cette croyance à la falsification.

4. Hypothèse architecturale
Transformez l’assumption en une hypothèse architecturale testable et falsifiable.

Votre hypothèse doit contenir au minimum :

la solution ou décision évaluée ;
la charge ou les conditions d’exécution ;
au moins un attribut de qualité ;
une mesure ;
un seuil permettant de déterminer si l’hypothèse est supportée ou rejetée.
Format suggéré :

H1 : Sous les conditions __________, l’utilisation de __________ permettra de __________ avec __________ inférieur/supérieur à __________.

Exemple de structure, à ne pas simplement recopier :

« Kafka peut soutenir X événements/s avec une latence p95 inférieure à Y ms dans l’environnement Z. »

Partie 2 — Concevoir le PoC
Un PoC n’est pas simplement une première version du système. Dans le cours, il est défini comme une expérimentation à court terme permettant de valider une hypothèse, réduire les risques et soutenir une décision.

5. Expérience
Décrivez le plus petit PoC possible permettant de tester votre hypothèse.

Précisez :

les composants nécessaires ;
la charge générée ;
la durée approximative du test ;
les scénarios testés.
6. Métriques
Indiquez les métriques que vous collecteriez.

Choisissez uniquement les métriques réellement utiles pour tester votre hypothèse.

Exemples possibles :

événements/seconde ;
latence p50/p95/p99 ;
taux de messages perdus ;
taille du backlog ;
utilisation CPU ;
mémoire ;
utilisation disque ;
temps de récupération après surcharge.
Les PoC servent notamment à évaluer la faisabilité, les risques, les technologies candidates et leurs limitations en matière de performance.

7. Critères de décision
Définissez explicitement les conditions qui conduiraient aux trois décisions suivantes.

Décision	Condition
Adopter	
Réviser	
Rejeter	
Votre réponse doit permettre à une autre équipe de prendre la décision uniquement à partir des résultats du PoC.