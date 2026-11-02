-- Données de référence, identiques pour A et B. Réexécutable : remet le stock à sa valeur initiale.
-- SKU-LOW a volontairement peu de stock pour provoquer des « stock insuffisant après paiement
-- autorisé » (compensation par void du paiement). Mélange de charge : D12 (2 % sur SKU-LOW).

INSERT INTO products (sku, price_cents, stock) VALUES
  ('SKU-001', 1999, 1000000),
  ('SKU-002', 4999, 1000000),
  ('SKU-003',  999, 1000000),
  ('SKU-004', 2499, 1000000),
  ('SKU-005', 7999, 1000000),
  ('SKU-LOW', 1499,      50)
ON CONFLICT (sku) DO UPDATE
  SET price_cents = EXCLUDED.price_cents,
      stock       = EXCLUDED.stock;
