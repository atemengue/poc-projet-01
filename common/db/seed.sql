-- Données de référence, identiques pour A et B. Réexécutable : remet le stock à sa valeur initiale.
-- SKU-LOW a volontairement peu de stock pour provoquer des « stock insuffisant après paiement
-- autorisé » (compensation par void du paiement). Mélange de charge : D12 (2 % sur SKU-LOW).

-- initial_stock = stock au départ : sert à vérifier la conservation du stock (I6).
INSERT INTO products (sku, price_cents, stock, initial_stock) VALUES
  ('SKU-001', 1999, 1000000, 1000000),
  ('SKU-002', 4999, 1000000, 1000000),
  ('SKU-003',  999, 1000000, 1000000),
  ('SKU-004', 2499, 1000000, 1000000),
  ('SKU-005', 7999, 1000000, 1000000),
  ('SKU-LOW', 1499,      50,      50)
ON CONFLICT (sku) DO UPDATE
  SET price_cents   = EXCLUDED.price_cents,
      stock         = EXCLUDED.stock,
      initial_stock = EXCLUDED.initial_stock;
