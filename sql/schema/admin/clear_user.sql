-- ==========================================
-- Wipe des données liées à un UUID précis
-- Remplace '11111111-1111-4111-8111-111111111111' par l'UUID cible
-- ==========================================
DELETE FROM cards WHERE uuid = '11111111-1111-4111-8111-111111111111';
DELETE FROM users WHERE uuid = '11111111-1111-4111-8111-111111111111';