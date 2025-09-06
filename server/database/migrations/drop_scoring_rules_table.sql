-- Migration to drop the scoring_rules table
-- Date: 2025-09-06
-- Reason: The scoring_rules table is not used by the application.
-- The actual scoring system is hardcoded in scoringService.js
-- and follows the tier-based system defined in docs/SCORING_SYSTEM.md

DROP TABLE IF EXISTS scoring_rules;